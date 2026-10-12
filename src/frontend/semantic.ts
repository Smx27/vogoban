import type * as TS from "typescript-compiler";
import { ids } from "../graph/identity.ts";
import type { RelationshipType } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { cachedProjectAnalysis, FRONTEND_VERSION, frontendProvenance, type Recorder } from "./common.ts";
import { FRONTEND_PROJECTS, type DeclRef, type TsProgramView } from "./program.ts";

const ID = "typescript.semantic";
const VERSION = FRONTEND_VERSION;

/** Make sure a declaration resolved by the compiler has the same entity the syntax plugin would have produced. */
export function ensureDecl(ctx: AnalysisContext, rec: Recorder, view: TsProgramView, ref: DeclRef, plugin = ID): string {
  const id = ids.entity(ref.key);
  if (ctx.graph.has(id)) return id;
  rec.entity({
    key: ref.key,
    kind: ref.kind,
    layer: "semantic",
    name: ref.name,
    qualifiedName: `${ref.file}:${ref.path}`,
    repositoryId: ctx.repository.id,
    projectId: view.pkg.entityId,
    language: /\.(m|c)?tsx?$/i.test(ref.file) ? "typescript" : "javascript",
    symbolKey: `ts:${ref.file}#${ref.path}`,
    location: { file: ref.file, startLine: ref.line, startColumn: ref.column },
    metadata: { symbolKind: ref.declKind, identity: "module-path" },
    provenance: frontendProvenance(ctx, plugin, VERSION, "declaration", "typescript-compiler", ref.file, ref.line, ref.column),
  });
  return id;
}

/** Owner entity of a node: its enclosing declaration, or the module (file) for top-level code. */
export function ownerId(ctx: AnalysisContext, rec: Recorder, view: TsProgramView, node: TS.Node, plugin = ID): string | null {
  const owner = view.ownerOf(node);
  if (owner) return ensureDecl(ctx, rec, view, owner, plugin);
  return ctx.fileEntityId(view.repoPath(node.getSourceFile())) ?? null;
}

export const typescriptSemanticPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "semantic",
  async run(ctx: AnalysisContext) {
    const projects = ctx.artifacts.get(FRONTEND_PROJECTS) ?? [];
    if (!projects.length) return;
    if (!ctx.options.semantic) {
      ctx.graph.diagnostic({ repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: null, severity: "info", recoverable: true, code: "semantic-disabled", message: "TypeScript semantic analysis disabled (--no-semantic): TS/JS graph contains syntax-level declarations and module imports only" });
      return;
    }
    let cached = 0;
    let analyzed = 0;
    for (const project of projects) {
      try {
        const result = await cachedProjectAnalysis(ctx, ID, VERSION, project.pkg, project.key, async (rec) => {
          const view = await project.view();
          if (!view) return;
          for (const f of view.failedFiles) rec.diagnostic({ repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: f.file, severity: "error", recoverable: true, code: "typescript-parse-failed", message: `the TypeScript compiler could not parse ${f.file}; it keeps syntax-level facts only: ${f.error}` });
          const counts = analyzeProject(ctx, rec, view);
          rec.annotate(project.pkg.entityId, { typescriptSemantic: "compiled", typescriptFiles: view.sourceFiles.length, ...counts }, frontendProvenance(ctx, ID, VERSION, "program", "typescript-compiler", project.pkg.tsconfig?.path ?? project.pkg.path));
        });
        if (result.cached) cached++;
        else analyzed++;
      } catch (error) {
        ctx.graph.diagnostic({
          repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: project.pkg.path, severity: "error", recoverable: true, code: "typescript-program-failed",
          message: `TypeScript semantic analysis failed for ${project.pkg.path}; syntax-level facts are kept: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    ctx.log.info("typescript.semantic", { projects: projects.length, analyzed, cached });
  },
};

function analyzeProject(ctx: AnalysisContext, rec: Recorder, view: TsProgramView): Record<string, number> {
  const fileFailed = (file: string, error: string) =>
    rec.diagnostic({ repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file, severity: "error", recoverable: true, code: "typescript-file-failed", message: `analysis of ${file} failed and was skipped; other files are unaffected: ${error}` });
  const ts = view.ts;
  const repoId = ctx.repository.id;
  const counts: Record<string, number> = {};
  const relate = (type: RelationshipType, sourceId: string | null, ref: DeclRef, at: TS.Node, metadata: Record<string, string | boolean> = {}) => {
    const targetId = ensureDecl(ctx, rec, view, ref);
    if (!sourceId || sourceId === targetId) return;
    const l = view.loc(at);
    rec.relate({ type, sourceId, targetId, repositoryId: repoId, evidence: "COMPILER_RESOLVED", metadata, provenance: frontendProvenance(ctx, ID, VERSION, type.toLowerCase(), "typescript-compiler", l.file, l.line, l.column) });
    counts[type] = (counts[type] ?? 0) + 1;
  };
  const isTypePosition = (n: TS.Node) => {
    for (let p: TS.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isTypeNode(p)) return true;
      if (ts.isExpression(p) || ts.isStatement(p) || ts.isClassElement(p)) return false;
    }
    return false;
  };

  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.SuperKeyword) {
        const cls = ts.findAncestor(node, (n) => ts.isClassDeclaration(n) || ts.isClassExpression(n)) as TS.ClassLikeDeclaration | undefined;
        const ext = cls?.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
        const base = ext ? view.symbolAt(ext.expression) : undefined;
        const ctor = base?.members?.get("__constructor" as TS.__String);
        for (const ref of view.declRefs(ctor)) relate("CALLS", ownerId(ctx, rec, view, node), ref, node, { call: "super" });
      } else {
        const target = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee;
        for (const ref of view.declRefs(view.symbolAt(target))) if (ref.kind === "Method" || ref.kind === "Field" || ref.kind === "Property") relate("CALLS", ownerId(ctx, rec, view, node), ref, node);
      }
    } else if (ts.isNewExpression(node)) {
      for (const ref of view.declRefs(view.symbolAt(node.expression))) if (ref.kind === "Type") relate("CONSTRUCTS", ownerId(ctx, rec, view, node), ref, node);
    } else if ((ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node)) && node.heritageClauses) {
      const self = view.keyOf(node);
      if (self) {
        const selfId = ensureDecl(ctx, rec, view, self);
        for (const clause of node.heritageClauses) {
          for (const t of clause.types) {
            const type: RelationshipType = ts.isInterfaceDeclaration(node) ? "EXTENDS" : clause.token === ts.SyntaxKind.ExtendsKeyword ? "INHERITS" : "IMPLEMENTS";
            for (const ref of view.declRefs(view.symbolAt(t.expression))) if (ref.kind === "Type") relate(type, selfId, ref, t);
          }
        }
        if (!ts.isInterfaceDeclaration(node)) overrides(node);
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
      for (const ref of view.declRefs(view.symbolAt(name))) if (ref.kind === "Type") relate("USES_TYPE", ownerId(ctx, rec, view, node), ref, node);
    } else if (ts.isIdentifier(node) && isReference(node) && !isTypePosition(node)) {
      for (const ref of view.declRefs(view.symbolAt(node))) if (ref.kind === "Type" || ref.kind === "Method" || (ref.kind === "Field" && ref.file !== view.repoPath(node.getSourceFile()))) relate("REFERENCES", ownerId(ctx, rec, view, node), ref, node);
    }
    ts.forEachChild(node, visit);
  };

  const isReference = (id: TS.Identifier) => {
    const p = id.parent;
    if (!p) return false;
    if (ts.isCallExpression(p) && p.expression === id) return false;
    if (ts.isNewExpression(p) && p.expression === id) return false;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
    if (ts.isExpressionWithTypeArguments(p)) return false;
    if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isBindingElement(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && (p as { name?: TS.Node }).name === id) return false;
    if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) return false;
    return true;
  };

  const overrides = (cls: TS.ClassLikeDeclaration) => {
    for (const clause of cls.heritageClauses ?? []) {
      const type: RelationshipType = clause.token === ts.SyntaxKind.ExtendsKeyword ? "OVERRIDES" : "IMPLEMENTS";
      for (const heritage of clause.token === ts.SyntaxKind.ExtendsKeyword ? clause.types.slice(0, 1) : clause.types) {
        let baseType: TS.Type;
        try {
          baseType = view.checker.getTypeAtLocation(heritage);
        } catch {
          continue;
        }
        for (const member of cls.members) {
          if (!(ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isGetAccessor(member)) || !member.name || !ts.isIdentifier(member.name)) continue;
          const mine = view.keyOf(member);
          const base = baseType.getProperty(member.name.text);
          if (!mine || !base) continue;
          for (const ref of view.declRefs(base)) if (ref.key !== mine.key && ref.kind === mine.kind) relate(type, ensureDecl(ctx, rec, view, mine), ref, member);
        }
      }
    }
  };

  view.eachFile(fileFailed, visit);
  return counts;
}
