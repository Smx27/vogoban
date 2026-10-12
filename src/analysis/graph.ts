import type { Entity, EntityKind, EvidenceLevel, Metadata, Provenance, RelationshipType } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export type AnalysisScope = "repository" | "meta" | "all";

export interface AnalysisOptions {
  scope: AnalysisScope;
  repositoryId?: string;
  environment?: string;
}

export interface Edge {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  evidence: EvidenceLevel;
  confidence: number;
  graphScope: "repository" | "meta";
  repositoryId: string | null;
  targetRepositoryId: string | null;
  environment: string | null;
  provenance: Provenance | null;
  metadata: Metadata;
}

const CHUNK = 400;
const CONFIRMED: EvidenceLevel[] = ["EXACT", "COMPILER_RESOLVED", "DECLARED", "STRUCTURALLY_RESOLVED"];
export const isConfirmed = (e: Edge) => CONFIRMED.includes(e.evidence) && e.confidence >= 0.7;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const byEdge = (a: Edge, b: Edge) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class AnalysisGraph {
  private readonly entityCache = new Map<string, Entity | null>();
  private readonly outCache = new Map<string, Edge[]>();
  private readonly inCache = new Map<string, Edge[]>();
  fetches = 0;

  constructor(readonly store: GraphStore, readonly options: AnalysisOptions) {}

  entities(ids: Iterable<string>): Map<string, Entity> {
    const missing = [...new Set(ids)].filter((id) => !this.entityCache.has(id));
    for (const chunk of chunks(missing)) {
      this.fetches++;
      const found = new Map([...this.store.findEntities({ ids: chunk }), ...(this.options.scope === "repository" ? [] : this.store.findMetaEntities({ ids: chunk }))].map((e) => [e.id, e]));
      for (const id of chunk) this.entityCache.set(id, found.get(id) ?? null);
    }
    const out = new Map<string, Entity>();
    for (const id of ids) {
      const e = this.entityCache.get(id);
      if (e) out.set(id, e);
    }
    return out;
  }

  entity(id: string): Entity | null {
    return this.entities([id]).get(id) ?? null;
  }

  visible(entity: Entity | null | undefined): boolean {
    if (!entity) return false;
    if (this.options.repositoryId && this.options.scope === "repository" && entity.repositoryId && entity.repositoryId !== this.options.repositoryId) return false;
    const env = this.options.environment;
    const own = entity.metadata.environment;
    return !env || typeof own !== "string" || !own || own.toLowerCase() === env.toLowerCase();
  }

  private accept(edge: Edge): boolean {
    if (this.options.scope === "repository" && edge.graphScope === "meta") return false;
    if (this.options.scope === "meta" && edge.graphScope === "repository" && this.options.repositoryId && edge.repositoryId !== this.options.repositoryId) return false;
    if (this.options.repositoryId && this.options.scope === "repository" && edge.repositoryId && edge.repositoryId !== this.options.repositoryId) return false;
    const env = this.options.environment;
    return !env || !edge.environment || edge.environment.toLowerCase() === env.toLowerCase();
  }

  private load(ids: string[], direction: "out" | "in") {
    const cache = direction === "out" ? this.outCache : this.inCache;
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    for (const chunk of chunks(missing)) {
      this.fetches++;
      for (const id of chunk) cache.set(id, []);
      const filter = direction === "out" ? { sourceIds: chunk } : { targetIds: chunk };
      for (const r of this.store.findRelationships(filter)) {
        const env = typeof r.metadata.environment === "string" ? r.metadata.environment : null;
        const edge: Edge = { id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId, evidence: r.evidence, confidence: r.confidence, graphScope: "repository", repositoryId: r.repositoryId, targetRepositoryId: r.repositoryId, environment: env, provenance: r.provenance[0] ?? null, metadata: r.metadata };
        if (this.accept(edge)) cache.get(direction === "out" ? r.sourceId : r.targetId)!.push(edge);
      }
      if (this.options.scope !== "repository") {
        for (const r of this.store.findMetaRelationships(filter)) {
          const edge: Edge = { id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId, evidence: r.evidence, confidence: r.confidence, graphScope: "meta", repositoryId: r.sourceRepositoryId, targetRepositoryId: r.targetRepositoryId, environment: r.environment, provenance: r.provenance[0] ?? null, metadata: r.metadata };
          if (this.accept(edge)) cache.get(direction === "out" ? r.sourceId : r.targetId)!.push(edge);
        }
      }
      for (const id of chunk) cache.get(id)!.sort(byEdge);
    }
  }

  out(ids: string[], types?: RelationshipType[]): Map<string, Edge[]> {
    this.load(ids, "out");
    return new Map(ids.map((id) => [id, (this.outCache.get(id) ?? []).filter((e) => !types || types.includes(e.type))]));
  }

  in(ids: string[], types?: RelationshipType[]): Map<string, Edge[]> {
    this.load(ids, "in");
    return new Map(ids.map((id) => [id, (this.inCache.get(id) ?? []).filter((e) => !types || types.includes(e.type))]));
  }

  ofKind(kinds: EntityKind[], repositoryId?: string): Entity[] {
    return this.store.findEntities({ kinds, repositoryId });
  }
}

export interface EntityRef {
  id: string;
  kind: EntityKind;
  name: string;
  qualifiedName: string | null;
  repositoryId: string | null;
  graphScope: "repository" | "meta";
  location: string | null;
}

export const ref = (e: Entity): EntityRef => ({
  id: e.id, kind: e.kind, name: e.name, qualifiedName: e.qualifiedName, repositoryId: e.repositoryId, graphScope: e.layer === "meta" ? "meta" : "repository",
  location: e.location ? `${e.location.file}:${e.location.startLine}` : null,
});
