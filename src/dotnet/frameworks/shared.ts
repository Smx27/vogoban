import { ids, keys } from "../../graph/identity.ts";
import type { EvidenceLevel, Provenance, RelationshipType } from "../../graph/model.ts";
import { artifactKey, type AnalysisContext } from "../../plugins/types.ts";
import { DOTNET_PROJECTS, DOTNET_SEMANTIC, type DotnetProject } from "../artifacts.ts";
import type { ArgValue, FactLocation, InvocationFact, ReceiverFact, SemanticProjectFacts, SymRef, SymbolFact } from "../semantic-facts.ts";
import { SymbolEntities, toSourceLocation } from "../semantic-graph.ts";

export interface IndexedInvocation {
  invocation: InvocationFact;
  project: DotnetProject;
  owner: string | null;
  method: string;
}

export interface SemanticIndex {
  projects: Map<string, DotnetProject>;
  facts: SemanticProjectFacts[];
  symbols: Map<string, { symbol: SymbolFact; project: DotnetProject }>;
  symbolsByQualifiedName: Map<string, SymbolFact>;
  members: Map<string, SymbolFact[]>;
  invocations: IndexedInvocation[];
  invocationsByLocation: Map<string, IndexedInvocation>;
  calls: Map<string, string[]>;
  overridden: Set<string>;
}

const SEMANTIC_INDEX = artifactKey<SemanticIndex | null>("dotnet.frameworks.index");

export function locationKey(l: FactLocation | undefined): string {
  return l ? `${l.file}:${l.line}:${l.column}-${l.endLine}:${l.endColumn}` : "";
}

export { memberPath, stripGenerics } from "../names.ts";
import { memberPath, stripGenerics } from "../names.ts";

export function methodName(ref: SymRef | undefined): string {
  return ref ? (memberPath(ref.qualifiedName).split(".").pop() ?? "") : "";
}

export function containingTypeName(ref: SymRef | undefined): string | null {
  return ref?.containingType ? stripGenerics(ref.containingType.qualifiedName) : null;
}

export function semanticIndex(ctx: AnalysisContext): SemanticIndex | null {
  const cached = ctx.artifacts.get(SEMANTIC_INDEX);
  if (cached !== undefined) return cached;
  const facts = ctx.artifacts.get(DOTNET_SEMANTIC);
  const projectList = ctx.artifacts.get(DOTNET_PROJECTS);
  if (!facts?.length || !projectList) {
    ctx.artifacts.set(SEMANTIC_INDEX, null);
    return null;
  }
  const projects = new Map(projectList.map((p) => [p.entityId, p]));
  const index: SemanticIndex = {
    projects,
    facts,
    symbols: new Map(),
    symbolsByQualifiedName: new Map(),
    members: new Map(),
    invocations: [],
    invocationsByLocation: new Map(),
    calls: new Map(),
    overridden: new Set(),
  };
  for (const f of facts) {
    const project = projects.get(f.projectId);
    if (!project) continue;
    for (const s of f.symbols) {
      index.symbols.set(s.key, { symbol: s, project });
      if (!s.containerKey || ["Class", "Record", "Struct", "RecordStruct", "Interface"].includes(s.kind)) index.symbolsByQualifiedName.set(s.qualifiedName, s);
      if (s.containerKey) {
        const list = index.members.get(s.containerKey) ?? [];
        list.push(s);
        index.members.set(s.containerKey, list);
      }
    }
    for (const r of f.relations) {
      if (r.type === "CALLS" && !r.target.external) {
        const list = index.calls.get(r.source) ?? [];
        list.push(r.target.key);
        index.calls.set(r.source, list);
      }
      if (r.type === "OVERRIDES") index.overridden.add(r.target.key);
    }
    for (const invocation of f.invocations) {
      const indexed = { invocation, project, owner: containingTypeName(invocation.target), method: methodName(invocation.target) };
      index.invocations.push(indexed);
      index.invocationsByLocation.set(locationKey(invocation.location), indexed);
    }
  }
  ctx.artifacts.set(SEMANTIC_INDEX, index);
  return index;
}

export function entityIdOf(ctx: AnalysisContext, symbolKey: string): string {
  return ids.entity(keys.symbol(ctx.repository.id, symbolKey));
}

export function arg(args: ArgValue[], parameter: string, fallbackIndex?: number): ArgValue | undefined {
  return args.find((a) => a.parameter === parameter || a.name === parameter) ?? (fallbackIndex !== undefined && !args.some((a) => a.parameter) ? args[fallbackIndex] : undefined);
}

export function constant(value: ArgValue | undefined): string | null {
  return value && (value.kind === "string" || value.kind === "number" || value.kind === "enum" || value.kind === "bool") ? (value.value ?? null) : null;
}

export function stringArgs(value: ArgValue | undefined): string[] {
  if (!value) return [];
  if (value.kind === "string" && value.value) return [value.value];
  if (value.kind === "array") return (value.items ?? []).flatMap(stringArgs);
  return [];
}

export function attr(symbol: { attributes: SymbolFact["attributes"] }, ...names: string[]) {
  return symbol.attributes.filter((a) => names.includes(stripGenerics(a.type.qualifiedName)));
}

export function attrValue(attribute: { arguments: ArgValue[] }, named: string, positional?: number): string | null {
  const byName = attribute.arguments.find((a) => a.name === named);
  if (byName) return byName.value ?? null;
  const positionalArgs = attribute.arguments.filter((a) => !a.name);
  return positional !== undefined ? (positionalArgs[positional]?.value ?? null) : null;
}

export function receiverChain(receiver: ReceiverFact | undefined): ReceiverFact[] {
  const chain: ReceiverFact[] = [];
  for (let r = receiver; r; r = r.receiver) chain.push(r);
  return chain;
}

export function within(location: FactLocation, span: FactLocation | undefined): boolean {
  if (!span || location.file !== span.file) return false;
  const pos = (line: number, col: number) => line * 100000 + col;
  return pos(location.line, location.column) >= pos(span.line, span.column) && pos(location.line, location.column) <= pos(span.endLine, span.endColumn);
}

export function frameworkProvenance(ctx: AnalysisContext, plugin: string, evidenceKind: string, version: string, location?: FactLocation | null, resolver?: string): Provenance {
  return ctx.provenance({
    plugin,
    extractor: evidenceKind,
    mechanism: "roslyn-semantic-model+framework-rules",
    resolver: resolver ?? null,
    version,
    location: location ? toSourceLocation(location) : null,
  });
}

export function refs(ctx: AnalysisContext, version: string): SymbolEntities {
  return new SymbolEntities(ctx, version);
}

export function frameworkFailure(ctx: AnalysisContext, plugin: string, code: string, error: unknown, file: string | null = null) {
  ctx.graph.diagnostic({
    repositoryId: ctx.repository.id,
    category: "framework",
    plugin,
    file,
    severity: "error",
    recoverable: true,
    code,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function unresolvedFramework(
  ctx: AnalysisContext,
  plugin: string,
  input: { type: RelationshipType; sourceId: string; display: string; reason: string; category: string; location?: FactLocation; version: string; metadata?: Record<string, string | null> },
) {
  ctx.graph.unresolved({
    type: input.type,
    sourceId: input.sourceId,
    repositoryId: ctx.repository.id,
    targetDisplay: input.display,
    resolver: plugin,
    reason: input.reason,
    metadata: { category: input.category, ...input.metadata },
    provenance: frameworkProvenance(ctx, plugin, "UNRESOLVED_FRAMEWORK_PATTERN", input.version, input.location),
  });
}

export function relate(
  ctx: AnalysisContext,
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  evidence: EvidenceLevel,
  provenance: Provenance,
  metadata: Record<string, string | number | boolean | null | string[]> = {},
) {
  ctx.graph.relate({ type, sourceId, targetId, repositoryId: ctx.repository.id, evidence, metadata, provenance });
}
