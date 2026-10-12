import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "./audit.ts";
import { describePlatformConfig, loadPlatformConfig, resolveSecret } from "./config.ts";
import { migrate, migrationStatus, openDb, pendingMigrations, rollback } from "./db.ts";
import { startServer } from "./server.ts";
import { PlatformStore } from "./store.ts";
import { initTracing, metrics, platformLogger, shutdownTracing } from "./telemetry.ts";
import { ensureDataDir, Worker } from "./worker.ts";

export const PLATFORM_HELP = `Enterprise platform (configuration from $VOGOBAN_PLATFORM_CONFIG and VOGOBAN_* environment variables; see docs/platform.md)
  platform serve                 API + web application + MCP over HTTP + webhooks + health/metrics
  platform worker [--once]       Background worker (repository analysis, MetaGraph, governance, security, PR checks, exports, retention)
  platform migrate [status|up|down --to-version N]   Platform database migrations (up is also run by serve/worker)
  platform config                Effective platform configuration (secret references only)
  platform tenant create <slug> <name> --admin-email <email>   Create a tenant and invite its first Organization Admin
  platform tenant list
  platform token create <tenant> <name> --role <role> [--scope-repo <repository-id>] [--days N]   Service token for CI/MCP (printed once)
  platform audit verify <tenant> Verify the tenant's audit hash chain`;

const version = () => (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;

export async function platformCommand(args: string[], opts: Record<string, string | boolean | undefined>): Promise<void> {
  const cfg = loadPlatformConfig();
  const [sub, ...rest] = args;
  if (!sub || sub === "help") {
    console.log(PLATFORM_HELP);
    return;
  }
  if (sub === "config") {
    console.log(JSON.stringify(describePlatformConfig(cfg), null, 2));
    if (cfg.errors.length) process.exitCode = 2;
    return;
  }
  if (cfg.errors.length) throw new Error(`platform configuration invalid:\n${cfg.errors.map((e) => `  - ${e}`).join("\n")}`);
  ensureDataDir(cfg);
  const db = openDb(cfg.databaseUrl);
  const store = new PlatformStore(db);
  const log = platformLogger("platform");
  try {
    if (sub === "migrate") {
      const action = rest[0] ?? "up";
      if (action === "status") console.log(JSON.stringify(await migrationStatus(db), null, 2));
      else if (action === "up") console.log(`applied: ${(await migrate(db)).join(", ") || "none (up to date)"}`);
      else if (action === "down") {
        const to = Number(opts["to-version"] ?? NaN);
        if (!Number.isInteger(to) || to < 0) throw new Error("migrate down needs --to-version N");
        console.log(`rolled back: ${(await rollback(db, to)).join(", ") || "none"}`);
      } else throw new Error("migrate status|up|down");
      return;
    }
    await migrate(db);
    await store.seedRoles();
    if (sub === "serve" || sub === "worker") {
      initTracing(`${cfg.otel.serviceName}-${sub === "serve" ? "api" : "worker"}`, version(), cfg.otel.endpoint);
      if (sub === "serve") {
        const server = await startServer(cfg, store, version());
        await new Promise<void>((resolve) => {
          for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => resolve());
        });
        log.info("api.stopping");
        server.stop();
      } else {
        const worker = new Worker(cfg, store, version());
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => worker.stop());
        const metricsToken = resolveSecret(cfg.metricsTokenRef);
        const health = cfg.worker.healthPort > 0 && !opts.once
          ? Bun.serve({ hostname: cfg.listen.host, port: cfg.worker.healthPort, fetch: async (req) => {
              const path = new URL(req.url).pathname;
              if (path === "/health/live") return Response.json({ status: worker.stopped ? "stopping" : "ok", worker: worker.id, running: worker.runningJobs });
              if (path === "/health/ready") {
                const ok = await pendingMigrations(store.db).then((n) => n === 0, () => false);
                return Response.json({ status: ok ? "ready" : "not-ready", database: ok }, { status: ok ? 200 : 503 });
              }
              if (path === "/metrics") return metricsToken && req.headers.get("authorization") !== `Bearer ${metricsToken}` ? new Response("unauthorized", { status: 401 }) : new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
              return new Response("not found", { status: 404 });
            } })
          : null;
        await worker.run({ once: !!opts.once });
        health?.stop(true);
      }
      await shutdownTracing();
      return;
    }
    if (sub === "tenant") {
      if (rest[0] === "list") {
        for (const t of await store.tenants()) console.log(`${t.id}  ${t.slug}  ${t.status}  ${t.name}`);
        return;
      }
      if (rest[0] !== "create" || !rest[1] || !rest[2] || typeof opts["admin-email"] !== "string") throw new Error("platform tenant create <slug> <name> --admin-email <email>");
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(rest[1])) throw new Error("slug must be lowercase letters, digits or dashes");
      if (await store.tenant(rest[1])) throw new Error(`tenant ${rest[1]} exists`);
      const t = await store.createTenant(rest[1], rest.slice(2).join(" "));
      await store.invite(t.id, String(opts["admin-email"]), [{ roleKey: "org_admin", scopeType: "tenant", scopeId: null, environments: null }], "cli");
      await new AuditLog(db).append({ tenantId: t.id, actorType: "system", actorId: `cli:${process.env.USER ?? "operator"}`, action: "tenant.created", resourceType: "tenant", resourceId: t.id, outcome: "success", metadata: { slug: t.slug, adminEmail: opts["admin-email"] } });
      console.log(`created tenant ${t.slug} (${t.id}); ${opts["admin-email"]} becomes Organization Admin at first login`);
      return;
    }
    if (sub === "token" && rest[0] === "create") {
      const [, slug, name] = rest;
      const t = slug ? await store.tenant(slug) : null;
      if (!t || !name || typeof opts.role !== "string") throw new Error("platform token create <tenant> <name> --role <role> [--scope-repo <id>]");
      const role = await store.roleByKey(t.id, opts.role);
      if (!role) throw new Error(`unknown role ${opts.role}`);
      const repo = typeof opts["scope-repo"] === "string" ? await store.repository(t.id, opts["scope-repo"]) : null;
      if (opts["scope-repo"] && !repo) throw new Error("repository not found");
      const days = Number(opts.days ?? 90);
      const { id, secret } = await store.createToken(t.id, name, "service", null, "cli", new Date(Date.now() + days * 86_400_000).toISOString());
      await store.bind(t.id, "token", id, role.id, repo ? "repository" : "tenant", repo?.id ?? null, null, "cli");
      await new AuditLog(db).append({ tenantId: t.id, actorType: "system", actorId: `cli:${process.env.USER ?? "operator"}`, action: "token.create", resourceType: "token", resourceId: id, outcome: "success", metadata: { name, role: role.key, repository: repo?.id ?? null, days } });
      console.log(secret);
      console.error(`service token ${id} (${role.key}${repo ? ` on ${repo.name}` : ""}, ${days} days); the secret above is shown only once`);
      return;
    }
    if (sub === "audit" && rest[0] === "verify") {
      const t = rest[1] ? await store.tenant(rest[1]) : null;
      if (!t) throw new Error("platform audit verify <tenant>");
      const r = await new AuditLog(db).verify(t.id);
      console.log(JSON.stringify(r, null, 2));
      if (!r.valid) process.exitCode = 4;
      return;
    }
    throw new Error(`unknown platform command: ${sub}\n\n${PLATFORM_HELP}`);
  } finally {
    await db.close();
  }
}
