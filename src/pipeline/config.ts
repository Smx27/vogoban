import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TransportReference {
  broker: string;
  kind: "topic" | "queue" | "exchange" | "stream";
  name: string;
}

export interface MessagingAbstraction {
  name: string;
  dispatch: "in-process" | "external";
  transport?: TransportReference;
  publishers?: { type: string; methods: string[]; messageArgument?: number }[];
  handlers?: { interface: string }[];
  subscriptions?: { methods: string[]; messageTypeArgument: number; handlerTypeArgument: number }[];
}

export interface InfrastructureConfig {
  pipelines: string[];
  environments: Record<string, string[]>;
  helmValues: string[];
}

export interface FrontendConfig {
  /** Globs of build output / vendored paths that should be analyzed anyway. */
  include: string[];
  /** Globs of TS/JS paths that must never be analyzed. */
  exclude: string[];
}

export interface VogobanConfig {
  repository: { id: string | null; name: string | null };
  openapi: string[];
  messaging: MessagingAbstraction[];
  infrastructure: InfrastructureConfig;
  frontend: FrontendConfig;
  errors: string[];
}

export const CONFIG_FILE = "vogoban.json";

export function loadConfig(root: string): VogobanConfig {
  const config: VogobanConfig = { repository: { id: null, name: null }, openapi: [], messaging: [], infrastructure: { pipelines: [], environments: {}, helmValues: [] }, frontend: { include: [], exclude: [] }, errors: [] };
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return config;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VogobanConfig>;
    if (Array.isArray(raw.openapi)) config.openapi = raw.openapi.filter((p): p is string => typeof p === "string").map((p) => p.replace(/^\.\//, ""));
    if (Array.isArray(raw.messaging)) {
      for (const m of raw.messaging) {
        if (!m || typeof m.name !== "string") {
          config.errors.push("messaging entries require a name");
          continue;
        }
        config.messaging.push({ ...m, dispatch: m.dispatch === "in-process" ? "in-process" : "external" });
      }
    }
    const repository = (raw as { repository?: { id?: unknown; name?: unknown } }).repository;
    if (repository && typeof repository === "object") {
      config.repository.id = typeof repository.id === "string" && repository.id.trim() ? repository.id.trim() : null;
      config.repository.name = typeof repository.name === "string" && repository.name.trim() ? repository.name.trim() : null;
    }
    const infra = (raw as { infrastructure?: Partial<Record<keyof InfrastructureConfig, unknown>> }).infrastructure;
    if (infra && typeof infra === "object") {
      const paths = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").map((p) => p.replace(/^\.\//, "")) : []);
      config.infrastructure.pipelines = paths(infra.pipelines);
      config.infrastructure.helmValues = paths(infra.helmValues);
      if (infra.environments && typeof infra.environments === "object") {
        for (const [name, globs] of Object.entries(infra.environments as Record<string, unknown>)) config.infrastructure.environments[name] = paths(globs);
      }
    }
    const frontend = (raw as { frontend?: { include?: unknown; exclude?: unknown } }).frontend;
    if (frontend && typeof frontend === "object") {
      const globs = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && !p.split("/").includes("node_modules") && !p.startsWith("/") && !p.split("/").includes("..")).map((p) => p.replace(/^\.\//, "")) : []);
      config.frontend.include = globs(frontend.include);
      config.frontend.exclude = globs(frontend.exclude);
    }
  } catch (error) {
    config.errors.push(`invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return config;
}
