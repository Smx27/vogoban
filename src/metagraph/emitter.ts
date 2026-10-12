import { stableId } from "../graph/identity.ts";
import {
  EVIDENCE_LEVELS,
  type CatalogEntry,
  type Entity,
  type EntityKind,
  type EvidenceLevel,
  type MetaBatch,
  type MetaConflict,
  type MetaRelationship,
  type MetaUnresolved,
  type Metadata,
  type Provenance,
  type RelationshipType,
  type RepositoryStatus,
} from "../graph/model.ts";

export interface RepoView {
  entry: CatalogEntry;
  status: RepositoryStatus;
  repositoryEntityId: string;
}

export interface Endpoint {
  id: string;
  repositoryId: string | null;
  provenance?: Provenance[];
}

const MAX_PROVENANCE = 50;
const rank = (e: EvidenceLevel) => EVIDENCE_LEVELS.indexOf(e);
const provKey = (p: Provenance) => `${p.repositoryId}|${p.plugin}|${p.extractor}|${p.location ? `${p.location.file}:${p.location.startLine}` : ""}`;

function addProvenance(list: Provenance[], items: Provenance[]) {
  for (const p of items) {
    if (list.length >= MAX_PROVENANCE) return;
    if (!list.some((x) => provKey(x) === provKey(p))) list.push(p);
  }
}

export class MetaEmitter {
  private readonly entities = new Map<string, Entity>();
  private readonly relationships = new Map<string, MetaRelationship>();
  private readonly unresolvedRefs = new Map<string, MetaUnresolved>();
  private readonly conflicts = new Map<string, MetaConflict>();

  constructor(
    readonly category: string,
    readonly resolver: string,
    readonly version: string,
    readonly snapshotId: string,
    readonly repos: Map<string, RepoView>,
  ) {}

  provenance(extractor: string, mechanism = "cross-repository-resolution"): Provenance {
    return { repositoryId: null, commit: null, location: null, plugin: `metagraph.${this.resolver}`, extractor, resolver: `metagraph.${this.resolver}`, mechanism, analysisVersion: this.version };
  }

  repositoryEntity(repositoryId: string): Endpoint {
    return { id: this.repos.get(repositoryId)!.repositoryEntityId, repositoryId };
  }

  entity(input: { key: string; kind: EntityKind; name: string; qualifiedName?: string | null; metadata?: Metadata; extractor: string }): string {
    const id = stableId("me", input.key);
    const existing = this.entities.get(id);
    if (existing) {
      for (const [k, v] of Object.entries(input.metadata ?? {})) {
        const cur = existing.metadata[k];
        existing.metadata[k] = Array.isArray(cur) && Array.isArray(v) ? ([...new Set([...cur, ...v])].sort() as string[]) : (cur ?? v);
      }
      return id;
    }
    this.entities.set(id, {
      id, key: input.key, kind: input.kind, layer: "meta", name: input.name, qualifiedName: input.qualifiedName ?? null, repositoryId: null, projectId: null,
      assembly: null, language: null, symbolKey: null, location: null, external: false, metadata: { graphScope: "meta", ...input.metadata }, provenance: [this.provenance(input.extractor)],
    });
    return id;
  }

  private sideMetadata(prefix: "source" | "target", repositoryId: string | null): Metadata {
    if (!repositoryId) return { [`${prefix}Scope`]: "meta" };
    const repo = this.repos.get(repositoryId)?.entry;
    return { [`${prefix}Scope`]: "repository", [`${prefix}Repository`]: repo?.name ?? repositoryId, [`${prefix}Commit`]: repo?.analyzedCommit ?? null, [`${prefix}GraphVersion`]: repo?.graphVersion ?? null };
  }

  relate(input: {
    type: RelationshipType;
    source: Endpoint;
    target: Endpoint;
    evidence: EvidenceLevel;
    confidence: number;
    evidenceKinds: string[];
    extractor: string;
    environment?: string | null;
    metadata?: Metadata;
  }): string {
    const env = input.environment ?? null;
    const id = stableId("mr", `${this.category}|${input.type}|${input.source.id}|${input.target.id}|${env ?? ""}`);
    const sideProv = [...(input.source.provenance ?? []).slice(0, 3), ...(input.target.provenance ?? []).slice(0, 3)];
    const existing = this.relationships.get(id);
    if (existing) {
      existing.metadata.evidenceKinds = [...new Set([...(existing.metadata.evidenceKinds as string[]), ...input.evidenceKinds])].sort();
      existing.metadata.occurrences = Number(existing.metadata.occurrences ?? 1) + 1;
      if (rank(input.evidence) < rank(existing.evidence)) existing.evidence = input.evidence;
      existing.confidence = Math.max(existing.confidence, input.confidence);
      for (const [k, v] of Object.entries(input.metadata ?? {})) {
        const cur = existing.metadata[k];
        if (Array.isArray(cur) && Array.isArray(v)) existing.metadata[k] = [...new Set([...cur, ...v])].sort() as string[];
      }
      addProvenance(existing.provenance, sideProv);
      return id;
    }
    const provenance = [this.provenance(input.extractor)];
    addProvenance(provenance, sideProv);
    this.relationships.set(id, {
      id,
      type: input.type,
      sourceId: input.source.id,
      targetId: input.target.id,
      repositoryId: null,
      evidence: input.evidence,
      confidence: input.confidence,
      metadata: {
        ...input.metadata,
        graphScope: "meta",
        resolver: `metagraph.${this.resolver}@${this.version}`,
        evidenceKinds: [...new Set(input.evidenceKinds)].sort(),
        ...this.sideMetadata("source", input.source.repositoryId),
        ...this.sideMetadata("target", input.target.repositoryId),
      },
      provenance,
      category: this.category,
      sourceRepositoryId: input.source.repositoryId,
      targetRepositoryId: input.target.repositoryId,
      environment: env,
      snapshotId: this.snapshotId,
    });
    return id;
  }

  unresolved(input: { type: RelationshipType; source: Endpoint; display: string; reason: string; category: string; extractor: string; metadata?: Metadata; confidence?: number }) {
    const id = stableId("mu", `${this.category}|${input.type}|${input.source.id}|${input.display}`);
    const existing = this.unresolvedRefs.get(id);
    if (existing) {
      addProvenance(existing.provenance, input.source.provenance ?? []);
      return;
    }
    const provenance = [this.provenance(input.extractor)];
    addProvenance(provenance, (input.source.provenance ?? []).slice(0, 3));
    this.unresolvedRefs.set(id, {
      id, category: this.category, type: input.type, sourceId: input.source.id, repositoryId: input.source.repositoryId ?? "",
      targetDisplay: input.display, resolver: `metagraph.${this.resolver}`, reason: input.reason, confidence: input.confidence ?? 0,
      metadata: { category: input.category, ...this.sideMetadata("source", input.source.repositoryId), ...input.metadata }, provenance,
    });
  }

  conflict(input: { kind: string; subject: string; factIds: string[]; description: string; severity?: "info" | "warning" | "error"; provenance?: Provenance[] }) {
    const id = stableId("mc", `${this.category}|${input.kind}|${input.subject}`);
    const provenance = [this.provenance("CONFLICT")];
    addProvenance(provenance, input.provenance ?? []);
    this.conflicts.set(id, { id, category: this.category, repositoryId: null, kind: input.kind, subject: input.subject, factIds: [...new Set(input.factIds)].sort(), severity: input.severity ?? "warning", status: "unresolved", description: input.description, provenance });
  }

  batch(): MetaBatch {
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      entities: [...this.entities.values()].sort(byId),
      relationships: [...this.relationships.values()].sort(byId),
      unresolved: [...this.unresolvedRefs.values()].sort(byId),
      conflicts: [...this.conflicts.values()].sort(byId),
    };
  }
}
