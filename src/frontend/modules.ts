import type * as TS from "typescript-compiler";
import { ids, keys } from "../graph/identity.ts";
import type { RelationshipType } from "../graph/model.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { FRONTEND_VERSION, FRONTEND_WORKSPACE, frontendKeys, frontendProvenance, isFrontendSource } from "./common.ts";
import { createTsProjects, FRONTEND_PROJECTS, KIND_OF, toVirtual, type DeclRef, type TsProgramView } from "./program.ts";
import { ModuleResolver, type ModuleTarget } from "./resolve.ts";
import { declPath, TS_SYNTAX, type ImportKind, type TsSyntaxFacts } from "./syntax.ts";

const ID = "frontend.modules";
const VERSION = FRONTEND_VERSION;

export interface ResolvedImport {
  specifier: string;
  kind: ImportKind;
  names: [string, string][];
  line: number;
  target: ModuleTarget;
}

export const FRONTEND_MODULES = artifactKey<Map<string, ResolvedImport[]>>("frontend.modules");

const EDGE: Record<ImportKind, RelationshipType> = {
  static: "IMPORTS",
  "side-effect": "IMPORTS",
  type: "TYPE_IMPORTS",
  dynamic: "DYNAMIC_IMPORTS",
  require: "REQUIRES",
  "re-export": "RE_EXPORTS",
  "re-export-type": "RE_EXPORTS",
  reference: "REFERENCES_MODULE",
};

export const frontendModulesPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "semantic",
  async run(ctx: AnalysisContext) {
    const syntax = ctx.artifacts.get(TS_SYNTAX) ?? new Map<string, TsSyntaxFacts>();
    const workspace = ctx.artifacts.get(FRONTEND_WORKSPACE);
    if (!workspace || !syntax.size) return;
    const repoId = ctx.repository.id;
    const graph = ctx.graph;
    const files = new Set(ctx.files.filter(isFrontendSource).map((f) => f.path));
    const resolver = new ModuleResolver(files, workspace);
    const modules = new Map<string, ResolvedImport[]>();
    let resolved = 0;
    let external = 0;
    let unresolved = 0;

    for (const [file, facts] of [...syntax].sort(([a], [b]) => a.localeCompare(b))) {
      const fileId = ctx.fileEntityId(file);
      if (!fileId) continue;
      const pkg = workspace.packageOf(file);
      const prov = (line: number, extractor: string) => frontendProvenance(ctx, ID, VERSION, extractor, "tree-sitter", file, line);
      const declared = new Map<string, string>();
      for (const d of facts.declarations) {
        const path = declPath(d.container, d.name);
        const key = frontendKeys.symbol(repoId, file, path);
        const id = graph.entity({
          key,
          kind: KIND_OF[d.kind],
          layer: "semantic",
          name: d.name,
          qualifiedName: `${file}:${path}`,
          repositoryId: repoId,
          projectId: pkg?.entityId ?? null,
          language: /\.(m|c)?tsx?$/i.test(file) ? "typescript" : "javascript",
          symbolKey: `ts:${file}#${path}`,
          location: { file, startLine: d.line, startColumn: d.column, endLine: d.endLine },
          metadata: { symbolKind: d.kind, identity: "module-path", form: d.form, exported: d.exported, ...(d.isDefault ? { defaultExport: true } : {}) },
          provenance: prov(d.line, "declaration"),
        });
        graph.relate({ type: "DECLARES", sourceId: fileId, targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(d.line, "declaration") });
        if (d.container) {
          graph.relate({ type: "DECLARES", sourceId: ids.entity(frontendKeys.symbol(repoId, file, d.container)), targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(d.line, "declaration") });
        } else {
          declared.set(d.name, id);
          if (d.exported) graph.relate({ type: "EXPORTS", sourceId: fileId, targetId: id, repositoryId: repoId, evidence: "DECLARED", metadata: { exportName: d.isDefault ? "default" : d.name }, provenance: prov(d.line, "export") });
        }
      }
      for (const [exported, local] of facts.exportNames) {
        const id = declared.get(local);
        if (id) graph.relate({ type: "EXPORTS", sourceId: fileId, targetId: id, repositoryId: repoId, evidence: "DECLARED", metadata: { exportName: exported }, provenance: prov(1, "export") });
      }

      const list: ResolvedImport[] = [];
      for (const imp of facts.imports) {
        const target = resolver.resolve(file, imp.specifier, pkg);
        list.push({ specifier: imp.specifier, kind: imp.kind, names: imp.names, line: imp.line, target });
        const type = EDGE[imp.kind];
        const metadata = { specifier: imp.specifier, names: [...new Set(imp.names.map(([n]) => n))].sort().slice(0, 50), ...(imp.kind === "side-effect" ? { sideEffect: true } : {}), ...(imp.kind === "re-export-type" ? { typeOnly: true } : {}) };
        if (target.kind === "file") {
          resolved++;
          const targetId = ctx.fileEntityId(target.path);
          if (targetId && targetId !== fileId) graph.relate({ type, sourceId: fileId, targetId, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { ...metadata, resolution: target.via }, provenance: prov(imp.line, "module-resolution") });
        } else if (target.kind === "package") {
          external++;
          const name = target.builtin ? `node:${target.name.replace(/^node:/, "")}` : target.name;
          const declaredDep = !!pkg?.dependencies[target.name];
          const packageId = graph.entity({
            key: keys.package("npm", name),
            kind: "Package",
            layer: "repository",
            name,
            qualifiedName: `npm:${name}`,
            repositoryId: null,
            language: "javascript",
            external: true,
            metadata: { ecosystem: "npm", ...(target.builtin ? { builtin: true } : {}) },
            provenance: prov(imp.line, "module-resolution"),
          });
          graph.relate({ type, sourceId: fileId, targetId: packageId, repositoryId: repoId, evidence: "DECLARED", metadata: { ...metadata, declaredDependency: declaredDep || target.builtin }, provenance: prov(imp.line, "module-resolution") });
          if (!declaredDep && !target.builtin && pkg)
            graph.diagnostic({ repositoryId: repoId, category: "resolver", plugin: ID, file, severity: "info", recoverable: true, code: "undeclared-package-import", message: `${file} imports '${target.name}', which ${pkg.path} does not declare as a dependency` });
        } else {
          unresolved++;
          graph.unresolved({ type, sourceId: fileId, repositoryId: repoId, targetDisplay: imp.specifier, resolver: ID, reason: target.reason, metadata: { category: "unresolved-module", specifier: imp.specifier }, provenance: prov(imp.line, "module-resolution") });
        }
      }
      modules.set(file, list);
    }
    ctx.artifacts.set(FRONTEND_MODULES, modules);

    const closure = (start: string[]) => {
      const seen = new Set(start);
      const queue = [...start];
      while (queue.length) {
        const f = queue.pop()!;
        for (const imp of modules.get(f) ?? []) if (imp.target.kind === "file" && !seen.has(imp.target.path)) {
          seen.add(imp.target.path);
          queue.push(imp.target.path);
        }
      }
      return [...seen].sort();
    };
    ctx.artifacts.set(FRONTEND_PROJECTS, createTsProjects(ctx, workspace.packages, resolver, closure));
    ctx.log.info("frontend.modules", { files: modules.size, resolved, external, unresolved });
  },
};

export interface LazyImportTarget {
  /** Repository file of the static `import("...")`, or null when the specifier is not a string literal or does not resolve. */
  file: string | null;
  /** Export the loader selects: a named export, "default", or null when the selection is not a supported static shape. */
  member: string | null;
}

/**
 * The module and export a lazy loader expression selects, from its syntax only. Supported shapes are a (possibly
 * async, block-bodied or parenthesized) arrow/function returning `import("x")`, `import("x").then(m => m.X)`,
 * `import("x").then(m => m.default)`, `import("x").then(m => ({ default: m.X }))` and `(await import("x")).X`.
 * Anything else leaves `member` null (and `file` null when no static import() is reachable), never a guess.
 */
export function lazyImportTarget(view: TsProgramView, loader: TS.Expression): LazyImportTarget {
  const ts = view.ts;
  const unwrap = (e: TS.Expression | undefined): TS.Expression | undefined => {
    let cur = e;
    for (;;) {
      if (!cur) return undefined;
      if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
      else if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const body = cur.body;
        if (ts.isBlock(body)) {
          const ret = body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!) ? body.statements[0]!.expression : undefined;
          if (!ret) return undefined;
          cur = ret;
        } else cur = body;
      } else return cur;
    }
  };
  const importOf = (e: TS.Expression | undefined): string | null => {
    const call = unwrap(e);
    if (!call || !ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const arg = call.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg) || call.arguments.length !== 1) return null;
    return view.resolveFile(view.repoPath(call.getSourceFile()), arg.text);
  };
  const selected = (e: TS.Expression | undefined, param: string): string | null => {
    const body = unwrap(e);
    if (!body) return null;
    if (ts.isPropertyAccessExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === param) return body.name.text;
    if (ts.isObjectLiteralExpression(body) && body.properties.length === 1) {
      const p = body.properties[0]!;
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "default") return selected(p.initializer, param);
    }
    return null;
  };
  const expr = unwrap(loader);
  if (!expr) return { file: null, member: null };
  const direct = importOf(expr);
  if (direct) return { file: direct, member: "default" };
  if (ts.isPropertyAccessExpression(expr)) {
    const file = importOf(expr.expression);
    return { file, member: file ? expr.name.text : null };
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "then" && expr.arguments.length === 1) {
    const file = importOf(expr.expression.expression);
    if (!file) return { file: null, member: null };
    const cb = expr.arguments[0]!;
    const param = (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length === 1 && ts.isIdentifier(cb.parameters[0]!.name) ? cb.parameters[0]!.name.text : null;
    return { file, member: param ? selected(cb, param) : null };
  }
  return { file: null, member: null };
}

/** The declaration behind a repository module's export (`default` for the default export), followed through `export { A as B }` / `export default A` aliases. */
export function moduleExport(view: TsProgramView, file: string, name: string): { refs: DeclRef[]; decl: TS.Declaration | null } {
  const sf = view.program.getSourceFile(toVirtual(file));
  const moduleSymbol = sf ? view.checker.getSymbolAtLocation(sf) : undefined;
  if (!moduleSymbol) return { refs: [], decl: null };
  let sym = view.checker.getExportsOfModule(moduleSymbol).find((e) => e.name === name);
  if (sym && sym.flags & view.ts.SymbolFlags.Alias) {
    try {
      sym = view.checker.getAliasedSymbol(sym);
    } catch {
      return { refs: [], decl: null };
    }
  }
  if (!sym) return { refs: [], decl: null };
  return { refs: view.declRefs(sym), decl: sym.valueDeclaration ?? sym.declarations?.[0] ?? null };
}
