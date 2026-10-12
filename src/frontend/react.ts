import type * as TS from "typescript-compiler";
import type { EvidenceLevel, Metadata, RelationshipType } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { cachedProjectAnalysis, FRONTEND_VERSION, frontendKeys, frontendProvenance, within, type Recorder } from "./common.ts";
import { staticString } from "./http.ts";
import { lazyImportTarget, moduleExport } from "./modules.ts";
import { FRONTEND_PROJECTS, objectProperty, type DeclRef, type TsProgramView } from "./program.ts";
import { ensureDecl, ownerId } from "./semantic.ts";

const ID = "frontend.react";
const VERSION = FRONTEND_VERSION;

export const reactPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const projects = (ctx.artifacts.get(FRONTEND_PROJECTS) ?? []).filter((p) => p.pkg.frameworks.includes("react") || p.pkg.frameworks.includes("nextjs"));
    if (!projects.length || !ctx.options.semantic) return;
    for (const project of projects) {
      try {
        await cachedProjectAnalysis(ctx, ID, VERSION, project.pkg, project.key, async (rec) => {
          const view = await project.view();
          if (view) analyzeReact(ctx, rec, view);
        });
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file: project.pkg.path, severity: "error", recoverable: true, code: "react-analysis-failed", message: `React analysis failed for ${project.pkg.path}; generic TypeScript facts are kept: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  },
};

function analyzeReact(ctx: AnalysisContext, rec: Recorder, view: TsProgramView): void {
  const fileFailed = (file: string, error: string) =>
    rec.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file, severity: "error", recoverable: true, code: "react-file-failed", message: `analysis of ${file} failed and was skipped; other files are unaffected: ${error}` });
  const ts = view.ts;
  const repoId = ctx.repository.id;
  const pkg = view.pkg;
  const routerDeclared = Object.keys(pkg.dependencies).some((d) => /^(react-router|react-router-dom|@remix-run\/react)$/.test(d));
  const prov = (extractor: string, node: TS.Node) => {
    const l = view.loc(node);
    return frontendProvenance(ctx, ID, VERSION, extractor, "typescript-compiler", l.file, l.line, l.column);
  };
  const relate = (type: RelationshipType, sourceId: string | null, targetId: string, at: TS.Node, evidence: EvidenceLevel, metadata: Metadata = {}) => {
    if (sourceId && sourceId !== targetId) rec.relate({ type, sourceId, targetId, repositoryId: repoId, evidence, metadata: { framework: "react", ...metadata }, provenance: prov(type.toLowerCase(), at) });
  };
  const fromModule = (id: TS.Node, module: RegExp) => {
    const origin = view.importOrigin(id);
    return !!origin && module.test(origin.module);
  };
  const refs = (expr: TS.Node | undefined): DeclRef[] => {
    if (!expr) return [];
    const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    return view.declRefs(view.symbolAt(target));
  };
  const role = (ref: DeclRef, value: string, at: TS.Node, extra: Metadata = {}) => {
    const id = ensureDecl(ctx, rec, view, ref, ID);
    rec.annotate(id, { frontendRole: value, framework: "react", ...extra }, prov("react-role", at));
    return id;
  };
  const containsJsx = (node: TS.Node): boolean => {
    let found = false;
    const visit = (n: TS.Node) => {
      if (found || (n !== node && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)))) return;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  // Components, hooks and contexts.
  for (const sf of view.sourceFiles) {
    for (const stmt of sf.statements) {
      const decls: TS.Node[] = ts.isVariableStatement(stmt) ? [...stmt.declarationList.declarations] : [stmt];
      for (const d of decls) {
        const ref = view.keyOf(d);
        if (!ref) continue;
        if (ts.isClassDeclaration(d)) {
          const ext = d.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
          const base = ext && (ts.isPropertyAccessExpression(ext) ? ext.name.text : ts.isIdentifier(ext) ? ext.text : "");
          if (ext && /^(Pure)?Component$/.test(base ?? "") && fromModule(ts.isPropertyAccessExpression(ext) ? ext.expression : ext, /^(react|preact\/compat)$/)) {
            const id = role(ref, "component", d, { componentKind: "class" });
            for (const m of d.members) {
              const mref = ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ? view.keyOf(m) : null;
              if (mref && /^(constructor|render|componentDidMount|componentDidUpdate|componentWillUnmount|shouldComponentUpdate|getDerivedStateFromProps|getSnapshotBeforeUpdate|componentDidCatch|getDerivedStateFromError)$/.test(mref.name))
                relate("CALLS", id, ensureDecl(ctx, rec, view, mref, ID), m, "DECLARED", { via: "react-lifecycle" });
            }
          }
          continue;
        }
        const fn = ts.isFunctionDeclaration(d) ? d : ts.isVariableDeclaration(d) ? d.initializer : undefined;
        if (!fn) continue;
        if (ts.isCallExpression(fn) && ts.isIdentifier(fn.expression) && fn.expression.text === "createContext" && fromModule(fn.expression, /^react$/)) {
          role(ref, "context", d);
          continue;
        }
        const body = ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn : ts.isCallExpression(fn) && fn.arguments[0] && (ts.isArrowFunction(fn.arguments[0]) || ts.isFunctionExpression(fn.arguments[0])) && ts.isIdentifier(fn.expression) && /^(memo|forwardRef)$/.test(fn.expression.text) ? fn.arguments[0] : undefined;
        if (!body) continue;
        if (/^use[A-Z0-9]/.test(ref.name)) role(ref, "hook", d);
        else if ((/^[A-Z]/.test(ref.name) || ref.name === "default") && containsJsx(body)) role(ref, "component", d, { componentKind: "function" });
      }
    }
  }

  // JSX: renders, context providers; hooks and context consumption.
  const visit = (node: TS.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName;
      const owner = ownerId(ctx, rec, view, node, ID);
      if (ts.isPropertyAccessExpression(tag) && tag.name.text === "Provider") {
        for (const r of refs(tag.expression)) relate("PROVIDES_CONTEXT", owner, role(r, "context", tag), node, "COMPILER_RESOLVED");
      } else if (!(ts.isIdentifier(tag) && /^[a-z]/.test(tag.text))) {
        for (const r of refs(tag)) if (r.kind === "Type" || r.kind === "Method" || r.kind === "Field") relate("RENDERS", owner, ensureDecl(ctx, rec, view, r, ID), node, "COMPILER_RESOLVED", { tag: tag.getText().slice(0, 80) });
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z0-9]/.test(node.expression.text)) {
      const owner = ownerId(ctx, rec, view, node, ID);
      const name = node.expression.text;
      if (name === "useContext" && fromModule(node.expression, /^react$/)) {
        for (const r of refs(node.arguments[0])) relate("CONSUMES_CONTEXT", owner, role(r, "context", node), node, "COMPILER_RESOLVED");
      }
      const targets = refs(node.expression);
      for (const r of targets) relate("USES_HOOK", owner, role(r, "hook", node), node, "COMPILER_RESOLVED");
      if (!targets.length && owner) {
        const origin = view.importOrigin(node.expression);
        if (origin) rec.annotate(owner, { hooksUsed: [`${origin.module}:${origin.name === "default" ? name : origin.name}`] }, prov("react-hook", node));
      }
    }
    ts.forEachChild(node, visit);
  };
  view.eachFile(fileFailed, visit);

  // Routes
  const app = (file: string) => pkg.applications.filter((a) => within(a.root, file)).sort((a, b) => b.root.length - a.root.length)[0] ?? pkg.applications[0] ?? null;
  const routeEntity = (full: string, at: TS.Node, meta: Metadata, framework = "react-router") => {
    const l = view.loc(at);
    const owner = app(l.file);
    const id = rec.entity({
      key: frontendKeys.route(repoId, `react:${owner?.root ?? pkg.dir}`, full),
      kind: "FrontendRoute",
      layer: "application",
      name: full,
      qualifiedName: `${owner?.name ?? pkg.name}:${full}`,
      repositoryId: repoId,
      projectId: pkg.entityId,
      language: /\.(m|c)?tsx?$/i.test(l.file) ? "typescript" : "javascript",
      location: { file: l.file, startLine: l.line, startColumn: l.column },
      metadata: { framework, path: full, ...meta },
      provenance: prov("react-route", at),
    });
    if (owner) relate("EXPOSES_ROUTE", owner.entityId, id, at, "DECLARED", { router: framework });
    return id;
  };
  const join = (prefix: string, path: string | null, index: boolean) => {
    if (path?.startsWith("/")) return path.replace(/\/+$/, "") || "/";
    const segs = [prefix.replace(/\/+$/, ""), index ? "" : (path ?? "")].filter(Boolean).join("/");
    return `/${segs}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  };
  const lazyComponent = (routeId: string, target: TS.Node, at: TS.Node): boolean => {
    const decl = view.symbolAt(target)?.valueDeclaration;
    const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    if (!init || !ts.isCallExpression(init) || init.arguments.length !== 1) return false;
    const callee = init.expression;
    const isLazy = ts.isIdentifier(callee) ? callee.text === "lazy" && fromModule(callee, /^react$/) : ts.isPropertyAccessExpression(callee) && callee.name.text === "lazy" && ts.isIdentifier(callee.expression) && fromModule(callee.expression, /^react$/);
    if (!isLazy) return false;
    const loader = init.arguments[0]!;
    const lazy = lazyImportTarget(view, loader);
    const exported = lazy.file && lazy.member ? moduleExport(view, lazy.file, lazy.member) : { refs: [] };
    const fileId = lazy.file ? ctx.fileEntityId(lazy.file) : undefined;
    if (fileId) relate("LOADS_MODULE", routeId, fileId, at, "STRUCTURALLY_RESOLVED", { lazy: true, via: "react-lazy" });
    const components = exported.refs.filter((r) => r.kind === "Type" || r.kind === "Method" || r.kind === "Field");
    for (const r of components) relate("ROUTES_TO_COMPONENT", routeId, ensureDecl(ctx, rec, view, r, ID), at, "COMPILER_RESOLVED", { lazy: true, via: "react-lazy", export: lazy.member });
    if (!components.length) rec.unresolved({ type: "ROUTES_TO_COMPONENT", sourceId: routeId, repositoryId: repoId, targetDisplay: init.getText().slice(0, 120), resolver: ID, reason: !lazy.file ? "React.lazy loader is not a static import() of a repository module" : !lazy.member ? "React.lazy loader selects an export with an unsupported expression" : `module ${lazy.file} has no resolvable export '${lazy.member}'`, metadata: { category: "dynamic-lazy-route", module: lazy.file, export: lazy.member }, provenance: prov("react-route", loader) });
    return true;
  };
  const linkTargets = (routeId: string, value: TS.Expression | undefined, at: TS.Node) => {
    if (!value) return;
    const linkJsx = (el: TS.JsxElement | TS.JsxSelfClosingElement, wrapped: boolean) => {
      const tag = (ts.isJsxElement(el) ? el.openingElement : el).tagName;
      if (!lazyComponent(routeId, ts.isPropertyAccessExpression(tag) ? tag.name : tag, at)) for (const r of refs(tag)) relate("ROUTES_TO_COMPONENT", routeId, ensureDecl(ctx, rec, view, r, ID), at, "COMPILER_RESOLVED", wrapped ? { via: "wrapper-child" } : {});
      if (ts.isJsxElement(el)) for (const child of el.children) if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) linkJsx(child, true);
    };
    let expr = value;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) linkJsx(expr, false);
    else if (!lazyComponent(routeId, expr, at)) for (const r of refs(expr)) relate("ROUTES_TO_COMPONENT", routeId, ensureDecl(ctx, rec, view, r, ID), at, "COMPILER_RESOLVED");
  };
  const lazyLoad = (routeId: string, loader: TS.Expression) => {
    let found = false;
    const scan = (n: TS.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const file = view.resolveFile(view.repoPath(n.getSourceFile()), n.arguments[0].text);
        const fileId = file ? ctx.fileEntityId(file) : undefined;
        if (fileId) {
          relate("LOADS_MODULE", routeId, fileId, n, "STRUCTURALLY_RESOLVED", { lazy: true });
          found = true;
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(loader);
    if (!found) rec.unresolved({ type: "LOADS_MODULE", sourceId: routeId, repositoryId: repoId, targetDisplay: loader.getText().slice(0, 120), resolver: ID, reason: "lazy route loader is not a static import() of a repository module", metadata: { category: "dynamic-lazy-route" }, provenance: prov("react-route", loader) });
  };
  const seenArrays = new Set<TS.Node>();
  const objectRoutes = (arr: TS.ArrayLiteralExpression, prefix: string, parent: string | null) => {
    if (seenArrays.has(arr)) return;
    seenArrays.add(arr);
    for (const item of arr.elements) {
      if (!ts.isObjectLiteralExpression(item)) continue;
      const pathExpr = objectProperty(ts, item, "path");
      const path = pathExpr ? staticString(view, pathExpr) : null;
      const index = objectProperty(ts, item, "index")?.kind === ts.SyntaxKind.TrueKeyword;
      if (pathExpr && path === null) {
        rec.diagnostic({ repositoryId: repoId, category: "framework", plugin: ID, file: view.loc(item).file, severity: "info", recoverable: true, code: "dynamic-route-path", message: `route path ${pathExpr.getText().slice(0, 80)} at ${view.loc(item).file}:${view.loc(item).line} is not statically determinable` });
        continue;
      }
      const full = join(prefix, path, index);
      const id = path !== null || index ? routeEntity(full, item, { index, detection: "route-object" }) : null;
      if (id) {
        if (parent) relate("CONTAINS", parent, id, item, "DECLARED", { role: "child-route" });
        linkTargets(id, objectProperty(ts, item, "element") ?? objectProperty(ts, item, "Component") ?? objectProperty(ts, item, "component") ?? undefined, item);
        const lazy = objectProperty(ts, item, "lazy");
        if (lazy) lazyLoad(id, lazy);
      }
      const children = objectProperty(ts, item, "children");
      if (children && ts.isArrayLiteralExpression(children)) objectRoutes(children, path !== null ? full : prefix, id ?? parent);
    }
  };
  const isRouteObjectArray = (arr: TS.ArrayLiteralExpression) =>
    arr.elements.length > 0 && arr.elements.every((e) => ts.isObjectLiteralExpression(e) && (objectProperty(ts, e, "path") || objectProperty(ts, e, "index")) && (objectProperty(ts, e, "element") || objectProperty(ts, e, "Component") || objectProperty(ts, e, "lazy") || objectProperty(ts, e, "children")));
  const jsxRoutes = (el: TS.JsxElement | TS.JsxSelfClosingElement, prefix: string, parent: string | null) => {
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    const attr = (name: string) => opening.attributes.properties.find((p): p is TS.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
    const value = (a: TS.JsxAttribute | undefined) => (!a?.initializer ? undefined : ts.isStringLiteral(a.initializer) ? a.initializer : ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined);
    const pathAttr = attr("path");
    const path = pathAttr ? staticString(view, value(pathAttr) ?? null) : null;
    const index = !!attr("index");
    let id: string | null = null;
    let next = prefix;
    if (path !== null || index) {
      const full = join(prefix, path, index);
      id = routeEntity(full, opening, { index, detection: "jsx-route" });
      if (parent) relate("CONTAINS", parent, id, opening, "DECLARED", { role: "child-route" });
      linkTargets(id, value(attr("element")) ?? value(attr("component")) ?? value(attr("Component")), opening);
      const lazy = value(attr("lazy"));
      if (lazy) lazyLoad(id, lazy);
      if (path !== null) next = full;
    }
    if (ts.isJsxElement(el)) for (const child of el.children) if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && isRouteTag(child)) jsxRoutes(child, next, id ?? parent);
  };
  const isRouteTag = (el: TS.JsxElement | TS.JsxSelfClosingElement) => {
    const tag = (ts.isJsxElement(el) ? el.openingElement : el).tagName;
    return ts.isIdentifier(tag) && tag.text === "Route" && fromModule(tag, /^react-router(-dom)?$/);
  };
  const findRoutes = (node: TS.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isRouteTag(node)) {
      const parent = node.parent;
      const nested = parent && (ts.isJsxElement(parent) && isRouteTag(parent));
      if (!nested) jsxRoutes(node, "", null);
      return;
    }
    if (routerDeclared && ts.isArrayLiteralExpression(node) && isRouteObjectArray(node)) {
      const parentObj = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name.getText() === "children";
      if (!parentObj) objectRoutes(node, "", null);
      return;
    }
    ts.forEachChild(node, findRoutes);
  };
  view.eachFile(fileFailed, findRoutes);

  // Next.js file-system routes (app router pages and pages router), declared by directory structure.
  if (pkg.frameworks.includes("nextjs")) {
    for (const sf of view.sourceFiles) {
      const rel = view.repoPath(sf).slice(pkg.dir ? pkg.dir.length + 1 : 0);
      const appMatch = /^(?:src\/)?app\/(.*?)(?:^|\/)?page\.(t|j)sx?$/.exec(rel);
      const pagesMatch = /^(?:src\/)?pages\/(.*)\.(t|j)sx?$/.exec(rel);
      let route: string | null = null;
      if (appMatch) route = `/${appMatch[1]!.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/")}`;
      else if (pagesMatch && !/^(_app|_document|_error|api\/)/.test(pagesMatch[1]!)) route = `/${pagesMatch[1]!.replace(/(^|\/)index$/, "")}`;
      if (route === null) continue;
      const full = route.replace(/\[\[?\.\.\.(\w+)\]?\]/g, "{*$1}").replace(/\[(\w+)\]/g, "{$1}").replace(/\/+$/, "") || "/";
      const id = routeEntity(full, sf, { detection: appMatch ? "next-app-router" : "next-pages-router" }, "nextjs");
      const def = sf.statements.find((s) => (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && (ts.getCombinedModifierFlags(s) & ts.ModifierFlags.Default) !== 0) ?? sf.statements.find(ts.isExportAssignment);
      const ref = def ? view.keyOf(def) ?? (ts.isExportAssignment(def) ? refs(def.expression)[0] ?? null : null) : null;
      if (ref) relate("ROUTES_TO_COMPONENT", id, role(ref, "component", def!, { componentKind: "page" }), def!, "DECLARED", { convention: "nextjs-file-system-route" });
    }
  }
}
