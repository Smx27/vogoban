import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, auditRecord } from "../ai/assistant.ts";
import { McpServer } from "../ai/mcp.ts";
import { DEFAULT_LIMITS, LIMIT_CAPS, type ConversationTurn, type InputSchema } from "../ai/model.ts";
import { createProvider, type AiConfig } from "../ai/provider.ts";
import { runTool, TOOL_INDEX, toolCatalog } from "../ai/tools.ts";
import { AnalysisGraph } from "../analysis/graph.ts";
import { diffSnapshots } from "../analysis/diff.ts";
import { findCycleSet } from "../analysis/structure.ts";
import { loadEnterpriseConfig } from "../enterprise/config.ts";
import { loadPolicies } from "../governance/policy.ts";
import { ENTITY_KINDS, isEntityKind, isRelationshipType, type EntityKind, type RelationshipType } from "../graph/model.ts";
import { AuditLog } from "./audit.ts";
import { isOperator } from "./auth.ts";
import { describePlatformConfig, isSecretRef, resolveSecret, type PlatformConfig } from "./config.ts";
import { migrationStatus } from "./db.ts";
import { GraphUnavailable, TenantGraphs, TOOL_PERMISSION } from "./graph.ts";
import { ApiError, json, type RequestContext, type Route } from "./http.ts";
import { enqueueJob, jobDto } from "./jobs.ts";
import { detectProvider, JobFailure, PROVIDERS, repositoryIdentity, validateOutboundUrl, validateRepositoryUrl } from "./providers.ts";
import { PERMISSIONS, type AccessContext, type Permission } from "./rbac.ts";
import { EXPORT_KINDS, REPORT_KINDS, type CapturedScope } from "./reports.ts";
import { decodeCursor, encodeCursor, mergeSettings, type PlatformStore, type Repository, type Tenant } from "./store.ts";
import { metrics } from "./telemetry.ts";

export interface PlatformServices {
  cfg: PlatformConfig;
  store: PlatformStore;
  audit: AuditLog;
  graphs: TenantGraphs;
  version: string;
}

const T = "/api/v1/t/{tenant}";
const LIMIT: InputSchema = { limit: { type: "integer", min: 1, max: 200, default: 50, description: "Page size" }, cursor: { type: "string", maxLength: 400, description: "Cursor from the previous page" } };
const SECRET_REF_FIELD = { type: "string", maxLength: 300, description: "Secret reference (env:NAME or file:/path); never a secret value" } as const;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

const actor = (c: RequestContext) => ({ actorType: (c.auth?.principal.type ?? "anonymous") as "user" | "token" | "anonymous", actorId: c.auth?.principal.id ?? null });
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new ApiError(404, "NOT_FOUND", `${what} not found`);
  return v;
};
const tenantOf = (c: RequestContext) => c.tenant!;
const accessOf = (c: RequestContext) => c.access!;
const flag = (cfg: PlatformConfig, t: Tenant, f: string) => (t.settings.features[f] ?? cfg.features[f as keyof PlatformConfig["features"]]) !== false;

function requirePermission(a: AccessContext, p: Permission, repositoryId?: string) {
  if (repositoryId ? !a.canOn(p, repositoryId) : !a.can(p)) throw new ApiError(403, "FORBIDDEN", `missing permission ${p}${repositoryId ? ` on repository ${repositoryId}` : ""}`);
}

/** Repository visible for a permission, else 404 (existence of inaccessible repositories is not revealed). */
async function visibleRepository(s: PlatformServices, c: RequestContext, ref: string, p: Permission = "repos.read"): Promise<Repository> {
  const repo = await s.store.repository(tenantOf(c).id, ref);
  if (!repo || !accessOf(c).canOn(p, repo.id)) {
    if (repo && accessOf(c).canOn("repos.read", repo.id)) throw new ApiError(403, "FORBIDDEN", `missing permission ${p} on repository ${repo.name}`);
    throw new ApiError(404, "NOT_FOUND", "repository not found");
  }
  return repo;
}

const repoDto = (r: Repository) => ({ id: r.id, name: r.name, provider: r.provider, url: r.url, identity: r.identity, organization: r.organization, project: r.project, branch: r.branch, credentialRef: r.credentialRef, webhookSecretRef: r.webhookSecretRef, teamId: r.teamId, status: r.status, catalogId: r.catalogId, createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt, lastAnalyzedAt: r.lastAnalyzedAt, webhookPath: `/api/v1/hooks/${r.id}` });

function tenantDto(t: Tenant, includeSettings: boolean) {
  return { id: t.id, slug: t.slug, name: t.name, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, ...(includeSettings ? { settings: t.settings } : {}) };
}

async function captureScope(s: PlatformServices, a: AccessContext, permission: Permission, environment: string | null): Promise<CapturedScope> {
  const ga = await s.graphs.access(a, permission, { environment, intersect: permission === "graph.read" ? [] : ["graph.read"] });
  return { repositories: ga.scope.repositories, environment: ga.scope.environment, sections: ga.options.sections!, deniedTools: ga.options.deniedTools ?? [] };
}

function aiConfigFor(t: Tenant, model: string | null): AiConfig {
  const ai = t.settings.ai;
  const chosen = model ?? ai.model;
  const allowed = ai.allowedModels.length ? ai.allowedModels : ai.model ? [ai.model] : [];
  if (chosen && !allowed.includes(chosen)) throw new ApiError(403, "FORBIDDEN", `model ${chosen} is not allowed for this tenant (allowed: ${allowed.join(", ") || "none"})`);
  return {
    file: null, provider: ai.provider as AiConfig["provider"], model: chosen, endpoint: ai.endpoint ?? (ai.provider === "anthropic" ? "https://api.anthropic.com" : ai.provider === "openai-compatible" ? "https://api.openai.com/v1" : null), apiKeyEnv: null,
    apiVersion: ai.apiVersion ?? (ai.provider === "azure-openai" ? "2024-10-21" : null), temperature: 0, maxOutputTokens: Math.min(ai.maxOutputTokens, 4000), contextTokens: Math.min(ai.contextTokens, LIMIT_CAPS.maxContextTokens), timeoutMs: 60000, retries: 1,
    planner: "deterministic", audit: false, aliases: {}, errors: [],
  };
}

export function routes(s: PlatformServices): Route[] {
  const { cfg, store, audit, graphs } = s;
  const dashboardCache = new Map<string, unknown>();

  return [
    // ---------- identity / session ----------
    {
      method: "GET", path: "/api/v1/me", summary: "Current principal, tenant memberships and effective permissions", tag: "auth", auth: "authenticated",
      handler: async (c) => {
        const a = c.auth!;
        const memberships = a.user ? await store.memberships(a.user.id) : [];
        const tenants = a.tokenTenantId ? [(await store.tenant(a.tokenTenantId))!] : memberships.filter((m) => m.status === "active" && m.tenant.status === "active").map((m) => m.tenant);
        const { accessFor } = await import("./auth.ts");
        return {
          principal: { type: a.principal.type, id: a.principal.id, label: a.principal.label, operator: a.principal.operator, method: a.method },
          user: a.user ? { id: a.user.id, email: a.user.email, displayName: a.user.displayName } : null,
          tenants: await Promise.all(tenants.map(async (t) => ({ ...tenantDto(t, false), access: (await accessFor(store, a, t.id))?.summary() ?? null }))),
        };
      },
    },
    {
      method: "GET", path: "/api/v1/auth/config", summary: "Authentication mode for clients", tag: "auth", auth: "public",
      handler: async () => ({ mode: cfg.mode, oidc: !!(cfg.auth.issuer && cfg.auth.clientId), loginUrl: "/auth/login", apiTokens: true, apiVersion: "v1" }),
    },

    // ---------- tenants (platform operators) ----------
    {
      method: "GET", path: "/api/v1/tenants", summary: "Tenants visible to the caller (operators see all)", tag: "tenants", auth: "authenticated",
      handler: async (c) => {
        if (c.auth!.principal.operator) return { items: (await store.tenants()).map((t) => tenantDto(t, false)), nextCursor: null };
        const m = c.auth!.user ? await store.memberships(c.auth!.user.id) : [];
        return { items: m.filter((x) => x.status === "active").map((x) => tenantDto(x.tenant, false)), nextCursor: null };
      },
    },
    {
      method: "POST", path: "/api/v1/tenants", summary: "Create a tenant and invite its first organization admin", tag: "tenants", auth: "operator", audit: "tenant.create", rate: "default",
      body: { slug: { type: "string", required: true, maxLength: 41, description: "Stable URL identifier (lowercase, digits, dashes)" }, name: { type: "string", required: true, maxLength: 200, description: "Display name" }, adminEmail: { type: "string", required: true, maxLength: 320, description: "Email of the first Organization Admin (claimed at first OIDC login)" } },
      handler: async (c) => {
        const slug = String(c.body.slug);
        if (!SLUG.test(slug)) throw new ApiError(400, "VALIDATION_FAILED", "slug must be 2-41 lowercase letters, digits or dashes");
        if (await store.tenant(slug)) throw new ApiError(409, "CONFLICT", "tenant slug already exists");
        const t = await store.createTenant(slug, String(c.body.name));
        await store.invite(t.id, String(c.body.adminEmail), [{ roleKey: "org_admin", scopeType: "tenant", scopeId: null, environments: null }], c.auth!.principal.id);
        await audit.append({ tenantId: t.id, ...actor(c), action: "tenant.created", resourceType: "tenant", resourceId: t.id, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { slug, adminEmail: c.body.adminEmail } });
        return tenantDto(t, true);
      },
    },
    {
      method: "GET", path: "/api/v1/platform", summary: "Platform configuration (no secrets), migrations and workers", tag: "admin", auth: "operator",
      handler: async () => ({ version: s.version, config: describePlatformConfig(cfg), migrations: await migrationStatus(store.db), workers: await store.workers() }),
    },

    // ---------- tenant administration ----------
    {
      method: "GET", path: T, summary: "Tenant details; settings for tenant admins", tag: "tenants", auth: "tenant",
      handler: async (c) => tenantDto(tenantOf(c), accessOf(c).can("tenant.admin")),
    },
    {
      method: "PATCH", path: `${T}/settings`, summary: "Update feature flags, retention and environments", tag: "admin", auth: "tenant", permission: "tenant.admin", audit: "tenant.settings.update",
      body: { features: { type: "string", maxLength: 2000, description: "JSON object of feature flags (ai, mcp, integrations, security, governance, exports)" }, retention: { type: "string", maxLength: 2000, description: "JSON object: jobsDays, auditDays, aiHistoryDays, exportsDays, graphVersionsKeep, evaluationsDays (null = keep forever)" }, environments: { type: "string[]", maxItems: 30, description: "Declared environment names" }, name: { type: "string", maxLength: 200, description: "Display name" } },
      handler: async (c) => {
        const t = tenantOf(c);
        const parse = (v: unknown, what: string) => {
          if (v === undefined) return undefined;
          try {
            const o = JSON.parse(String(v));
            if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error();
            return o as Record<string, unknown>;
          } catch {
            throw new ApiError(400, "VALIDATION_FAILED", `${what} must be a JSON object`);
          }
        };
        const features = parse(c.body.features, "features");
        const retention = parse(c.body.retention, "retention");
        if (features && Object.entries(features).some(([k, v]) => !["ai", "mcp", "integrations", "security", "governance", "exports"].includes(k) || typeof v !== "boolean")) throw new ApiError(400, "VALIDATION_FAILED", "unknown feature flag or non-boolean value");
        if (retention && Object.entries(retention).some(([k, v]) => !(k in t.settings.retention) || (v !== null && (typeof v !== "number" || v < 1)))) throw new ApiError(400, "VALIDATION_FAILED", "retention values must be positive numbers or null");
        const settings = mergeSettings({ ...t.settings, features: { ...t.settings.features, ...(features ?? {}) }, retention: { ...t.settings.retention, ...(retention ?? {}) }, environments: (c.body.environments as string[] | undefined)?.map((e) => e.toLowerCase()) ?? t.settings.environments });
        const updated = await store.updateTenant(t.id, { settings, name: c.body.name as string | undefined });
        return tenantDto(updated!, true);
      },
    },
    {
      method: "PUT", path: `${T}/settings/ai`, summary: "Configure the AI provider, allowed models and budgets (credentials by reference only)", tag: "admin", auth: "tenant", permission: "tenant.admin", audit: "tenant.ai.update",
      body: {
        provider: { type: "string", required: true, enum: ["none", "openai-compatible", "azure-openai", "anthropic"], description: "LLM provider" }, model: { type: "string", maxLength: 120, description: "Default model / deployment" }, endpoint: { type: "string", maxLength: 300, description: "Provider endpoint (https; http only for local servers)" },
        apiVersion: { type: "string", maxLength: 40, description: "Azure OpenAI API version" }, apiKeySecretRef: SECRET_REF_FIELD, allowedModels: { type: "string[]", maxItems: 20, description: "Models users may select (empty = only the default)" },
        maxOutputTokens: { type: "integer", min: 64, max: 4000, description: "Output token cap per answer" }, contextTokens: { type: "integer", min: 1000, max: 200000, description: "Evidence context budget" },
        userRequestsPerDay: { type: "integer", min: 0, max: 100000, description: "Per-user daily AI requests" }, userTokensPerDay: { type: "integer", min: 0, max: 100000000, description: "Per-user daily tokens" }, teamTokensPerDay: { type: "integer", min: 0, max: 1000000000, description: "Per-team daily tokens" },
        tenantRequestsPerDay: { type: "integer", min: 0, max: 10000000, description: "Tenant daily AI requests" }, tenantTokensPerDay: { type: "integer", min: 0, max: 10000000000, description: "Tenant daily tokens" },
      },
      handler: async (c) => {
        const t = tenantOf(c);
        const b = c.body as Record<string, any>;
        if (b.apiKeySecretRef && !isSecretRef(b.apiKeySecretRef)) throw new ApiError(400, "VALIDATION_FAILED", "apiKeySecretRef must be env:NAME or file:/path (secret values are never accepted)");
        if (b.endpoint) {
          try {
            await validateOutboundUrl(b.endpoint, cfg);
          } catch (error) {
            throw new ApiError(400, "VALIDATION_FAILED", error instanceof JobFailure ? error.message : "invalid endpoint", error instanceof JobFailure ? { code: error.code } : undefined);
          }
        }
        const ai = { ...t.settings.ai, provider: b.provider, model: b.model ?? t.settings.ai.model, endpoint: b.endpoint ?? t.settings.ai.endpoint, apiVersion: b.apiVersion ?? t.settings.ai.apiVersion, apiKeySecretRef: b.apiKeySecretRef ?? t.settings.ai.apiKeySecretRef, allowedModels: b.allowedModels ?? t.settings.ai.allowedModels, maxOutputTokens: b.maxOutputTokens ?? t.settings.ai.maxOutputTokens, contextTokens: b.contextTokens ?? t.settings.ai.contextTokens, budgets: { ...t.settings.ai.budgets, ...Object.fromEntries(["userRequestsPerDay", "userTokensPerDay", "teamTokensPerDay", "tenantRequestsPerDay", "tenantTokensPerDay"].filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) } };
        const updated = await store.updateTenant(t.id, { settings: { ...t.settings, ai } });
        return { ai: updated!.settings.ai, credentialResolves: ai.apiKeySecretRef ? !!resolveSecret(ai.apiKeySecretRef) : null };
      },
    },
    {
      method: "GET", path: `${T}/members`, summary: "Members with status, teams and role bindings", tag: "admin", auth: "tenant", permission: "members.manage",
      handler: async (c) => {
        const t = tenantOf(c);
        const users = await store.tenantUsers(t.id);
        const bindings = await store.bindings(t.id, { principalType: "user" });
        return { items: users.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName, status: u.membership, lastLoginAt: u.lastLoginAt, bindings: bindings.filter((b) => b.principalId === u.id) })), nextCursor: null };
      },
    },
    {
      method: "PATCH", path: `${T}/members/{userId}`, summary: "Enable or disable a member", tag: "admin", auth: "tenant", permission: "members.manage", audit: "member.update",
      body: { status: { type: "string", required: true, enum: ["active", "disabled"], description: "Membership status" } },
      handler: async (c) => {
        need(await store.membership(tenantOf(c).id, c.params.userId!), "member");
        if (c.params.userId === c.auth!.principal.id) throw new ApiError(409, "CONFLICT", "you cannot change your own membership");
        await store.setMembership(tenantOf(c).id, c.params.userId!, c.body.status as "active" | "disabled");
        return { userId: c.params.userId, status: c.body.status };
      },
    },
    {
      method: "GET", path: `${T}/invitations`, summary: "Open and accepted invitations", tag: "admin", auth: "tenant", permission: "members.manage",
      handler: async (c) => ({ items: await store.invitations(tenantOf(c).id), nextCursor: null }),
    },
    {
      method: "POST", path: `${T}/invitations`, summary: "Invite a user by email with a role binding (claimed at first OIDC login with a verified email)", tag: "admin", auth: "tenant", permission: "members.manage", audit: "member.invite",
      body: { email: { type: "string", required: true, maxLength: 320, description: "Email" }, role: { type: "string", required: true, maxLength: 80, description: "Role key" }, scopeType: { type: "string", enum: ["tenant", "team", "repository"], default: "tenant", description: "Binding scope" }, scopeId: { type: "string", maxLength: 80, description: "Team or repository id" }, environments: { type: "string[]", maxItems: 20, description: "Restrict to environments" } },
      handler: async (c) => {
        const t = tenantOf(c);
        if (!/^[^@\s]+@[^@\s]+$/.test(String(c.body.email))) throw new ApiError(400, "VALIDATION_FAILED", "invalid email");
        need(await store.roleByKey(t.id, String(c.body.role)), "role");
        await checkScope(store, t.id, c.body.scopeType as string, c.body.scopeId as string | undefined);
        const id = await store.invite(t.id, String(c.body.email), [{ roleKey: String(c.body.role), scopeType: String(c.body.scopeType), scopeId: (c.body.scopeId as string) ?? null, environments: (c.body.environments as string[]) ?? null }], c.auth!.principal.id);
        return { id };
      },
    },
    {
      method: "GET", path: `${T}/teams`, summary: "Teams and business units (hierarchical)", tag: "admin", auth: "tenant",
      handler: async (c) => ({ items: await Promise.all((await store.teams(tenantOf(c).id)).map(async (t) => ({ ...t, members: accessOf(c).can("members.manage") ? (await store.teamMembers(t.id)).map((u) => ({ id: u.id, email: u.email })) : undefined }))), nextCursor: null }),
    },
    {
      method: "POST", path: `${T}/teams`, summary: "Create a team or business unit", tag: "admin", auth: "tenant", permission: "members.manage", audit: "team.create",
      body: { key: { type: "string", required: true, maxLength: 60, description: "Stable key (matches enterprise-metadata team ids for ownership)" }, name: { type: "string", required: true, maxLength: 200, description: "Name" }, kind: { type: "string", enum: ["team", "business_unit"], default: "team", description: "Kind" }, parentId: { type: "string", maxLength: 60, description: "Parent team/business unit" } },
      handler: async (c) => {
        const t = tenantOf(c);
        if (!SLUG.test(String(c.body.key))) throw new ApiError(400, "VALIDATION_FAILED", "key must be lowercase letters, digits or dashes");
        if (c.body.parentId) need(await store.team(t.id, String(c.body.parentId)), "parent team");
        if (await store.team(t.id, String(c.body.key))) throw new ApiError(409, "CONFLICT", "team key exists");
        return { id: await store.createTeam(t.id, String(c.body.key), String(c.body.name), c.body.kind as "team", (c.body.parentId as string) ?? null) };
      },
    },
    {
      method: "POST", path: `${T}/teams/{teamId}/members`, summary: "Add a member to a team", tag: "admin", auth: "tenant", permission: "members.manage", audit: "team.member.add",
      body: { userId: { type: "string", required: true, maxLength: 60, description: "User id" } },
      handler: async (c) => {
        const team = need(await store.team(tenantOf(c).id, c.params.teamId!), "team");
        need(await store.membership(tenantOf(c).id, String(c.body.userId)), "member");
        await store.addTeamMember(team.id, String(c.body.userId));
        return { teamId: team.id, userId: c.body.userId };
      },
    },
    {
      method: "DELETE", path: `${T}/teams/{teamId}/members/{userId}`, summary: "Remove a team member", tag: "admin", auth: "tenant", permission: "members.manage", audit: "team.member.remove",
      handler: async (c) => {
        const team = need(await store.team(tenantOf(c).id, c.params.teamId!), "team");
        return { removed: await store.removeTeamMember(team.id, c.params.userId!) };
      },
    },
    {
      method: "GET", path: `${T}/roles`, summary: "Built-in and custom roles with permissions", tag: "admin", auth: "tenant",
      handler: async (c) => ({ items: await store.roles(tenantOf(c).id), permissions: PERMISSIONS, nextCursor: null }),
    },
    {
      method: "POST", path: `${T}/roles`, summary: "Create a custom role", tag: "admin", auth: "tenant", permission: "members.manage", audit: "role.create",
      body: { key: { type: "string", required: true, maxLength: 60, description: "Role key" }, name: { type: "string", required: true, maxLength: 120, description: "Name" }, permissions: { type: "string[]", required: true, enum: PERMISSIONS, maxItems: PERMISSIONS.length, description: "Permissions" } },
      handler: async (c) => {
        if (await store.roleByKey(tenantOf(c).id, String(c.body.key))) throw new ApiError(409, "CONFLICT", "role key exists");
        return { id: await store.createRole(tenantOf(c).id, String(c.body.key), String(c.body.name), c.body.permissions as Permission[]) };
      },
    },
    {
      method: "GET", path: `${T}/role-bindings`, summary: "Role bindings (who has which role on which scope)", tag: "admin", auth: "tenant", permission: "members.manage",
      handler: async (c) => ({ items: await store.bindings(tenantOf(c).id), nextCursor: null }),
    },
    {
      method: "POST", path: `${T}/role-bindings`, summary: "Grant a role to a user, team or service token at tenant, team or repository scope", tag: "admin", auth: "tenant", permission: "members.manage", audit: "permission.grant",
      body: { principalType: { type: "string", required: true, enum: ["user", "team", "token"], description: "Principal type" }, principalId: { type: "string", required: true, maxLength: 60, description: "User, team or token id" }, role: { type: "string", required: true, maxLength: 60, description: "Role key or id" }, scopeType: { type: "string", enum: ["tenant", "team", "repository"], default: "tenant", description: "Scope" }, scopeId: { type: "string", maxLength: 60, description: "Team or repository id" }, environments: { type: "string[]", maxItems: 20, description: "Restrict to environments" } },
      handler: async (c) => {
        const t = tenantOf(c);
        const role = need(await store.roleByKey(t.id, String(c.body.role)), "role");
        const pid = String(c.body.principalId);
        if (c.body.principalType === "user") need(await store.membership(t.id, pid), "member");
        if (c.body.principalType === "team") need(await store.team(t.id, pid), "team");
        if (c.body.principalType === "token" && !(await store.tokens(t.id)).some((x) => x.id === pid && x.kind === "service")) throw new ApiError(404, "NOT_FOUND", "service token not found");
        await checkScope(store, t.id, c.body.scopeType as string, c.body.scopeId as string | undefined);
        return { id: await store.bind(t.id, c.body.principalType as "user", pid, role.id, c.body.scopeType as "tenant", (c.body.scopeId as string) ?? null, (c.body.environments as string[]) ?? null, c.auth!.principal.id) };
      },
    },
    {
      method: "DELETE", path: `${T}/role-bindings/{bindingId}`, summary: "Revoke a role binding", tag: "admin", auth: "tenant", permission: "members.manage", audit: "permission.revoke",
      handler: async (c) => ({ removed: need((await store.unbind(tenantOf(c).id, c.params.bindingId!)) || null, "role binding") }),
    },
    {
      method: "GET", path: `${T}/tokens`, summary: "API tokens (secrets are never returned after creation)", tag: "admin", auth: "tenant",
      handler: async (c) => {
        const all = await store.tokens(tenantOf(c).id);
        return { items: accessOf(c).can("members.manage") ? all : all.filter((x) => x.userId === c.auth!.user?.id && x.kind === "personal"), nextCursor: null };
      },
    },
    {
      method: "POST", path: `${T}/tokens`, summary: "Create a personal token (acts as you) or a service token for CI/MCP (needs a role binding)", tag: "admin", auth: "tenant", audit: "token.create", rate: "auth",
      body: { name: { type: "string", required: true, maxLength: 120, description: "Name" }, kind: { type: "string", enum: ["personal", "service"], default: "personal", description: "Token kind" }, expiresDays: { type: "integer", min: 1, max: 365, default: 90, description: "Lifetime in days" }, role: { type: "string", maxLength: 60, description: "Service tokens: role to bind" }, scopeType: { type: "string", enum: ["tenant", "team", "repository"], default: "tenant", description: "Service tokens: binding scope" }, scopeId: { type: "string", maxLength: 60, description: "Service tokens: scope id" } },
      handler: async (c) => {
        const t = tenantOf(c);
        if (c.auth!.method === "api-token") throw new ApiError(403, "FORBIDDEN", "tokens cannot mint tokens");
        const service = c.body.kind === "service";
        if (service) requirePermission(accessOf(c), "members.manage");
        if (!service && !c.auth!.user) throw new ApiError(403, "FORBIDDEN", "personal tokens need a user");
        const role = service ? need(await store.roleByKey(t.id, String(c.body.role ?? "")), "role") : null;
        if (service) await checkScope(store, t.id, c.body.scopeType as string, c.body.scopeId as string | undefined);
        const { id, secret } = await store.createToken(t.id, String(c.body.name), service ? "service" : "personal", service ? null : c.auth!.user!.id, c.auth!.principal.id, new Date(Date.now() + Number(c.body.expiresDays) * 86_400_000).toISOString());
        if (role) await store.bind(t.id, "token", id, role.id, c.body.scopeType as "tenant", (c.body.scopeId as string) ?? null, null, c.auth!.principal.id);
        return { id, secret, note: "store the secret now; it cannot be retrieved again" };
      },
    },
    {
      method: "DELETE", path: `${T}/tokens/{tokenId}`, summary: "Revoke an API token", tag: "admin", auth: "tenant", audit: "token.revoke",
      handler: async (c) => {
        const tok = need((await store.tokens(tenantOf(c).id)).find((x) => x.id === c.params.tokenId), "token");
        if (!(accessOf(c).can("members.manage") || (tok.userId && tok.userId === c.auth!.user?.id))) throw new ApiError(403, "FORBIDDEN", "not your token");
        return { revoked: (await store.revokeToken(tenantOf(c).id, tok.id)) > 0 };
      },
    },

    // ---------- repositories, jobs, graph versions ----------
    {
      method: "GET", path: `${T}/repositories`, summary: "Repositories the caller can read", tag: "repositories", auth: "tenant", permission: "repos.read", paginated: true,
      query: { status: { type: "string", enum: ["active", "archived"], description: "Status" }, provider: { type: "string", maxLength: 40, description: "Provider" }, team: { type: "string", maxLength: 60, description: "Owning team id" }, ...LIMIT },
      handler: async (c) => {
        const list = await store.repositories(tenantOf(c).id, { ids: accessOf(c).repositories("repos.read"), status: c.query.status as string, provider: c.query.provider as string, teamId: c.query.team as string });
        return page(list.map(repoDto), c, (r) => r.name + "|" + r.id);
      },
    },
    {
      method: "POST", path: `${T}/repositories`, summary: "Register a repository (validated URL, credential by reference) and optionally queue analysis", tag: "repositories", auth: "tenant", permission: "repos.manage", audit: "repository.register", feature: "integrations", rate: "analysis",
      body: { url: { type: "string", required: true, maxLength: 500, description: "HTTPS clone URL (file:// in local mode)" }, name: { type: "string", maxLength: 120, description: "Display name" }, branch: { type: "string", maxLength: 200, default: "main", description: "Tracked branch" }, provider: { type: "string", enum: Object.keys(PROVIDERS), description: "Provider (detected from the host when omitted)" }, organization: { type: "string", maxLength: 200, description: "Provider organization" }, project: { type: "string", maxLength: 200, description: "Provider project (Azure DevOps)" }, credentialRef: SECRET_REF_FIELD, webhookSecretRef: SECRET_REF_FIELD, teamId: { type: "string", maxLength: 60, description: "Owning platform team" }, analyze: { type: "boolean", default: true, description: "Queue analysis immediately" } },
      handler: async (c) => {
        const t = tenantOf(c);
        const b = c.body as Record<string, any>;
        for (const k of ["credentialRef", "webhookSecretRef"]) if (b[k] && !isSecretRef(b[k])) throw new ApiError(400, "VALIDATION_FAILED", `${k} must be a secret reference (env:NAME or file:/path); secret values are never stored`);
        try {
          await validateRepositoryUrl(b.url, cfg);
        } catch (error) {
          if (error instanceof JobFailure) throw new ApiError(400, "VALIDATION_FAILED", error.message, { code: error.code });
          throw error;
        }
        if (b.teamId) need(await store.team(t.id, b.teamId), "team");
        const identity = repositoryIdentity(b.url);
        if ((await store.repositories(t.id)).some((r) => r.identity === identity)) throw new ApiError(409, "CONFLICT", "repository already registered");
        const provider = b.provider ?? detectProvider(b.url);
        const repo = await store.createRepository({ tenantId: t.id, name: b.name ?? identity.split("/").pop()!, provider, url: b.url.replace(/\/+$/, ""), identity, organization: b.organization ?? null, project: b.project ?? null, branch: b.branch, credentialRef: b.credentialRef ?? null, webhookSecretRef: b.webhookSecretRef ?? null, teamId: b.teamId ?? null, createdBy: c.auth!.principal.id });
        const job = b.analyze ? (await enqueueJob(store, cfg, { tenantId: t.id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "ANALYZE_REPOSITORY", { repositoryId: repo.id, params: { ref: repo.branch, reason: "registration" }, dedupe: `analyze:${repo.id}:${repo.branch}` })).job : null;
        return { repository: repoDto(repo), job: job && jobDto(job) };
      },
    },
    {
      method: "GET", path: `${T}/repositories/{repositoryId}`, summary: "Repository details with its current graph version", tag: "repositories", auth: "tenant", permission: "repos.read",
      handler: async (c) => {
        const repo = await visibleRepository(s, c, c.params.repositoryId!);
        const current = (await store.graphVersions(tenantOf(c).id, { repositoryIds: [repo.id], status: "CURRENT", limit: 1 })).items[0] ?? null;
        return { repository: repoDto(repo), currentGraphVersion: current };
      },
    },
    {
      method: "PATCH", path: `${T}/repositories/{repositoryId}`, summary: "Change branch, credential/webhook references, owning team or lifecycle status", tag: "repositories", auth: "tenant", permission: "repos.manage", audit: "repository.update",
      body: { branch: { type: "string", maxLength: 200, description: "Tracked branch" }, credentialRef: SECRET_REF_FIELD, webhookSecretRef: SECRET_REF_FIELD, teamId: { type: "string", maxLength: 60, description: "Owning team" }, status: { type: "string", enum: ["active", "archived", "deleted"], description: "Lifecycle: archived keeps graph history readable; deleted hides the registration (graph history is kept)" } },
      handler: async (c) => {
        const repo = await visibleRepository(s, c, c.params.repositoryId!, "repos.manage");
        const b = c.body as Record<string, any>;
        for (const k of ["credentialRef", "webhookSecretRef"]) if (b[k] && !isSecretRef(b[k])) throw new ApiError(400, "VALIDATION_FAILED", `${k} must be a secret reference`);
        if (b.teamId) need(await store.team(tenantOf(c).id, b.teamId), "team");
        return repoDto((await store.updateRepository(tenantOf(c).id, repo.id, b))!);
      },
    },
    {
      method: "POST", path: `${T}/repositories/{repositoryId}/analyze`, summary: "Queue repository analysis (deduplicated by repository, commit, analyzer version and configuration)", tag: "repositories", auth: "tenant", permission: "analysis.run", audit: "analysis.request", rate: "analysis",
      body: { ref: { type: "string", maxLength: 200, description: "Branch, tag or commit (default: tracked branch)" }, force: { type: "boolean", default: false, description: "Re-analyze even if this commit is the current graph version" } },
      handler: async (c) => {
        const repo = await visibleRepository(s, c, c.params.repositoryId!, "analysis.run");
        const ref = String(c.body.ref ?? repo.branch);
        const r = await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "ANALYZE_REPOSITORY", { repositoryId: repo.id, params: { ref, force: !!c.body.force, reason: "manual" }, dedupe: `analyze:${repo.id}:${ref}` });
        return { job: jobDto(r.job), deduplicated: r.deduplicated };
      },
    },
    {
      method: "POST", path: `${T}/repositories/{repositoryId}/pull-request-checks`, summary: "CI: analyze a head commit against the current graph (architecture diff, rule changes, risk). Poll the job for outcome PASS/WARN/FAIL", tag: "ci", auth: "tenant", permission: "analysis.run", audit: "ci.check.request", rate: "analysis",
      body: { commit: { type: "string", required: true, maxLength: 200, description: "Head commit or ref" }, pullRequest: { type: "integer", min: 1, max: 100000000, description: "Pull request number" }, failOn: { type: "string", enum: ["INFO", "WARNING", "ERROR", "CRITICAL"], default: "ERROR", description: "Fail threshold for new violations" } },
      handler: async (c) => {
        const repo = await visibleRepository(s, c, c.params.repositoryId!, "analysis.run");
        const r = await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "PULL_REQUEST_ANALYSIS", { repositoryId: repo.id, params: { commit: c.body.commit, pullRequest: c.body.pullRequest ?? null, failOn: c.body.failOn }, dedupe: `pr:${repo.id}:${c.body.commit}:${c.body.failOn}` });
        return { job: jobDto(r.job), deduplicated: r.deduplicated, poll: `/api/v1/t/${tenantOf(c).slug}/jobs/${r.job.id}` };
      },
    },
    {
      method: "GET", path: `${T}/jobs`, summary: "Jobs (tenant-level jobs and jobs of readable repositories)", tag: "jobs", auth: "tenant", permission: "repos.read", paginated: true,
      query: { status: { type: "string", enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"], description: "Status" }, type: { type: "string", maxLength: 40, description: "Job type" }, repository: { type: "string", maxLength: 60, description: "Repository id" }, ...LIMIT },
      handler: async (c) => {
        const allowed = accessOf(c).repositories("repos.read");
        const ids = c.query.repository ? (allowed === null || allowed.includes(String(c.query.repository)) ? [String(c.query.repository)] : []) : allowed;
        const p = await store.jobs(tenantOf(c).id, { status: c.query.status as string, type: c.query.type as string, repositoryIds: ids, cursor: c.query.cursor as string, limit: Number(c.query.limit) });
        return { items: p.items.filter((j) => j.type !== "EXPORT" || j.createdBy === c.auth!.principal.id || accessOf(c).can("audit.read")).map(jobDto), nextCursor: p.nextCursor };
      },
    },
    {
      method: "GET", path: `${T}/jobs/{jobId}`, summary: "Job status, progress, result and failure", tag: "jobs", auth: "tenant", permission: "repos.read",
      handler: async (c) => jobDto(await visibleJob(s, c)),
    },
    {
      method: "POST", path: `${T}/jobs/{jobId}/cancel`, summary: "Cancel a queued or running job", tag: "jobs", auth: "tenant", permission: "repos.read", audit: "job.cancel",
      handler: async (c) => {
        const j = await visibleJob(s, c);
        if (!(accessOf(c).can("tenant.admin") || j.createdBy === c.auth!.principal.id || (j.repositoryId && accessOf(c).canOn("analysis.run", j.repositoryId)))) throw new ApiError(403, "FORBIDDEN", "not permitted to cancel this job");
        if (!["QUEUED", "RUNNING"].includes(j.status)) throw new ApiError(409, "CONFLICT", `job is ${j.status}`);
        return jobDto((await store.requestCancel(tenantOf(c).id, j.id))!);
      },
    },
    {
      method: "GET", path: `${T}/graph-versions`, summary: "Graph versions (commit, analyzer and configuration provenance)", tag: "graph", auth: "tenant", permission: "repos.read", paginated: true,
      query: { repository: { type: "string", maxLength: 60, description: "Repository id" }, status: { type: "string", enum: ["CURRENT", "HISTORICAL", "ARCHIVED"], description: "Status" }, ...LIMIT },
      handler: async (c) => {
        const allowed = accessOf(c).repositories("repos.read");
        const ids = c.query.repository ? (allowed === null || allowed.includes(String(c.query.repository)) ? [String(c.query.repository)] : []) : allowed;
        return store.graphVersions(tenantOf(c).id, { repositoryIds: ids, status: c.query.status as string, cursor: c.query.cursor as string, limit: Number(c.query.limit) });
      },
    },
    {
      method: "GET", path: `${T}/graph-versions/{graphVersionId}`, summary: "One graph version", tag: "graph", auth: "tenant", permission: "repos.read",
      handler: async (c) => {
        const v = need(await store.graphVersion(tenantOf(c).id, c.params.graphVersionId!), "graph version");
        if (!accessOf(c).canOn("repos.read", v.repositoryId)) throw new ApiError(404, "NOT_FOUND", "graph version not found");
        return v;
      },
    },
    {
      method: "GET", path: `${T}/graph-versions/{graphVersionId}/entities`, summary: "Entities of a historical graph version (from its stored snapshot)", tag: "graph", auth: "tenant", permission: "graph.read", paginated: true,
      query: { kind: { type: "string", enum: ENTITY_KINDS, description: "Entity kind" }, q: { type: "string", maxLength: 200, description: "Name filter" }, ...LIMIT },
      handler: async (c) => {
        const v = need(await store.graphVersion(tenantOf(c).id, c.params.graphVersionId!), "graph version");
        if (!accessOf(c).canOn("graph.read", v.repositoryId)) throw new ApiError(404, "NOT_FOUND", "graph version not found");
        if (!v.snapshotId) throw new ApiError(409, "CONFLICT", "graph version has no stored snapshot");
        const snap = graphs.store(tenantOf(c).id).getGraphSnapshot(v.snapshotId);
        if (!snap) throw new ApiError(409, "CONFLICT", "snapshot was removed by retention (graph version archived)");
        const q = (c.query.q as string | undefined)?.toLowerCase();
        const rows = snap.payload.entities.filter((e) => (!c.query.kind || e[1] === c.query.kind) && (!q || `${e[3] ?? e[2]}`.toLowerCase().includes(q))).sort((a, b) => a[0].localeCompare(b[0]));
        const after = decodeCursor(c.query.cursor as string);
        const start = after ? rows.findIndex((e) => e[0] > after) : 0;
        const slice = start < 0 ? [] : rows.slice(start, start + Number(c.query.limit));
        return { graphVersion: v.id, snapshot: v.snapshotId, commit: v.commit, total: rows.length, items: slice.map((e) => ({ id: e[0], kind: e[1], name: e[2], qualifiedName: e[3], file: e[4], line: e[9] ?? null, projectId: e[7], repositoryId: e[8] })), nextCursor: start >= 0 && start + slice.length < rows.length ? encodeCursor(slice[slice.length - 1]![0]) : null };
      },
    },

    // ---------- graph exploration ----------
    {
      method: "GET", path: `${T}/entities`, summary: "List or search entities in permitted repositories (bounded, keyset-paginated)", tag: "graph", auth: "tenant", permission: "graph.read", rate: "graph", paginated: true,
      query: { q: { type: "string", maxLength: 200, description: "Name / qualified name contains" }, kind: { type: "string[]", enum: ENTITY_KINDS, maxItems: 10, description: "Entity kinds" }, repository: { type: "string", maxLength: 60, description: "Repository id" }, ...LIMIT },
      handler: async (c) => {
        const gstore = graphs.store(tenantOf(c).id);
        const scope = await graphs.catalogScope(accessOf(c), "graph.read");
        let repoIds = scope ?? gstore.listCatalog().map((x) => x.repositoryId);
        if (c.query.repository) {
          const repo = await visibleRepository(s, c, String(c.query.repository), "graph.read");
          repoIds = repo.catalogId ? [repo.catalogId] : [];
        }
        const limit = Number(c.query.limit);
        const items = gstore.findEntities({ repositoryIds: repoIds, kinds: c.query.kind as EntityKind[] | undefined, nameLike: c.query.q as string | undefined, afterId: decodeCursor(c.query.cursor as string) ?? "", limit: limit + 1 });
        const shown = items.slice(0, limit);
        return { items: shown.map((e) => ({ id: e.id, kind: e.kind, name: e.name, qualifiedName: e.qualifiedName, repositoryId: e.repositoryId, repository: gstore.getCatalog(e.repositoryId ?? "")?.name ?? null, location: e.location ? `${e.location.file}:${e.location.startLine}` : null })), nextCursor: items.length > limit ? encodeCursor(shown[shown.length - 1]!.id) : null };
      },
    },
    {
      method: "GET", path: `${T}/entities/{entityId}`, summary: "Entity identity, metadata, temporal info and relationship counts", tag: "graph", auth: "tenant", permission: "graph.read", rate: "graph",
      handler: async (c) => toolResponse(await graphs.access(accessOf(c), "graph.read"), "get_entity", { entity: c.params.entityId, limit: 50 }),
    },
    {
      method: "GET", path: `${T}/entities/{entityId}/relationships`, summary: "Relationships of an entity (both endpoints must be visible; keyset-paginated)", tag: "graph", auth: "tenant", permission: "graph.read", rate: "graph", paginated: true,
      query: { direction: { type: "string", enum: ["out", "in"], default: "out", description: "Direction" }, type: { type: "string[]", maxItems: 10, description: "Relationship types" }, ...LIMIT },
      handler: async (c) => {
        const ga = await graphs.access(accessOf(c), "graph.read");
        const e = ga.store.getEntity(c.params.entityId!) ?? ga.store.findMetaEntities({ ids: [c.params.entityId!] })[0];
        if (!e || !ga.allowed(e.repositoryId)) throw new ApiError(404, "NOT_FOUND", "entity not found");
        const types = (c.query.type as string[] | undefined)?.map((x) => x.toUpperCase());
        if (types?.some((x) => !isRelationshipType(x))) throw new ApiError(400, "VALIDATION_FAILED", "unknown relationship type");
        const limit = Number(c.query.limit);
        const out = c.query.direction === "out";
        const rels = ga.store.findRelationships({ ...(out ? { sourceIds: [e.id] } : { targetIds: [e.id] }), types: types as RelationshipType[] | undefined, afterId: decodeCursor(c.query.cursor as string) ?? "", limit: limit + 1 });
        const others = ga.meta.entities(rels.map((r) => (out ? r.targetId : r.sourceId)));
        const visible = rels.slice(0, limit).filter((r) => ga.allowed(others.get(out ? r.targetId : r.sourceId)?.repositoryId));
        return { items: visible.map((r) => ({ id: r.id, type: r.type, direction: c.query.direction, evidence: r.evidence, confidence: r.confidence, other: others.get(out ? r.targetId : r.sourceId) ? ga.candidate(others.get(out ? r.targetId : r.sourceId)!) : null, provenance: r.provenance.slice(0, 3).map((p) => ({ plugin: p.plugin, mechanism: p.mechanism, location: p.location })), metadata: r.metadata })), nextCursor: rels.length > limit ? encodeCursor(rels[limit - 1]!.id) : null };
      },
    },
    {
      method: "GET", path: `${T}/entities/{entityId}/neighborhood`, summary: "Bounded neighborhood (depth ≤ 2, ≤ 200 nodes) for exploration", tag: "graph", auth: "tenant", permission: "graph.read", rate: "graph",
      query: { depth: { type: "integer", min: 1, max: 2, default: 1, description: "Depth" }, limit: { type: "integer", min: 1, max: 200, default: 60, description: "Max nodes" }, environment: { type: "string", maxLength: 60, description: "Environment" } },
      handler: async (c) => {
        const ga = await graphs.access(accessOf(c), "graph.read", { environment: c.query.environment as string });
        const root = ga.store.getEntity(c.params.entityId!) ?? ga.store.findMetaEntities({ ids: [c.params.entityId!] })[0];
        if (!root || !ga.allowed(root.repositoryId)) throw new ApiError(404, "NOT_FOUND", "entity not found");
        const g = ga.analysisGraph();
        const nodes = new Map([[root.id, root]]);
        const edges: { id: string; type: string; source: string; target: string; evidence: string; scope: string }[] = [];
        let frontier = [root.id];
        let truncated = false;
        for (let d = 0; d < Number(c.query.depth) && frontier.length; d++) {
          const next: string[] = [];
          const all = [...[...g.out(frontier).values()].flat(), ...[...g.in(frontier).values()].flat()];
          const ents = g.entities(all.flatMap((x) => [x.sourceId, x.targetId]));
          for (const edge of all) {
            const other = nodes.has(edge.sourceId) ? edge.targetId : edge.sourceId;
            const ent = ents.get(other);
            if (!ent || !ga.allowed(ent.repositoryId)) continue;
            if (!nodes.has(other)) {
              if (nodes.size >= Number(c.query.limit)) {
                truncated = true;
                continue;
              }
              nodes.set(other, ent);
              next.push(other);
            }
            edges.push({ id: edge.id, type: edge.type, source: edge.sourceId, target: edge.targetId, evidence: edge.evidence, scope: edge.graphScope });
          }
          frontier = next;
        }
        return { root: root.id, nodes: [...nodes.values()].map((e) => ga.candidate(e)), edges: [...new Map(edges.map((e) => [e.id, e])).values()], truncated };
      },
    },
    {
      method: "POST", path: `${T}/query/{tool}`, summary: "Run a deterministic graph tool (dependencies, dependents, paths, impact, blast radius, consumers, providers, deployments, owners, security, governance, diffs, summaries). Same tools as MCP and the CLI.", tag: "graph", auth: "tenant", permission: "graph.read", rate: "graph",
      query: { environment: { type: "string", maxLength: 60, description: "Environment view" } },
      handler: async (c) => {
        const name = c.params.tool!;
        if (!TOOL_INDEX.has(name)) throw new ApiError(404, "NOT_FOUND", `unknown tool ${name}; see GET ${T}/query`);
        const perm = TOOL_PERMISSION[name] ?? "graph.read";
        const ga = await graphs.access(accessOf(c), perm, { environment: c.query.environment as string, intersect: perm === "graph.read" ? [] : ["graph.read"] });
        const r = toolResponse(ga, name, c.body);
        if (perm === "security.read" || name === "get_owners") await audit.append({ tenantId: tenantOf(c).id, ...actor(c), action: "architecture.sensitive.read", resourceType: "tool", resourceId: name, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { input: c.body, status: (r as { status: string }).status } });
        return r;
      },
    },
    {
      method: "GET", path: `${T}/query`, summary: "Available graph tools with input schemas and required permission", tag: "graph", auth: "tenant", permission: "graph.read",
      handler: async () => ({ items: toolCatalog().map((t) => ({ ...t, permission: TOOL_PERMISSION[t.name] ?? "graph.read" })), nextCursor: null }),
    },
    {
      method: "GET", path: `${T}/search`, summary: "Unified tenant search: repositories, architecture entities (exact / canonical / scoped / alias / partial), teams, users", tag: "graph", auth: "tenant", permission: "repos.read", rate: "search",
      query: { q: { type: "string", required: true, maxLength: 200, description: "Search text" }, limit: { type: "integer", min: 1, max: 50, default: 20, description: "Max results per group" } },
      handler: async (c) => search(s, c),
    },

    // ---------- governance, security, ownership ----------
    {
      method: "GET", path: `${T}/policies`, summary: "Active architecture policy documents", tag: "governance", auth: "tenant", permission: "governance.read",
      handler: async (c) => ({ items: (await store.documents(tenantOf(c).id, "policy")).map(({ content, ...d }) => ({ ...d, bytes: content.length })), nextCursor: null }),
    },
    {
      method: "GET", path: `${T}/policies/{name}/versions`, summary: "All versions of one policy document (who changed it, when, content hash)", tag: "governance", auth: "tenant", permission: "governance.read",
      handler: async (c) => ({ items: (await store.documents(tenantOf(c).id, "policy", false)).filter((d) => d.name === c.params.name), nextCursor: null }),
    },
    {
      method: "PUT", path: `${T}/policies/{name}`, summary: "Create a new version of a policy document (validated with the governance engine)", tag: "governance", auth: "tenant", permission: "policies.manage", audit: "policy.change",
      body: { content: { type: "string", required: true, maxLength: 500_000, description: "Policy YAML" } },
      handler: async (c) => {
        const name = c.params.name!;
        if (!SLUG.test(name)) throw new ApiError(400, "VALIDATION_FAILED", "policy names are lowercase letters, digits and dashes");
        validateDocument("policy", String(c.body.content), await store.documents(tenantOf(c).id, "policy"), name);
        const r = await store.putDocument(tenantOf(c).id, "policy", name, String(c.body.content), c.auth!.principal.id);
        const job = await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "GOVERNANCE_EVALUATION", { dedupe: `gov:${tenantOf(c).id}` });
        return { name, ...r, evaluationJob: job.job.id };
      },
    },
    {
      method: "DELETE", path: `${T}/policies/{name}`, summary: "Deactivate a policy document (history is kept)", tag: "governance", auth: "tenant", permission: "policies.manage", audit: "policy.deactivate",
      handler: async (c) => ({ deactivated: (await store.deactivateDocument(tenantOf(c).id, "policy", c.params.name!)) > 0 }),
    },
    {
      method: "GET", path: `${T}/enterprise-metadata`, summary: "Active enterprise metadata (teams, ownership, classification, criticality, trust boundaries)", tag: "ownership", auth: "tenant", permission: "ownership.read",
      handler: async (c) => ({ current: (await store.documents(tenantOf(c).id, "enterprise"))[0] ?? null, versions: (await store.documents(tenantOf(c).id, "enterprise", false)).map(({ content, ...d }) => d) }),
    },
    {
      method: "PUT", path: `${T}/enterprise-metadata`, summary: "New version of enterprise metadata (ownership and security classification changes are audited)", tag: "ownership", auth: "tenant", permission: "metadata.manage", audit: "enterprise_metadata.change",
      body: { content: { type: "string", required: true, maxLength: 500_000, description: "Enterprise metadata YAML" } },
      handler: async (c) => {
        validateDocument("enterprise", String(c.body.content), [], "enterprise");
        const r = await store.putDocument(tenantOf(c).id, "enterprise", "enterprise", String(c.body.content), c.auth!.principal.id);
        const ctx = { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId };
        await enqueueJob(store, cfg, ctx, "SECURITY_ANALYSIS", { dedupe: `sec:${tenantOf(c).id}` });
        await enqueueJob(store, cfg, ctx, "GOVERNANCE_EVALUATION", { dedupe: `gov:${tenantOf(c).id}` });
        return r;
      },
    },
    {
      method: "POST", path: `${T}/governance/evaluate`, summary: "Queue a governance evaluation of the current graph", tag: "governance", auth: "tenant", permission: "governance.read", feature: "governance", rate: "analysis",
      handler: async (c) => jobDto((await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "GOVERNANCE_EVALUATION", { dedupe: `gov:${tenantOf(c).id}` })).job),
    },
    {
      method: "GET", path: `${T}/governance/evaluations`, summary: "Stored governance evaluations (violations limited to readable repositories)", tag: "governance", auth: "tenant", permission: "governance.read", feature: "governance",
      query: { severity: { type: "string", maxLength: 20, description: "Severity" }, team: { type: "string", maxLength: 60, description: "Owning team id (ownership)" }, repository: { type: "string", maxLength: 120, description: "Repository name" }, limit: { type: "integer", min: 1, max: 20, default: 5, description: "Evaluations" } },
      handler: async (c) => {
        const names = await permittedRepoNames(s, c, "governance.read");
        return { items: (await store.evaluations(tenantOf(c).id, "governance", Number(c.query.limit))).map((e) => ({ ...e, summary: { ...e.summary, violations: (e.summary.violations ?? []).filter((v: any) => v.repositories.every((r: string) => names === null || names.includes(r)) && (!c.query.severity || v.severity === String(c.query.severity).toUpperCase()) && (!c.query.team || v.owners.includes(c.query.team)) && (!c.query.repository || v.repositories.includes(c.query.repository))) } })), nextCursor: null };
      },
    },
    {
      method: "POST", path: `${T}/security/analyze`, summary: "Queue security and ownership analysis", tag: "security", auth: "tenant", permission: "security.read", feature: "security", rate: "analysis",
      handler: async (c) => jobDto((await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "SECURITY_ANALYSIS", { dedupe: `sec:${tenantOf(c).id}` })).job),
    },
    {
      method: "GET", path: `${T}/security/evaluations`, summary: "Latest security posture and findings (readable repositories only; secret values are never collected)", tag: "security", auth: "tenant", permission: "security.read", feature: "security",
      handler: async (c) => {
        const names = await permittedRepoNames(s, c, "security.read");
        const latest = (await store.evaluations(tenantOf(c).id, "security", 1))[0];
        if (!latest) return { evaluation: null };
        const { ownership, teams, ...rest } = latest.summary;
        return { evaluation: { ...latest, summary: { ...rest, posture: names === null ? rest.posture : null, findings: (rest.findings ?? []).filter((f: any) => names === null || (f.repository && names.includes(f.repository))) } } };
      },
    },
    {
      method: "GET", path: `${T}/ownership`, summary: "Ownership overview: states, unowned components, conflicts, teams", tag: "ownership", auth: "tenant", permission: "ownership.read",
      handler: async (c) => {
        const names = await permittedRepoNames(s, c, "ownership.read");
        const latest = (await store.evaluations(tenantOf(c).id, "security", 1))[0];
        if (!latest) return { evaluation: null };
        const o = latest.summary.ownership ?? {};
        const ok = (comp: any) => names === null || (comp?.repository && names.includes(comp.repository));
        const unowned = (o.unowned ?? []).filter((u: any) => ok(u.component));
        return { evaluation: { id: latest.id, createdAt: latest.createdAt, snapshots: latest.snapshots, byState: names === null ? o.byState : null, unownedTotal: unowned.length, unowned: unowned.slice(0, 500), conflicts: (o.conflicts ?? []).filter((x: any) => ok(x.component)), teams: names === null ? latest.summary.teams : null } };
      },
    },
    {
      method: "GET", path: `${T}/dashboard`, summary: "Engineering overview and explainable architecture-health factors from real graph and platform data", tag: "dashboard", auth: "tenant", permission: "repos.read",
      handler: async (c) => dashboard(s, c, dashboardCache),
    },

    // ---------- AI and MCP ----------
    {
      method: "POST", path: `${T}/ai/ask`, summary: "Ask an architecture question; answered from permitted graph evidence (deterministic when possible), with budgets enforced", tag: "ai", auth: "tenant", permission: "ai.use", feature: "ai", rate: "ai",
      body: { question: { type: "string", required: true, maxLength: 2000, description: "Question" }, environment: { type: "string", maxLength: 60, description: "Environment view" }, model: { type: "string", maxLength: 120, description: "Model (must be allowed)" }, conversation: { type: "string", maxLength: 20000, description: "JSON array of previous turns {question, focus:[{id,kind,name}]} (ids are re-authorized)" }, repositories: { type: "string[]", maxItems: 20, description: "Narrow the question to these repository ids" }, llm: { type: "string", enum: ["auto", "off", "required"], default: "auto", description: "LLM usage" } },
      handler: async (c) => aiAsk(s, c),
    },
    {
      method: "GET", path: `${T}/ai/queries`, summary: "AI answer history with provenance (own; audit.read sees all)", tag: "ai", auth: "tenant", permission: "ai.use", paginated: true, query: LIMIT,
      handler: async (c) => store.aiQueries(tenantOf(c).id, { userId: accessOf(c).can("audit.read") ? undefined : c.auth!.principal.id, cursor: c.query.cursor as string, limit: Number(c.query.limit) }),
    },
    {
      method: "GET", path: `${T}/ai/usage`, summary: "Today's AI usage against budgets", tag: "ai", auth: "tenant", permission: "ai.use",
      handler: async (c) => {
        const t = tenantOf(c);
        const day = new Date().toISOString().slice(0, 10);
        const teams = c.auth!.user ? await store.userTeams(t.id, c.auth!.user.id) : [];
        return { day, budgets: t.settings.ai.budgets, usage: await store.aiUsage(t.id, day, [{ type: "user", id: c.auth!.principal.id }, ...teams.map((id) => ({ type: "team", id })), { type: "tenant", id: t.id }]) };
      },
    },
    {
      method: "GET", path: `${T}/mcp`, summary: "MCP connection details (Streamable HTTP; bearer token or OIDC token)", tag: "mcp", auth: "tenant", permission: "mcp.use", feature: "mcp",
      handler: async (c) => ({ endpoint: `${cfg.publicUrl}/api/v1/t/${tenantOf(c).slug}/mcp`, transport: "streamable-http (JSON responses)", auth: "Authorization: Bearer <platform API token or OIDC access token>", readOnly: true, tools: toolCatalog().map((t) => t.name) }),
    },
    {
      method: "POST", path: `${T}/mcp`, summary: "MCP JSON-RPC endpoint (read-only tools, resources and prompts; caller permissions apply)", tag: "mcp", auth: "tenant", permission: "mcp.use", feature: "mcp", rate: "mcp",
      handler: async (c) => mcp(s, c),
    },

    // ---------- exports ----------
    {
      method: "POST", path: `${T}/exports`, summary: "Queue an export or report (runs in a worker with your permissions at request time)", tag: "exports", auth: "tenant", permission: "exports.create", feature: "exports", rate: "exports", audit: "export.request",
      body: { kind: { type: "string", required: true, enum: EXPORT_KINDS, description: "Export kind" }, format: { type: "string", enum: ["json", "jsonl", "csv", "markdown"], default: "json", description: "Format (markdown for reports)" }, report: { type: "string", enum: REPORT_KINDS, description: "Report kind (kind=report)" }, repository: { type: "string", maxLength: 60, description: "Repository id" }, entity: { type: "string", maxLength: 400, description: "Entity reference" }, from: { type: "string", maxLength: 80, description: "Diff: from snapshot" }, to: { type: "string", maxLength: 80, description: "Diff: to snapshot" }, environment: { type: "string", maxLength: 60, description: "Environment" } },
      handler: async (c) => {
        const b = c.body as Record<string, any>;
        const a = accessOf(c);
        if (b.kind === "report" && !b.report) throw new ApiError(400, "VALIDATION_FAILED", "report kind required");
        const needs: Permission = b.kind === "security" || b.report === "security" ? "security.read" : b.kind === "governance" || b.report === "governance" ? "governance.read" : b.kind === "ownership" || b.report === "ownership" ? "ownership.read" : b.kind === "impact" || b.report === "impact" ? "impact.run" : "graph.read";
        requirePermission(a, needs);
        let catalog: string | null = null;
        if (b.repository) {
          const repo = await visibleRepository(s, c, b.repository, "graph.read");
          catalog = repo.catalogId;
          if (!catalog) throw new ApiError(409, "GRAPH_NOT_ANALYZED", "repository has not been analyzed");
        }
        const scope = await captureScope(s, a, needs, b.environment ?? null);
        const r = await enqueueJob(store, cfg, { tenantId: tenantOf(c).id, createdBy: c.auth!.principal.id, correlationId: c.correlationId }, "EXPORT", { params: { kind: b.kind, format: b.format, report: b.report ?? null, repository: catalog, entity: b.entity ?? null, from: b.from ?? null, to: b.to ?? null, scope }, dedupe: null });
        return jobDto(r.job);
      },
    },
    {
      method: "GET", path: `${T}/exports`, summary: "Your exports (audit.read: all)", tag: "exports", auth: "tenant", permission: "exports.create", paginated: true, query: LIMIT,
      handler: async (c) => {
        const p = await store.jobs(tenantOf(c).id, { type: "EXPORT", cursor: c.query.cursor as string, limit: Number(c.query.limit) });
        return { items: p.items.filter((j) => j.createdBy === c.auth!.principal.id || accessOf(c).can("audit.read")).map(jobDto), nextCursor: p.nextCursor };
      },
    },
    {
      method: "GET", path: `${T}/exports/{jobId}/download`, summary: "Download a completed export (only its requester or audit readers)", tag: "exports", auth: "tenant", permission: "exports.create", audit: "export.download",
      handler: async (c) => {
        const j = need(await store.job(tenantOf(c).id, c.params.jobId!), "export");
        if (j.type !== "EXPORT" || !(j.createdBy === c.auth!.principal.id || accessOf(c).can("audit.read"))) throw new ApiError(404, "NOT_FOUND", "export not found");
        if (j.status !== "COMPLETED" || !j.result?.file) throw new ApiError(409, "CONFLICT", `export is ${j.status}`);
        const path = join(graphs.tenantDir(tenantOf(c).id), "exports", j.id, String(j.result.file).replace(/[\\/]/g, ""));
        if (!existsSync(path)) throw new ApiError(404, "NOT_FOUND", "export file was removed by retention");
        return new Response(Bun.file(path), { headers: { "content-type": String(j.result.contentType ?? "application/octet-stream"), "content-disposition": `attachment; filename="${String(j.result.file).replace(/[^\w.-]/g, "_")}"` } });
      },
    },

    // ---------- audit ----------
    {
      method: "GET", path: `${T}/audit`, summary: "Append-only audit log", tag: "audit", auth: "tenant", permission: "audit.read", paginated: true,
      query: { action: { type: "string", maxLength: 80, description: "Action prefix" }, actor: { type: "string", maxLength: 80, description: "Actor id" }, resourceType: { type: "string", maxLength: 40, description: "Resource type" }, resourceId: { type: "string", maxLength: 120, description: "Resource id" }, outcome: { type: "string", enum: ["success", "denied", "failure"], description: "Outcome" }, from: { type: "string", maxLength: 40, description: "From (ISO time)" }, to: { type: "string", maxLength: 40, description: "To (ISO time)" }, ...LIMIT },
      handler: async (c) => audit.list(tenantOf(c).id, { action: c.query.action as string, actorId: c.query.actor as string, resourceType: c.query.resourceType as string, resourceId: c.query.resourceId as string, outcome: c.query.outcome as string, from: c.query.from as string, to: c.query.to as string, cursor: c.query.cursor as string, limit: Number(c.query.limit) }),
    },
    {
      method: "GET", path: `${T}/audit/verify`, summary: "Verify the audit hash chain", tag: "audit", auth: "tenant", permission: "audit.read",
      handler: async (c) => audit.verify(tenantOf(c).id),
    },
  ];
}

async function checkScope(store: PlatformStore, tenantId: string, scopeType: string | undefined, scopeId: string | undefined) {
  if (!scopeType || scopeType === "tenant") return;
  if (!scopeId) throw new ApiError(400, "VALIDATION_FAILED", `${scopeType} scope needs scopeId`);
  if (scopeType === "team") need(await store.team(tenantId, scopeId), "team");
  if (scopeType === "repository") need(await store.repository(tenantId, scopeId), "repository");
}

function page<T>(list: T[], c: RequestContext, key: (t: T) => string) {
  const after = decodeCursor(c.query.cursor as string);
  const limit = Number(c.query.limit);
  const rest = after ? list.filter((x) => key(x) > after) : list;
  const items = rest.slice(0, limit);
  return { items, nextCursor: rest.length > limit ? encodeCursor(key(items[items.length - 1]!)) : null };
}

async function visibleJob(s: PlatformServices, c: RequestContext) {
  const j = need(await s.store.job(tenantOf(c).id, c.params.jobId!), "job");
  const a = accessOf(c);
  if (j.repositoryId && !a.canOn("repos.read", j.repositoryId)) throw new ApiError(404, "NOT_FOUND", "job not found");
  if (j.type === "EXPORT" && j.createdBy !== c.auth!.principal.id && !a.can("audit.read")) throw new ApiError(404, "NOT_FOUND", "job not found");
  return j;
}

async function permittedRepoNames(s: PlatformServices, c: RequestContext, p: Permission): Promise<string[] | null> {
  const ids = accessOf(c).repositories(p);
  if (ids === null) return null;
  const repos = await s.store.repositories(tenantOf(c).id, { ids });
  const catalog = s.graphs.store(tenantOf(c).id);
  return repos.map((r) => (r.catalogId ? (catalog.getCatalog(r.catalogId)?.name ?? null) : null)).filter((n): n is string => !!n);
}

function toolResponse(ga: Awaited<ReturnType<TenantGraphs["access"]>>, name: string, input: unknown) {
  const r = runTool(ga, name, input);
  if (r.status === "ERROR" && r.error?.startsWith("invalid input")) throw new ApiError(400, "VALIDATION_FAILED", r.error);
  if (r.status === "OUT_OF_SCOPE") throw new ApiError(403, "FORBIDDEN", r.error ?? r.summary.join(" "));
  if (r.status === "NOT_FOUND" && name === "get_entity") throw new ApiError(404, "NOT_FOUND", r.summary.join(" "));
  if (r.status === "ERROR") throw new ApiError(500, "INTERNAL", "graph tool failed");
  return { ...r, evidence: r.evidence.map(({ key, ...e }) => e) };
}

function validateDocument(kind: "policy" | "enterprise", content: string, existing: { name: string; content: string }[], name: string) {
  const dir = mkdtempSync(join(tmpdir(), "vogoban-validate-"));
  try {
    if (kind === "policy") {
      for (const p of existing.filter((x) => x.name !== name)) writeFileSync(join(dir, `${p.name}.yaml`), p.content);
      writeFileSync(join(dir, `${name}.yaml`), content);
      const set = loadPolicies([dir]);
      if (/\binclude\s*:/.test(content) && /(\.\.|^\/|\s\/)/m.test(content.match(/include\s*:[^\n]*(\n\s+-[^\n]*)*/)?.[0] ?? "")) throw new ApiError(400, "VALIDATION_FAILED", "policy includes must reference documents of this tenant by relative name");
      if (set.errors.length) throw new ApiError(400, "VALIDATION_FAILED", `policy validation failed: ${set.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: set.errors.map((e) => ({ path: e.path, message: e.message })) });
    } else {
      writeFileSync(join(dir, "enterprise.yaml"), content);
      const cfg = loadEnterpriseConfig(join(dir, "enterprise.yaml"));
      if (cfg.errors.length) throw new ApiError(400, "VALIDATION_FAILED", `enterprise metadata validation failed: ${cfg.errors.slice(0, 5).map((e) => `${e.path} ${e.message}`).join("; ")}`, { errors: cfg.errors });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "VALIDATION_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function search(s: PlatformServices, c: RequestContext) {
  const q = String(c.query.q).trim();
  const limit = Number(c.query.limit);
  const a = accessOf(c);
  const t = tenantOf(c);
  const lc = q.toLowerCase();
  const repos = (await s.store.repositories(t.id, { ids: a.repositories("repos.read") })).filter((r) => r.name.toLowerCase().includes(lc) || r.identity.includes(lc)).slice(0, limit).map((r) => ({ match: r.name.toLowerCase() === lc ? "exact" : "partial", repository: repoDto(r) }));
  const teams = (await s.store.teams(t.id)).filter((x) => x.key.includes(lc) || x.name.toLowerCase().includes(lc)).slice(0, limit).map((x) => ({ match: x.key === lc || x.name.toLowerCase() === lc ? "exact" : "partial", team: x }));
  const users = a.can("members.manage") ? (await s.store.tenantUsers(t.id)).filter((u) => (u.email ?? "").includes(lc) || (u.displayName ?? "").toLowerCase().includes(lc)).slice(0, limit).map((u) => ({ id: u.id, email: u.email, displayName: u.displayName })) : [];
  let entities: unknown[] = [];
  let resolution: unknown = null;
  if (a.can("graph.read")) {
    try {
      const ga = await s.graphs.access(a, "graph.read");
      const r = ga.resolve(q);
      resolution = r.status === "RESOLVED" ? { status: "RESOLVED", match: /alias/.test(r.method) ? "alias" : /symbol|qualified|id|repository|route/.test(r.method) ? "canonical" : "exact", method: r.method, entity: ga.candidate(r.entity) } : r.status === "AMBIGUOUS" ? { status: "AMBIGUOUS", method: r.method, candidates: r.candidates.map((x) => ga.candidate(x)) } : { status: r.status };
      entities = ga.search(q, undefined, limit).map((e) => {
        const exact = e.name === q || e.qualifiedName === q;
        return { match: exact ? "exact" : e.name.toLowerCase() === lc ? "scoped" : "partial", entity: ga.candidate(e) };
      });
    } catch (error) {
      if (!(error instanceof GraphUnavailable)) throw error;
    }
  }
  return { query: q, resolution, entities, repositories: repos, teams, users, note: "partial matches are candidates only; architecture tools resolve names exactly and report ambiguity" };
}

async function aiAsk(s: PlatformServices, c: RequestContext) {
  const t = tenantOf(c);
  const a = accessOf(c);
  const b = c.body as Record<string, any>;
  const day = new Date().toISOString().slice(0, 10);
  const teams = c.auth!.user ? await s.store.userTeams(t.id, c.auth!.user.id) : [];
  const subjects = [{ type: "user", id: c.auth!.principal.id }, ...teams.map((id) => ({ type: "team", id })), { type: "tenant", id: t.id }];
  const usage = await s.store.aiUsage(t.id, day, subjects);
  const bud = t.settings.ai.budgets;
  const over = [
    usage[`user:${c.auth!.principal.id}`]!.requests >= bud.userRequestsPerDay ? "user daily requests" : null,
    usage[`user:${c.auth!.principal.id}`]!.tokens >= bud.userTokensPerDay ? "user daily tokens" : null,
    teams.some((id) => usage[`team:${id}`]!.tokens >= bud.teamTokensPerDay) ? "team daily tokens" : null,
    usage[`tenant:${t.id}`]!.requests >= bud.tenantRequestsPerDay ? "tenant daily requests" : null,
    usage[`tenant:${t.id}`]!.tokens >= bud.tenantTokensPerDay ? "tenant daily tokens" : null,
  ].filter(Boolean);
  const reject = async (exceeded: unknown[]) => {
    await s.audit.append({ tenantId: t.id, ...actor(c), action: "ai.query", resourceType: "ai", outcome: "denied", correlationId: c.correlationId, ip: c.ip, metadata: { reason: "budget", exceeded } });
    throw new ApiError(429, "RATE_LIMITED", `AI budget exhausted: ${exceeded.join(", ")}`, { budget: exceeded, retryAfterSeconds: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - Date.now()) / 1000) });
  };
  if (over.length) await reject(over);
  let conversation: ConversationTurn[] = [];
  if (b.conversation) {
    try {
      conversation = (JSON.parse(b.conversation) as ConversationTurn[]).slice(-10).map((x) => ({ at: String(x.at ?? ""), question: String(x.question ?? "").slice(0, 2000), intent: String(x.intent ?? ""), focus: Array.isArray(x.focus) ? x.focus.slice(0, 5).map((f) => ({ id: String(f.id), kind: String(f.kind), name: String(f.name) })) : [] }));
    } catch {
      throw new ApiError(400, "VALIDATION_FAILED", "conversation must be a JSON array");
    }
  }
  let restrictTo: string[] | undefined;
  if (Array.isArray(b.repositories) && b.repositories.length) {
    const repos = await s.store.repositories(t.id, { ids: b.repositories });
    restrictTo = repos.filter((r) => a.canOn("ai.use", r.id) && r.catalogId).map((r) => r.catalogId!);
  }
  const ga = await s.graphs.access(a, "ai.use", { environment: b.environment ?? null, intersect: ["graph.read"], limits: { maxContextTokens: t.settings.ai.contextTokens }, restrictTo });
  const aiCfg = aiConfigFor(t, b.model ?? null);
  let provider = null;
  try {
    if (aiCfg.endpoint && aiCfg.provider !== "none") await validateOutboundUrl(aiCfg.endpoint, s.cfg);
    provider = aiCfg.provider !== "none" && aiCfg.model ? createProvider(aiCfg, aiCfg.provider === "openai-compatible" && !t.settings.ai.apiKeySecretRef ? "" : resolveSecret(t.settings.ai.apiKeySecretRef)) : null;
  } catch {
    provider = null;
  }
  const reserved = await s.store.addAiUsage(t.id, day, subjects, 1, 0);
  const overReserved = [
    reserved[`user:${c.auth!.principal.id}`]!.requests > bud.userRequestsPerDay ? "user daily requests" : null,
    reserved[`tenant:${t.id}`]!.requests > bud.tenantRequestsPerDay ? "tenant daily requests" : null,
  ].filter(Boolean);
  if (overReserved.length) {
    await s.store.addAiUsage(t.id, day, subjects, -1, 0);
    await reject(overReserved);
  }
  const started = performance.now();
  const answer = await ask(ga, { question: String(b.question), scope: ga.scope, limits: ga.limits, conversation, llm: b.llm ?? "auto", llmPlanning: false }, { config: aiCfg, provider, auditPath: null });
  const latency = performance.now() - started;
  const llm = answer.provenance.llm;
  const tokens = (llm?.usage?.inputTokens ?? 0) + (llm?.usage?.outputTokens ?? 0);
  await s.store.addAiUsage(t.id, day, subjects, 0, tokens);
  const record = auditRecord(answer);
  const queryId = await s.store.saveAiQuery({ tenantId: t.id, userId: c.auth!.principal.id, question: answer.question, status: answer.status, mode: answer.mode, provider: llm?.provider ?? null, model: llm?.responseModel ?? llm?.model ?? null, tokensIn: llm?.usage?.inputTokens ?? 0, tokensOut: llm?.usage?.outputTokens ?? 0, latencyMs: Math.round(latency), record });
  await s.audit.append({ tenantId: t.id, ...actor(c), action: "ai.query", resourceType: "ai_query", resourceId: queryId, outcome: "success", correlationId: c.correlationId, ip: c.ip, metadata: { status: answer.status, mode: answer.mode, provider: llm?.provider ?? null, model: llm?.responseModel ?? llm?.model ?? null, tools: answer.tools.map((x) => x.tool), evidence: answer.evidence.length, tokens } });
  metrics.aiRequests.inc({ tenant: t.slug, mode: answer.mode, status: answer.status });
  if (llm) {
    metrics.aiTokens.inc({ tenant: t.slug, provider: llm.provider, model: llm.model, direction: "input" }, llm.usage?.inputTokens ?? 0);
    metrics.aiTokens.inc({ tenant: t.slug, provider: llm.provider, model: llm.model, direction: "output" }, llm.usage?.outputTokens ?? 0);
  }
  metrics.aiLatency.observe({ mode: answer.mode }, latency / 1000);
  const { results, ...rest } = answer;
  return { queryId, ...rest, evidence: rest.evidence.map(({ key, ...e }) => e), focus: answer.plan.mentions.filter((m) => m.status === "RESOLVED" && m.entity).map((m) => ({ id: m.entity!.id, kind: m.entity!.kind, name: m.entity!.name })) };
}

async function mcp(s: PlatformServices, c: RequestContext) {
  const t = tenantOf(c);
  const body = c.body as { id?: unknown; method?: string; params?: Record<string, any> };
  if (!body || typeof body.method !== "string") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
  const ga = await s.graphs.access(accessOf(c), "mcp.use", { intersect: ["graph.read"] });
  const server = new McpServer(() => ga, s.version);
  const notification = body.id === undefined || body.id === null;
  let result: unknown;
  let error: { code: number; message: string } | null = null;
  try {
    result = await server.handle({ jsonrpc: "2.0", id: body.id as string, method: body.method, params: body.params });
  } catch (e) {
    error = { code: (e as { code?: number }).code ?? -32603, message: e instanceof Error ? e.message : String(e) };
  }
  metrics.mcpCalls.inc({ method: body.method, outcome: error ? "error" : "ok" });
  if (body.method === "tools/call" || body.method === "resources/read") {
    const status = (result as { structuredContent?: { status?: string } })?.structuredContent?.status ?? (error ? "error" : "ok");
    await s.audit.append({ tenantId: t.id, ...actor(c), action: `mcp.${body.method.replace("/", ".")}`, resourceType: body.method === "tools/call" ? "tool" : "resource", resourceId: String(body.params?.name ?? body.params?.uri ?? ""), outcome: error ? "failure" : "success", correlationId: c.correlationId, ip: c.ip, metadata: { status, arguments: body.params?.arguments ?? null } });
  }
  if (notification) return new Response(null, { status: 202 });
  return json(error ? { jsonrpc: "2.0", id: body.id, error } : { jsonrpc: "2.0", id: body.id, result }, 200, { "mcp-protocol-version": "2025-06-18" });
}

async function dashboard(s: PlatformServices, c: RequestContext, cache: Map<string, unknown>) {
  const t = tenantOf(c);
  const a = accessOf(c);
  const counts = await s.store.counts(t.id);
  const repos = await s.store.repositories(t.id, { ids: a.repositories("repos.read") });
  let gstore: ReturnType<TenantGraphs["store"]> | null = null;
  try {
    gstore = s.graphs.store(t.id);
  } catch (error) {
    if (!(error instanceof GraphUnavailable)) throw error;
  }
  const readable = new Set(a.repositories("graph.read") ?? repos.map((r) => r.id));
  const analyzed = repos.filter((r) => r.catalogId && readable.has(r.id));
  const versionKey = `${t.id}|${analyzed.map((r) => `${r.id}@${gstore?.getCatalog(r.catalogId!)?.graphVersion ?? ""}`).join(",")}`;
  let structure = cache.get(versionKey) as Record<string, any> | undefined;
  if (!structure && gstore) {
    const kinds: Record<string, number> = {};
    const perRepo: Record<string, unknown>[] = [];
    let cycles = 0;
    let breaking = 0;
    let changes = 0;
    const recent: unknown[] = [];
    for (const r of analyzed) {
      const stats = gstore.stats(r.catalogId!).entitiesByKind;
      for (const k of ["Application", "Api", "ApiOperation", "Message", "Project", "Deployment", "ExternalSystem"]) kinds[k] = (kinds[k] ?? 0) + (stats[k] ?? 0);
      const g = new AnalysisGraph(gstore, { scope: "repository", repositoryId: r.catalogId! });
      const repoCycles = findCycleSet(g, "project", r.catalogId!).length;
      cycles += repoCycles;
      const snaps = gstore.listGraphSnapshots({ scope: "repository", repositoryId: r.catalogId! });
      let repoBreaking = 0;
      if (snaps.length >= 2) {
        const d = diffSnapshots(gstore, snaps[snaps.length - 2]!.id, snaps[snaps.length - 1]!.id);
        repoBreaking = d.architecture.filter((x) => x.breakingPotential).length;
        breaking += repoBreaking;
        changes += d.architecture.length;
        recent.push(...d.architecture.filter((x) => x.breakingPotential).slice(0, 5).map((x) => ({ repository: r.name, kind: x.kind, description: x.description, from: d.old.commit, to: d.new.commit })));
      }
      const catalog = gstore.getCatalog(r.catalogId!);
      perRepo.push({ repository: r.name, id: r.id, commit: catalog?.analyzedCommit ?? null, analyzedAt: catalog?.analyzedAt ?? null, ageHours: catalog?.analyzedAt ? Math.round((Date.now() - Date.parse(catalog.analyzedAt)) / 3_600_000) : null, projectCycles: repoCycles, breakingChangesSinceLastSnapshot: repoBreaking });
    }
    structure = { kinds, cycles, breaking, changes, recent: recent.slice(0, 15), perRepo };
    cache.set(versionKey, structure);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
  }
  const gov = a.can("governance.read") ? (await s.store.evaluations(t.id, "governance", 1))[0] : undefined;
  const sec = (await s.store.evaluations(t.id, "security", 1))[0];
  const govNames = a.can("governance.read") ? await permittedRepoNames(s, c, "governance.read").catch(() => []) : [];
  const secNames = a.can("security.read") ? await permittedRepoNames(s, c, "security.read").catch(() => []) : [];
  const ownNames = a.can("ownership.read") ? await permittedRepoNames(s, c, "ownership.read").catch(() => []) : [];
  const violations = gov ? (gov.summary.violations ?? []).filter((v: any) => v.status === "VIOLATION" && v.repositories.every((r: string) => govNames === null || govNames!.includes(r))) : [];
  const findings = sec && a.can("security.read") ? (sec.summary.findings ?? []).filter((f: any) => secNames === null || (f.repository && secNames!.includes(f.repository))) : [];
  const unowned = sec && a.can("ownership.read") ? (sec.summary.ownership?.unowned ?? []).filter((u: any) => ownNames === null || (u.component?.repository && ownNames!.includes(u.component.repository))) : [];
  const count = (list: any[], f: (x: any) => string) => list.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  return {
    tenant: tenantDto(t, false),
    platform: { repositories: repos.length, analyzedRepositories: analyzed.length, queuedJobs: counts.queuedJobs, runningJobs: counts.runningJobs, failedJobs24h: counts.failedJobs24h, users: counts.users, teams: counts.teams },
    architecture: structure ? { services: structure.kinds.Application ?? 0, apis: structure.kinds.Api ?? 0, apiOperations: structure.kinds.ApiOperation ?? 0, messages: structure.kinds.Message ?? 0, projects: structure.kinds.Project ?? 0, deployments: structure.kinds.Deployment ?? 0, recentBreakingChanges: structure.recent } : null,
    health: {
      note: "Factors are reported separately with their evidence source; no combined score is computed.",
      governance: gov ? { source: `evaluation ${gov.id} at ${gov.createdAt}`, outcome: govNames === null ? gov.summary.outcome : null, violations: violations.length, bySeverity: count(violations, (v) => v.severity) } : a.can("governance.read") ? { source: null, note: "no governance evaluation yet (configure policies)" } : null,
      security: a.can("security.read") ? (sec ? { source: `evaluation ${sec.id} at ${sec.createdAt}`, findings: findings.length, bySeverity: count(findings, (f) => f.severity), publicEndpointsWithoutObservedAuth: findings.filter((f: any) => f.category === "PUBLIC_ENDPOINT_WITHOUT_OBSERVED_AUTH").length } : { source: null }) : null,
      ownership: a.can("ownership.read") ? (sec ? { source: `evaluation ${sec.id}`, unownedComponents: unowned.length, conflicts: (sec.summary.ownership?.conflicts ?? []).filter((x: any) => ownNames === null || ownNames!.includes(x.component?.repository)).length } : { source: null }) : null,
      structuralRisk: structure ? { source: "project dependency cycles in current graphs", projectCycles: structure.cycles } : null,
      drift: structure ? { source: "architecture diff between each repository's two latest snapshots", architectureChanges: structure.changes, potentiallyBreaking: structure.breaking } : null,
      freshness: structure ? { source: "catalog analysis timestamps", repositories: structure.perRepo } : null,
    },
  };
}
