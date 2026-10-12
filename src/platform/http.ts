import { jsonSchema, validateInput, type InputSchema } from "../ai/model.ts";
import type { AccessContext, Permission } from "./rbac.ts";
import type { Authenticated } from "./auth.ts";
import type { RateLimitRule } from "./config.ts";
import type { Tenant } from "./store.ts";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export const ERROR_CODES: Record<string, { status: number; description: string }> = {
  UNAUTHENTICATED: { status: 401, description: "No valid session, OIDC bearer token or API token" },
  INVALID_TOKEN: { status: 401, description: "Bearer token rejected" },
  FORBIDDEN: { status: 403, description: "Authenticated but not permitted (tenant membership, role, repository or environment scope)" },
  NOT_FOUND: { status: 404, description: "Resource does not exist in this tenant (or is not visible to the caller)" },
  VALIDATION_FAILED: { status: 400, description: "Request parameters or body failed schema validation" },
  CONFLICT: { status: 409, description: "Resource already exists or state does not allow the operation" },
  PAYLOAD_TOO_LARGE: { status: 413, description: "Request body exceeds the configured limit" },
  RATE_LIMITED: { status: 429, description: "Rate limit or AI budget exceeded; retry after the indicated delay" },
  FEATURE_DISABLED: { status: 403, description: "Feature disabled for this tenant or platform" },
  GRAPH_NOT_ANALYZED: { status: 409, description: "The tenant has no analyzed graph yet" },
  GRAPH_SCHEMA_INCOMPATIBLE: { status: 409, description: "Stored graph was produced by an incompatible engine schema" },
  DEPENDENCY_UNAVAILABLE: { status: 503, description: "A required dependency (database, identity provider) is unavailable" },
  INTERNAL: { status: 500, description: "Unexpected error; report the correlation id" },
};

export interface RequestContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  correlationId: string;
  ip: string | null;
  auth: Authenticated | null;
  tenant: Tenant | null;
  access: AccessContext | null;
}

export type Handler = (ctx: RequestContext) => Promise<Response | unknown>;

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  tag: string;
  auth: "public" | "authenticated" | "tenant" | "operator";
  permission?: Permission;
  feature?: string;
  rate?: string;
  query?: InputSchema;
  body?: InputSchema;
  paginated?: boolean;
  audit?: string;
  handler: Handler;
}

export function compile(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\w+)\\?\}/g, "(?<$1>[^/]+)").replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`);
}

export function validate(schema: InputSchema | undefined, input: unknown, where: string): Record<string, unknown> {
  if (!schema) return {};
  const { value, errors } = validateInput(schema, input);
  if (errors.length) throw new ApiError(400, "VALIDATION_FAILED", `invalid ${where}: ${errors.join("; ")}`, { errors });
  return value;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export function errorResponse(e: ApiError, correlationId: string): Response {
  return json({ error: { code: e.code, message: e.message, correlationId, ...(e.details ? { details: e.details } : {}) } }, e.status, e.code === "RATE_LIMITED" && e.details?.retryAfterSeconds ? { "retry-after": String(e.details.retryAfterSeconds) } : {});
}

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
};

/** Token buckets per key (tenant/principal/category); per-process, so limits apply per API replica. AI budgets are durable and global. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  take(key: string, rule: RateLimitRule): { ok: boolean; retryAfterSeconds: number } {
    const nowMs = Date.now();
    const b = this.buckets.get(key) ?? { tokens: rule.capacity, at: nowMs };
    b.tokens = Math.min(rule.capacity, b.tokens + ((nowMs - b.at) / 60_000) * rule.refillPerMinute);
    b.at = nowMs;
    if (this.buckets.size > 50_000) this.buckets.clear();
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return { ok: false, retryAfterSeconds: Math.ceil(((1 - b.tokens) / rule.refillPerMinute) * 60) };
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return { ok: true, retryAfterSeconds: 0 };
  }
}

const PAGINATION_PARAMS = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }, description: "Page size (bounded)" },
  { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque cursor from the previous page's nextCursor" },
];

/** OpenAPI 3.1 document generated from the same route table and input schemas the server validates with. */
export function openApi(routes: Route[], version: string, publicUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    if (!r.path.startsWith("/api/")) continue;
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const query = r.query ? Object.entries(jsonSchema(r.query).properties).map(([name, schema]) => ({ name, in: "query", required: !!r.query![name]!.required, schema })) : [];
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      operationId: `${r.method.toLowerCase()}${r.path.replace(/\{(\w+)\}/g, "By_$1").replace(/[^A-Za-z0-9]+(\w)/g, (_m, c: string) => c.toUpperCase())}`,
      parameters: [...params, ...query, ...(r.paginated ? PAGINATION_PARAMS : [])],
      security: r.auth === "public" ? [] : [{ bearer: [] }, { session: [] }],
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(r.body) } } } } : {}),
      responses: {
        "200": { description: r.paginated ? "Page of results ({ items, nextCursor })" : "Success", content: { "application/json": { schema: r.paginated ? { $ref: "#/components/schemas/Page" } : { type: "object" } } } },
        ...(r.auth === "public" ? {} : { "401": { $ref: "#/components/responses/Error" }, "403": { $ref: "#/components/responses/Error" } }),
        "400": { $ref: "#/components/responses/Error" },
        "429": { $ref: "#/components/responses/Error" },
      },
      "x-vogoban-authorization": r.auth === "tenant" ? { tenantMembership: true, permission: r.permission ?? null, feature: r.feature ?? null } : r.auth,
    };
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Vogoban Platform API", version, description: "Multi-tenant architecture intelligence API. Tenant routes live under /api/v1/t/{tenant}. All list endpoints are bounded and cursor-paginated; graph traversals are depth- and node-limited. Errors use { error: { code, message, correlationId, details } }." },
    servers: [{ url: publicUrl }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "OIDC access/ID token from the configured identity provider, or a platform API token (vgb_…)" },
        session: { type: "apiKey", in: "cookie", name: "vogoban_session", description: "Web session established through /auth/login (OIDC authorization code + PKCE)" },
      },
      schemas: {
        Page: { type: "object", properties: { items: { type: "array", items: { type: "object" } }, nextCursor: { type: ["string", "null"] } }, required: ["items", "nextCursor"] },
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string", enum: Object.keys(ERROR_CODES) }, message: { type: "string" }, correlationId: { type: "string" }, details: { type: "object" } }, required: ["code", "message", "correlationId"] } } },
      },
      responses: { Error: { description: Object.entries(ERROR_CODES).map(([k, v]) => `${k} (${v.status}): ${v.description}`).join("; "), content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
    },
  };
}
