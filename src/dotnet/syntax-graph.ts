import { keys } from "../graph/identity.ts";
import type { EntityKind, Provenance } from "../graph/model.ts";
import type { AnalysisContext } from "../plugins/types.ts";
import { CSHARP_SYNTAX, type DotnetProject } from "./artifacts.ts";
import type { SyntaxDecl } from "./csharp-syntax.ts";

const PLUGIN = "csharp.tree-sitter";
const TYPE_KIND: Record<string, string> = { class: "Class", interface: "Interface", struct: "Struct", record: "Record", "record struct": "RecordStruct", enum: "Enum", delegate: "Delegate" };

function entityKind(decl: SyntaxDecl): EntityKind {
  if (decl.kind in TYPE_KIND) return "Type";
  if (decl.kind === "method" || decl.kind === "constructor" || decl.kind === "operator") return "Method";
  if (decl.kind === "property" || decl.kind === "indexer") return "Property";
  if (decl.kind === "event") return "Event";
  return "Field";
}

export function emitSyntaxGraph(ctx: AnalysisContext, project: DotnetProject): void {
  const syntax = ctx.artifacts.get(CSHARP_SYNTAX);
  if (!syntax) return;
  const { graph, repository } = ctx;
  const repoId = repository.id;
  const prov = (file: string, decl?: SyntaxDecl): Provenance =>
    ctx.provenance({
      plugin: PLUGIN, extractor: "syntax-declaration", mechanism: "tree-sitter", version: "1",
      location: { file, startLine: decl?.line ?? 1, startColumn: decl?.column ?? 1, ...(decl ? { endLine: decl.endLine, endColumn: decl.endColumn } : {}) },
    });
  const typeIds = new Map<string, string>();

  for (const file of project.sourceFiles) {
    const facts = syntax.get(file);
    if (!facts) continue;
    const fileId = ctx.fileEntityId(file);
    const decls = [...facts.declarations].sort((a, b) => a.containerPath.length - b.containerPath.length);
    for (const decl of decls) {
      const kind = entityKind(decl);
      const ownerDoc = [decl.namespace, ...decl.containerPath].filter(Boolean).join(".");
      const isType = kind === "Type" && decl.kind !== "delegate" || decl.kind === "delegate" && decl.containerPath.length === 0;
      const simple = decl.arity && kind === "Type" ? `${decl.name}\`${decl.arity}` : decl.name;
      const symbolKey = isType || decl.kind === "delegate"
        ? `${project.assemblyName}::T:${[ownerDoc, simple].filter(Boolean).join(".")}`
        : `${project.assemblyName}::S:${ownerDoc}.${decl.name}(${decl.parameterTypes.join(",")})`;
      const baseName = [decl.namespace, ...decl.containerPath.map((p) => p.replace(/`\d+$/, "")), decl.name].filter(Boolean).join(".");
      const qualifiedName = kind === "Method" ? `${baseName}(${decl.parameterTypes.join(", ")})` : baseName;
      const id = graph.entity({
        key: keys.symbol(repoId, symbolKey),
        kind: decl.kind === "delegate" ? "Type" : kind,
        layer: "semantic",
        name: decl.name,
        qualifiedName,
        repositoryId: repoId,
        projectId: project.entityId,
        assembly: project.assemblyName,
        language: "csharp",
        symbolKey,
        location: { file, startLine: decl.line, startColumn: decl.column, endLine: decl.endLine, endColumn: decl.endColumn },
        metadata: { symbolKind: TYPE_KIND[decl.kind] ?? decl.kind, identity: "syntactic", modifiers: decl.modifiers, returnType: decl.returnType, parameterCount: decl.parameterTypes.length },
        provenance: prov(file, decl),
      });
      if (fileId) graph.relate({ type: "DECLARES", sourceId: fileId, targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(file, decl) });
      const container = typeIds.get(`${project.assemblyName}::T:${ownerDoc}`);
      if (container) {
        graph.relate({ type: "DECLARES", sourceId: container, targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(file, decl) });
      } else if (decl.namespace && decl.containerPath.length === 0) {
        const nsId = graph.entity({
          key: keys.namespace(repoId, decl.namespace), kind: "Namespace", layer: "semantic", name: decl.namespace.split(".").pop()!, qualifiedName: decl.namespace,
          repositoryId: repoId, language: "csharp", provenance: prov(file),
        });
        graph.relate({ type: "CONTAINS", sourceId: nsId, targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(file, decl) });
        graph.relate({ type: "CONTAINS", sourceId: project.entityId, targetId: nsId, repositoryId: repoId, evidence: "DECLARED", provenance: prov(file) });
      }
      if (kind === "Type") typeIds.set(symbolKey, id);
      for (const base of decl.baseTypes) {
        graph.unresolved({
          type: "INHERITS", sourceId: id, repositoryId: repoId, targetDisplay: base, resolver: PLUGIN,
          reason: "syntax-only analysis cannot resolve base type identity or distinguish base class from interface", metadata: { category: "analyzer-limitation" }, provenance: prov(file, decl),
        });
      }
    }
  }
}
