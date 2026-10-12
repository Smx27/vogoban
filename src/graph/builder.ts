import {
  EVIDENCE_LEVELS,
  type Conflict,
  type Diagnostic,
  type Entity,
  type EntityKind,
  type EvidenceLevel,
  type GraphBatch,
  type GraphLayer,
  type Metadata,
  type Provenance,
  type Relationship,
  type RelationshipType,
  type Severity,
  type SourceLocation,
  type UnresolvedReference,
  type DiagnosticCategory,
} from "./model.ts";
import { ids } from "./identity.ts";

export interface EntityDraft {
  key: string;
  kind: EntityKind;
  layer: GraphLayer;
  name: string;
  qualifiedName?: string | null;
  repositoryId: string | null;
  projectId?: string | null;
  assembly?: string | null;
  language?: string | null;
  symbolKey?: string | null;
  location?: SourceLocation | null;
  external?: boolean;
  metadata?: Metadata;
  provenance: Provenance;
}

export interface RelationshipDraft {
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  repositoryId: string | null;
  evidence: EvidenceLevel;
  confidence?: number;
  metadata?: Metadata;
  provenance: Provenance;
  additionalProvenance?: Provenance[];
  occurrences?: number;
}

export interface UnresolvedDraft {
  type: RelationshipType;
  sourceId: string;
  repositoryId: string;
  targetDisplay: string;
  resolver: string;
  reason: string;
  confidence?: number;
  metadata?: Metadata;
  provenance: Provenance;
}

export interface DiagnosticDraft {
  repositoryId: string;
  category: DiagnosticCategory;
  plugin: string;
  file: string | null;
  severity: Severity;
  recoverable: boolean;
  code: string;
  message: string;
}

const evidenceRank = (level: EvidenceLevel) => EVIDENCE_LEVELS.indexOf(level);
const MAX_PROVENANCE = 50;

function provenanceKey(p: Provenance): string {
  const l = p.location;
  return `${p.plugin}|${p.extractor}|${p.mechanism}|${l ? `${l.file}:${l.startLine}:${l.startColumn}` : ""}`;
}

function appendProvenance(list: Provenance[], p: Provenance) {
  if (list.length >= MAX_PROVENANCE) return;
  const key = provenanceKey(p);
  if (!list.some((existing) => provenanceKey(existing) === key)) list.push(p);
}

export class GraphBuilder {
  private readonly entities = new Map<string, Entity>();
  private readonly relationships = new Map<string, Relationship>();
  private readonly unresolvedRefs = new Map<string, UnresolvedReference>();
  private readonly diagnostics = new Map<string, Diagnostic>();
  private readonly conflicts = new Map<string, Conflict>();

  entity(draft: EntityDraft): string {
    const id = ids.entity(draft.key);
    const existing = this.entities.get(id);
    if (existing) {
      appendProvenance(existing.provenance, draft.provenance);
      existing.metadata = { ...draft.metadata, ...existing.metadata };
      if (!existing.location && draft.location) existing.location = draft.location;
      if ((existing.external && draft.external === false) || (!existing.location && draft.location)) {
        const provenance = [draft.provenance, ...existing.provenance.filter((p) => provenanceKey(p) !== provenanceKey(draft.provenance))];
        Object.assign(existing, this.toEntity(id, draft), { provenance, metadata: { ...existing.metadata, ...draft.metadata } });
      }
      return id;
    }
    this.entities.set(id, this.toEntity(id, draft));
    return id;
  }

  annotate(id: string, metadata: Metadata, provenance: Provenance): void {
    const existing = this.entities.get(id);
    if (!existing) return;
    for (const [key, value] of Object.entries(metadata)) {
      const current = existing.metadata[key];
      existing.metadata[key] = Array.isArray(current) && Array.isArray(value) ? ([...new Set([...current, ...value])] as string[]) : value;
    }
    appendProvenance(existing.provenance, provenance);
  }

  has(id: string): boolean {
    return this.entities.has(id);
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  allEntities(): Iterable<Entity> {
    return this.entities.values();
  }

  allRelationships(): Iterable<Relationship> {
    return this.relationships.values();
  }

  relate(draft: RelationshipDraft): string {
    const id = ids.relationship(draft.type, draft.sourceId, draft.targetId);
    const existing = this.relationships.get(id);
    if (existing) {
      appendProvenance(existing.provenance, draft.provenance);
      for (const p of draft.additionalProvenance ?? []) appendProvenance(existing.provenance, p);
      existing.metadata.occurrences = Number(existing.metadata.occurrences ?? 1) + (draft.occurrences ?? 1);
      if (evidenceRank(draft.evidence) < evidenceRank(existing.evidence)) {
        existing.evidence = draft.evidence;
        existing.metadata = { ...existing.metadata, ...draft.metadata };
        existing.confidence = Math.max(existing.confidence, draft.confidence ?? 1);
      }
      return id;
    }
    this.relationships.set(id, {
      id,
      type: draft.type,
      sourceId: draft.sourceId,
      targetId: draft.targetId,
      repositoryId: draft.repositoryId,
      evidence: draft.evidence,
      confidence: draft.confidence ?? 1,
      metadata: { ...draft.metadata, ...(draft.occurrences && draft.occurrences > 1 ? { occurrences: draft.occurrences } : {}) },
      provenance: [draft.provenance],
    });
    for (const p of draft.additionalProvenance ?? []) appendProvenance(this.relationships.get(id)!.provenance, p);
    return id;
  }

  unresolved(draft: UnresolvedDraft): string {
    const id = ids.unresolved(draft.type, draft.sourceId, draft.targetDisplay);
    const existing = this.unresolvedRefs.get(id);
    if (existing) {
      appendProvenance(existing.provenance, draft.provenance);
      return id;
    }
    this.unresolvedRefs.set(id, {
      id,
      type: draft.type,
      sourceId: draft.sourceId,
      repositoryId: draft.repositoryId,
      targetDisplay: draft.targetDisplay,
      resolver: draft.resolver,
      reason: draft.reason,
      confidence: draft.confidence ?? 0,
      metadata: { ...draft.metadata },
      provenance: [draft.provenance],
    });
    return id;
  }

  diagnostic(draft: DiagnosticDraft): void {
    const id = ids.diagnostic(draft.repositoryId, draft.plugin, draft.file ?? "", draft.code, draft.message);
    if (!this.diagnostics.has(id)) this.diagnostics.set(id, { id, ...draft });
  }

  conflict(conflict: Omit<Conflict, "id">): void {
    const id = ids.conflict(conflict.kind, conflict.subject);
    this.conflicts.set(id, { id, ...conflict });
  }

  finalize(): GraphBatch {
    for (const rel of this.relationships.values()) {
      if (this.entities.has(rel.sourceId) && this.entities.has(rel.targetId)) continue;
      this.relationships.delete(rel.id);
      if (rel.repositoryId) {
        this.diagnostic({
          repositoryId: rel.repositoryId,
          category: "resolver",
          plugin: rel.provenance[0]?.plugin ?? "builder",
          file: rel.provenance[0]?.location?.file ?? null,
          severity: "warning",
          recoverable: true,
          code: "dangling-relationship",
          message: `${rel.type} ${rel.sourceId} -> ${rel.targetId} references an entity that was not produced`,
        });
      }
    }
    for (const ref of this.unresolvedRefs.values()) {
      if (!this.entities.has(ref.sourceId)) this.unresolvedRefs.delete(ref.id);
    }
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return {
      entities: [...this.entities.values()].sort(byId),
      relationships: [...this.relationships.values()].sort(byId),
      unresolved: [...this.unresolvedRefs.values()].sort(byId),
      diagnostics: [...this.diagnostics.values()].sort(byId),
      conflicts: [...this.conflicts.values()].sort(byId),
    };
  }

  private toEntity(id: string, draft: EntityDraft): Entity {
    return {
      id,
      key: draft.key,
      kind: draft.kind,
      layer: draft.layer,
      name: draft.name,
      qualifiedName: draft.qualifiedName ?? null,
      repositoryId: draft.repositoryId,
      projectId: draft.projectId ?? null,
      assembly: draft.assembly ?? null,
      language: draft.language ?? null,
      symbolKey: draft.symbolKey ?? null,
      location: draft.location ?? null,
      external: draft.external ?? false,
      metadata: { ...draft.metadata },
      provenance: [draft.provenance],
    };
  }
}
