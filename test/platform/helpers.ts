import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../src/platform/audit.ts";
import { loadPlatformConfig, type PlatformConfig } from "../../src/platform/config.ts";
import { migrate, openDb } from "../../src/platform/db.ts";
import { startServer, type Server } from "../../src/platform/server.ts";
import { PlatformStore } from "../../src/platform/store.ts";

export const ROOT = join(import.meta.dir, "../..");
export const CLI = join(ROOT, "src/cli/main.ts");
export const FIXTURE = join(ROOT, "test/azure/fixtures/contoso-orders");

export interface Platform {
  cfg: PlatformConfig;
  store: PlatformStore;
  audit: AuditLog;
  server: Server;
  base: string;
  dataDir: string;
  stop(): Promise<void>;
}

/** Starts the platform API in sqlite mode on a random port with an isolated data directory. */
export async function startPlatform(env: Record<string, string> = {}): Promise<Platform> {
  const dataDir = mkdtempSync(join(tmpdir(), "vogoban-platform-"));
  writeFileSync(join(dataDir, "platform.yaml"), "rateLimits:\n  auth: { capacity: 10000, refillPerMinute: 10000 }\n");
  const cfg = loadPlatformConfig({
    VOGOBAN_PLATFORM_CONFIG: join(dataDir, "platform.yaml"),
    VOGOBAN_MODE: "local",
    VOGOBAN_DATA_DIR: dataDir,
    VOGOBAN_DATABASE_URL: `sqlite://${join(dataDir, "platform.db")}`,
    VOGOBAN_PUBLIC_URL: "http://127.0.0.1:0",
    VOGOBAN_HOST: "127.0.0.1",
    VOGOBAN_PORT: "0",
    ...env,
  });
  if (cfg.errors.length) throw new Error(cfg.errors.join("; "));
  const db = openDb(cfg.databaseUrl);
  await migrate(db);
  const store = new PlatformStore(db);
  await store.seedRoles();
  const server = await startServer(cfg, store, "0.0.0-test");
  const base = `http://127.0.0.1:${server.port}`;
  return {
    cfg, store, audit: new AuditLog(db), server, base, dataDir,
    stop: async () => {
      server.stop();
      await db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Creates a tenant with a service token bound to a built-in role (tenant-wide unless a repository scope is given). */
export async function tenantWithToken(p: Platform, slug: string, role = "org_admin", scope: { repositoryId?: string; environments?: string[] } = {}) {
  const tenant = (await p.store.tenant(slug)) ?? (await p.store.createTenant(slug, slug));
  const r = await p.store.roleByKey(tenant.id, role);
  if (!r) throw new Error(`unknown role ${role}`);
  const { id, secret } = await p.store.createToken(tenant.id, `${role}-token`, "service", null, "test", null);
  await p.store.bind(tenant.id, "token", id, r.id, scope.repositoryId ? "repository" : "tenant", scope.repositoryId ?? null, scope.environments ?? null, "test");
  return { tenant, tokenId: id, secret };
}

/** Analyzes the contoso-orders fixture (copied outside the repository) into the tenant's graph store with the CLI. */
export function analyzeFixtureInto(p: Platform, tenantId: string, name = "contoso-orders") {
  const work = join(p.dataDir, "src", name);
  mkdirSync(join(p.dataDir, "tenants", tenantId), { recursive: true });
  cpSync(FIXTURE, work, { recursive: true });
  const db = join(p.dataDir, "tenants", tenantId, "graph.db");
  const r = Bun.spawnSync(["bun", CLI, "analyze", work, "--db", db, "--log-level", "error"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_OFFLINE: "1" } });
  if (r.exitCode !== 0) throw new Error(`fixture analysis failed (${r.exitCode}): ${r.stderr.toString()}`);
  return db;
}

export const bearer = (secret: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${secret}`, "content-type": "application/json", ...extra });

export async function call(p: Platform, method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const res = await fetch(`${p.base}${path}`, { method, headers: init.headers, body: init.body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export const rpc = (id: unknown, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
