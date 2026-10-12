import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { accessFor, AuthError, authenticate, Oidc, safeReturnTo, userFromClaims, isOperator } from "./auth.ts";
import { AuditLog } from "./audit.ts";
import { resolveSecret, type PlatformConfig } from "./config.ts";
import { pendingMigrations } from "./db.ts";
import { GraphUnavailable, TenantGraphs } from "./graph.ts";
import { ApiError, compile, errorResponse, json, openApi, RateLimiter, SECURITY_HEADERS, validate, type RequestContext, type Route } from "./http.ts";
import { enqueueJob } from "./jobs.ts";
import { PROVIDERS, repositoryIdentity } from "./providers.ts";
import { AccessDenied } from "./rbac.ts";
import { routes } from "./api.ts";
import { ScopeError } from "../ai/access.ts";
import { metrics, platformLogger, tracer, traceIdOf } from "./telemetry.ts";
import { newId, type PlatformStore } from "./store.ts";

const WEB_DIR = join(import.meta.dir, "web");
const PUBLIC_DIR = join(import.meta.dir, "public");

type StaticFile = { body: string | Uint8Array; type: string };

export interface Server {
  stop(): void;
  port: number;
}

/** The API process: REST API, OIDC login, webhooks, MCP over HTTP, health, metrics and the web application (same origin). */
/**
 * Client address for rate limiting and audit (A-02). X-Forwarded-For is attacker-controlled unless the direct peer is a
 * configured trusted proxy (VOGOBAN_TRUSTED_PROXIES: exact addresses or IPv4 CIDR prefixes); otherwise the socket address wins.
 */
export function clientIp(forwardedFor: string | null, peer: string | null, trustedProxies: string[]): string | null {
  const trusted = peer !== null && trustedProxies.some((p) => p === peer || p === "*" || (p.endsWith("/32") && p.slice(0, -3) === peer) || cidrMatch(peer, p));
  if (!trusted) return peer;
  const hops = (forwardedFor ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!trustedProxies.some((p) => p === hop || cidrMatch(hop, p))) return /^[0-9a-fA-F.:]+$/.test(hop) ? hop : peer;
  }
  return hops[0] ?? peer;
}

function cidrMatch(address: string, cidr: string): boolean {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(cidr);
  if (!m || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const toInt = (ip: string) => ip.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
  const bits = Number(m[2]);
  if (bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(address) & mask) === (toInt(m[1]!) & mask);
}

export async function startServer(cfg: PlatformConfig, store: PlatformStore, version: string): Promise<Server> {
  const log = platformLogger("api");
  const audit = new AuditLog(store.db);
  const graphs = new TenantGraphs(cfg, store);
  const oidc = new Oidc(cfg, store);
  const limiter = new RateLimiter();
  const table = routes({ cfg, store, audit, graphs, version });
  const compiled = table.map((r) => ({ route: r, re: compile(r.path) }));
  const spec = openApi(table, version, cfg.publicUrl);
  const webBundle = await buildWeb(log);
  const publicBundle = await buildPublicWeb(log, cfg.publicUrl);
  const metricsToken = resolveSecret(cfg.metricsTokenRef);
  const origin = new URL(cfg.publicUrl).origin;

  const rate = (category: string, key: string) => {
    const rule = cfg.rateLimits[category as keyof PlatformConfig["rateLimits"]] ?? cfg.rateLimits.default;
    const r = limiter.take(`${category}|${key}`, rule);
    if (!r.ok) {
      metrics.rateLimited.inc({ category });
      throw new ApiError(429, "RATE_LIMITED", `rate limit exceeded for ${category}`, { retryAfterSeconds: r.retryAfterSeconds });
    }
  };

  const readBody = async (req: Request): Promise<string> => {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > cfg.limits.maxBodyBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${cfg.limits.maxBodyBytes} bytes`);
    const text = await req.text();
    if (text.length > cfg.limits.maxBodyBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${cfg.limits.maxBodyBytes} bytes`);
    return text;
  };

  const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.auth.secureCookies ? "; Secure" : ""}`;

  async function handleAuth(req: Request, url: URL, c: { correlationId: string; ip: string | null }): Promise<Response> {
    rate("auth", c.ip ?? "unknown");
    if (url.pathname === "/auth/login") {
      if (!oidc.enabled) throw new ApiError(404, "NOT_FOUND", "OIDC login is not configured; use an API token");
      return Response.redirect(await oidc.loginUrl(url.searchParams.get("returnTo")), 302);
    }
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) throw new ApiError(400, "VALIDATION_FAILED", url.searchParams.get("error_description") ?? "missing code or state");
      try {
        const { claims, returnTo } = await oidc.callback(code, state);
        const user = await userFromClaims(store, cfg, claims);
        const session = await store.createSession(user.id, cfg.auth.sessionTtlHours, c.ip, req.headers.get("user-agent"));
        await audit.append({ tenantId: null, actorType: "user", actorId: user.id, action: "auth.login", resourceType: "user", resourceId: user.id, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { issuer: claims.iss, operator: isOperator(cfg, user) } });
        for (const m of await store.memberships(user.id)) await audit.append({ tenantId: m.tenant.id, actorType: "user", actorId: user.id, action: "auth.login", resourceType: "user", resourceId: user.id, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: {} });
        return new Response(null, { status: 302, headers: { location: safeReturnTo(returnTo, cfg.publicUrl), "set-cookie": cookie("vogoban_session", session, cfg.auth.sessionTtlHours * 3600) } });
      } catch (error) {
        await audit.append({ tenantId: null, actorType: "anonymous", actorId: null, action: "auth.login", outcome: "failure", correlationId: c.correlationId, ip: c.ip, metadata: { reason: error instanceof Error ? error.message : String(error) } });
        throw error instanceof AuthError ? new ApiError(401, error.code === "OIDC_UNAVAILABLE" ? "DEPENDENCY_UNAVAILABLE" : "UNAUTHENTICATED", error.message) : error;
      }
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      const sid = req.headers.get("cookie")?.split(/;\s*/).find((x) => x.startsWith("vogoban_session="))?.slice(16);
      if (sid) {
        const s = await store.session(sid);
        await store.revokeSession(sid);
        if (s) await audit.append({ tenantId: null, actorType: "user", actorId: s.userId, action: "auth.logout", outcome: "success", correlationId: c.correlationId, ip: c.ip });
      }
      return json({ loggedOut: true, endSessionUrl: await oidc.logoutUrl() }, 200, { "set-cookie": cookie("vogoban_session", "", 0) });
    }
    throw new ApiError(404, "NOT_FOUND", "not found");
  }

  /** Webhooks authenticate by provider signature against the repository's registered secret, never by bearer tokens. */
  async function handleWebhook(req: Request, repoId: string, c: { correlationId: string; ip: string | null }): Promise<Response> {
    rate("webhooks", repoId);
    const body = await readBody(req);
    const repo = await store.repositoryById(repoId);
    const reject = async (status: number, reason: string) => {
      await audit.append({ tenantId: repo?.tenantId ?? null, actorType: "webhook", actorId: null, action: "webhook.received", resourceType: "repository", resourceId: repoId, outcome: "denied", correlationId: c.correlationId, ip: c.ip, metadata: { reason } });
      throw new ApiError(status, status === 404 ? "NOT_FOUND" : "FORBIDDEN", reason);
    };
    if (!repo || repo.status !== "active") return reject(404, "unknown repository");
    const tenant = await store.tenant(repo.tenantId);
    if (!tenant || tenant.status !== "active" || tenant.settings.features.integrations === false || !cfg.features.integrations) return reject(403, "integrations disabled");
    const secret = resolveSecret(repo.webhookSecretRef);
    if (!secret) return reject(403, "no webhook secret configured for this repository");
    const provider = PROVIDERS[repo.provider] ?? PROVIDERS.git!;
    if (!provider.verifyWebhook(req.headers, body, secret)) return reject(403, "invalid webhook signature");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reject(400, "malformed payload");
    }
    const event = provider.parseWebhook(req.headers, payload);
    if (event.repositoryUrl && repositoryIdentity(event.repositoryUrl) !== repo.identity) return reject(403, "event is for a different repository");
    const ctx = { tenantId: repo.tenantId, createdBy: `webhook:${repo.provider}`, correlationId: c.correlationId };
    let job = null;
    if (event.kind === "push" && event.branch === repo.branch && event.commit && /^[0-9a-f]{40}$/i.test(event.commit)) {
      job = (await enqueueJob(store, cfg, ctx, "ANALYZE_REPOSITORY", { repositoryId: repo.id, params: { commit: event.commit, ref: repo.branch, reason: "push" }, dedupe: `analyze:${repo.id}:${event.commit}` })).job;
    } else if (event.kind === "pull_request" && event.commit && /^[0-9a-f]{40}$/i.test(event.commit)) {
      job = (await enqueueJob(store, cfg, ctx, "PULL_REQUEST_ANALYSIS", { repositoryId: repo.id, params: { commit: event.commit, pullRequest: event.pullRequest, baseBranch: event.baseBranch, failOn: "ERROR" }, dedupe: `pr:${repo.id}:${event.commit}:ERROR` })).job;
    }
    await audit.append({ tenantId: repo.tenantId, actorType: "webhook", actorId: repo.provider, action: "webhook.received", resourceType: "repository", resourceId: repo.id, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { event: event.kind, action: event.action, branch: event.branch, commit: event.commit, job: job?.id ?? null } });
    return json({ accepted: true, event: event.kind, job: job?.id ?? null }, 202);
  }

  async function health(path: string): Promise<Response> {
    if (path === "/health/live") return json({ status: "ok", version });
    const checks: Record<string, { ok: boolean; detail?: unknown }> = {};
    try {
      await store.db.ping();
      const pending = await pendingMigrations(store.db);
      checks.database = { ok: pending === 0, detail: pending ? `${pending} pending migrations` : store.db.dialect };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    try {
      const queued = Number((await store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'QUEUED'"))?.n ?? 0);
      metrics.queueDepth.set({}, queued);
      const workers = await store.workers();
      const live = workers.filter((w) => w.status === "running" && Date.now() - Date.parse(w.heartbeatAt) < 60_000);
      checks.queue = { ok: true, detail: { queued, liveWorkers: live.length } };
      checks.workers = { ok: true, detail: live.length ? `${live.length} live` : "no live worker: jobs stay queued until a worker starts (API remains available)" };
    } catch (error) {
      checks.queue = { ok: false, detail: String(error) };
    }
    checks.identityProvider = { ok: true, detail: oidc.enabled ? ((await oidc.ready()) ? "reachable" : "unreachable: logins fail, API tokens keep working") : "not configured" };
    checks.dataDir = { ok: existsSync(cfg.dataDir) };
    const ready = Object.values(checks).every((x) => x.ok);
    return json({ status: ready ? "ready" : "not-ready", version, checks }, ready ? 200 : 503);
  }

  async function handleApi(req: Request, url: URL, c: RequestContext, span: ReturnType<typeof trace.getActiveSpan>, label: (r: string) => void): Promise<{ res: Response; route: string }> {
    const match = compiled.find((x) => x.route.method === req.method && x.re.test(url.pathname));
    if (!match) {
      if (compiled.some((x) => x.re.test(url.pathname))) throw new ApiError(405, "VALIDATION_FAILED", "method not allowed");
      throw new ApiError(404, "NOT_FOUND", "no such endpoint");
    }
    const r: Route = match.route;
    label(`${r.method} ${r.path}`);
    try {
      c.params = Object.fromEntries(Object.entries(url.pathname.match(match.re)!.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    } catch {
      throw new ApiError(400, "VALIDATION_FAILED", "malformed percent-encoding in path");
    }
    span?.updateName(`${r.method} ${r.path}`);
    c.auth = await authenticate(req, store, oidc, cfg);
    if (r.auth !== "public" && !c.auth) throw new ApiError(401, "UNAUTHENTICATED", "authentication required");
    if (c.auth?.method === "session" && req.method !== "GET" && req.headers.get("origin") !== origin) throw new ApiError(403, "FORBIDDEN", "cross-origin request rejected");
    if (r.auth === "operator" && !c.auth!.principal.operator) throw new ApiError(403, "FORBIDDEN", "platform operators only");
    if (r.auth === "tenant") {
      const t = await store.tenant(c.params.tenant!);
      const access = t && t.status === "active" ? await accessFor(store, c.auth!, t.id) : null;
      if (!t || !access) throw new ApiError(404, "NOT_FOUND", "tenant not found");
      c.tenant = t;
      c.access = access;
      span?.setAttribute("vogoban.tenant", t.slug);
      if (r.feature && (t.settings.features[r.feature] === false || !cfg.features[r.feature as keyof PlatformConfig["features"]])) throw new ApiError(403, "FEATURE_DISABLED", `feature ${r.feature} is disabled`);
      if (r.permission && !access.can(r.permission)) throw new ApiError(403, "FORBIDDEN", `missing permission ${r.permission}`);
    }
    rate(r.rate ?? "default", `${c.tenant?.id ?? "-"}|${c.auth?.principal.id ?? c.ip ?? "anon"}`);
    c.query = validate(r.query, Object.fromEntries([...url.searchParams.keys()].map((k) => { const all = url.searchParams.getAll(k); return [k, r.query?.[k]?.type === "string[]" ? all.flatMap((x) => x.split(",")) : all[0]]; })), "query");
    if (r.paginated && !r.query?.limit) c.query = { ...c.query, ...validate({ limit: { type: "integer", min: 1, max: cfg.limits.maxPageSize, default: 50, description: "" }, cursor: { type: "string", maxLength: 400, description: "" } }, { limit: url.searchParams.get("limit") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined }, "query") };
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const text = await readBody(req);
      let parsed: unknown = {};
      if (text.trim()) {
        if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new ApiError(400, "VALIDATION_FAILED", "content-type must be application/json");
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ApiError(400, "VALIDATION_FAILED", "body is not valid JSON");
        }
      }
      c.body = r.body ? validate(r.body, parsed, "body") : ((parsed ?? {}) as Record<string, unknown>);
    }
    const out = await r.handler(c);
    if (r.audit) await audit.append({ tenantId: c.tenant?.id ?? null, actorType: c.auth?.principal.type ?? "anonymous", actorId: c.auth?.principal.id ?? null, action: r.audit, resourceType: r.tag, resourceId: Object.values(c.params).filter((v) => v !== c.params.tenant).join("/") || null, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { body: c.body, params: c.params } });
    return { res: out instanceof Response ? out : json(out), route: `${r.method} ${r.path}` };
  }

  const server = Bun.serve({
    hostname: cfg.listen.host,
    port: cfg.listen.port,
    idleTimeout: 120,
    maxRequestBodySize: cfg.limits.maxBodyBytes * 2,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const given = req.headers.get("x-correlation-id");
      const correlationId = given && /^[\w.-]{8,80}$/.test(given) ? given : newId("cor");
      const ip = clientIp(req.headers.get("x-forwarded-for"), srv.requestIP(req)?.address ?? null, cfg.trustedProxies);
      const started = performance.now();
      let route = url.pathname.startsWith("/api/") ? "unmatched" : url.pathname.startsWith("/assets/") || url.pathname.startsWith("/public-assets/") ? "static" : url.pathname;
      return tracer().startActiveSpan(`${req.method} ${url.pathname.startsWith("/api/") ? "api" : url.pathname}`, { attributes: { "http.request.method": req.method, "url.path": url.pathname, "vogoban.correlation_id": correlationId } }, async (span) => {
        let res: Response;
        const c: RequestContext = { req, url, params: {}, query: {}, body: {}, correlationId, ip, auth: null, tenant: null, access: null };
        try {
          if (url.pathname === "/health/live" || url.pathname === "/health/ready") res = await health(url.pathname);
          else if (url.pathname === "/metrics") {
            if (metricsToken && req.headers.get("authorization") !== `Bearer ${metricsToken}`) throw new ApiError(401, "UNAUTHENTICATED", "metrics token required");
            res = new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
          } else if (url.pathname === "/api/v1/openapi.json") res = json(spec);
          else if (url.pathname.startsWith("/auth/")) res = await handleAuth(req, url, c);
          else if (req.method === "POST" && /^\/api\/v1\/hooks\/[\w]+$/.test(url.pathname)) {
            route = "POST /api/v1/hooks/{repositoryId}";
            res = await handleWebhook(req, url.pathname.split("/").pop()!, c);
          } else if (url.pathname.startsWith("/api/")) ({ res, route } = await handleApi(req, url, c, span, (x) => (route = x)));
          else if (url.pathname.startsWith("/assets/")) res = web(url.pathname, webBundle);
          else if (url.pathname === "/app" || url.pathname.startsWith("/app/")) res = web(url.pathname, webBundle);
          else res = publicWeb(url.pathname, publicBundle);
        } catch (error) {
          const e = toApiError(error);
          if (e.code === "FORBIDDEN" && c.tenant && c.auth) await audit.append({ tenantId: c.tenant.id, actorType: c.auth.principal.type, actorId: c.auth.principal.id, action: "access.denied", resourceType: "endpoint", resourceId: route, outcome: "denied", correlationId, ip, metadata: { reason: e.message } }).catch(() => undefined);
          if (e.status >= 500) log.error("request.failed", { correlation_id: correlationId, trace_id: traceIdOf(span) ?? undefined, route, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
          span.setStatus({ code: e.status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
          res = errorResponse(e, correlationId);
        }
        const seconds = (performance.now() - started) / 1000;
        span.setAttribute("http.response.status_code", res.status);
        span.end();
        metrics.httpRequests.inc({ route, method: req.method, status: String(res.status) });
        metrics.httpDuration.observe({ route }, seconds);
        log.info("request", { correlation_id: correlationId, trace_id: traceIdOf(span) ?? undefined, method: req.method, route, status: res.status, ms: Math.round(seconds * 1000), tenant: c.tenant?.slug, principal: c.auth?.principal.id });
        const headers = new Headers(res.headers);
        headers.set("x-correlation-id", correlationId);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
        if (url.pathname.startsWith("/api/")) headers.set("cache-control", "no-store");
        if (cfg.auth.secureCookies) headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
        return new Response(res.body, { status: res.status, headers });
      });
    },
  });
  log.info("api.started", { url: cfg.publicUrl, port: server.port, mode: cfg.mode, database: store.db.dialect, oidc: oidc.enabled });
  return { stop: () => server.stop(true), port: server.port! };
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AuthError) return new ApiError(error.code === "OIDC_UNAVAILABLE" ? 503 : 401, error.code === "OIDC_UNAVAILABLE" ? "DEPENDENCY_UNAVAILABLE" : error.code === "INVALID_TOKEN" ? "INVALID_TOKEN" : "UNAUTHENTICATED", error.message);
  if (error instanceof AccessDenied || error instanceof ScopeError) return new ApiError(403, "FORBIDDEN", error.message);
  if (error instanceof GraphUnavailable) return new ApiError(409, error.code === "GRAPH_UNAVAILABLE" ? "GRAPH_NOT_ANALYZED" : error.code, error.message);
  const text = `${(error as { code?: string })?.code ?? ""} ${error instanceof Error ? error.message : ""}`;
  const sqlState = String((error as { errno?: string })?.errno ?? "");
  if (/^(08|53|57P0|57014|55P03)/.test(sqlState) || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_POSTGRES_(CONNECTION|IDLE|LIFETIME)|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|IDLE_TIMEOUT|CONNECTION_TIMEOUT|Idle timeout reached|Connection timeout|terminating connection|57P01|57P03|08006|08001|too many clients|ConnectionClosed|Failed to read data|not yet accepting connections|in recovery mode|No space left on device|could not extend file/i.test(text))
    return new ApiError(503, "DEPENDENCY_UNAVAILABLE", "the database is temporarily unavailable; retry shortly");
  return new ApiError(500, "INTERNAL", "internal error");
}

async function buildWeb(log: ReturnType<typeof platformLogger>): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  if (!existsSync(join(WEB_DIR, "app.ts"))) return files;
  const out = await Bun.build({ entrypoints: [join(WEB_DIR, "app.ts")], target: "browser", minify: true });
  if (!out.success) {
    log.error("web.build_failed", { logs: out.logs.map(String) });
    return files;
  }
  files.set("/assets/app.js", { body: await out.outputs[0]!.text(), type: "text/javascript; charset=utf-8" });
  files.set("/assets/app.css", { body: readFileSync(join(WEB_DIR, "app.css"), "utf8"), type: "text/css; charset=utf-8" });
  files.set("/", { body: readFileSync(join(WEB_DIR, "index.html"), "utf8"), type: "text/html; charset=utf-8" });
  return files;
}

/** Builds the unauthenticated product site independently from the enterprise dashboard. */
export async function buildPublicWeb(log: ReturnType<typeof platformLogger>, publicUrl: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  const index = join(PUBLIC_DIR, "index.html");
  if (!existsSync(index)) return files;

  const app = ["app.ts", "main.ts"].map((name) => join(PUBLIC_DIR, name)).find(existsSync);
  if (app) {
    const out = await Bun.build({ entrypoints: [app], target: "browser", minify: true });
    if (!out.success) log.error("public_web.build_failed", { logs: out.logs.map(String) });
    else files.set("/public-assets/app.js", { body: await out.outputs[0]!.text(), type: "text/javascript; charset=utf-8" });
  }

  for (const name of ["site.css", "app.css"]) {
    const css = join(PUBLIC_DIR, name);
    if (existsSync(css)) files.set(`/public-assets/${name}`, { body: readFileSync(css, "utf8"), type: "text/css; charset=utf-8" });
  }

  const canonical = publicCanonicalUrl(publicUrl);
  files.set("/", { body: publicIndex(readFileSync(index, "utf8"), canonical), type: "text/html; charset=utf-8" });
  for (const name of ["favicon.svg", "robots.txt"]) {
    const path = join(PUBLIC_DIR, name);
    if (existsSync(path)) files.set(`/${name}`, { body: readFileSync(path, "utf8"), type: name.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8" });
  }
  files.set("/sitemap.xml", { body: sitemap(canonical), type: "application/xml; charset=utf-8" });
  return files;
}

function publicCanonicalUrl(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function publicIndex(html: string, canonical: string | null): string {
  if (!canonical) return html.replace(/\s*<link rel="canonical"[^>]*>\s*/i, "\n");
  const tag = `<link rel="canonical" href="${canonical}" />`;
  return /<link rel="canonical"[^>]*>/i.test(html) ? html.replace(/<link rel="canonical"[^>]*>/i, tag) : html.replace("</head>", `    ${tag}\n  </head>`);
}

function sitemap(canonical: string | null): string {
  if (!canonical) return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"></urlset>\n";
  const routes = ["/", "/features", "/architecture", "/getting-started", "/privacy", "/contact", "/docs", "/docs/getting-started", "/docs/installation", "/docs/quickstart", "/docs/concepts"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes.map((route) => `  <url><loc>${canonical}${route}</loc></url>`).join("\n")}\n</urlset>\n`;
}

function web(path: string, files: Map<string, StaticFile>): Response {
  const f = files.get(path) ?? (path.startsWith("/assets/") ? null : files.get("/"));
  if (!f) return new Response("not found", { status: 404 });
  return new Response(f.body as BodyInit, { headers: { "content-type": f.type, "cache-control": path.startsWith("/assets/") ? "public, max-age=300" : "no-cache" } });
}

function publicWeb(path: string, files: Map<string, StaticFile>): Response {
  const f = files.get(path) ?? (path.startsWith("/public-assets/") ? null : files.get("/"));
  if (!f) return new Response("not found", { status: 404 });
  return new Response(f.body as BodyInit, { headers: { "content-type": f.type, "cache-control": path.startsWith("/public-assets/") ? "public, max-age=300" : "no-cache" } });
}
