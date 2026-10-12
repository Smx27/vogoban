import type * as TS from "typescript-compiler";
import type { EvidenceLevel, Metadata, RelationshipType } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { cachedProjectAnalysis, dirOf, FRONTEND_VERSION, frontendKeys, frontendProvenance, repoJoin, within, type Recorder } from "./common.ts";
import { lazyImportTarget, moduleExport } from "./modules.ts";
import { FRONTEND_PROJECTS, objectProperty, type DeclRef, type TsProgramView } from "./program.ts";
import { ensureDecl, ownerId } from "./semantic.ts";

const ID = "frontend.angular";
const VERSION = FRONTEND_VERSION;
const ROLES: Record<string, string> = { Component: "component", Directive: "directive", Pipe: "pipe", Injectable: "service", NgModule: "module" };
const GUARD_KEYS: Record<string, string> = { canActivate: "canActivate", canActivateChild: "canActivateChild", canDeactivate: "canDeactivate", canMatch: "canMatch", canLoad: "canLoad" };

export const angularPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const projects = (ctx.artifacts.get(FRONTEND_PROJECTS) ?? []).filter((p) => p.pkg.frameworks.includes("angular"));
    if (!projects.length || !ctx.options.semantic) return;
    for (const project of projects) {
      try {
        await cachedProjectAnalysis(ctx, ID, VERSION, project.pkg, project.key, async (rec) => {
          const view = await project.view();
          if (view) await analyzeAngular(ctx, rec, view);
        });
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file: project.pkg.path, severity: "error", recoverable: true, code: "angular-analysis-failed", message: `Angular analysis failed for ${project.pkg.path}; generic TypeScript facts are kept: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  },
};

interface AngularClass {
  node: TS.ClassDeclaration;
  ref: DeclRef;
  id: string;
  role: string;
  args: TS.ObjectLiteralExpression | null;
}

async function analyzeAngular(ctx: AnalysisContext, rec: Recorder, view: TsProgramView): Promise<void> {
  const fileFailed = (file: string, error: string) =>
    rec.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file, severity: "error", recoverable: true, code: "angular-file-failed", message: `analysis of ${file} failed and was skipped; other files are unaffected: ${error}` });
  const ts = view.ts;
  const repoId = ctx.repository.id;
  const pkg = view.pkg;
  const prov = (extractor: string, node: TS.Node | null, mechanism = "typescript-compiler") => {
    const l = node ? view.loc(node) : null;
    return frontendProvenance(ctx, ID, VERSION, extractor, mechanism, l?.file ?? pkg.path, l?.line ?? 1, l?.column ?? 1);
  };
  const relate = (type: RelationshipType, sourceId: string, targetId: string, at: TS.Node | null, evidence: EvidenceLevel, metadata: Metadata = {}, extractor = type.toLowerCase()) => {
    if (sourceId !== targetId) rec.relate({ type, sourceId, targetId, repositoryId: repoId, evidence, metadata, provenance: prov(extractor, at) });
  };
  const fromAngular = (id: TS.Node, module: RegExp) => {
    const origin = view.importOrigin(id);
    return !!origin && module.test(origin.module);
  };
  const decorators = (node: TS.Node): TS.Decorator[] => (ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : []);
  const refsOf = (expr: TS.Expression | undefined): DeclRef[] => {
    if (!expr) return [];
    const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    return view.declRefs(view.symbolAt(target));
  };
  const arrayItems = (expr: TS.Expression | null | undefined): TS.Expression[] => {
    if (!expr) return [];
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.flatMap((e) => (ts.isSpreadElement(e) ? arrayItems(e.expression) : [e]));
    if (ts.isIdentifier(expr)) {
      const decl = view.symbolAt(expr)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return arrayItems(decl.initializer);
    }
    return [expr];
  };

  const classes: AngularClass[] = [];
  for (const sf of view.sourceFiles) {
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt)) continue;
      const ref = view.keyOf(stmt);
      if (!ref) continue;
      for (const d of decorators(stmt)) {
        if (!ts.isCallExpression(d.expression) || !ts.isIdentifier(d.expression.expression)) continue;
        const name = d.expression.expression.text;
        if (!ROLES[name] || !fromAngular(d.expression.expression, /^@angular\/core$/)) continue;
        const args = d.expression.arguments[0] && ts.isObjectLiteralExpression(d.expression.arguments[0]) ? d.expression.arguments[0] : null;
        classes.push({ node: stmt, ref, id: ensureDecl(ctx, rec, view, ref, ID), role: ROLES[name]!, args });
      }
      for (const h of stmt.heritageClauses ?? []) for (const t of h.types) {
        if (!ts.isIdentifier(t.expression)) continue;
        const iface = t.expression.text;
        const role = /^Can(Activate|ActivateChild|Deactivate|Match|Load)$/.test(iface) && fromAngular(t.expression, /^@angular\/router$/) ? "guard" : iface === "HttpInterceptor" && fromAngular(t.expression, /^@angular\/common\/http$/) ? "interceptor" : iface === "Resolve" && fromAngular(t.expression, /^@angular\/router$/) ? "resolver" : null;
        if (role) rec.annotate(ensureDecl(ctx, rec, view, ref, ID), { frontendRole: role, framework: "angular" }, prov("angular-role", stmt));
      }
    }
  }

  // Framework-invoked members: Angular calls lifecycle hooks, constructors (DI), pipe transforms and guard/interceptor entry points.
  const LIFECYCLE = /^(constructor|ngOnInit|ngOnChanges|ngDoCheck|ngAfterContentInit|ngAfterContentChecked|ngAfterViewInit|ngAfterViewChecked|ngOnDestroy|transform|intercept|canActivate|canActivateChild|canDeactivate|canMatch|canLoad|resolve)$/;
  for (const c of classes) {
    for (const m of c.node.members) {
      const ref = (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) ? view.keyOf(m) : null;
      if (ref && LIFECYCLE.test(ref.name)) relate("CALLS", c.id, ensureDecl(ctx, rec, view, ref, ID), m, "DECLARED", { via: "angular-lifecycle", framework: "angular" }, "angular-lifecycle");
    }
  }

  const literal = (e: TS.Expression | null) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null);
  const selectors = new Map<string, AngularClass[]>();
  for (const c of classes) {
    const selector = literal(c.args ? objectProperty(ts, c.args, "selector") : null);
    const standalone = c.args ? objectProperty(ts, c.args, "standalone") : null;
    const providedIn = literal(c.args ? objectProperty(ts, c.args, "providedIn") : null);
    const pipeName = literal(c.args ? objectProperty(ts, c.args, "name") : null);
    rec.annotate(c.id, {
      frontendRole: c.role,
      framework: "angular",
      ...(selector ? { selector } : {}),
      ...(standalone ? { standalone: standalone.kind === ts.SyntaxKind.TrueKeyword } : {}),
      ...(providedIn ? { providedIn } : {}),
      ...(pipeName && c.role === "pipe" ? { pipeName } : {}),
    }, prov("angular-decorator", c.node));
    if (selector && (c.role === "component" || c.role === "directive")) {
      for (const s of selector.split(",").map((x) => x.trim()).filter(Boolean)) selectors.set(s, [...(selectors.get(s) ?? []), c]);
    }
  }

  for (const c of classes) {
    const ctor = c.node.members.find(ts.isConstructorDeclaration);
    for (const p of ctor?.parameters ?? []) {
      const tokenDecorator = decorators(p).find((d) => ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === "Inject");
      const token = tokenDecorator && ts.isCallExpression(tokenDecorator.expression) ? tokenDecorator.expression.arguments[0] : undefined;
      const typeName = p.type && ts.isTypeReferenceNode(p.type) ? (ts.isQualifiedName(p.type.typeName) ? p.type.typeName.right : p.type.typeName) : undefined;
      const targets = token ? refsOf(token) : typeName ? view.declRefs(view.symbolAt(typeName)) : [];
      for (const t of targets) relate("INJECTS", c.id, ensureDecl(ctx, rec, view, t, ID), p, "COMPILER_RESOLVED", { mechanism: token ? "inject-token" : "constructor-parameter", framework: "angular" });
    }
  }
  const injectCalls = (node: TS.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "inject" && fromAngular(node.expression, /^@angular\/core$/) && node.arguments[0]) {
      const owner = view.ownerOf(node);
      const ownerClass = owner?.declKind === "class" ? owner : owner && owner.path.includes(".") ? view.keyOf(ts.findAncestor(node, ts.isClassDeclaration) ?? node) : owner;
      const source = ownerClass ? ensureDecl(ctx, rec, view, ownerClass, ID) : ownerId(ctx, rec, view, node, ID);
      for (const t of refsOf(node.arguments[0])) if (source) relate("INJECTS", source, ensureDecl(ctx, rec, view, t, ID), node, "COMPILER_RESOLVED", { mechanism: "inject-function", framework: "angular" });
    }
    ts.forEachChild(node, injectCalls);
  };
  view.eachFile(fileFailed, injectCalls);

  for (const c of classes.filter((x) => x.args)) {
    const args = c.args!;
    const uses = (prop: string, role: string) => {
      for (const item of arrayItems(objectProperty(ts, args, prop))) {
        const target = ts.isCallExpression(item) && ts.isPropertyAccessExpression(item.expression) ? item.expression.expression : item;
        for (const t of refsOf(target as TS.Expression)) if (t.kind === "Type") relate("USES_COMPONENT", c.id, ensureDecl(ctx, rec, view, t, ID), item, "COMPILER_RESOLVED", { role, framework: "angular" });
      }
    };
    if (c.role === "module") {
      uses("declarations", "declaration");
      uses("imports", "import");
      uses("exports", "export");
      uses("bootstrap", "bootstrap");
    } else if (c.role === "component" || c.role === "directive") {
      uses("imports", "standalone-import");
    }
    registerProviders(objectProperty(ts, args, "providers"), c.id);
  }

  function registerProviders(list: TS.Expression | null, ownerEntity: string) {
    for (const item of arrayItems(list)) {
      if (ts.isObjectLiteralExpression(item)) {
        const provide = objectProperty(ts, item, "provide");
        const impl = objectProperty(ts, item, "useClass") ?? objectProperty(ts, item, "useExisting") ?? objectProperty(ts, item, "useFactory");
        const interceptor = !!provide && ts.isIdentifier(provide) && provide.text === "HTTP_INTERCEPTORS" && fromAngular(provide, /^@angular\/common\/http$/);
        for (const t of refsOf(impl ?? undefined)) {
          const targetId = ensureDecl(ctx, rec, view, t, ID);
          relate("REGISTERS", ownerEntity, targetId, item, "COMPILER_RESOLVED", { token: provide?.getText().slice(0, 120) ?? null, framework: "angular", ...(interceptor ? { role: "http-interceptor" } : {}) });
          if (interceptor) {
            rec.annotate(targetId, { frontendRole: "interceptor", framework: "angular" }, prov("angular-provider", item));
            for (const app of pkg.applications) relate("USES_MIDDLEWARE", app.entityId, targetId, item, "COMPILER_RESOLVED", { kind: "http-interceptor", framework: "angular" });
          }
        }
      } else if (ts.isCallExpression(item) && ts.isIdentifier(item.expression) && item.expression.text === "provideHttpClient") {
        for (const feature of item.arguments) {
          if (!ts.isCallExpression(feature) || !ts.isIdentifier(feature.expression) || feature.expression.text !== "withInterceptors") continue;
          for (const fn of arrayItems(feature.arguments[0])) for (const t of refsOf(fn)) {
            const targetId = ensureDecl(ctx, rec, view, t, ID);
            rec.annotate(targetId, { frontendRole: "interceptor", framework: "angular" }, prov("angular-provider", fn));
            relate("REGISTERS", ownerEntity, targetId, fn, "COMPILER_RESOLVED", { framework: "angular", role: "http-interceptor" });
            for (const app of pkg.applications) relate("USES_MIDDLEWARE", app.entityId, targetId, fn, "COMPILER_RESOLVED", { kind: "http-interceptor", framework: "angular" });
          }
        }
      } else {
        for (const t of refsOf(item)) if (t.kind === "Type") relate("REGISTERS", ownerEntity, ensureDecl(ctx, rec, view, t, ID), item, "COMPILER_RESOLVED", { framework: "angular" });
      }
    }
  }

  // Standalone bootstrap configuration: bootstrapApplication(App, { providers }) / ApplicationConfig objects.
  const providerConfigs = (node: TS.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "bootstrapApplication" && node.arguments[1]) {
      const cfg = ts.isObjectLiteralExpression(node.arguments[1]) ? node.arguments[1] : null;
      const owner = ownerId(ctx, rec, view, node, ID);
      if (cfg && owner) registerProviders(objectProperty(ts, cfg, "providers"), owner);
    }
    if (ts.isVariableDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "ApplicationConfig" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const ref = view.keyOf(node);
      if (ref) registerProviders(objectProperty(ts, node.initializer, "providers"), ensureDecl(ctx, rec, view, ref, ID));
    }
    ts.forEachChild(node, providerConfigs);
  };
  view.eachFile(fileFailed, providerConfigs);

  // Templates: element/attribute selectors -> RENDERS; event bindings -> component methods.
  const htmlFiles = new Set(pkg.files.filter((f) => f.language === "html").map((f) => f.path));
  for (const c of classes.filter((x) => x.role === "component" && x.args)) {
    const args = c.args!;
    let template = literal(objectProperty(ts, args, "template"));
    let templateFile = c.ref.file;
    const url = literal(objectProperty(ts, args, "templateUrl"));
    if (url) {
      const path = repoJoin(dirOf(c.ref.file), url);
      if (path && htmlFiles.has(path)) {
        template = await ctx.readText(path);
        templateFile = path;
        const fileId = ctx.fileEntityId(path);
        if (fileId) relate("REFERENCES", c.id, fileId, objectProperty(ts, args, "templateUrl"), "DECLARED", { role: "template", framework: "angular" });
      } else {
        rec.unresolved({ type: "REFERENCES", sourceId: c.id, repositoryId: repoId, targetDisplay: url, resolver: ID, reason: "templateUrl does not name a discovered template file in this repository", metadata: { category: "missing-template" }, provenance: prov("angular-template", c.node) });
      }
    }
    if (template === null) continue;
    const rendered = new Set<string>();
    for (const m of template.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
      const tag = m[1]!.toLowerCase();
      const attrs = [...m[2]!.matchAll(/\s\[?\(?([\w.-]+)\)?\]?(?=[\s=>/])/g)].map((a) => a[1]!);
      const hits = [...(selectors.get(tag) ?? []), ...attrs.flatMap((a) => [...(selectors.get(`[${a}]`) ?? []), ...(selectors.get(`${tag}[${a}]`) ?? [])])];
      for (const target of hits) {
        if (rendered.has(target.id)) continue;
        rendered.add(target.id);
        const line = template.slice(0, m.index).split("\n").length;
        rec.relate({ type: "RENDERS", sourceId: c.id, targetId: target.id, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { selector: target.args ? (literal(objectProperty(ts, target.args, "selector")) ?? tag) : tag, via: "template-selector", framework: "angular" }, provenance: frontendProvenance(ctx, ID, VERSION, "angular-template", "template-scan", templateFile, line) });
      }
      if (/-/.test(tag) && !hits.length && !/^(ng-|router-outlet)/.test(tag) && !rendered.has(`unresolved:${tag}`)) {
        rendered.add(`unresolved:${tag}`);
        rec.unresolved({ type: "RENDERS", sourceId: c.id, repositoryId: repoId, targetDisplay: `<${tag}>`, resolver: ID, reason: "no component or directive in this project declares this selector (likely from an external library)", metadata: { category: "external-or-unknown-selector" }, provenance: frontendProvenance(ctx, ID, VERSION, "angular-template", "template-scan", templateFile, template.slice(0, m.index).split("\n").length) });
      }
    }
    const methods = new Map(c.node.members.filter((m) => (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name && ts.isIdentifier(m.name)).map((m) => [(m.name as TS.Identifier).text, m]));
    for (const m of template.matchAll(/\(([\w.-]+)\)\s*=\s*"([^"]*)"|\{\{([^}]*)\}\}|\[[\w.-]+\]\s*=\s*"([^"]*)"/g)) {
      const expression = m[2] ?? m[3] ?? m[4] ?? "";
      for (const call of expression.matchAll(/(?<![\w.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const member = methods.get(call[1]!);
        const ref = member ? view.keyOf(member) : null;
        if (!ref) continue;
        const line = template.slice(0, m.index).split("\n").length;
        rec.relate({ type: "CALLS", sourceId: c.id, targetId: ensureDecl(ctx, rec, view, ref, ID), repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { via: m[1] ? `template-event (${m[1]})` : "template-binding", framework: "angular" }, provenance: frontendProvenance(ctx, ID, VERSION, "angular-template", "template-scan", templateFile, line) });
      }
    }
  }

  // Routes
  const app = (file: string) => pkg.applications.filter((a) => within(a.root, file)).sort((a, b) => b.root.length - a.root.length)[0] ?? pkg.applications[0] ?? null;
  const seenArrays = new Set<TS.Node>();
  const roots: TS.Expression[] = [];
  const findRoots = (node: TS.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      const forRoot = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "RouterModule" && (name === "forRoot");
      if ((forRoot || name === "provideRouter") && node.arguments[0]) roots.push(node.arguments[0]);
    }
    ts.forEachChild(node, findRoots);
  };
  view.eachFile(fileFailed, findRoots);

  const walkRoutes = (expr: TS.Expression | null | undefined, prefix: string, parentRoute: string | null, depth: number) => {
    if (!expr || depth > 8) return;
    let arr: TS.Expression = expr;
    if (ts.isIdentifier(arr)) {
      const decl = view.symbolAt(arr)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) arr = decl.initializer;
    }
    while (ts.isAsExpression(arr) || ts.isSatisfiesExpression(arr) || ts.isParenthesizedExpression(arr)) arr = arr.expression;
    if (!ts.isArrayLiteralExpression(arr) || seenArrays.has(arr)) return;
    seenArrays.add(arr);
    for (const item of arrayItems(arr)) {
      if (!ts.isObjectLiteralExpression(item)) continue;
      const path = literal(objectProperty(ts, item, "path")) ?? "";
      const full = `/${[prefix, path].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
      const file = view.loc(item).file;
      const owner = app(file);
      const appKey = owner?.root ?? pkg.dir;
      const routeId = rec.entity({
        key: frontendKeys.route(repoId, `angular:${appKey}`, full),
        kind: "FrontendRoute",
        layer: "application",
        name: full,
        qualifiedName: `${owner?.name ?? pkg.name}:${full}`,
        repositoryId: repoId,
        projectId: pkg.entityId,
        language: "typescript",
        location: { file, startLine: view.loc(item).line, startColumn: view.loc(item).column },
        metadata: { framework: "angular", path: full, segment: path, redirectTo: literal(objectProperty(ts, item, "redirectTo")), pathMatch: literal(objectProperty(ts, item, "pathMatch")), title: literal(objectProperty(ts, item, "title")) },
        provenance: prov("angular-route", item),
      });
      if (owner) relate("EXPOSES_ROUTE", owner.entityId, routeId, item, "DECLARED", { framework: "angular" });
      if (parentRoute) relate("CONTAINS", parentRoute, routeId, item, "DECLARED", { role: "child-route" });
      for (const t of refsOf(objectProperty(ts, item, "component") ?? undefined)) relate("ROUTES_TO_COMPONENT", routeId, ensureDecl(ctx, rec, view, t, ID), item, "COMPILER_RESOLVED", { framework: "angular" });
      for (const [key, kind] of Object.entries(GUARD_KEYS)) {
        for (const g of arrayItems(objectProperty(ts, item, key))) {
          const refs = refsOf(ts.isCallExpression(g) ? g.expression : g);
          for (const t of refs) {
            const gid = ensureDecl(ctx, rec, view, t, ID);
            relate("GUARDED_BY", routeId, gid, g, "COMPILER_RESOLVED", { guard: kind, framework: "angular", note: "static guard declaration; not proof of runtime enforcement" });
            rec.annotate(gid, { frontendRole: "guard", framework: "angular" }, prov("angular-route", g));
          }
          if (!refs.length) rec.unresolved({ type: "GUARDED_BY", sourceId: routeId, repositoryId: repoId, targetDisplay: g.getText().slice(0, 120), resolver: ID, reason: "guard expression does not resolve to a declaration in this project", metadata: { category: "unresolved-guard", guard: kind }, provenance: prov("angular-route", g) });
        }
      }
      const resolve = objectProperty(ts, item, "resolve");
      if (resolve && ts.isObjectLiteralExpression(resolve)) {
        for (const p of resolve.properties) if (ts.isPropertyAssignment(p)) for (const t of refsOf(p.initializer)) relate("RESOLVED_BY", routeId, ensureDecl(ctx, rec, view, t, ID), p, "COMPILER_RESOLVED", { key: p.name.getText(), framework: "angular" });
      }
      for (const [prop, type] of [["loadComponent", "LOADS_COMPONENT"], ["loadChildren", "LOADS_MODULE"]] as const) {
        const loader = objectProperty(ts, item, prop);
        if (!loader) continue;
        const lazy = lazyImportTarget(view, loader);
        if (!lazy.file) {
          rec.unresolved({ type, sourceId: routeId, repositoryId: repoId, targetDisplay: loader.getText().slice(0, 120), resolver: ID, reason: "lazy loader is not a static import() of a repository module", metadata: { category: "dynamic-lazy-route" }, provenance: prov("angular-route", loader) });
          continue;
        }
        const fileId = ctx.fileEntityId(lazy.file);
        if (fileId) relate("LOADS_MODULE", routeId, fileId, loader, "STRUCTURALLY_RESOLVED", { framework: "angular", lazy: true, via: prop });
        const exported = lazy.member ? moduleExport(view, lazy.file, lazy.member) : { refs: [], decl: null };
        if (!lazy.member || (!exported.refs.length && !exported.decl)) {
          rec.unresolved({ type, sourceId: routeId, repositoryId: repoId, targetDisplay: loader.getText().slice(0, 120), resolver: ID, reason: lazy.member ? `module ${lazy.file} has no resolvable export '${lazy.member}'` : "lazy loader selects an export with an unsupported expression", metadata: { category: "dynamic-lazy-route", module: lazy.file, export: lazy.member }, provenance: prov("angular-route", loader) });
          continue;
        }
        const via = lazy.member === "default" ? "default-export" : "named-export";
        if (type === "LOADS_COMPONENT") {
          for (const t of exported.refs) if (t.kind === "Type") relate("LOADS_COMPONENT", routeId, ensureDecl(ctx, rec, view, t, ID), loader, "COMPILER_RESOLVED", { framework: "angular", lazy: true, via, export: lazy.member });
          continue;
        }
        const decl = exported.decl;
        if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) walkRoutes(decl.name, full, routeId, depth + 1);
        else if (decl && ts.isClassDeclaration(decl)) {
          const forChild = findForChild(decl);
          if (forChild) walkRoutes(forChild, full, routeId, depth + 1);
          for (const t of exported.refs) if (t.kind === "Type") relate("LOADS_MODULE", routeId, ensureDecl(ctx, rec, view, t, ID), loader, "COMPILER_RESOLVED", { framework: "angular", lazy: true, via: "ngmodule", export: lazy.member });
        }
      }
      walkRoutes(objectProperty(ts, item, "children"), full, routeId, depth + 1);
    }
  };

  const findForChild = (cls: TS.ClassDeclaration): TS.Expression | null => {
    let found: TS.Expression | null = null;
    const visit = (n: TS.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "forChild" && n.arguments[0]) found = n.arguments[0];
      ts.forEachChild(n, visit);
    };
    for (const d of decorators(cls)) visit(d);
    return found;
  };

  for (const root of roots) walkRoutes(root, "", null, 0);
}
