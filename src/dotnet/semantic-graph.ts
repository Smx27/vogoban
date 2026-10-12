import { keys } from "../graph/identity.ts";
import { memberPath } from "./names.ts";
import { isRelationshipType, type EntityKind, type Metadata, type Provenance, type SourceLocation } from "../graph/model.ts";
import type { AnalysisContext } from "../plugins/types.ts";
import { DOTNET_PROJECTS, type DotnetProject } from "./artifacts.ts";
import type { FactLocation, SemanticProjectFacts, SymRef, SymbolFact, UnresolvedFact } from "./semantic-facts.ts";

const PLUGIN = "dotnet.roslyn";
const PRIMITIVES = new Set([
  "string", "int", "long", "short", "byte", "sbyte", "uint", "ulong", "ushort", "bool", "char", "double", "float", "decimal", "object", "void", "nint", "nuint",
]);

export function entityKindFor(kind: string): EntityKind | null {
  switch (kind) {
    case "Class": case "Interface": case "Struct": case "Enum": case "Delegate": case "Record": case "RecordStruct":
      return "Type";
    case "Method": case "Constructor": case "Operator": case "Destructor":
      return "Method";
    case "Property": case "Indexer":
      return "Property";
    case "Field": case "EnumMember":
      return "Field";
    case "Event":
      return "Event";
    default:
      return null;
  }
}

const MISSING_REFERENCE = new Set(["CS0246", "CS0234", "CS0012", "CS0400", "CS0518", "CS0006", "CS0009"]);
const MISSING_MEMBER = new Set(["CS0103", "CS0117", "CS1061", "CS0426", "CS7036"]);
const OVERLOAD = new Set(["CS1501", "CS1503", "CS0121", "CS1502", "CS0411", "CS1929"]);

export function unresolvedCategory(u: UnresolvedFact, project: DotnetProject, facts: SemanticProjectFacts): string {
  const allFrameworks = facts.frameworks.length;
  if (u.targetFrameworks && u.targetFrameworks.length < allFrameworks) return "conditional-compilation";
  if (u.cascadedFrom) return "dependent-on-unresolved-type";
  const simpleName = u.display.split(/[<(]/)[0]!.split(".").pop() ?? "";
  if (project.razorComponents.includes(simpleName)) return "generated-dependency-unavailable";
  const declaresPackages = project.packages.length > 0 || facts.frameworks.some((f) => (f.packageReferences?.length ?? 0) > 0);
  const unrestored = declaresPackages && facts.frameworks.some((f) => !f.restored);
  const id = u.diagnosticId ?? "";
  if (MISSING_REFERENCE.has(id)) return unrestored ? "missing-package" : "missing-assembly";
  if (MISSING_MEMBER.has(id)) return unrestored ? "missing-package" : "unknown-symbol";
  if (OVERLOAD.has(id)) return "overload-resolution";
  if (id === "CS0122") return "inaccessible";
  if (id) return "compilation-failure";
  return "analyzer-limitation";
}

export function toSourceLocation(l: FactLocation): SourceLocation {
  return { file: l.file, startLine: l.line, startColumn: l.column, endLine: l.endLine, endColumn: l.endColumn };
}

export function symbolEntityKey(repositoryId: string, ref: { key: string; external: boolean }): string {
  return keys.symbol(ref.external ? null : repositoryId, ref.key);
}

export class SymbolEntities {
  constructor(private readonly ctx: AnalysisContext, private readonly version: string) {}

  private prov(extractor: string, location: FactLocation | null | undefined): Provenance {
    return this.ctx.provenance({ plugin: PLUGIN, extractor, mechanism: "roslyn-semantic-model", version: this.version, location: location ? toSourceLocation(location) : null });
  }

  ensureRef(ref: SymRef, observedAt: FactLocation | null | undefined): string | null {
    const kind = entityKindFor(ref.kind);
    if (!kind || ref.key === "?") return null;
    const key = symbolEntityKey(this.ctx.repository.id, ref);
    const graph = this.ctx.graph;
    const id = graph.entity({
      key,
      kind,
      layer: "semantic",
      name: memberPath(ref.display).split(".").pop() || ref.display,
      qualifiedName: ref.qualifiedName,
      repositoryId: ref.external ? null : this.ctx.repository.id,
      assembly: ref.assembly ?? null,
      language: "csharp",
      symbolKey: ref.key,
      external: ref.external,
      metadata: { symbolKind: ref.kind },
      provenance: this.prov(ref.external ? "metadata-reference" : "source-reference", observedAt),
    });
    if (ref.external && ref.containingType) {
      const owner = this.ensureRef(ref.containingType, observedAt);
      if (owner) {
        graph.relate({ type: "DECLARES", sourceId: owner, targetId: id, repositoryId: this.ctx.repository.id, evidence: "COMPILER_RESOLVED", provenance: this.prov("metadata-reference", observedAt) });
      }
    }
    return id;
  }

  typeTargets(ref: SymRef | undefined): SymRef[] {
    if (!ref) return [];
    const out: SymRef[] = [];
    const visit = (r: SymRef) => {
      if (r.kind !== "TypeParameter" && !PRIMITIVES.has(r.qualifiedName) && entityKindFor(r.kind)) out.push(r);
      r.typeArguments?.forEach(visit);
    };
    visit(ref);
    return out;
  }
}

export function emitSemanticGraph(ctx: AnalysisContext, project: DotnetProject, facts: SemanticProjectFacts, version: string): void {
  const { graph, repository } = ctx;
  const repoId = repository.id;
  const refs = new SymbolEntities(ctx, version);
  const prov = (extractor: string, location?: FactLocation | null): Provenance =>
    ctx.provenance({ plugin: PLUGIN, extractor, mechanism: "roslyn-semantic-model", version, location: location ? toSourceLocation(location) : null });

  const generatedFiles = new Set(ctx.files.filter((f) => f.generated).map((f) => f.path));
  const allFrameworks = facts.frameworks.length;
  const frameworkMeta = (tfms: string[] | undefined): Metadata => (tfms && tfms.length < allFrameworks ? { targetFrameworks: tfms } : {});
  const idByKey = new Map<string, string>();
  const namespaceIds = new Map<string, string>();
  const ensureNamespace = (name: string): string | null => {
    if (!name) return null;
    const known = namespaceIds.get(name);
    if (known) return known;
    const id = graph.entity({
      key: keys.namespace(repoId, name), kind: "Namespace", layer: "semantic", name: name.split(".").pop()!, qualifiedName: name,
      repositoryId: repoId, language: "csharp", provenance: prov("namespace"),
    });
    namespaceIds.set(name, id);
    const parent = name.includes(".") ? ensureNamespace(name.slice(0, name.lastIndexOf("."))) : null;
    if (parent) graph.relate({ type: "CONTAINS", sourceId: parent, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("namespace") });
    graph.relate({ type: "CONTAINS", sourceId: project.entityId, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("namespace") });
    return id;
  };

  const declareSymbol = (symbol: SymbolFact) => {
    const kind = entityKindFor(symbol.kind);
    if (!kind) return;
    const id = graph.entity({
      key: keys.symbol(repoId, symbol.key),
      kind,
      layer: "semantic",
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      repositoryId: repoId,
      projectId: project.entityId,
      assembly: project.assemblyName,
      language: "csharp",
      symbolKey: symbol.key,
      location: symbol.location ? toSourceLocation(symbol.location) : null,
      external: false,
      metadata: {
        symbolKind: symbol.kind,
        signature: symbol.signature,
        accessibility: symbol.accessibility,
        modifiers: symbol.modifiers,
        namespace: symbol.namespace,
        returnType: symbol.returnTypeDisplay ?? null,
        parameterCount: symbol.parameters.length,
        arity: symbol.arity,
        generated: symbol.generated,
        implicit: symbol.implicit,
        ...(symbol.conditions ? { conditions: symbol.conditions } : {}),
        ...frameworkMeta(symbol.targetFrameworks),
      },
      provenance: prov("declaration", symbol.location),
    });
    idByKey.set(symbol.key, id);
  };

  for (const symbol of facts.symbols) declareSymbol(symbol);

  for (const symbol of facts.symbols) {
    const id = idByKey.get(symbol.key);
    if (!id) continue;
    const location = symbol.location;
    const container = symbol.containerKey ? idByKey.get(symbol.containerKey) : undefined;
    if (container) {
      graph.relate({ type: "DECLARES", sourceId: container, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("declaration", location) });
    } else if (entityKindFor(symbol.kind) === "Type") {
      const ns = ensureNamespace(symbol.namespace);
      graph.relate({ type: "CONTAINS", sourceId: ns ?? project.entityId, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("declaration", location) });
      graph.relate({ type: "ASSEMBLY_CONTAINS", sourceId: project.assemblyEntityId, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("declaration", location) });
    }
    for (const loc of [location, ...symbol.additionalLocations]) {
      const fileId = loc ? ctx.fileEntityId(loc.file) : undefined;
      if (fileId) graph.relate({ type: "DECLARES", sourceId: fileId, targetId: id, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("declaration", loc) });
    }
    for (const attr of symbol.attributes) {
      const target = refs.ensureRef(attr.type, location);
      if (!target) continue;
      graph.relate({
        type: "ATTRIBUTED_WITH", sourceId: id, targetId: target, repositoryId: repoId, evidence: "COMPILER_RESOLVED",
        metadata: { arguments: attr.arguments.map((a) => `${a.name ? `${a.name}=` : ""}${a.value ?? a.type?.qualifiedName ?? a.kind}`) },
        provenance: prov("attribute", location),
      });
    }
    for (const parameter of symbol.parameters) {
      const paramId = graph.entity({
        key: `${keys.symbol(repoId, symbol.key)}#param:${parameter.ordinal}`,
        kind: "Parameter",
        layer: "semantic",
        name: parameter.name,
        qualifiedName: `${symbol.qualifiedName}#${parameter.name}`,
        repositoryId: repoId,
        projectId: project.entityId,
        assembly: project.assemblyName,
        language: "csharp",
        symbolKey: `${symbol.key}#${parameter.ordinal}`,
        location: symbol.location ? toSourceLocation(symbol.location) : null,
        metadata: {
          ordinal: parameter.ordinal,
          type: parameter.typeDisplay,
          refKind: parameter.refKind ?? null,
          isParams: parameter.isParams,
          hasDefault: parameter.hasDefault,
          extensionReceiver: parameter.ordinal === 0 && symbol.modifiers.includes("extension"),
        },
        provenance: prov("parameter", location),
      });
      graph.relate({ type: "ACCEPTS_PARAMETER", sourceId: id, targetId: paramId, repositoryId: repoId, evidence: "COMPILER_RESOLVED", metadata: { ordinal: parameter.ordinal }, provenance: prov("parameter", location) });
      for (const t of refs.typeTargets(parameter.type)) {
        const typeId = refs.ensureRef(t, location);
        if (!typeId) continue;
        graph.relate({ type: "USES_TYPE", sourceId: paramId, targetId: typeId, repositoryId: repoId, evidence: "COMPILER_RESOLVED", provenance: prov("parameter", location) });
        graph.relate({ type: "USES_TYPE", sourceId: id, targetId: typeId, repositoryId: repoId, evidence: "COMPILER_RESOLVED", metadata: { role: "parameter" }, provenance: prov("parameter", location) });
      }
    }
  }

  for (const rel of facts.relations) {
    const sourceId = idByKey.get(rel.source);
    if (!sourceId || !isRelationshipType(rel.type)) continue;
    {
      const targetId = refs.ensureRef(rel.target, rel.locations[0]);
      if (!targetId || targetId === sourceId) continue;
      const [first, ...rest] = rel.locations;
      graph.relate({
        type: rel.type,
        sourceId,
        targetId,
        repositoryId: repoId,
        evidence: "COMPILER_RESOLVED",
        metadata: {
          ...(rel.target.typeArguments?.length ? { typeArguments: rel.target.typeArguments.map((t) => t.qualifiedName) } : {}),
          ...frameworkMeta(rel.targetFrameworks),
          ...(rel.locations.length > 0 && rel.locations.every((l) => generatedFiles.has(l.file)) ? { generatedSource: true } : {}),
        },
        occurrences: rel.count,
        provenance: prov(`relation:${rel.type.toLowerCase()}`, first),
        additionalProvenance: rest.map((l) => prov(`relation:${rel.type.toLowerCase()}`, l)),
      });
    }
  }

  for (const u of facts.unresolved) {
    const sourceId = idByKey.get(u.source);
    if (!sourceId || !isRelationshipType(u.type)) continue;
    graph.unresolved({
      type: u.type,
      sourceId,
      repositoryId: repoId,
      targetDisplay: u.display,
      resolver: PLUGIN,
      reason: u.reason,
      metadata: {
        category: unresolvedCategory(u, project, facts),
        diagnosticId: u.diagnosticId ?? null,
        cascadedFrom: u.cascadedFrom ?? null,
        candidates: u.candidates,
        ...frameworkMeta(u.targetFrameworks),
      },
      provenance: prov(`unresolved:${u.type.toLowerCase()}`, u.location),
    });
  }

  emitCompilationContext(ctx, project, facts, prov);
  ctx.log.info("semantic.normalized", {
    project: project.name,
    symbols: idByKey.size,
    relations: facts.relations.length,
    unresolved: facts.unresolved.length,
    frameworks: facts.frameworks.map((f) => f.targetFramework),
  });
}

function emitCompilationContext(ctx: AnalysisContext, project: DotnetProject, facts: SemanticProjectFacts, prov: (extractor: string, location?: FactLocation | null) => Provenance) {
  const { graph, repository } = ctx;
  const repoId = repository.id;
  graph.entity({
    key: keys.project(repoId, project.path),
    kind: "Project",
    layer: "repository",
    name: project.name,
    repositoryId: repoId,
    metadata: {
      semanticTargetFrameworks: facts.frameworks.map((f) => f.targetFramework),
      referencePacks: facts.frameworks.map((f) => `${f.targetFramework}: ${f.referencePack}${f.exactReferencePack ? "" : " (approximate)"}`),
      projectEvaluation: [...new Set(facts.frameworks.map((f) => f.evaluation))],
      compilerErrors: facts.compilerErrors,
      compilerWarnings: facts.compilerWarnings,
    },
    provenance: prov("compilation-context", null),
  });

  const evaluationProv = (file: string) =>
    ctx.provenance({ plugin: PLUGIN, extractor: "msbuild-evaluation", mechanism: "msbuild-project-evaluation", version: "1", location: { file, startLine: 1, startColumn: 1 } });
  const packageFrameworks = new Map<string, { name: string; version: string | null; frameworks: string[] }>();
  const compiledOnlyIn = new Map<string, string[]>();
  for (const framework of facts.frameworks) {
    if (framework.evaluationError && framework.evaluationError !== "disabled") {
      graph.diagnostic({
        repositoryId: repoId, category: "project", plugin: PLUGIN, file: project.path, severity: "warning", recoverable: true, code: "project-evaluation-failed",
        message: `MSBuild evaluation for ${framework.targetFramework} failed; using static project parsing (${framework.evaluationError})`,
      });
    }
    for (const pkg of framework.packageReferences ?? []) {
      const entry = packageFrameworks.get(pkg.name.toLowerCase()) ?? { name: pkg.name, version: pkg.version ?? null, frameworks: [] };
      entry.frameworks.push(framework.targetFramework);
      packageFrameworks.set(pkg.name.toLowerCase(), entry);
    }
    for (const file of framework.additionalSourceFiles) compiledOnlyIn.set(file, [...(compiledOnlyIn.get(file) ?? []), framework.targetFramework]);
  }
  for (const [file, frameworks] of compiledOnlyIn) {
    const fileId = ctx.fileEntityId(file);
    if (!fileId) continue;
    graph.relate({
      type: "PROJECT_CONTAINS", sourceId: project.entityId, targetId: fileId, repositoryId: repoId, evidence: "EXACT",
      metadata: { rule: "msbuild-evaluated-compile-item", ...(frameworks.length < facts.frameworks.length ? { targetFrameworks: frameworks } : {}) },
      provenance: evaluationProv(project.path),
    });
  }
  for (const pkg of packageFrameworks.values()) {
    const packageId = graph.entity({
      key: keys.package("nuget", pkg.name), kind: "Package", layer: "repository", name: pkg.name, qualifiedName: `nuget:${pkg.name}`,
      repositoryId: null, language: "dotnet", external: true, metadata: { ecosystem: "nuget" }, provenance: evaluationProv(project.path),
    });
    graph.relate({
      type: "PACKAGE_DEPENDS_ON", sourceId: project.entityId, targetId: packageId, repositoryId: repoId, evidence: "EXACT",
      metadata: { version: pkg.version, direct: true, versionSource: "msbuild-evaluation", ...(pkg.frameworks.length < facts.frameworks.length ? { targetFrameworks: pkg.frameworks } : {}) },
      provenance: evaluationProv(project.path),
    });
  }

  const assemblyEntityByProject = new Map((ctx.artifacts.get(DOTNET_PROJECTS) ?? []).map((p) => [p.entityId, p.assemblyEntityId]));
  const usage = new Map<string, { use: SemanticProjectFacts["frameworks"][number]["usedAssemblies"][number]; frameworks: string[] }>();
  for (const framework of facts.frameworks) {
    for (const use of framework.usedAssemblies) {
      const key = `${use.source}|${use.name}`;
      const entry = usage.get(key) ?? { use, frameworks: [] };
      entry.frameworks.push(framework.targetFramework);
      usage.set(key, entry);
    }
    if (!framework.exactReferencePack) {
      graph.diagnostic({
        repositoryId: repoId, category: "compilation", plugin: PLUGIN, file: project.path, severity: "warning", recoverable: true, code: "reference-pack-approximate",
        message: `no installed reference pack matches ${framework.targetFramework}; analyzed against ${framework.referencePack}`,
      });
    }
  }
  for (const { use, frameworks } of [...usage.values()].sort((a, b) => a.use.name.localeCompare(b.use.name))) {
    const targetId = use.source === "project" && use.projectId
      ? assemblyEntityByProject.get(use.projectId)
      : graph.entity({
          key: keys.assembly(null, use.name),
          kind: "Assembly",
          layer: "repository",
          name: use.name,
          qualifiedName: use.name,
          repositoryId: null,
          assembly: use.name,
          language: "dotnet",
          external: true,
          metadata: { source: use.source },
          provenance: prov("used-assembly-reference", null),
        });
    if (!targetId) continue;
    const packageMatch = use.path ? /[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/](?:lib|ref|runtimes)[\\/]/i.exec(use.path) : null;
    graph.relate({
      type: "ASSEMBLY_REFERENCES",
      sourceId: project.entityId,
      targetId,
      repositoryId: repoId,
      evidence: "COMPILER_RESOLVED",
      metadata: {
        version: use.version,
        source: use.source,
        package: packageMatch ? `${packageMatch[1]}/${packageMatch[2]}` : null,
        ...(frameworks.length < facts.frameworks.length ? { targetFrameworks: frameworks } : {}),
      },
      provenance: prov("used-assembly-reference", null),
    });
    if (packageMatch) {
      const packageId = graph.entity({
        key: keys.package("nuget", packageMatch[1]!), kind: "Package", layer: "repository", name: packageMatch[1]!, qualifiedName: `nuget:${packageMatch[1]}`,
        repositoryId: null, language: "dotnet", external: true, metadata: { ecosystem: "nuget" }, provenance: prov("used-assembly-reference", null),
      });
      graph.relate({
        type: "CONTAINS", sourceId: packageId, targetId, repositoryId: repoId, evidence: "EXACT",
        metadata: { version: packageMatch[2]! }, provenance: prov("package-asset", null),
      });
    }
  }

  if (facts.compilerErrors > 0) {
    graph.diagnostic({
      repositoryId: repoId, category: "compilation", plugin: PLUGIN, file: project.path, severity: "warning", recoverable: true, code: "compilation-errors",
      message: `${facts.compilerErrors} compiler errors in ${project.name} (${facts.frameworks.map((f) => f.targetFramework).join(", ")}; references: ${facts.referenceSources.join(", ") || "none"}); unbound symbols are recorded as unresolved references`,
    });
    for (const d of facts.diagnostics) {
      graph.diagnostic({ repositoryId: repoId, category: "compilation", plugin: PLUGIN, file: d.file ?? project.path, severity: "info", recoverable: true, code: d.id, message: `${d.message} (line ${d.line})` });
    }
  }
}
