import type { EvidenceLevel, Metadata, Provenance, RelationshipType, SourceLocation } from "../graph/model.ts";
import type { FactLocation } from "../dotnet/semantic-facts.ts";
import type { AnalysisContext } from "../plugins/types.ts";

export function azRelate(ctx: AnalysisContext, type: RelationshipType, sourceId: string, targetId: string, evidence: EvidenceLevel, provenance: Provenance, metadata: Metadata = {}, confidence = 1): string {
  return ctx.graph.relate({ type, sourceId, targetId, repositoryId: ctx.repository.id, evidence, confidence, metadata, provenance });
}

export function azProv(ctx: AnalysisContext, plugin: string, version: string, extractor: string, mechanism: string, location: SourceLocation | FactLocation | null | undefined, resolver: string | null = null): Provenance {
  const loc: SourceLocation | null = !location ? null : "startLine" in location ? location : { file: location.file, startLine: location.line, startColumn: location.column };
  return ctx.provenance({ plugin, extractor, mechanism, version, resolver, location: loc });
}

export function azUnresolved(ctx: AnalysisContext, plugin: string, input: { type: RelationshipType; sourceId: string; display: string; reason: string; category: string; provenance: Provenance; metadata?: Metadata }) {
  ctx.graph.unresolved({ type: input.type, sourceId: input.sourceId, repositoryId: ctx.repository.id, targetDisplay: input.display, resolver: plugin, reason: input.reason, metadata: { category: input.category, ...input.metadata }, provenance: input.provenance });
}

export const toSource = (l: FactLocation | null | undefined): SourceLocation | null => (l ? { file: l.file, startLine: l.line, startColumn: l.column } : null);
