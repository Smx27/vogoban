import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphAccess, readOnlyStore } from "../ai/access.ts";
import { DEFAULT_LIMITS, type AiLimits } from "../ai/model.ts";
import { GRAPH_SCHEMA_VERSION } from "../graph/model.ts";
import { ANALYZER_VERSION } from "../pipeline/analyze.ts";
import { defaultPlugins } from "../plugins/registry.ts";
import { SqliteGraphStore } from "../store/sqlite.ts";
import type { GraphStore } from "../store/store.ts";
import type { PlatformConfig } from "./config.ts";
import { AccessDenied, type AccessContext, type Permission } from "./rbac.ts";
import { sha256, type PlatformStore } from "./store.ts";

export class GraphUnavailable extends Error {
  constructor(readonly code: "GRAPH_NOT_ANALYZED" | "GRAPH_SCHEMA_INCOMPATIBLE" | "GRAPH_UNAVAILABLE", message: string) {
    super(message);
  }
}

const SAFE_ID = /^[a-z]+_[0-9a-f]{24}$/;

export const pluginVersions = () => Object.fromEntries(defaultPlugins().map((p) => [p.id, p.version]));

/** Fingerprint of everything that changes graph generation for the same commit (analyzer, schema, plugins, semantic and restore options). */
export function analysisFingerprint(cfg: PlatformConfig) {
  const config = { analyzerVersion: ANALYZER_VERSION, schemaVersion: GRAPH_SCHEMA_VERSION, plugins: pluginVersions(), semantic: true, dotnetRestore: cfg.git.restore };
  return { config, fingerprint: sha256(JSON.stringify(config)).slice(0, 32) };
}

/** Tool → platform permission. Graph tools default to graph.read. */
export const TOOL_PERMISSION: Record<string, Permission> = {
  find_impact: "impact.run",
  get_blast_radius: "impact.run",
  get_owners: "ownership.read",
  get_endpoint_security: "security.read",
  get_security_findings: "security.read",
  get_data_flows: "security.read",
  get_governance_violations: "governance.read",
};

/**
 * Tenant graph data lives in one graph store per tenant (physical isolation), opened through the existing GraphStore abstraction.
 * Platform services only ever hand the engines read-only stores; workers own the writes.
 */
export class TenantGraphs {
  private readonly stores = new Map<string, GraphStore>();
  private readonly accessCache = new Map<string, GraphAccess>();

  constructor(readonly cfg: PlatformConfig, readonly platform: PlatformStore) {}

  tenantDir(tenantId: string): string {
    if (!SAFE_ID.test(tenantId)) throw new Error("invalid tenant id");
    return join(this.cfg.dataDir, "tenants", tenantId);
  }
  graphPath(tenantId: string) {
    return join(this.tenantDir(tenantId), "graph.db");
  }

  /** Read handle on the tenant graph. A store written by an incompatible engine schema is refused, never silently loaded. */
  store(tenantId: string): GraphStore {
    const cached = this.stores.get(tenantId);
    if (cached) return cached;
    if (!existsSync(this.graphPath(tenantId))) throw new GraphUnavailable("GRAPH_NOT_ANALYZED", "no repository of this tenant has been analyzed yet");
    let store: SqliteGraphStore;
    try {
      store = new SqliteGraphStore(this.graphPath(tenantId));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new GraphUnavailable(/schema/i.test(msg) ? "GRAPH_SCHEMA_INCOMPATIBLE" : "GRAPH_UNAVAILABLE", msg);
    }
    const ro = readOnlyStore(store);
    this.stores.set(tenantId, ro);
    return ro;
  }

  /** Writable store for workers only. */
  writable(tenantId: string): SqliteGraphStore {
    mkdirSync(this.tenantDir(tenantId), { recursive: true });
    return new SqliteGraphStore(this.graphPath(tenantId));
  }

  /** Active policy and enterprise-metadata documents written to a content-addressed directory the engines read from. */
  async configuration(tenantId: string) {
    const policies = await this.platform.documents(tenantId, "policy");
    const enterprise = (await this.platform.documents(tenantId, "enterprise"))[0] ?? null;
    const fingerprint = sha256(JSON.stringify([policies.map((p) => [p.name, p.sha256]), enterprise?.sha256 ?? null])).slice(0, 20);
    const dir = join(this.tenantDir(tenantId), "config", fingerprint);
    if (!existsSync(dir)) {
      mkdirSync(join(dir, "policies"), { recursive: true });
      for (const p of policies) writeFileSync(join(dir, "policies", `${p.name}.yaml`), p.content);
      if (enterprise) writeFileSync(join(dir, "enterprise.yaml"), enterprise.content);
    }
    return {
      fingerprint,
      policyPaths: policies.length ? [join(dir, "policies")] : null,
      enterprisePath: enterprise ? join(dir, "enterprise.yaml") : null,
      documents: { policies: policies.map((p) => ({ name: p.name, version: p.version, sha256: p.sha256 })), enterprise: enterprise ? { version: enterprise.version, sha256: enterprise.sha256 } : null },
    };
  }

  /** Catalog ids (graph repository ids) the caller may see for a permission; null = whole tenant. */
  async catalogScope(access: AccessContext, permission: Permission): Promise<string[] | null> {
    const repoIds = access.repositories(permission);
    if (repoIds === null) return null;
    const repos = await this.platform.repositories(access.tenantId, { ids: repoIds });
    return repos.map((r) => r.catalogId).filter((c): c is string => !!c);
  }

  /**
   * GraphAccess for one caller and permission: repository scope and environment come from platform authorization, so retrieval,
   * impact, AI and MCP never see repositories the caller cannot access. Instances are cached by graph version identity.
   */
  async access(access: AccessContext, permission: Permission, options: { environment?: string | null; limits?: Partial<AiLimits>; aliases?: Record<string, string>; intersect?: Permission[]; restrictTo?: string[] } = {}): Promise<GraphAccess> {
    for (const p of [permission, ...(options.intersect ?? [])]) if (!access.can(p)) throw new AccessDenied(`missing permission ${p}`);
    const store = this.store(access.tenantId);
    let repositories = await this.catalogScope(access, permission);
    for (const p of options.intersect ?? []) {
      const other = await this.catalogScope(access, p);
      if (other === null) continue;
      repositories = repositories === null ? other : repositories.filter((r) => other.includes(r));
    }
    if (options.restrictTo) repositories = repositories === null ? options.restrictTo : repositories.filter((r) => options.restrictTo!.includes(r));
    const known = new Set(store.listCatalog().map((c) => c.repositoryId));
    const scoped = repositories === null ? null : repositories.filter((r) => known.has(r));
    const environment = access.environment(options.environment ?? null);
    const config = await this.configuration(access.tenantId);
    const covers = async (perm: Permission) => {
      const allowed = await this.catalogScope(access, perm);
      if (allowed === null) return true;
      if (scoped === null) return false;
      return scoped.every((r) => allowed.includes(r));
    };
    const sections = { security: await covers("security.read"), governance: await covers("governance.read"), ownership: await covers("ownership.read") };
    const deniedTools: string[] = [];
    for (const [tool, perm] of Object.entries(TOOL_PERMISSION)) if (perm !== permission && !(await covers(perm))) deniedTools.push(tool);
    const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    const versionKey = store.listCatalog().map((c) => `${c.repositoryId}@${c.graphVersion}`).sort().join(",") + `|${store.listMetaSnapshots()[0]?.id ?? ""}`;
    const key = sha256(JSON.stringify([access.tenantId, permission, options.intersect ?? [], scoped, environment, config.fingerprint, versionKey, sections, deniedTools, limits, options.aliases ?? {}]));
    const hit = this.accessCache.get(key);
    if (hit) return hit;
    const ga = new GraphAccess(store, { graph: "all", repositories: scoped, environment, snapshots: { repositories: {}, meta: null } }, limits, { policyPaths: config.policyPaths, enterprisePath: config.enterprisePath, aliases: options.aliases ?? {}, sections, deniedTools });
    if (this.accessCache.size > 64) this.accessCache.delete(this.accessCache.keys().next().value!);
    this.accessCache.set(key, ga);
    return ga;
  }

  invalidate(tenantId: string) {
    this.stores.delete(tenantId);
  }
}
