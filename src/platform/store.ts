import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db, Param, Row } from "./db.ts";
import { BUILTIN_ROLES, PERMISSIONS, type Binding, type Permission } from "./rbac.ts";

export const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export interface TenantSettings {
  features: Partial<Record<string, boolean>>;
  retention: { jobsDays: number | null; auditDays: number | null; aiHistoryDays: number | null; exportsDays: number | null; graphVersionsKeep: number | null; evaluationsDays: number | null };
  ai: {
    provider: string;
    model: string | null;
    endpoint: string | null;
    apiVersion: string | null;
    apiKeySecretRef: string | null;
    allowedModels: string[];
    maxOutputTokens: number;
    contextTokens: number;
    budgets: { userRequestsPerDay: number; userTokensPerDay: number; teamTokensPerDay: number; tenantRequestsPerDay: number; tenantTokensPerDay: number };
  };
  environments: string[];
}

export const DEFAULT_SETTINGS: TenantSettings = {
  features: {},
  retention: { jobsDays: null, auditDays: null, aiHistoryDays: null, exportsDays: null, graphVersionsKeep: null, evaluationsDays: null },
  ai: {
    provider: "none", model: null, endpoint: null, apiVersion: null, apiKeySecretRef: null, allowedModels: [], maxOutputTokens: 1200, contextTokens: 12000,
    budgets: { userRequestsPerDay: 50, userTokensPerDay: 200_000, teamTokensPerDay: 1_000_000, tenantRequestsPerDay: 1000, tenantTokensPerDay: 5_000_000 },
  },
  environments: [],
};

export function mergeSettings(raw: unknown): TenantSettings {
  const s = (raw ?? {}) as Partial<TenantSettings>;
  return {
    features: { ...DEFAULT_SETTINGS.features, ...(s.features ?? {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(s.retention ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}), budgets: { ...DEFAULT_SETTINGS.ai.budgets, ...(s.ai?.budgets ?? {}) } },
    environments: s.environments ?? [],
  };
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "archived";
  settings: TenantSettings;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string | null;
  displayName: string | null;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Repository {
  id: string;
  tenantId: string;
  name: string;
  provider: string;
  url: string;
  identity: string;
  organization: string | null;
  project: string | null;
  branch: string;
  credentialRef: string | null;
  webhookSecretRef: string | null;
  teamId: string | null;
  status: "active" | "archived" | "deleted";
  catalogId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastAnalyzedAt: string | null;
}

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export const JOB_TYPES = ["ANALYZE_REPOSITORY", "METAGRAPH_BUILD", "GOVERNANCE_EVALUATION", "SECURITY_ANALYSIS", "PULL_REQUEST_ANALYSIS", "EXPORT", "RETENTION"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface Job {
  id: string;
  tenantId: string;
  type: JobType;
  status: JobStatus;
  repositoryId: string | null;
  dedupeKey: string | null;
  params: Record<string, any>;
  result: Record<string, any> | null;
  errorCode: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
  progress: number | null;
  progressMessage: string | null;
  priority: number;
  exclusive: boolean;
  runAfter: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequested: boolean;
  createdBy: string | null;
  correlationId: string | null;
  traceparent: string | null;
  worker: Record<string, any> | null;
  graphVersionId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GraphVersion {
  id: string;
  tenantId: string;
  repositoryId: string;
  catalogRepositoryId: string;
  graphVersion: string;
  snapshotId: string | null;
  commit: string | null;
  branch: string | null;
  analyzerVersion: string;
  schemaVersion: number;
  configFingerprint: string;
  config: Record<string, unknown>;
  pluginVersions: Record<string, string>;
  dedupeKey: string;
  jobId: string | null;
  correlationId: string | null;
  status: "CURRENT" | "HISTORICAL" | "ARCHIVED";
  entities: number;
  relationships: number;
  createdAt: string;
}

const tenant = (r: Row): Tenant => ({ id: r.id, slug: r.slug, name: r.name, status: r.status, settings: mergeSettings(parse(r.settings, {})), createdAt: r.created_at, updatedAt: r.updated_at });
const user = (r: Row): User => ({ id: r.id, issuer: r.issuer, subject: r.subject, email: r.email, displayName: r.display_name, status: r.status, createdAt: r.created_at, lastLoginAt: r.last_login_at });
const repository = (r: Row): Repository => ({
  id: r.id, tenantId: r.tenant_id, name: r.name, provider: r.provider, url: r.url, identity: r.identity, organization: r.organization, project: r.project, branch: r.branch,
  credentialRef: r.credential_ref, webhookSecretRef: r.webhook_secret_ref, teamId: r.team_id, status: r.status, catalogId: r.catalog_id, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, lastAnalyzedAt: r.last_analyzed_at,
});
const job = (r: Row): Job => ({
  id: r.id, tenantId: r.tenant_id, type: r.type, status: r.status, repositoryId: r.repository_id, dedupeKey: r.dedupe_key, params: parse(r.params, {}), result: parse(r.result, null),
  errorCode: r.error_code, errorClass: r.error_class, errorMessage: r.error_message, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), progress: r.progress === null ? null : Number(r.progress),
  progressMessage: r.progress_message, priority: Number(r.priority), exclusive: Number(r.exclusive) === 1, runAfter: r.run_after, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at,
  cancelRequested: Number(r.cancel_requested) === 1, createdBy: r.created_by, correlationId: r.correlation_id, traceparent: r.traceparent, worker: parse(r.worker, null), graphVersionId: r.graph_version_id,
  createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
});
const graphVersion = (r: Row): GraphVersion => ({
  id: r.id, tenantId: r.tenant_id, repositoryId: r.repository_id, catalogRepositoryId: r.catalog_repository_id, graphVersion: r.graph_version, snapshotId: r.snapshot_id, commit: r.commit_sha, branch: r.branch,
  analyzerVersion: r.analyzer_version, schemaVersion: Number(r.schema_version), configFingerprint: r.config_fingerprint, config: parse(r.config, {}), pluginVersions: parse(r.plugin_versions, {}), dedupeKey: r.dedupe_key,
  jobId: r.job_id, correlationId: r.correlation_id, status: r.status, entities: Number(r.entities), relationships: Number(r.relationships), createdAt: r.created_at,
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset pagination: cursor is the opaque last sort key of the previous page. */
export const encodeCursor = (v: string) => Buffer.from(v).toString("base64url");
export const decodeCursor = (c: string | null | undefined) => (c ? Buffer.from(c, "base64url").toString() : null);

export class PlatformStore {
  constructor(readonly db: Db) {}

  async seedRoles() {
    for (const r of BUILTIN_ROLES) {
      const existing = await this.db.get("SELECT id FROM roles WHERE tenant_id IS NULL AND key = ?", [r.key]);
      if (existing) await this.db.run("UPDATE roles SET name = ?, permissions = ? WHERE id = ?", [r.name, json(r.permissions), existing.id]);
      else await this.db.run("INSERT INTO roles (id, tenant_id, key, name, permissions, builtin, created_at) VALUES (?, NULL, ?, ?, ?, 1, ?)", [newId("role"), r.key, r.name, json(r.permissions), now()]);
    }
  }

  // tenants
  async createTenant(slug: string, name: string): Promise<Tenant> {
    const t = { id: newId("ten"), slug, name, status: "active", settings: json({}), at: now() };
    await this.db.run("INSERT INTO tenants (id, slug, name, status, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [t.id, slug, name, t.status, t.settings, t.at, t.at]);
    return (await this.tenant(t.id))!;
  }
  async tenant(idOrSlug: string): Promise<Tenant | null> {
    const r = await this.db.get("SELECT * FROM tenants WHERE id = ? OR slug = ?", [idOrSlug, idOrSlug]);
    return r ? tenant(r) : null;
  }
  async tenants(): Promise<Tenant[]> {
    return (await this.db.all("SELECT * FROM tenants ORDER BY slug")).map(tenant);
  }
  async updateTenant(id: string, patch: { name?: string; status?: string; settings?: TenantSettings }) {
    const t = await this.tenant(id);
    if (!t) return null;
    await this.db.run("UPDATE tenants SET name = ?, status = ?, settings = ?, updated_at = ? WHERE id = ?", [patch.name ?? t.name, patch.status ?? t.status, json(patch.settings ?? t.settings), now(), id]);
    return this.tenant(id);
  }

  // users
  async userByIdentity(issuer: string, subject: string) {
    const r = await this.db.get("SELECT * FROM users WHERE issuer = ? AND subject = ?", [issuer, subject]);
    return r ? user(r) : null;
  }
  async user(id: string) {
    const r = await this.db.get("SELECT * FROM users WHERE id = ?", [id]);
    return r ? user(r) : null;
  }
  async upsertLogin(issuer: string, subject: string, email: string | null, displayName: string | null): Promise<User> {
    const existing = await this.userByIdentity(issuer, subject);
    if (existing) {
      await this.db.run("UPDATE users SET email = ?, display_name = ?, last_login_at = ? WHERE id = ?", [email, displayName, now(), existing.id]);
      return (await this.user(existing.id))!;
    }
    const id = newId("usr");
    await this.db.run("INSERT INTO users (id, issuer, subject, email, display_name, status, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)", [id, issuer, subject, email, displayName, now(), now()]);
    return (await this.user(id))!;
  }
  async tenantUsers(tenantId: string) {
    return (await this.db.all("SELECT u.*, m.status AS membership_status FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = ? ORDER BY u.email, u.id", [tenantId])).map((r) => ({ ...user(r), membership: r.membership_status as string }));
  }
  async memberships(userId: string) {
    return (await this.db.all("SELECT t.*, m.status AS membership_status FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.slug", [userId])).map((r) => ({ tenant: tenant(r), status: r.membership_status as string }));
  }
  async membership(tenantId: string, userId: string) {
    return (await this.db.get<{ status: string }>("SELECT status FROM memberships WHERE tenant_id = ? AND user_id = ?", [tenantId, userId]))?.status ?? null;
  }
  async setMembership(tenantId: string, userId: string, status: "active" | "disabled") {
    const exists = await this.membership(tenantId, userId);
    if (exists) await this.db.run("UPDATE memberships SET status = ? WHERE tenant_id = ? AND user_id = ?", [status, tenantId, userId]);
    else await this.db.run("INSERT INTO memberships (tenant_id, user_id, status, created_at) VALUES (?, ?, ?, ?)", [tenantId, userId, status, now()]);
  }
  async invite(tenantId: string, email: string, roles: { roleKey: string; scopeType: string; scopeId: string | null; environments: string[] | null }[], by: string | null) {
    const id = newId("inv");
    await this.db.run("INSERT INTO invitations (id, tenant_id, email, roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, tenantId, email.toLowerCase(), json(roles), by, now()]);
    return id;
  }
  async invitations(tenantId: string) {
    return (await this.db.all("SELECT * FROM invitations WHERE tenant_id = ? ORDER BY created_at DESC", [tenantId])).map((r) => ({ id: r.id, email: r.email, roles: parse(r.roles, []), createdBy: r.created_by, createdAt: r.created_at, acceptedAt: r.accepted_at }));
  }
  /** On login a verified email claims every open invitation addressed to it: membership plus the invited role bindings. */
  async acceptInvitations(user: User): Promise<string[]> {
    if (!user.email) return [];
    const open = await this.db.all("SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL", [user.email.toLowerCase()]);
    for (const inv of open) {
      await this.db.tx(async (tx) => {
        const s = new PlatformStore(tx);
        await s.setMembership(inv.tenant_id, user.id, "active");
        for (const r of parse<{ roleKey: string; scopeType: string; scopeId: string | null; environments: string[] | null }[]>(inv.roles, [])) {
          const role = await s.roleByKey(inv.tenant_id, r.roleKey);
          if (role) await s.bind(inv.tenant_id, "user", user.id, role.id, r.scopeType as Binding["scopeType"], r.scopeId, r.environments, inv.created_by);
        }
        await tx.run("UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now(), user.id, inv.id]);
      });
    }
    return open.map((i) => i.tenant_id);
  }

  // teams
  async createTeam(tenantId: string, key: string, name: string, kind: "team" | "business_unit", parentId: string | null) {
    const id = newId("team");
    await this.db.run("INSERT INTO teams (id, tenant_id, key, name, kind, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)", [id, tenantId, key, name, kind, parentId, now()]);
    return id;
  }
  async teams(tenantId: string) {
    return (await this.db.all("SELECT * FROM teams WHERE tenant_id = ? ORDER BY key", [tenantId])).map((r) => ({ id: r.id as string, key: r.key as string, name: r.name as string, kind: r.kind as string, parentId: r.parent_id as string | null, status: r.status as string, createdAt: r.created_at as string }));
  }
  async team(tenantId: string, id: string) {
    return (await this.teams(tenantId)).find((t) => t.id === id || t.key === id) ?? null;
  }
  async teamMembers(teamId: string) {
    return (await this.db.all("SELECT u.* FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY u.email", [teamId])).map(user);
  }
  async userTeams(tenantId: string, userId: string): Promise<string[]> {
    return (await this.db.all<{ team_id: string }>("SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.tenant_id = ? AND tm.user_id = ?", [tenantId, userId])).map((r) => r.team_id);
  }
  async addTeamMember(teamId: string, userId: string) {
    await this.db.run("INSERT INTO team_members (team_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [teamId, userId, now()]);
  }
  async removeTeamMember(teamId: string, userId: string) {
    return this.db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
  }

  // roles and bindings
  async roles(tenantId: string) {
    return (await this.db.all("SELECT * FROM roles WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY builtin DESC, key", [tenantId])).map((r) => ({ id: r.id as string, key: r.key as string, name: r.name as string, permissions: parse<Permission[]>(r.permissions, []), builtin: Number(r.builtin) === 1 }));
  }
  async roleByKey(tenantId: string, key: string) {
    return (await this.roles(tenantId)).find((r) => r.key === key || r.id === key) ?? null;
  }
  async createRole(tenantId: string, key: string, name: string, permissions: Permission[]) {
    const bad = permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (bad.length) throw new Error(`unknown permissions: ${bad.join(", ")}`);
    const id = newId("role");
    await this.db.run("INSERT INTO roles (id, tenant_id, key, name, permissions, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)", [id, tenantId, key, name, json(permissions), now()]);
    return id;
  }
  async bind(tenantId: string, principalType: "user" | "team" | "token", principalId: string, roleId: string, scopeType: Binding["scopeType"], scopeId: string | null, environments: string[] | null, by: string | null) {
    const id = newId("rb");
    await this.db.run("INSERT INTO role_bindings (id, tenant_id, principal_type, principal_id, role_id, scope_type, scope_id, environments, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, tenantId, principalType, principalId, roleId, scopeType, scopeId, environments?.length ? json(environments) : null, by, now()]);
    return id;
  }
  async unbind(tenantId: string, bindingId: string) {
    return this.db.run("DELETE FROM role_bindings WHERE tenant_id = ? AND id = ?", [tenantId, bindingId]);
  }
  async bindings(tenantId: string, filter: { principalType?: string; principalIds?: string[] } = {}) {
    const params: Param[] = [tenantId];
    let where = "rb.tenant_id = ?";
    if (filter.principalType) {
      where += " AND rb.principal_type = ?";
      params.push(filter.principalType);
    }
    if (filter.principalIds) {
      if (!filter.principalIds.length) return [];
      where += ` AND rb.principal_id IN (${filter.principalIds.map(() => "?").join(",")})`;
      params.push(...filter.principalIds);
    }
    return (await this.db.all(`SELECT rb.*, r.key AS role_key, r.permissions FROM role_bindings rb JOIN roles r ON r.id = rb.role_id WHERE ${where} ORDER BY rb.created_at`, params)).map((r) => ({
      id: r.id as string, principalType: r.principal_type as string, principalId: r.principal_id as string, roleId: r.role_id as string, roleKey: r.role_key as string,
      permissions: parse<Permission[]>(r.permissions, []), scopeType: r.scope_type as Binding["scopeType"], scopeId: r.scope_id as string | null, environments: parse<string[] | null>(r.environments, null), createdBy: r.created_by as string | null, createdAt: r.created_at as string,
    }));
  }

  // api tokens
  async createToken(tenantId: string, name: string, kind: "personal" | "service", userId: string | null, by: string | null, expiresAt: string | null) {
    const secret = `vgb_${randomToken(30)}`;
    const id = newId("tok");
    await this.db.run("INSERT INTO api_tokens (id, tenant_id, name, kind, user_id, token_hash, prefix, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, tenantId, name, kind, userId, sha256(secret), secret.slice(0, 10), by, now(), expiresAt]);
    return { id, secret };
  }
  async tokenBySecret(secret: string) {
    const r = await this.db.get("SELECT * FROM api_tokens WHERE token_hash = ?", [sha256(secret)]);
    if (!r || r.revoked_at || (r.expires_at && r.expires_at < now())) return null;
    await this.db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [now(), r.id]);
    return { id: r.id as string, tenantId: r.tenant_id as string, name: r.name as string, kind: r.kind as string, userId: r.user_id as string | null };
  }
  async tokens(tenantId: string) {
    return (await this.db.all("SELECT id, name, kind, user_id, prefix, created_by, created_at, expires_at, last_used_at, revoked_at FROM api_tokens WHERE tenant_id = ? ORDER BY created_at DESC", [tenantId])).map((r) => ({ id: r.id, name: r.name, kind: r.kind, userId: r.user_id, prefix: r.prefix, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
  }
  async revokeToken(tenantId: string, id: string) {
    return this.db.run("UPDATE api_tokens SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL", [now(), tenantId, id]);
  }

  // sessions and OIDC login state
  async createSession(userId: string, ttlHours: number, ip: string | null, userAgent: string | null) {
    const secret = randomToken(32);
    await this.db.run("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)", [sha256(secret), userId, now(), new Date(Date.now() + ttlHours * 3600_000).toISOString(), ip, userAgent?.slice(0, 200) ?? null]);
    return secret;
  }
  async session(secret: string) {
    const r = await this.db.get("SELECT * FROM sessions WHERE id_hash = ?", [sha256(secret)]);
    return r && !r.revoked_at && r.expires_at > now() ? { userId: r.user_id as string, expiresAt: r.expires_at as string } : null;
  }
  async revokeSession(secret: string) {
    await this.db.run("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?", [now(), sha256(secret)]);
  }
  async saveOidcState(state: string, verifier: string, nonce: string, returnTo: string | null) {
    await this.db.run("DELETE FROM oidc_states WHERE created_at < ?", [new Date(Date.now() - 600_000).toISOString()]);
    await this.db.run("INSERT INTO oidc_states (state, verifier, nonce, return_to, created_at) VALUES (?, ?, ?, ?, ?)", [state, verifier, nonce, returnTo, now()]);
  }
  async takeOidcState(state: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.get("SELECT * FROM oidc_states WHERE state = ?", [state]);
      if (!r) return null;
      await tx.run("DELETE FROM oidc_states WHERE state = ?", [state]);
      return r.created_at < new Date(Date.now() - 600_000).toISOString() ? null : { verifier: r.verifier as string, nonce: r.nonce as string, returnTo: r.return_to as string | null };
    });
  }

  // repositories
  async createRepository(r: Omit<Repository, "id" | "createdAt" | "updatedAt" | "lastAnalyzedAt" | "catalogId" | "status">) {
    const id = newId("repo");
    await this.db.run(
      "INSERT INTO repositories (id, tenant_id, name, provider, url, identity, organization, project, branch, credential_ref, webhook_secret_ref, team_id, status, catalog_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)",
      [id, r.tenantId, r.name, r.provider, r.url, r.identity, r.organization, r.project, r.branch, r.credentialRef, r.webhookSecretRef, r.teamId, r.createdBy, now(), now()],
    );
    return (await this.repository(r.tenantId, id))!;
  }
  async repository(tenantId: string, id: string) {
    const r = await this.db.get("SELECT * FROM repositories WHERE tenant_id = ? AND (id = ? OR name = ?) AND status != 'deleted' ORDER BY created_at LIMIT 1", [tenantId, id, id]);
    return r ? repository(r) : null;
  }
  async repositoryById(id: string) {
    const r = await this.db.get("SELECT * FROM repositories WHERE id = ?", [id]);
    return r ? repository(r) : null;
  }
  async repositories(tenantId: string, filter: { status?: string; ids?: string[] | null; provider?: string; teamId?: string } = {}) {
    if (filter.ids && !filter.ids.length) return [];
    const params: Param[] = [tenantId];
    let where = "tenant_id = ? AND status != 'deleted'";
    if (filter.status) (where += " AND status = ?"), params.push(filter.status);
    if (filter.provider) (where += " AND provider = ?"), params.push(filter.provider);
    if (filter.teamId) (where += " AND team_id = ?"), params.push(filter.teamId);
    if (filter.ids) (where += ` AND id IN (${filter.ids.map(() => "?").join(",")})`), params.push(...filter.ids);
    return (await this.db.all(`SELECT * FROM repositories WHERE ${where} ORDER BY name, id`, params)).map(repository);
  }
  async updateRepository(tenantId: string, id: string, patch: Partial<Pick<Repository, "branch" | "credentialRef" | "webhookSecretRef" | "teamId" | "status" | "catalogId" | "lastAnalyzedAt" | "name">>) {
    const r = await this.repository(tenantId, id);
    if (!r) return null;
    const m = { ...r, ...patch };
    await this.db.run("UPDATE repositories SET name = ?, branch = ?, credential_ref = ?, webhook_secret_ref = ?, team_id = ?, status = ?, catalog_id = ?, last_analyzed_at = ?, updated_at = ? WHERE id = ?", [m.name, m.branch, m.credentialRef, m.webhookSecretRef, m.teamId, m.status, m.catalogId, m.lastAnalyzedAt, now(), r.id]);
    return this.repositoryById(r.id);
  }

  // jobs
  async enqueue(j: { tenantId: string; type: JobType; repositoryId?: string | null; dedupeKey?: string | null; params?: Record<string, unknown>; priority?: number; exclusive?: boolean; maxAttempts: number; createdBy: string | null; correlationId: string | null; traceparent?: string | null }): Promise<{ job: Job; deduplicated: boolean }> {
    if (j.dedupeKey) {
      const active = await this.db.get("SELECT * FROM jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('QUEUED', 'RUNNING')", [j.tenantId, j.dedupeKey]);
      if (active) return { job: job(active), deduplicated: true };
    }
    const id = newId("job");
    try {
      await this.db.run(
        "INSERT INTO jobs (id, tenant_id, type, status, repository_id, dedupe_key, params, attempts, max_attempts, priority, exclusive, run_after, cancel_requested, created_by, correlation_id, traceparent, created_at) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        [id, j.tenantId, j.type, j.repositoryId ?? null, j.dedupeKey ?? null, json(j.params ?? {}), j.maxAttempts, j.priority ?? 100, j.exclusive ? 1 : 0, now(), j.createdBy, j.correlationId, j.traceparent ?? null, now()],
      );
    } catch (error) {
      if (j.dedupeKey) {
        const active = await this.db.get("SELECT * FROM jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('QUEUED', 'RUNNING')", [j.tenantId, j.dedupeKey]);
        if (active) return { job: job(active), deduplicated: true };
      }
      throw error;
    }
    return { job: (await this.job(j.tenantId, id))!, deduplicated: false };
  }
  async job(tenantId: string | null, id: string) {
    const r = tenantId ? await this.db.get("SELECT * FROM jobs WHERE tenant_id = ? AND id = ?", [tenantId, id]) : await this.db.get("SELECT * FROM jobs WHERE id = ?", [id]);
    return r ? job(r) : null;
  }
  async jobs(tenantId: string, filter: { status?: string; type?: string; repositoryIds?: string[] | null; cursor?: string | null; limit: number }): Promise<Page<Job>> {
    const params: Param[] = [tenantId];
    let where = "tenant_id = ?";
    if (filter.status) (where += " AND status = ?"), params.push(filter.status);
    if (filter.type) (where += " AND type = ?"), params.push(filter.type);
    if (filter.repositoryIds) {
      where += filter.repositoryIds.length ? ` AND (repository_id IS NULL OR repository_id IN (${filter.repositoryIds.map(() => "?").join(",")}))` : " AND repository_id IS NULL";
      params.push(...filter.repositoryIds);
    }
    const cursor = decodeCursor(filter.cursor);
    if (cursor) (where += " AND (created_at || '|' || id) < ?"), params.push(cursor);
    const rows = await this.db.all(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, filter.limit + 1]);
    const items = rows.slice(0, filter.limit).map(job);
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(`${items[items.length - 1]!.createdAt}|${items[items.length - 1]!.id}`) : null };
  }
  /** Atomically leases the next runnable job. Exclusive jobs (graph writers) additionally need the tenant's writer lock. */
  async claim(workerId: string, leaseSeconds: number): Promise<Job | null> {
    const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await this.db.run("UPDATE jobs SET status = 'CANCELLED', error_code = 'CANCELLED', error_class = 'cancelled', error_message = 'cancelled by request (worker lost)', lease_owner = NULL, lease_expires_at = NULL, completed_at = ? WHERE status = 'RUNNING' AND lease_expires_at < ? AND cancel_requested = 1", [now(), now()]);
    await this.db.run("UPDATE jobs SET status = 'FAILED', error_code = 'WORKER_LOST', error_class = 'transient', error_message = 'worker lost the job on its final attempt (lease expired)', lease_owner = NULL, lease_expires_at = NULL, completed_at = ? WHERE status = 'RUNNING' AND lease_expires_at < ? AND attempts >= max_attempts", [now(), now()]);
    await this.db.run("UPDATE jobs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL, run_after = ? WHERE status = 'RUNNING' AND lease_expires_at < ?", [now(), now()]);
    const candidates = await this.db.all("SELECT id, tenant_id, exclusive FROM jobs WHERE status = 'QUEUED' AND run_after <= ? ORDER BY priority, created_at LIMIT 20", [now()]);
    for (const c of candidates) {
      if (Number(c.exclusive) === 1 && !(await this.lock(`tenant-writer:${c.tenant_id}`, c.id, leaseSeconds))) continue;
      const changed = await this.db.run("UPDATE jobs SET status = 'RUNNING', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'QUEUED'", [workerId, lease, now(), c.id]);
      if (changed) return this.job(null, c.id);
      if (Number(c.exclusive) === 1) await this.unlock(`tenant-writer:${c.tenant_id}`, c.id);
    }
    return null;
  }
  async heartbeat(jobId: string, workerId: string, leaseSeconds: number, progress?: { progress?: number; message?: string }) {
    const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await this.db.run("UPDATE jobs SET lease_expires_at = ?, progress = COALESCE(?, progress), progress_message = COALESCE(?, progress_message) WHERE id = ? AND lease_owner = ? AND status = 'RUNNING'", [lease, progress?.progress ?? null, progress?.message ?? null, jobId, workerId]);
    const j = await this.job(null, jobId);
    if (j?.exclusive) await this.lock(`tenant-writer:${j.tenantId}`, jobId, leaseSeconds);
    return j;
  }
  async finishJob(j: Job, outcome: { status: JobStatus; result?: unknown; errorCode?: string | null; errorClass?: string | null; errorMessage?: string | null; graphVersionId?: string | null; retryAt?: string | null; worker?: unknown }) {
    const retry = !!outcome.retryAt;
    await this.db.run(
      "UPDATE jobs SET status = ?, result = COALESCE(?, result), error_code = ?, error_class = ?, error_message = ?, graph_version_id = COALESCE(?, graph_version_id), run_after = COALESCE(?, run_after), lease_owner = NULL, lease_expires_at = NULL, worker = COALESCE(?, worker), completed_at = ?, progress = CASE WHEN ? = 'COMPLETED' THEN 1 ELSE progress END WHERE id = ?",
      [retry ? "QUEUED" : outcome.status, outcome.result === undefined ? null : json(outcome.result), outcome.errorCode ?? null, outcome.errorClass ?? null, outcome.errorMessage?.slice(0, 2000) ?? null, outcome.graphVersionId ?? null, outcome.retryAt ?? null, outcome.worker === undefined ? null : json(outcome.worker), retry ? null : now(), outcome.status, j.id],
    );
    if (j.exclusive) await this.unlock(`tenant-writer:${j.tenantId}`, j.id);
  }
  async requestCancel(tenantId: string, id: string) {
    const j = await this.job(tenantId, id);
    if (!j) return null;
    if (j.status === "QUEUED") await this.db.run("UPDATE jobs SET status = 'CANCELLED', cancel_requested = 1, completed_at = ? WHERE id = ? AND status = 'QUEUED'", [now(), id]);
    else if (j.status === "RUNNING") await this.db.run("UPDATE jobs SET cancel_requested = 1 WHERE id = ?", [id]);
    return this.job(tenantId, id);
  }

  async lock(name: string, owner: string, seconds: number): Promise<boolean> {
    const expires = new Date(Date.now() + seconds * 1000).toISOString();
    const changed = await this.db.run("INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE locks.owner = excluded.owner OR locks.expires_at < ?", [name, owner, expires, now()]);
    return changed > 0;
  }
  async unlock(name: string, owner: string) {
    await this.db.run("DELETE FROM locks WHERE name = ? AND owner = ?", [name, owner]);
  }

  // graph versions
  async graphVersionByKey(tenantId: string, dedupeKey: string) {
    const r = await this.db.get("SELECT * FROM graph_versions WHERE tenant_id = ? AND dedupe_key = ? AND status != 'ARCHIVED' ORDER BY created_at DESC LIMIT 1", [tenantId, dedupeKey]);
    return r ? graphVersion(r) : null;
  }
  async recordGraphVersion(v: Omit<GraphVersion, "id" | "createdAt" | "status">) {
    const id = newId("gv");
    await this.db.tx(async (tx) => {
      await tx.run("UPDATE graph_versions SET status = 'HISTORICAL' WHERE tenant_id = ? AND repository_id = ? AND status = 'CURRENT'", [v.tenantId, v.repositoryId]);
      await tx.run(
        "INSERT INTO graph_versions (id, tenant_id, repository_id, catalog_repository_id, graph_version, snapshot_id, commit_sha, branch, analyzer_version, schema_version, config_fingerprint, config, plugin_versions, dedupe_key, job_id, correlation_id, status, entities, relationships, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?, ?, ?)",
        [id, v.tenantId, v.repositoryId, v.catalogRepositoryId, v.graphVersion, v.snapshotId, v.commit, v.branch, v.analyzerVersion, v.schemaVersion, v.configFingerprint, json(v.config), json(v.pluginVersions), v.dedupeKey, v.jobId, v.correlationId, v.entities, v.relationships, now()],
      );
    });
    return id;
  }
  async graphVersions(tenantId: string, filter: { repositoryIds?: string[] | null; status?: string; cursor?: string | null; limit: number }): Promise<Page<GraphVersion>> {
    if (filter.repositoryIds && !filter.repositoryIds.length) return { items: [], nextCursor: null };
    const params: Param[] = [tenantId];
    let where = "tenant_id = ?";
    if (filter.repositoryIds) (where += ` AND repository_id IN (${filter.repositoryIds.map(() => "?").join(",")})`), params.push(...filter.repositoryIds);
    if (filter.status) (where += " AND status = ?"), params.push(filter.status);
    const cursor = decodeCursor(filter.cursor);
    if (cursor) (where += " AND (created_at || '|' || id) < ?"), params.push(cursor);
    const rows = await this.db.all(`SELECT * FROM graph_versions WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, filter.limit + 1]);
    const items = rows.slice(0, filter.limit).map(graphVersion);
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(`${items[items.length - 1]!.createdAt}|${items[items.length - 1]!.id}`) : null };
  }
  async graphVersion(tenantId: string, id: string) {
    const r = await this.db.get("SELECT * FROM graph_versions WHERE tenant_id = ? AND id = ?", [tenantId, id]);
    return r ? graphVersion(r) : null;
  }
  async setGraphVersionStatus(id: string, status: GraphVersion["status"]) {
    await this.db.run("UPDATE graph_versions SET status = ? WHERE id = ?", [status, id]);
  }

  // versioned tenant documents: architecture policies and enterprise metadata
  async putDocument(tenantId: string, kind: "policy" | "enterprise", name: string, content: string, by: string | null) {
    return this.db.tx(async (tx) => {
      const last = await tx.get<{ version: number; sha256: string }>("SELECT version, sha256 FROM documents WHERE tenant_id = ? AND kind = ? AND name = ? ORDER BY version DESC LIMIT 1", [tenantId, kind, name]);
      const sha = sha256(content);
      if (last && last.sha256 === sha) return { version: Number(last.version), changed: false };
      const version = (last ? Number(last.version) : 0) + 1;
      await tx.run("UPDATE documents SET status = 'superseded' WHERE tenant_id = ? AND kind = ? AND name = ? AND status = 'active'", [tenantId, kind, name]);
      await tx.run("INSERT INTO documents (id, tenant_id, kind, name, version, content, sha256, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)", [newId("doc"), tenantId, kind, name, version, content, sha, by, now()]);
      return { version, changed: true };
    });
  }
  async deactivateDocument(tenantId: string, kind: string, name: string) {
    return this.db.run("UPDATE documents SET status = 'superseded' WHERE tenant_id = ? AND kind = ? AND name = ? AND status = 'active'", [tenantId, kind, name]);
  }
  async documents(tenantId: string, kind: string, activeOnly = true) {
    return (await this.db.all(`SELECT * FROM documents WHERE tenant_id = ? AND kind = ? ${activeOnly ? "AND status = 'active'" : ""} ORDER BY name, version DESC`, [tenantId, kind])).map((r) => ({ id: r.id as string, name: r.name as string, version: Number(r.version), content: r.content as string, sha256: r.sha256 as string, status: r.status as string, createdBy: r.created_by as string | null, createdAt: r.created_at as string }));
  }

  // evaluations
  async saveEvaluation(tenantId: string, kind: string, jobId: string | null, snapshots: unknown, summary: unknown) {
    const id = newId("ev");
    await this.db.run("INSERT INTO evaluations (id, tenant_id, kind, job_id, snapshots, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, tenantId, kind, jobId, json(snapshots), json(summary), now()]);
    return id;
  }
  async evaluations(tenantId: string, kind: string, limit = 20) {
    return (await this.db.all("SELECT * FROM evaluations WHERE tenant_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?", [tenantId, kind, limit])).map((r) => ({ id: r.id as string, kind: r.kind as string, jobId: r.job_id as string | null, snapshots: parse(r.snapshots, null), summary: parse<Record<string, any>>(r.summary, {}), createdAt: r.created_at as string }));
  }

  // AI usage and history
  async aiUsage(tenantId: string, day: string, subjects: { type: string; id: string }[]) {
    const out: Record<string, { requests: number; tokens: number }> = {};
    for (const s of subjects) {
      const r = await this.db.get<{ requests: number; tokens: number }>("SELECT requests, tokens FROM ai_usage WHERE tenant_id = ? AND day = ? AND subject_type = ? AND subject_id = ?", [tenantId, day, s.type, s.id]);
      out[`${s.type}:${s.id}`] = { requests: Number(r?.requests ?? 0), tokens: Number(r?.tokens ?? 0) };
    }
    return out;
  }
  /** Atomically adds to each subject's counters and returns the post-update values (concurrent callers each see their own). */
  async addAiUsage(tenantId: string, day: string, subjects: { type: string; id: string }[], requests: number, tokens: number) {
    const out: Record<string, { requests: number; tokens: number }> = {};
    for (const s of subjects) {
      const r = await this.db.get<{ requests: number; tokens: number }>("INSERT INTO ai_usage (tenant_id, day, subject_type, subject_id, requests, tokens) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, day, subject_type, subject_id) DO UPDATE SET requests = ai_usage.requests + excluded.requests, tokens = ai_usage.tokens + excluded.tokens RETURNING requests, tokens", [tenantId, day, s.type, s.id, requests, tokens]);
      out[`${s.type}:${s.id}`] = { requests: Number(r?.requests ?? 0), tokens: Number(r?.tokens ?? 0) };
    }
    return out;
  }
  async saveAiQuery(q: { tenantId: string; userId: string | null; question: string; status: string; mode: string; provider: string | null; model: string | null; tokensIn: number; tokensOut: number; latencyMs: number; record: unknown }) {
    const id = newId("aiq");
    await this.db.run("INSERT INTO ai_queries (id, tenant_id, user_id, at, question, status, mode, provider, model, tokens_in, tokens_out, latency_ms, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, q.tenantId, q.userId, now(), q.question, q.status, q.mode, q.provider, q.model, q.tokensIn, q.tokensOut, q.latencyMs, json(q.record)]);
    return id;
  }
  async aiQueries(tenantId: string, filter: { userId?: string; cursor?: string | null; limit: number }) {
    const params: Param[] = [tenantId];
    let where = "tenant_id = ?";
    if (filter.userId) (where += " AND user_id = ?"), params.push(filter.userId);
    const cursor = decodeCursor(filter.cursor);
    if (cursor) (where += " AND (at || '|' || id) < ?"), params.push(cursor);
    const rows = await this.db.all(`SELECT * FROM ai_queries WHERE ${where} ORDER BY at DESC, id DESC LIMIT ?`, [...params, filter.limit + 1]);
    const items = rows.slice(0, filter.limit).map((r) => ({ id: r.id as string, userId: r.user_id as string | null, at: r.at as string, question: r.question as string, status: r.status as string, mode: r.mode as string, provider: r.provider as string | null, model: r.model as string | null, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), latencyMs: Number(r.latency_ms), record: parse<Record<string, any>>(r.record, {}) }));
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(`${items[items.length - 1]!.at}|${items[items.length - 1]!.id}`) : null };
  }

  // workers
  async workerHeartbeat(w: { id: string; hostname: string; pid: number; version: string; startedAt: string; status: string; currentJobs: string[] }) {
    await this.db.run("INSERT INTO workers (id, hostname, pid, version, started_at, heartbeat_at, status, current_jobs) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, status = excluded.status, current_jobs = excluded.current_jobs", [w.id, w.hostname, w.pid, w.version, w.startedAt, now(), w.status, json(w.currentJobs)]);
  }
  async workers() {
    return (await this.db.all("SELECT * FROM workers ORDER BY heartbeat_at DESC LIMIT 50")).map((r) => ({ id: r.id as string, hostname: r.hostname as string, pid: Number(r.pid), version: r.version as string, startedAt: r.started_at as string, heartbeatAt: r.heartbeat_at as string, status: r.status as string, currentJobs: parse<string[]>(r.current_jobs, []) }));
  }

  async counts(tenantId: string) {
    const one = async (sql: string, params: Param[]) => Number((await this.db.get<{ n: number }>(sql, params))?.n ?? 0);
    return {
      repositories: await one("SELECT COUNT(*) AS n FROM repositories WHERE tenant_id = ? AND status = 'active'", [tenantId]),
      analyzedRepositories: await one("SELECT COUNT(DISTINCT repository_id) AS n FROM graph_versions WHERE tenant_id = ? AND status = 'CURRENT'", [tenantId]),
      graphVersions: await one("SELECT COUNT(*) AS n FROM graph_versions WHERE tenant_id = ?", [tenantId]),
      queuedJobs: await one("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'QUEUED'", [tenantId]),
      runningJobs: await one("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'RUNNING'", [tenantId]),
      failedJobs24h: await one("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ? AND status = 'FAILED' AND completed_at > ?", [tenantId, new Date(Date.now() - 86_400_000).toISOString()]),
      users: await one("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND status = 'active'", [tenantId]),
      teams: await one("SELECT COUNT(*) AS n FROM teams WHERE tenant_id = ?", [tenantId]),
    };
  }
}
