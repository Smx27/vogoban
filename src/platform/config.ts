import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const API_VERSION = "v1";
export const PLATFORM_SCHEMA_VERSION = 1;

export const FEATURES = ["ai", "mcp", "integrations", "security", "governance", "exports"] as const;
export type Feature = (typeof FEATURES)[number];

export interface RateLimitRule {
  capacity: number;
  refillPerMinute: number;
}

export interface PlatformConfig {
  file: string | null;
  mode: "local" | "enterprise";
  dataDir: string;
  databaseUrl: string;
  publicUrl: string;
  listen: { host: string; port: number };
  /** Proxy addresses whose X-Forwarded-For is trusted for the client IP (rate limiting, audit); empty = the header is ignored. */
  trustedProxies: string[];
  auth: {
    issuer: string | null;
    clientId: string | null;
    clientSecretRef: string | null;
    scopes: string[];
    audience: string | null;
    sessionTtlHours: number;
    secureCookies: boolean;
    operators: string[];
  };
  git: { allowedHosts: string[]; allowPrivateNetworks: boolean; allowFileUrls: boolean; timeoutSeconds: number; restore: boolean };
  worker: { concurrency: number; pollSeconds: number; leaseSeconds: number; analysisTimeoutMinutes: number; maxAttempts: number; healthPort: number };
  rateLimits: Record<"auth" | "search" | "graph" | "ai" | "mcp" | "exports" | "analysis" | "webhooks" | "default", RateLimitRule>;
  features: Record<Feature, boolean>;
  limits: { maxBodyBytes: number; maxPageSize: number; maxDepth: number };
  metricsTokenRef: string | null;
  /** Evaluation only: permits http:// for localhost services (public URL, local model servers). */
  allowInsecureHttp: boolean;
  otel: { endpoint: string | null; serviceName: string };
  errors: string[];
}

const DEFAULT_RATE: PlatformConfig["rateLimits"] = {
  auth: { capacity: 20, refillPerMinute: 20 },
  search: { capacity: 60, refillPerMinute: 120 },
  graph: { capacity: 60, refillPerMinute: 120 },
  ai: { capacity: 5, refillPerMinute: 10 },
  mcp: { capacity: 60, refillPerMinute: 120 },
  exports: { capacity: 5, refillPerMinute: 5 },
  analysis: { capacity: 10, refillPerMinute: 10 },
  webhooks: { capacity: 60, refillPerMinute: 120 },
  default: { capacity: 120, refillPerMinute: 300 },
};

/**
 * Platform configuration: optional YAML file ($VOGOBAN_PLATFORM_CONFIG) overridden by environment variables.
 * Secrets are never values here, only references (env:NAME or file:/path) resolved at use time.
 */
export function loadPlatformConfig(env: Record<string, string | undefined> = process.env): PlatformConfig {
  const file = env.VOGOBAN_PLATFORM_CONFIG ?? null;
  const errors: string[] = [];
  let raw: Record<string, any> = {};
  if (file) {
    if (!existsSync(file)) throw new Error(`platform configuration not found: ${file}`);
    raw = (parseYaml(readFileSync(file, "utf8")) as Record<string, any>) ?? {};
  }
  const pick = <T>(envName: string, path: string[], fallback: T, parse: (v: string) => T = (v) => v as unknown as T): T => {
    const e = env[envName];
    if (e !== undefined && e !== "") return parse(e);
    let cur: any = raw;
    for (const p of path) cur = cur?.[p];
    return cur === undefined || cur === null ? fallback : (typeof cur === "string" ? parse(cur) : (cur as T));
  };
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const bool = (v: string) => /^(1|true|yes|on)$/i.test(v);
  const mode = pick<"local" | "enterprise">("VOGOBAN_MODE", ["mode"], "local");
  const dataDir = resolve(pick("VOGOBAN_DATA_DIR", ["dataDir"], ".vogoban-platform"));
  const publicUrl = pick("VOGOBAN_PUBLIC_URL", ["publicUrl"], "http://localhost:8080").replace(/\/+$/, "");
  const features = Object.fromEntries(FEATURES.map((f) => [f, pick(`VOGOBAN_FEATURE_${f.toUpperCase()}`, ["features", f], true, bool)])) as Record<Feature, boolean>;
  const rateLimits = Object.fromEntries(Object.entries(DEFAULT_RATE).map(([k, v]) => [k, { ...v, ...(raw.rateLimits?.[k] ?? {}) }])) as PlatformConfig["rateLimits"];
  const cfg: PlatformConfig = {
    file,
    mode,
    dataDir,
    databaseUrl: pick("VOGOBAN_DATABASE_URL", ["databaseUrl"], `sqlite://${resolve(dataDir, "platform.db")}`),
    publicUrl,
    listen: { host: pick("VOGOBAN_HOST", ["listen", "host"], mode === "local" ? "127.0.0.1" : "0.0.0.0"), port: pick("VOGOBAN_PORT", ["listen", "port"], 8080, Number) },
    trustedProxies: pick("VOGOBAN_TRUSTED_PROXIES", ["trustedProxies"], [], list).map((p) => p.trim()).filter(Boolean),
    auth: {
      issuer: pick<string | null>("VOGOBAN_OIDC_ISSUER", ["auth", "issuer"], null),
      clientId: pick<string | null>("VOGOBAN_OIDC_CLIENT_ID", ["auth", "clientId"], null),
      clientSecretRef: pick<string | null>("VOGOBAN_OIDC_CLIENT_SECRET_REF", ["auth", "clientSecretRef"], null),
      scopes: pick("VOGOBAN_OIDC_SCOPES", ["auth", "scopes"], ["openid", "email", "profile"], list),
      audience: pick<string | null>("VOGOBAN_OIDC_AUDIENCE", ["auth", "audience"], null),
      sessionTtlHours: pick("VOGOBAN_SESSION_TTL_HOURS", ["auth", "sessionTtlHours"], 12, Number),
      secureCookies: pick("VOGOBAN_SECURE_COOKIES", ["auth", "secureCookies"], publicUrl.startsWith("https://"), bool),
      operators: pick("VOGOBAN_PLATFORM_OPERATORS", ["auth", "operators"], [] as string[], list).map((x) => x.toLowerCase()),
    },
    git: {
      allowedHosts: pick("VOGOBAN_GIT_ALLOWED_HOSTS", ["git", "allowedHosts"], ["github.com", "gitlab.com", "dev.azure.com", "bitbucket.org"], list).map((h) => h.toLowerCase()),
      allowPrivateNetworks: pick("VOGOBAN_GIT_ALLOW_PRIVATE_NETWORKS", ["git", "allowPrivateNetworks"], false, bool),
      allowFileUrls: pick("VOGOBAN_GIT_ALLOW_FILE_URLS", ["git", "allowFileUrls"], mode === "local", bool),
      timeoutSeconds: pick("VOGOBAN_GIT_TIMEOUT_SECONDS", ["git", "timeoutSeconds"], 300, Number),
      restore: pick("VOGOBAN_WORKER_DOTNET_RESTORE", ["git", "restore"], false, bool),
    },
    worker: {
      concurrency: pick("VOGOBAN_WORKER_CONCURRENCY", ["worker", "concurrency"], 2, Number),
      pollSeconds: pick("VOGOBAN_WORKER_POLL_SECONDS", ["worker", "pollSeconds"], 2, Number),
      leaseSeconds: pick("VOGOBAN_WORKER_LEASE_SECONDS", ["worker", "leaseSeconds"], 60, Number),
      analysisTimeoutMinutes: pick("VOGOBAN_ANALYSIS_TIMEOUT_MINUTES", ["worker", "analysisTimeoutMinutes"], 60, Number),
      maxAttempts: pick("VOGOBAN_JOB_MAX_ATTEMPTS", ["worker", "maxAttempts"], 3, Number),
      healthPort: pick("VOGOBAN_WORKER_HEALTH_PORT", ["worker", "healthPort"], 9464, Number),
    },
    rateLimits,
    features,
    limits: { maxBodyBytes: pick("VOGOBAN_MAX_BODY_BYTES", ["limits", "maxBodyBytes"], 1_048_576, Number), maxPageSize: 200, maxDepth: 8 },
    metricsTokenRef: pick<string | null>("VOGOBAN_METRICS_TOKEN_REF", ["metricsTokenRef"], null),
    allowInsecureHttp: mode === "local" || env.VOGOBAN_ALLOW_INSECURE_HTTP === "1",
    otel: { endpoint: pick<string | null>("OTEL_EXPORTER_OTLP_ENDPOINT", ["otel", "endpoint"], null), serviceName: pick("OTEL_SERVICE_NAME", ["otel", "serviceName"], "vogoban") },
    errors,
  };
  if (!["local", "enterprise"].includes(cfg.mode)) errors.push("mode must be local or enterprise");
  if (!/^(sqlite|postgres|postgresql):\/\//.test(cfg.databaseUrl)) errors.push("databaseUrl must start with sqlite:// or postgres://");
  if (cfg.mode === "enterprise") {
    if (!cfg.auth.issuer || !cfg.auth.clientId) errors.push("enterprise mode requires an OIDC issuer and client id (VOGOBAN_OIDC_ISSUER, VOGOBAN_OIDC_CLIENT_ID)");
    if (cfg.databaseUrl.startsWith("sqlite") && env.VOGOBAN_ALLOW_SQLITE_PLATFORM !== "1") errors.push("enterprise mode requires PostgreSQL (VOGOBAN_DATABASE_URL); set VOGOBAN_ALLOW_SQLITE_PLATFORM=1 for single-node evaluation");
    if (!cfg.publicUrl.startsWith("https://") && !cfg.allowInsecureHttp) errors.push("enterprise mode requires an https public URL (TLS terminates at the ingress/load balancer); set VOGOBAN_ALLOW_INSECURE_HTTP=1 only for local evaluation");
  }
  if (cfg.databaseUrl.includes("@") && /:\/\/[^:/]+:[^@]+@/.test(cfg.databaseUrl) && file && raw.databaseUrl) errors.push("database credentials must not be written in the configuration file; pass VOGOBAN_DATABASE_URL from a secret");
  return cfg;
}

/** Configuration as shown to administrators: no secret material, only references. */
export function describePlatformConfig(cfg: PlatformConfig) {
  return {
    mode: cfg.mode, dataDir: cfg.dataDir, database: cfg.databaseUrl.replace(/\/\/([^:@/]+)(:[^@]*)?@/, "//$1:***@"), publicUrl: cfg.publicUrl, listen: cfg.listen,
    auth: { issuer: cfg.auth.issuer, clientId: cfg.auth.clientId, clientSecretRef: cfg.auth.clientSecretRef, scopes: cfg.auth.scopes, audience: cfg.auth.audience, sessionTtlHours: cfg.auth.sessionTtlHours, secureCookies: cfg.auth.secureCookies, operators: cfg.auth.operators.length },
    git: cfg.git, worker: cfg.worker, rateLimits: cfg.rateLimits, features: cfg.features, limits: cfg.limits, otel: cfg.otel, errors: cfg.errors,
  };
}

const SECRET_REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\0]+)$/;

export const isSecretRef = (ref: string) => SECRET_REF.test(ref);

/** Resolves secret references from the process environment or mounted secret files (Kubernetes secrets, Vault agent, Docker secrets). */
export function resolveSecret(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (!isSecretRef(ref)) throw new Error("secret references must be env:NAME or file:/absolute/path");
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] || null;
  const path = ref.slice(5);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}
