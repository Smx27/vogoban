import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const PROVIDERS = ["none", "openai-compatible", "azure-openai", "anthropic"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface AiConfig {
  file: string | null;
  provider: ProviderName;
  model: string | null;
  endpoint: string | null;
  apiKeyEnv: string | null;
  apiVersion: string | null;
  temperature: number | null;
  maxOutputTokens: number;
  contextTokens: number;
  timeoutMs: number;
  retries: number;
  planner: "deterministic" | "llm";
  audit: boolean;
  aliases: Record<string, string>;
  errors: string[];
}

const DEFAULT_ENDPOINT: Partial<Record<ProviderName, string>> = { "openai-compatible": "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" };
const DEFAULT_KEY_ENV: Partial<Record<ProviderName, string>> = { "openai-compatible": "OPENAI_API_KEY", "azure-openai": "AZURE_OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const KEYS = ["provider", "model", "endpoint", "apiKeyEnv", "apiVersion", "temperature", "maxOutputTokens", "contextTokens", "timeoutMs", "retries", "planner", "audit", "aliases"];

export function loadAiConfig(path: string | null): AiConfig {
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  if (path) {
    if (!existsSync(path)) throw new Error(`AI configuration not found: ${path}`);
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    else if (parsed !== null && parsed !== undefined) errors.push("AI configuration must be a mapping");
    for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`unknown key '${k}'`);
    if ("apiKey" in raw || "key" in raw || "secret" in raw) errors.push("raw credentials are not accepted; set apiKeyEnv to the name of an environment variable");
  }
  const env = process.env;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (key: string, v: unknown, fallback: number, min: number, max: number) => {
    if (v === undefined || v === null) return fallback;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      errors.push(`${key} must be a number between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const provider = (str(env.VOGOBAN_AI_PROVIDER) ?? str(raw.provider) ?? "none") as ProviderName;
  if (!PROVIDERS.includes(provider)) errors.push(`provider must be one of ${PROVIDERS.join(", ")}`);
  const model = str(env.VOGOBAN_AI_MODEL) ?? str(raw.model);
  if (provider !== "none" && !model) errors.push("model is required when a provider is configured");
  const endpoint = str(env.VOGOBAN_AI_ENDPOINT) ?? str(raw.endpoint) ?? DEFAULT_ENDPOINT[provider] ?? null;
  if (provider === "azure-openai" && !endpoint) errors.push("endpoint is required for azure-openai (https://<resource>.openai.azure.com)");
  if (endpoint && !/^https?:\/\//.test(endpoint)) errors.push("endpoint must be an http(s) URL");
  const apiKeyEnv = str(env.VOGOBAN_AI_API_KEY_ENV) ?? str(raw.apiKeyEnv) ?? DEFAULT_KEY_ENV[provider] ?? null;
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) errors.push("apiKeyEnv must be an environment variable name, not a credential");
  const planner = str(raw.planner) ?? "deterministic";
  if (planner !== "deterministic" && planner !== "llm") errors.push("planner must be deterministic or llm");
  const aliases: Record<string, string> = {};
  if (raw.aliases !== undefined) {
    if (!raw.aliases || typeof raw.aliases !== "object" || Array.isArray(raw.aliases)) errors.push("aliases must map names to entity ids");
    else for (const [k, v] of Object.entries(raw.aliases)) typeof v === "string" ? (aliases[k] = v) : errors.push(`alias '${k}' must be an entity id string`);
  }
  return {
    file: path,
    provider: PROVIDERS.includes(provider) ? provider : "none",
    model,
    endpoint,
    apiKeyEnv,
    apiVersion: str(raw.apiVersion) ?? (provider === "azure-openai" ? "2024-10-21" : null),
    temperature: raw.temperature === undefined ? 0 : num("temperature", raw.temperature, 0, 0, 2),
    maxOutputTokens: num("maxOutputTokens", raw.maxOutputTokens, 1200, 64, 32000),
    contextTokens: num("contextTokens", raw.contextTokens, 12000, 1000, 400000),
    timeoutMs: num("timeoutMs", raw.timeoutMs, 60000, 1000, 600000),
    retries: num("retries", raw.retries, 2, 0, 5),
    planner: planner === "llm" ? "llm" : "deterministic",
    audit: raw.audit === undefined ? true : raw.audit !== false,
    aliases,
    errors,
  };
}

export type AiDestination = "none" | "local-model" | "user-configured-provider";

/**
 * Where an AI request physically goes. Loopback/`.local`/unix endpoints are a co-located model on the user's own
 * machine ("local-model"); anything else is a provider the user explicitly configured. There is no vendor default.
 */
export function aiDestination(cfg: AiConfig): { kind: AiDestination; label: string; host: string | null; external: boolean } {
  if (cfg.provider === "none" || !cfg.model) return { kind: "none", label: "no AI provider configured", host: null, external: false };
  let host: string | null = null;
  try {
    host = cfg.endpoint ? new URL(cfg.endpoint).hostname.replace(/^\[|\]$/g, "") : null;
  } catch {
    host = null;
  }
  const local = !!host && (/^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/.test(host) || host.endsWith(".local") || cfg.endpoint!.startsWith("unix:"));
  if (local) return { kind: "local-model", label: `LOCAL MODEL on this machine (${cfg.endpoint})`, host, external: false };
  return { kind: "user-configured-provider", label: `USER-CONFIGURED PROVIDER ${cfg.provider} at ${host ?? cfg.endpoint ?? "?"}`, host, external: true };
}

export function describeConfig(cfg: AiConfig) {
  return {
    file: cfg.file, provider: cfg.provider, model: cfg.model, endpoint: cfg.endpoint, apiVersion: cfg.apiVersion,
    credential: cfg.apiKeyEnv ? { env: cfg.apiKeyEnv, present: !!process.env[cfg.apiKeyEnv] } : null,
    temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens, contextTokens: cfg.contextTokens, timeoutMs: cfg.timeoutMs, retries: cfg.retries,
    planner: cfg.planner, audit: cfg.audit, aliases: Object.keys(cfg.aliases).length, errors: cfg.errors,
    destination: aiDestination(cfg),
  };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxOutputTokens?: number;
  json?: boolean;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  finishReason: string | null;
}

export type LlmErrorKind = "not-configured" | "unavailable" | "timeout" | "auth" | "rate-limited" | "invalid-response";

export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string) {
    super(message);
  }
}

export interface LlmProvider {
  readonly provider: ProviderName;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

interface HttpCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  parse(json: any): LlmResponse;
}

class HttpProvider implements LlmProvider {
  constructor(readonly provider: ProviderName, readonly model: string, private readonly cfg: AiConfig, private readonly secret: string, private readonly build: (req: LlmRequest, cfg: AiConfig, secret: string) => HttpCall) {}

  private redact(text: string): string {
    return (this.secret ? text.split(this.secret).join("[redacted]") : text).slice(0, 300);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const call = this.build(request, this.cfg, this.secret);
    if (process.env.VOGOBAN_OFFLINE === "1") {
      let host: string | null = null;
      try { host = new URL(call.url).hostname.replace(/^\[|\]$/g, ""); } catch { host = null; }
      const loopback = !!host && (/^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(host) || host.endsWith(".local"));
      if (!loopback) throw new LlmError("not-configured", `offline mode (VOGOBAN_OFFLINE=1): refusing to contact non-local AI endpoint ${host ?? call.url}`);
    }
    let last: LlmError = new LlmError("unavailable", "no attempt made");
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt) await Bun.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(call.url, { method: "POST", headers: { "content-type": "application/json", ...call.headers }, body: JSON.stringify(call.body), signal: controller.signal, redirect: "manual" });
        const text = await res.text();
        if (res.status === 401 || res.status === 403) throw new LlmError("auth", `provider rejected the credential from ${this.cfg.apiKeyEnv ?? "configuration"} (HTTP ${res.status})`);
        if (res.status === 429) {
          last = new LlmError("rate-limited", "provider rate limit (HTTP 429)");
          continue;
        }
        if (res.status >= 500) {
          last = new LlmError("unavailable", `provider error HTTP ${res.status}: ${this.redact(text)}`);
          continue;
        }
        if (!res.ok) throw new LlmError("invalid-response", `provider returned HTTP ${res.status}: ${this.redact(text)}`);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new LlmError("invalid-response", "provider response is not JSON");
        }
        const parsed = call.parse(json);
        if (!parsed.text) throw new LlmError("invalid-response", "provider returned an empty completion");
        return parsed;
      } catch (error) {
        if (error instanceof LlmError) {
          if (error.kind === "auth" || error.kind === "invalid-response") throw error;
          last = error;
        } else if (error instanceof Error && error.name === "AbortError") last = new LlmError("timeout", `provider did not answer within ${this.cfg.timeoutMs} ms`);
        else last = new LlmError("unavailable", `provider unreachable: ${this.redact(error instanceof Error ? error.message : String(error))}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }
}

const openAiCall = (azure: boolean) => (req: LlmRequest, cfg: AiConfig, secret: string): HttpCall => {
  const base = cfg.endpoint!.replace(/\/+$/, "");
  const url = azure ? `${base}/openai/deployments/${encodeURIComponent(cfg.model!)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion!)}` : `${base}/chat/completions`;
  return {
    url,
    headers: secret ? (azure ? { "api-key": secret } : { authorization: `Bearer ${secret}` }) : {},
    body: {
      ...(azure ? {} : { model: cfg.model }),
      messages: req.messages,
      max_tokens: req.maxOutputTokens ?? cfg.maxOutputTokens,
      ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    },
    parse: (json) => ({
      text: String(json?.choices?.[0]?.message?.content ?? ""),
      model: String(json?.model ?? cfg.model),
      usage: json?.usage ? { inputTokens: Number(json.usage.prompt_tokens ?? 0), outputTokens: Number(json.usage.completion_tokens ?? 0) } : null,
      finishReason: json?.choices?.[0]?.finish_reason ?? null,
    }),
  };
};

const anthropicCall = (req: LlmRequest, cfg: AiConfig, secret: string): HttpCall => ({
  url: `${cfg.endpoint!.replace(/\/+$/, "")}/v1/messages`,
  headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" },
  body: {
    model: cfg.model,
    max_tokens: req.maxOutputTokens ?? cfg.maxOutputTokens,
    ...(cfg.temperature !== null ? { temperature: Math.min(1, cfg.temperature) } : {}),
    system: req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
    messages: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
  },
  parse: (json) => ({
    text: Array.isArray(json?.content) ? json.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("") : "",
    model: String(json?.model ?? cfg.model),
    usage: json?.usage ? { inputTokens: Number(json.usage.input_tokens ?? 0), outputTokens: Number(json.usage.output_tokens ?? 0) } : null,
    finishReason: json?.stop_reason ?? null,
  }),
});

/** `secret` lets platform services pass a credential resolved from a secret reference instead of reading cfg.apiKeyEnv. */
export function createProvider(cfg: AiConfig, secretOverride?: string | null): LlmProvider {
  if (cfg.provider === "none" || !cfg.model) throw new LlmError("not-configured", "no LLM provider configured (vogoban-ai.yaml, --ai-config or VOGOBAN_AI_PROVIDER/VOGOBAN_AI_MODEL)");
  if (cfg.errors.length) throw new LlmError("not-configured", `AI configuration invalid: ${cfg.errors.join("; ")}`);
  const secret = secretOverride ?? (cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? "") : "");
  if (!secret && cfg.provider !== "openai-compatible") throw new LlmError("not-configured", secretOverride === undefined ? `credential environment variable ${cfg.apiKeyEnv} is not set` : "AI provider credential reference does not resolve to a value");
  const build = cfg.provider === "anthropic" ? anthropicCall : openAiCall(cfg.provider === "azure-openai");
  return new HttpProvider(cfg.provider, cfg.model, cfg, secret, build);
}
