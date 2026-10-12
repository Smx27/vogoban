export const PERMISSIONS = [
  "tenant.admin",
  "members.manage",
  "repos.read",
  "repos.manage",
  "analysis.run",
  "graph.read",
  "impact.run",
  "governance.read",
  "policies.manage",
  "security.read",
  "metadata.manage",
  "ownership.read",
  "ai.use",
  "mcp.use",
  "exports.create",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that make sense on a single repository (or team/environment-scoped binding); the rest are tenant-wide by nature. */
export const RESOURCE_PERMISSIONS: Permission[] = ["repos.read", "repos.manage", "analysis.run", "graph.read", "impact.run", "governance.read", "security.read", "ownership.read", "ai.use", "mcp.use", "exports.create"];

export const BUILTIN_ROLES: { key: string; name: string; permissions: Permission[] }[] = [
  { key: "org_admin", name: "Organization Admin", permissions: [...PERMISSIONS] },
  { key: "architecture_admin", name: "Architecture Admin", permissions: ["repos.read", "repos.manage", "analysis.run", "graph.read", "impact.run", "governance.read", "policies.manage", "metadata.manage", "ownership.read", "ai.use", "mcp.use", "exports.create"] },
  { key: "security_admin", name: "Security Admin", permissions: ["repos.read", "graph.read", "impact.run", "governance.read", "security.read", "metadata.manage", "ownership.read", "ai.use", "mcp.use", "exports.create", "audit.read"] },
  { key: "repository_analyst", name: "Repository Analyst", permissions: ["repos.read", "analysis.run", "graph.read", "impact.run", "governance.read", "ownership.read", "ai.use", "mcp.use", "exports.create"] },
  { key: "viewer", name: "Viewer", permissions: ["repos.read", "graph.read", "governance.read", "ownership.read"] },
];

export interface Binding {
  permissions: Permission[];
  scopeType: "tenant" | "team" | "repository";
  scopeId: string | null;
  environments: string[] | null;
}

export interface Principal {
  type: "user" | "token";
  id: string;
  userId: string | null;
  label: string;
  operator: boolean;
}

/**
 * Effective platform permissions of one principal inside one tenant.
 * Tenant-scoped bindings apply to every repository; team-scoped bindings to repositories owned by the team or its sub-teams;
 * repository-scoped bindings to that repository only. Environment lists restrict which environment views may be queried.
 */
export class AccessContext {
  readonly tenantPermissions = new Set<Permission>();
  readonly repositoryPermissions = new Map<string, Set<Permission>>();
  readonly environments: string[] | null;

  constructor(readonly tenantId: string, readonly principal: Principal, bindings: Binding[], repositories: { id: string; teamId: string | null }[], teamTree: Map<string, string | null>) {
    const inTeam = (teamId: string | null, scope: string) => {
      for (let t = teamId; t; t = teamTree.get(t) ?? null) if (t === scope) return true;
      return false;
    };
    for (const b of bindings) {
      if (b.scopeType === "tenant") b.permissions.forEach((p) => this.tenantPermissions.add(p));
      const repos = b.scopeType === "tenant" ? repositories : b.scopeType === "team" ? repositories.filter((r) => inTeam(r.teamId, b.scopeId!)) : repositories.filter((r) => r.id === b.scopeId);
      for (const r of repos) {
        const set = this.repositoryPermissions.get(r.id) ?? new Set<Permission>();
        b.permissions.filter((p) => RESOURCE_PERMISSIONS.includes(p)).forEach((p) => set.add(p));
        this.repositoryPermissions.set(r.id, set);
      }
    }
    this.environments = bindings.length && bindings.every((b) => b.environments?.length) ? [...new Set(bindings.flatMap((b) => b.environments!.map((e) => e.toLowerCase())))].sort() : null;
  }

  /** Tenant-level check: granted by a tenant-scoped binding, or (for resource permissions) on at least one repository. */
  can(permission: Permission): boolean {
    if (this.tenantPermissions.has(permission)) return true;
    return RESOURCE_PERMISSIONS.includes(permission) && [...this.repositoryPermissions.values()].some((s) => s.has(permission));
  }

  canOn(permission: Permission, repositoryId: string): boolean {
    return this.tenantPermissions.has(permission) || !!this.repositoryPermissions.get(repositoryId)?.has(permission);
  }

  /** Repository ids on which the permission is granted; null means every repository of the tenant. */
  repositories(permission: Permission): string[] | null {
    if (this.tenantPermissions.has(permission)) return null;
    return [...this.repositoryPermissions.entries()].filter(([, s]) => s.has(permission)).map(([id]) => id).sort();
  }

  environment(requested: string | null | undefined): string | null {
    const env = requested?.toLowerCase() || null;
    if (!this.environments) return env;
    if (env && this.environments.includes(env)) return env;
    if (!env && this.environments.length === 1) return this.environments[0]!;
    throw new AccessDenied(env ? `environment ${env} is not permitted (allowed: ${this.environments.join(", ")})` : `an environment is required (allowed: ${this.environments.join(", ")})`);
  }

  summary() {
    return {
      tenantPermissions: [...this.tenantPermissions].sort(),
      repositoryPermissions: Object.fromEntries([...this.repositoryPermissions.entries()].filter(([, s]) => s.size).map(([id, s]) => [id, [...s].sort()])),
      environments: this.environments,
    };
  }
}

export class AccessDenied extends Error {}
