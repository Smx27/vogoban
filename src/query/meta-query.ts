import type { Entity, MetaRelationship, RelationshipType } from "../graph/model.ts";
import { catalogStatus, type CatalogStatus } from "../metagraph/catalog.ts";
import type { GraphStore } from "../store/store.ts";

export const REPOSITORY_EDGES: RelationshipType[] = ["CALLS_REPOSITORY", "DEPENDS_ON_REPOSITORY", "CONSUMES_REPOSITORY_CONTRACT", "SHARES_CONTRACT_WITH", "DEPLOYS_REPOSITORY"];

export interface Connection {
  relationship: MetaRelationship;
  other: Entity | null;
  direction: "out" | "in";
}

export class MetaQuery {
  constructor(private readonly store: GraphStore) {}

  entities(ids: string[]): Map<string, Entity> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return new Map([...this.store.findEntities({ ids: unique }), ...this.store.findMetaEntities({ ids: unique })].map((e) => [e.id, e]));
  }

  catalog(): CatalogStatus[] {
    return this.store.listCatalog().map(catalogStatus);
  }

  repository(ref: string): CatalogStatus | null {
    const entry = this.store.getCatalog(ref);
    return entry ? catalogStatus(entry) : null;
  }

  repositoryEntity(repositoryId: string): Entity | null {
    return this.store.findEntities({ kinds: ["Repository"], repositoryId })[0] ?? null;
  }

  profile(repositoryId: string) {
    const stats = this.store.stats(repositoryId);
    const e = stats.entitiesByKind;
    const n = (k: string) => e[k] ?? 0;
    const infra = n("Dockerfile") + n("Pipeline") + n("HelmChart") + n("Deployment") + n("KubernetesService");
    const roles = [n("Application") ? "application" : null, infra ? "infrastructure" : null, n("Message") + n("Api") && !n("Application") ? "contracts" : null].filter(Boolean) as string[];
    return {
      roles: roles.length ? roles : ["library"],
      projects: n("Project"), applications: n("Application"), apis: n("Api"), operations: n("ApiOperation"), messages: n("Message"),
      pipelines: n("Pipeline"), images: n("ContainerImage"), workloads: n("Deployment"), charts: n("HelmChart"), externalApiCalls: stats.relationshipsByType.CALLS_EXTERNAL_API ?? 0,
    };
  }

  connections(repositoryId?: string): Connection[] {
    const rels = this.store.findMetaRelationships({ types: [...REPOSITORY_EDGES, "USES_EXTERNAL_SYSTEM", "USES_DATABASE"], repositoryId }).filter((r) => r.sourceId === this.repoEntityId(r.sourceRepositoryId) || r.type === "SHARES_CONTRACT_WITH");
    const ents = this.entities(rels.flatMap((r) => [r.sourceId, r.targetId]));
    return rels.map((relationship) => {
      const out = !repositoryId || relationship.sourceRepositoryId === repositoryId;
      return { relationship, direction: out ? "out" : "in", other: ents.get(out ? relationship.targetId : relationship.sourceId) ?? null };
    });
  }

  private repoEntityCache = new Map<string, string | null>();
  private repoEntityId(repositoryId: string | null): string | null {
    if (!repositoryId) return null;
    if (!this.repoEntityCache.has(repositoryId)) this.repoEntityCache.set(repositoryId, this.repositoryEntity(repositoryId)?.id ?? null);
    return this.repoEntityCache.get(repositoryId)!;
  }

  operations(ref: string): Entity[] {
    const m = /^([A-Za-z]+)\s+(\/.*)$/.exec(ref.trim());
    if (m) {
      const shape = m[2]!.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "").toLowerCase();
      return this.store.findEntities({ kinds: ["ApiOperation"] }).filter((o) => String(o.metadata.method).toUpperCase() === m[1]!.toUpperCase() && String(o.metadata.routeShape ?? "").replace(/\/+$/, "").toLowerCase() === shape);
    }
    return this.store.findEntities({ ids: [ref] }).filter((e) => e.kind === "ApiOperation");
  }

  apis(ref: string): Entity[] {
    return this.store.findEntities({ kinds: ["Api"] }).filter((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase() || (a.qualifiedName ?? "").toLowerCase() === ref.toLowerCase() || a.name.toLowerCase().includes(ref.toLowerCase()));
  }

  providers(ref: string) {
    const ops = this.operations(ref);
    const apis = ops.length ? [] : this.apis(ref);
    const subjects = [...ops, ...apis];
    const implemented = this.store.findRelationships({ sourceIds: ops.map((o) => o.id), types: ["IMPLEMENTED_BY"] });
    const endpoints = this.entities(implemented.map((r) => r.targetId));
    return subjects.map((s) => ({
      subject: s,
      repository: s.repositoryId ? this.store.getCatalog(s.repositoryId)?.name ?? s.repositoryId : null,
      endpoints: implemented.filter((r) => r.sourceId === s.id).map((r) => endpoints.get(r.targetId)).filter((e): e is Entity => !!e),
      providedBy: this.store.findMetaRelationships({ targetIds: [s.id], types: ["PROVIDES_API"] }),
    }));
  }

  consumers(ref: string) {
    const ops = this.operations(ref);
    const apis = ops.length ? [] : this.apis(ref);
    const opIds = ops.length ? ops.map((o) => o.id) : this.store.findRelationships({ sourceIds: apis.map((a) => a.id), types: ["CONTAINS"] }).map((r) => r.targetId);
    const meta = this.store.findMetaRelationships({ targetIds: [...opIds, ...apis.map((a) => a.id)], types: ["CALLS_ENDPOINT", "CONSUMES_API"] });
    const local = this.store.findRelationships({ targetIds: opIds, types: ["CALLS_ENDPOINT"] });
    const ents = this.entities([...meta.map((r) => r.sourceId), ...local.map((r) => r.sourceId), ...opIds]);
    return {
      subjects: [...ops, ...apis],
      crossRepository: meta.map((r) => ({ relationship: r, consumer: ents.get(r.sourceId) ?? null, operation: ents.get(r.targetId) ?? null })),
      sameRepository: local.map((r) => ({ relationship: r, consumer: ents.get(r.sourceId) ?? null, operation: ents.get(r.targetId) ?? null })),
    };
  }

  messages(ref: string) {
    const contracts = this.store.findMetaEntities({ kinds: ["SharedContract"], nameLike: ref }).filter((c) => c.metadata.contractKind === "message" && (c.name.toLowerCase() === ref.toLowerCase() || (c.qualifiedName ?? "").toLowerCase() === ref.toLowerCase()));
    const local = this.store.findEntities({ kinds: ["Message"], nameLike: ref }).filter((m) => m.name.toLowerCase() === ref.toLowerCase() || (m.qualifiedName ?? "").toLowerCase() === ref.toLowerCase());
    const meta = this.store.findMetaRelationships({ sourceIds: contracts.map((c) => c.id), types: ["CONTAINS", "CONSUMED_BY"] });
    const metaIn = this.store.findMetaRelationships({ targetIds: contracts.map((c) => c.id), types: ["PUBLISHES_MESSAGE", "CONSUMES_MESSAGE", "CARRIES"] });
    const linked = new Set(meta.filter((r) => r.type === "CONTAINS").map((r) => r.targetId));
    const pubs = this.store.findRelationships({ targetIds: local.map((m) => m.id), types: ["PUBLISHES"] });
    const cons = this.store.findRelationships({ sourceIds: local.map((m) => m.id), types: ["CONSUMED_BY", "HANDLED_BY"] });
    const ents = this.entities([...meta.map((r) => r.targetId), ...metaIn.map((r) => r.sourceId), ...pubs.map((r) => r.sourceId), ...cons.map((r) => r.targetId)]);
    const unresolved = this.store.findMetaUnresolved({ category: "message" }).filter((u) => local.some((m) => m.id === u.sourceId));
    return {
      contracts: contracts.map((c) => ({
        contract: c,
        members: meta.filter((r) => r.sourceId === c.id && r.type === "CONTAINS").map((r) => ({ message: ents.get(r.targetId) ?? null, relationship: r })),
        publishers: metaIn.filter((r) => r.targetId === c.id && r.type === "PUBLISHES_MESSAGE").map((r) => ({ repository: ents.get(r.sourceId) ?? null, relationship: r })),
        consumers: metaIn.filter((r) => r.targetId === c.id && r.type === "CONSUMES_MESSAGE").map((r) => ({ repository: ents.get(r.sourceId) ?? null, relationship: r })),
        handlers: meta.filter((r) => r.sourceId === c.id && r.type === "CONSUMED_BY").map((r) => ({ handler: ents.get(r.targetId) ?? null, relationship: r })),
        transports: metaIn.filter((r) => r.targetId === c.id && r.type === "CARRIES").map((r) => ents.get(r.sourceId)).filter((e): e is Entity => !!e),
      })),
      unlinked: local.filter((m) => !linked.has(m.id)).map((m) => ({
        message: m,
        repository: m.repositoryId ? this.store.getCatalog(m.repositoryId)?.name ?? m.repositoryId : null,
        publishers: pubs.filter((r) => r.targetId === m.id).map((r) => ents.get(r.sourceId)).filter((e): e is Entity => !!e),
        consumers: cons.filter((r) => r.sourceId === m.id).map((r) => ents.get(r.targetId)).filter((e): e is Entity => !!e),
        unresolved: unresolved.filter((u) => u.sourceId === m.id),
      })),
    };
  }

  sharedPackages(filter?: string) {
    const rels = this.store.findMetaRelationships({ types: ["USES_SHARED_PACKAGE", "PRODUCES_PACKAGE"] });
    const ents = this.entities(rels.flatMap((r) => [r.sourceId, r.targetId]));
    const byPackage = new Map<string, { pkg: Entity | null; users: MetaRelationship[]; producers: MetaRelationship[] }>();
    for (const r of rels) {
      const entry = byPackage.get(r.targetId) ?? { pkg: ents.get(r.targetId) ?? null, users: [], producers: [] };
      (r.type === "PRODUCES_PACKAGE" ? entry.producers : entry.users).push(r);
      byPackage.set(r.targetId, entry);
    }
    return [...byPackage.values()]
      .filter((p) => !filter || (p.pkg?.name ?? "").toLowerCase().includes(filter.toLowerCase()))
      .map((p) => ({ ...p, producers: p.producers.map((r) => ({ relationship: r, project: ents.get(r.sourceId) ?? null })) }))
      .sort((a, b) => b.users.length - a.users.length || (a.pkg?.name ?? "").localeCompare(b.pkg?.name ?? ""));
  }

  externalSystems(filter?: string) {
    const systems = this.store.findMetaEntities({ kinds: ["ExternalSystem", "Database"], nameLike: filter });
    const rels = this.store.findMetaRelationships({ targetIds: systems.map((s) => s.id), types: ["USES_EXTERNAL_SYSTEM", "CALLS_EXTERNAL_SYSTEM", "USES_DATABASE"] });
    const ents = this.entities(rels.map((r) => r.sourceId));
    return systems.map((system) => {
      const incoming = rels.filter((r) => r.targetId === system.id);
      return {
        system,
        repositories: [...new Set(incoming.map((r) => r.sourceRepositoryId).filter((r): r is string => !!r))].map((r) => this.store.getCatalog(r)?.name ?? r).sort(),
        environments: [...new Set(incoming.map((r) => r.environment).filter((e): e is string => !!e))].sort(),
        sources: incoming.filter((r) => ents.get(r.sourceId)?.kind !== "Repository").map((r) => ({ relationship: r, source: ents.get(r.sourceId) ?? null })),
      };
    });
  }

  topology(repositoryId: string, reverse: boolean, depth: number, environment?: string) {
    const steps: { depth: number; repository: string; via: MetaRelationship; from: string }[] = [];
    const seen = new Set([repositoryId]);
    let frontier = [repositoryId];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const repo of frontier) {
        const rels = this.store.findMetaRelationships({ types: REPOSITORY_EDGES, repositoryId: repo, environment });
        for (const r of rels) {
          const from = r.type === "CONSUMES_REPOSITORY_CONTRACT" ? r.targetRepositoryId : r.sourceRepositoryId;
          const to = r.type === "CONSUMES_REPOSITORY_CONTRACT" ? r.sourceRepositoryId : r.targetRepositoryId;
          const [a, b] = reverse ? [to, from] : [from, to];
          if (a !== repo || !b || seen.has(b)) continue;
          seen.add(b);
          next.push(b);
          steps.push({ depth: d, repository: b, via: r, from: repo });
        }
      }
      frontier = next;
    }
    const external = reverse ? [] : this.store.findMetaRelationships({ types: ["USES_EXTERNAL_SYSTEM", "USES_DATABASE"], repositoryId, environment }).filter((r) => r.sourceRepositoryId === repositoryId && r.sourceId === this.repoEntityId(repositoryId));
    return { steps, external, externalEntities: this.entities(external.map((r) => r.targetId)) };
  }

  stats() {
    const rels = this.store.findMetaRelationships({});
    const count = (f: (r: MetaRelationship) => string) => {
      const out: Record<string, number> = {};
      for (const r of rels) out[f(r)] = (out[f(r)] ?? 0) + 1;
      return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
    };
    const unresolved = this.store.findMetaUnresolved({});
    const unresolvedByCategory: Record<string, number> = {};
    for (const u of unresolved) unresolvedByCategory[String(u.metadata.category)] = (unresolvedByCategory[String(u.metadata.category)] ?? 0) + 1;
    return {
      repositories: this.catalog().length,
      snapshot: this.store.listMetaSnapshots()[0] ?? null,
      relationshipsByCategory: count((r) => r.category),
      relationshipsByType: count((r) => r.type),
      relationshipsByEvidence: count((r) => r.evidence),
      metaEntitiesByKind: Object.fromEntries(["SharedContract", "ExternalSystem", "Database"].map((k) => [k, this.store.findMetaEntities({ kinds: [k as Entity["kind"]] }).length])),
      unresolved: unresolved.length,
      unresolvedByCategory,
      conflicts: this.store.findMetaConflicts({}).length,
    };
  }
}
