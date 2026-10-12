import type * as TS from "typescript-compiler";
import { HTTP_CALLS, type HttpCallFact } from "../contracts/http-calls.ts";
import { isSecretName, safeValue } from "../infrastructure/common.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { cachedProjectAnalysis, FRONTEND_VERSION, frontendProvenance, type Recorder } from "./common.ts";
import { FRONTEND_PROJECTS, objectProperty, type TsProgramView } from "./program.ts";
import { ownerId } from "./semantic.ts";

const ID = "frontend.http";
const VERSION = FRONTEND_VERSION;
const MAX_DEPTH = 10;
const MAX_SPECIALIZATION_DEPTH = 3;
const VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

type Hole =
  | { t: "hole"; kind: "param"; fn: string; index: number; name: string; optional?: boolean }
  | { t: "hole"; kind: "ctor"; cls: string; index: number; name: string; optional?: boolean }
  | { t: "hole"; kind: "config"; key: string; dflt: string | null; name: string; optional?: boolean }
  | { t: "hole"; kind: "dynamic"; name: string; optional?: boolean; alts?: string[] };
type Part = { t: "lit"; v: string } | Hole;
/** Abstract string value: concatenation of literal fragments and holes whose origin is known. */
type Val = Part[];

const lit = (v: string): Val => (v ? [{ t: "lit", v }] : []);
const dyn = (name: string): Val => [{ t: "hole", kind: "dynamic", name: name.replace(/\s+/g, " ").slice(0, 60) }];
const concat = (...vals: Val[]): Val => {
  const out: Part[] = [];
  for (const p of vals.flat()) {
    const last = out[out.length - 1];
    if (p.t === "lit" && last?.t === "lit") out[out.length - 1] = { t: "lit", v: last.v + p.v };
    else out.push(p);
  }
  return out;
};
const text = (v: Val) => v.map((p) => (p.t === "lit" ? p.v : `{${p.name}}`)).join("");
const isEmpty = (v: Val) => v.length === 0;

/** Static string evaluator over the TypeScript AST: literals, templates, concatenation, consts, object-literal configuration, constructor-assigned fields and environment variables. It never executes code. */
class Evaluator {
  private readonly active = new Set<TS.Node>();
  constructor(private readonly view: TsProgramView) {}

  private get ts() {
    return this.view.ts;
  }

  eval(expr: TS.Expression | undefined, depth = 0): Val {
    const ts = this.ts;
    if (!expr) return [];
    void ts;
    if (depth > MAX_DEPTH || this.active.has(expr)) return dyn(expr.getText());
    this.active.add(expr);
    try {
      return this.evalInner(expr, depth);
    } finally {
      this.active.delete(expr);
    }
  }

  private evalInner(expr: TS.Expression, depth: number): Val {
    const ts = this.ts;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return lit(expr.text);
    if (ts.isNumericLiteral(expr)) return lit(expr.text);
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isSatisfiesExpression(expr)) return this.eval(expr.expression, depth + 1);
    if (ts.isTemplateExpression(expr)) return concat(lit(expr.head.text), ...expr.templateSpans.flatMap((s) => [this.eval(s.expression, depth + 1), lit(s.literal.text)]));
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) return concat(this.eval(expr.left, depth + 1), this.eval(expr.right, depth + 1));
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return this.fallback(this.eval(expr.left, depth + 1), this.eval(expr.right, depth + 1));
      return dyn(expr.getText());
    }
    if (ts.isConditionalExpression(expr)) {
      const a = this.eval(expr.whenTrue, depth + 1);
      const b = this.eval(expr.whenFalse, depth + 1);
      if (text(a) === text(b)) return a;
      if (isEmpty(b) && a.length === 1 && a[0]!.t === "hole") return [{ ...a[0]!, optional: true }];
      if (isEmpty(a) && b.length === 1 && b[0]!.t === "hole") return [{ ...b[0]!, optional: true }];
      if (a.every((p) => p.t === "lit") && b.every((p) => p.t === "lit")) return [{ t: "hole", kind: "dynamic", name: expr.getText().replace(/\s+/g, " ").slice(0, 60), alts: [text(a), text(b)] }];
      return dyn(expr.getText());
    }
    if (ts.isCallExpression(expr)) return this.evalCall(expr, depth);
    if (ts.isPropertyAccessExpression(expr)) return this.evalProperty(expr, depth);
    if (ts.isIdentifier(expr)) return this.evalIdentifier(expr, expr, depth);
    return dyn(expr.getText());
  }

  private fallback(left: Val, right: Val): Val {
    if (left.length === 1 && left[0]!.t === "hole") {
      const h = left[0]!;
      if (h.kind === "config") return [{ ...h, dflt: right.length === 1 && right[0]!.t === "lit" ? right[0]!.v : null }];
      if (isEmpty(right)) return [{ ...h, optional: true }];
    }
    return left;
  }

  private evalCall(expr: TS.CallExpression, depth: number): Val {
    const ts = this.ts;
    const callee = expr.expression;
    if (ts.isIdentifier(callee) && /^(encodeURIComponent|encodeURI|String)$/.test(callee.text)) {
      const inner = this.eval(expr.arguments[0], depth + 1);
      return inner.length === 1 && inner[0]!.t === "hole" ? inner : dyn(expr.arguments[0]?.getText() ?? "value");
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === "replace" || method === "replaceAll") {
        const recv = this.eval(callee.expression, depth + 1);
        const pattern = expr.arguments[0];
        if (pattern && (ts.isRegularExpressionLiteral(pattern) || ((ts.isStringLiteral(pattern) || ts.isNoSubstitutionTemplateLiteral(pattern)) && /^\{[\w.-]+\}$/.test(pattern.text) && text(recv).includes(pattern.text)))) return recv;
        return dyn(expr.getText());
      }
      if (method === "trim" || method === "toString" || method === "valueOf") return this.eval(callee.expression, depth + 1);
      if (method === "concat") return concat(this.eval(callee.expression, depth + 1), ...expr.arguments.map((a) => this.eval(a, depth + 1)));
      if (method === "join" && ts.isArrayLiteralExpression(callee.expression)) {
        const sep = expr.arguments[0] && ts.isStringLiteral(expr.arguments[0]) ? expr.arguments[0].text : ",";
        return concat(...callee.expression.elements.flatMap((e, i) => (i ? [lit(sep), this.eval(e, depth + 1)] : [this.eval(e, depth + 1)])));
      }
    }
    const decl = this.view.symbolAt(callee)?.valueDeclaration;
    const body = decl && (this.ts.isFunctionDeclaration(decl) || this.ts.isArrowFunction(decl) || this.ts.isFunctionExpression(decl)) ? decl.body : decl && this.ts.isVariableDeclaration(decl) && decl.initializer && (this.ts.isArrowFunction(decl.initializer) || this.ts.isFunctionExpression(decl.initializer)) ? decl.initializer.body : undefined;
    if (body && expr.arguments.length === 0) {
      if (!this.ts.isBlock(body)) return this.eval(body, depth + 1);
      const returns = body.statements.filter(this.ts.isReturnStatement);
      if (returns.length === 1 && body.statements.length === 1) return this.eval(returns[0]!.expression, depth + 1);
    }
    return dyn(expr.getText());
  }

  private evalProperty(expr: TS.PropertyAccessExpression, depth: number): Val {
    const ts = this.ts;
    const chain = expr.getText().replace(/\s+/g, "");
    const env = /^(import\.meta\.env|process\.env)\.([A-Za-z_][\w]*)$/.exec(chain);
    if (env) return [{ t: "hole", kind: "config", key: env[2]!, dflt: null, name: env[2]! }];
    if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) return this.evalThisField(expr, depth);
    const viaLiteral = this.objectPath(expr);
    if (viaLiteral) return this.eval(viaLiteral, depth + 1);
    const sym = this.view.symbolAt(expr.name);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isPropertyAssignment(decl)) return this.eval(decl.initializer, depth + 1);
    if (decl && ts.isShorthandPropertyAssignment(decl)) return this.evalIdentifier(decl.name, decl.name, depth + 1);
    if (decl && ts.isEnumMember(decl) && decl.initializer) return this.eval(decl.initializer, depth + 1);
    if (decl && ts.isPropertyDeclaration(decl) && decl.initializer && decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword || m.kind === ts.SyntaxKind.ReadonlyKeyword)) return this.eval(decl.initializer, depth + 1);
    return dyn(expr.getText());
  }

  /** `a.b.c` where `a` is a const bound to an object literal: the initializer of the addressed property. */
  private objectPath(expr: TS.PropertyAccessExpression): TS.Expression | null {
    const ts = this.ts;
    const names: string[] = [];
    let cur: TS.Expression = expr;
    while (ts.isPropertyAccessExpression(cur)) {
      names.unshift(cur.name.text);
      cur = cur.expression;
    }
    if (!ts.isIdentifier(cur)) return null;
    const decl = this.view.symbolAt(cur)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isVariableDeclarationList(decl.parent) || (decl.parent.flags & ts.NodeFlags.Const) === 0) return null;
    let node: TS.Expression = decl.initializer;
    for (const name of names) {
      while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
      if (!ts.isObjectLiteralExpression(node)) return null;
      const next = objectProperty(ts, node, name);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** `this.x`: a field initializer or a single constructor assignment; constructor parameters become ctor holes. */
  evalThisField(expr: TS.PropertyAccessExpression, depth: number): Val {
    const ts = this.ts;
    const cls = ts.findAncestor(expr, (n) => ts.isClassDeclaration(n) || ts.isClassExpression(n)) as TS.ClassLikeDeclaration | undefined;
    const name = expr.name.text;
    const sym = this.view.symbolAt(expr.name);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent)) return this.paramHole(decl);
    const owner = decl && ts.isPropertyDeclaration(decl) ? (decl.parent as TS.ClassLikeDeclaration) : cls;
    if (!owner) return dyn(expr.getText());
    const sources: TS.Expression[] = [];
    let outsideCtor = false;
    if (decl && ts.isPropertyDeclaration(decl) && decl.initializer) sources.push(decl.initializer);
    const visit = (n: TS.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) {
        const holder = ts.findAncestor(n.parent, (a) => ts.isFunctionLike(a) || ts.isClassElement(a));
        if (holder && ts.isConstructorDeclaration(holder)) sources.push(n.right);
        else outsideCtor = true;
      }
      ts.forEachChild(n, visit);
    };
    for (const m of owner.members) visit(m);
    if (outsideCtor || sources.length !== 1) return dyn(`this.${name}`);
    return this.eval(sources[0], depth + 1);
  }

  paramHole(p: TS.ParameterDeclaration): Val {
    const ts = this.ts;
    const fn = p.parent;
    const index = fn.parameters.indexOf(p);
    const name = ts.isIdentifier(p.name) ? p.name.text : `arg${index}`;
    if (ts.isConstructorDeclaration(fn)) {
      const cls = this.view.keyOf(fn.parent);
      if (cls) return [{ t: "hole", kind: "ctor", cls: cls.key, index, name }];
    }
    const ref = this.view.keyOf(fn) ?? (ts.isVariableDeclaration(fn.parent) || ts.isPropertyDeclaration(fn.parent) ? this.view.keyOf(fn.parent) : null);
    return ref ? [{ t: "hole", kind: "param", fn: ref.key, index, name }] : dyn(name);
  }

  evalIdentifier(id: TS.Identifier, use: TS.Node, depth: number): Val {
    const ts = this.ts;
    if (id.text === "undefined") return [];
    const sym = this.view.symbolAt(id);
    const decl = sym?.valueDeclaration;
    if (!decl) return dyn(id.text);
    if (ts.isParameter(decl)) return this.paramHole(decl);
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (isConst) return decl.initializer ? this.eval(decl.initializer, depth + 1) : dyn(id.text);
      return this.flowValue(decl, use, depth);
    }
    if (ts.isPropertyAssignment(decl)) return this.eval(decl.initializer, depth + 1);
    if (ts.isEnumMember(decl) && decl.initializer) return this.eval(decl.initializer, depth + 1);
    return dyn(id.text);
  }

  /** Value of a `let`/`var` local at a use site: its initializer followed by assignments in source order before the use. */
  private flowValue(decl: TS.VariableDeclaration, use: TS.Node, depth: number): Val {
    const ts = this.ts;
    const scope = ts.findAncestor(decl, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n));
    if (!scope) return dyn(decl.name.getText());
    const declBlock = decl.parent.parent.parent;
    const sym = this.view.checker.getSymbolAtLocation(decl.name);
    let value: Val = decl.initializer ? this.eval(decl.initializer, depth + 1) : [];
    const assignments: TS.BinaryExpression[] = [];
    const visit = (n: TS.Node) => {
      if (n.pos >= use.pos) return;
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && n.end <= use.pos && this.view.checker.getSymbolAtLocation(n.left) === sym) assignments.push(n);
      ts.forEachChild(n, visit);
    };
    visit(scope);
    for (const a of assignments.sort((x, y) => x.pos - y.pos)) {
      const conditional = a.parent?.parent !== declBlock;
      const rhs = this.withSelf(a.right, decl, value, depth);
      if (a.operatorToken.kind === ts.SyntaxKind.EqualsToken) value = conditional ? dyn(decl.name.getText()) : rhs;
      else if (text(value).includes("?")) continue;
      else value = conditional ? concat(value, dyn(`${decl.name.getText()} (conditional)`)) : concat(value, rhs);
    }
    return value;
  }

  private withSelf(expr: TS.Expression, decl: TS.VariableDeclaration, current: Val, depth: number): Val {
    const ts = this.ts;
    const sym = this.view.checker.getSymbolAtLocation(decl.name);
    const selfRef = (n: TS.Expression): boolean => ts.isIdentifier(n) && this.view.checker.getSymbolAtLocation(n) === sym;
    if (selfRef(expr)) return current;
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && selfRef(expr.expression.expression)) {
      const method = expr.expression.name.text;
      const pattern = expr.arguments[0];
      if ((method === "replace" || method === "replaceAll") && pattern && (ts.isRegularExpressionLiteral(pattern) || ((ts.isStringLiteral(pattern) || ts.isNoSubstitutionTemplateLiteral(pattern)) && /^\{[\w.-]+\}$/.test(pattern.text)))) return current;
      if (method === "trim") return current;
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken && selfRef(expr.left)) return concat(current, this.eval(expr.right, depth + 1));
    return this.eval(expr, depth + 1);
  }
}

interface HttpSite {
  node: TS.CallExpression;
  api: "fetch" | "axios" | "angular-http-client";
  verb: Val | null;
  url: Val;
  base: Val | null;
  responseType: string | null;
  interceptor?: string;
}

/** Substitute holes using bindings for method parameters and constructor parameters. */
function substitute(v: Val, params: Map<string, Val>, ctors: Map<string, Val>): Val {
  return concat(
    ...v.map((p): Val => {
      if (p.t === "lit") return [p];
      const bound = p.kind === "param" ? params.get(`${p.fn}#${p.index}`) : p.kind === "ctor" ? ctors.get(`${p.cls}#${p.index}`) : undefined;
      if (!bound) return [p];
      if (p.optional && bound.length === 0) return [];
      return bound;
    }),
  );
}

const hasInstanceHoles = (v: Val) => v.some((p) => p.t === "hole" && (p.kind === "ctor" || p.kind === "param"));
/** An URL that cannot be finalized because constructor or argument values decide its base or path structure. */
const needsBinding = (verb: Val | null, v: Val) => hasInstanceHoles(v) && expand(v).some((x) => finalize(verb, x).url === null);

/** Join an axios-style base URL and request URL (axios combineURLs). */
function joinBase(base: Val | null, url: Val): Val {
  if (!base || isEmpty(base)) return url;
  if (isEmpty(url)) return base;
  const first = url[0]!;
  if (first.t === "lit" && /^[a-z][\w+.-]*:\/\//i.test(first.v)) return url;
  const b = [...base];
  const last = b[b.length - 1]!;
  if (last.t === "lit") b[b.length - 1] = { t: "lit", v: last.v.replace(/\/+$/, "") };
  const u = [...url];
  if (first.t === "lit") u[0] = { t: "lit", v: first.v.replace(/^\/+/, "") };
  return concat(b, lit("/"), u);
}

interface Finalized {
  verb: string | null;
  url: string | null;
  urlKind: HttpCallFact["urlKind"];
  baseAddress: string | null;
  baseConfigurationKey: string | null;
  configurationKey: string | null;
  details: Record<string, string>;
  reason: string | null;
}

/** Expand holes with statically known alternatives (e.g. `cond ? '/feed' : ''`) into separate values, at most 4. */
function expand(value: Val): Val[] {
  let out: Val[] = [[]];
  for (const p of value) {
    if (p.t === "hole" && p.kind === "dynamic" && p.alts) {
      if (out.length * p.alts.length > 4) return [value];
      out = out.flatMap((v) => p.alts!.map((a) => concat(v, lit(a))));
    } else out = out.map((v) => concat(v, [p]));
  }
  return out;
}

function finalize(verbVal: Val | null, value: Val): Finalized {
  const details: Record<string, string> = {};
  const verbText = verbVal === null ? "GET" : verbVal.length === 1 && verbVal[0]!.t === "lit" ? verbVal[0]!.v.toUpperCase() : null;
  const verb = verbText && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(verbText) ? verbText : null;
  const parts: Part[] = [];
  for (const p of value) {
    if (p.t === "lit") {
      const cut = p.v.search(/[?#]/);
      if (cut >= 0) {
        if (cut > 0) parts.push({ t: "lit", v: p.v.slice(0, cut) });
        break;
      }
    }
    parts.push(p);
  }
  const out: Finalized = { verb, url: null, urlKind: "dynamic", baseAddress: null, baseConfigurationKey: null, configurationKey: null, details, reason: null };
  if (!parts.length) {
    out.reason = "request URL is empty or not statically determinable";
    return out;
  }
  let rest = parts;
  const head = parts[0]!;
  if (head.t === "hole") {
    const next = parts[1];
    if (next && next.t !== "lit") {
      out.reason = `URL starts with ${parts.filter((p) => p.t === "hole").length} undetermined values (${text(parts.slice(0, 2))})`;
      details.urlExpression = text(parts).slice(0, 200);
      return out;
    }
    if (head.kind === "config") {
      out.baseConfigurationKey = head.key;
      if (head.dflt) {
        const safe = safeValue(head.key, head.dflt);
        if (safe.valueKind === "url" && safe.value) {
          out.baseAddress = safe.value;
          details.baseSource = `default of ${head.key}`;
        }
      }
    } else {
      details.baseExpression = head.name;
      if (head.optional) details.baseAssumption = "optional base URL defaults to empty (same origin)";
    }
    if (head.kind === "ctor" || head.kind === "param") details.baseBinding = head.kind === "ctor" ? "constructor argument" : "method argument";
    rest = parts.slice(1);
    if (!rest.length) {
      out.urlKind = head.kind === "config" ? "configuration" : "dynamic";
      out.configurationKey = head.kind === "config" ? head.key : null;
      out.baseConfigurationKey = null;
      out.reason = head.kind === "config" ? `URL comes from configuration ${head.key}` : "request URL is not statically determinable";
      return out;
    }
  }
  for (const p of rest) {
    if (p.t === "hole" && (p.kind === "ctor" || p.kind === "config" || (p.kind === "dynamic" && /conditional/.test(p.name)))) {
      out.reason = `URL path contains ${p.kind === "ctor" ? "a constructor-bound" : p.kind === "config" ? "a configuration-bound" : "a conditionally built"} fragment ({${p.name}}) whose segments are unknown`;
      details.urlExpression = text(parts).slice(0, 200);
      return out;
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i]!;
    if (p.t !== "hole") continue;
    const before = rest[i - 1];
    const after = rest[i + 1];
    const startsSegment = i === 0 || (before?.t === "lit" && before.v.endsWith("/"));
    const endsSegment = !after || (after.t === "lit" && after.v.startsWith("/"));
    if (!startsSegment || !endsSegment) {
      out.reason = `URL path fragment {${p.name}} is not a whole path segment and is not statically determinable`;
      details.urlExpression = text(parts).slice(0, 200);
      return out;
    }
  }
  const segmentName = (p: Hole) => (/^[A-Za-z_][\w]*$/.test(p.name) ? p.name : p.name.replace(/^.*\./, "").replace(/\W+/g, "") || "param");
  const url = rest.map((p) => (p.t === "lit" ? p.v : `{${segmentName(p)}}`)).join("");
  out.url = /^[a-z][\w+.-]*:\/\//i.test(url) || url.startsWith("/") ? url : `/${url}`;
  out.urlKind = rest.some((p) => p.t === "hole") ? "template" : "literal";
  if (/^[a-z][\w+.-]*:\/\//i.test(out.url)) {
    const safe = safeValue("url", out.url.replace(/\{([^}]*)\}/g, "__p_$1__"));
    out.url = safe.value ? safe.value.replace(/__p_([^_]*)__/g, "{$1}") : null;
    if (!out.url) out.reason = "URL could not be sanitized";
  }
  return out;
}

export const frontendHttpPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const projects = ctx.artifacts.get(FRONTEND_PROJECTS) ?? [];
    if (!projects.length || !ctx.options.semantic) return;
    const all: HttpCallFact[] = [];
    for (const project of projects) {
      try {
        const result = await cachedProjectAnalysis(ctx, ID, VERSION, project.pkg, project.key, async (rec) => {
          const view = await project.view();
          if (view) analyzeHttp(ctx, rec, view);
        });
        all.push(...result.http);
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file: project.pkg.path, severity: "error", recoverable: true, code: "frontend-http-failed", message: `frontend HTTP call analysis failed for ${project.pkg.path}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    ctx.artifacts.set(HTTP_CALLS, [...(ctx.artifacts.get(HTTP_CALLS) ?? []), ...all]);
    ctx.log.info("frontend.http-calls", { calls: all.length, resolvedUrls: all.filter((c) => c.url).length });
  },
};

function analyzeHttp(ctx: AnalysisContext, rec: Recorder, view: TsProgramView): void {
  const fileFailed = (file: string, error: string) =>
    rec.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file, severity: "error", recoverable: true, code: "frontend-http-file-failed", message: `analysis of ${file} failed and was skipped; other files are unaffected: ${error}` });
  const ts = view.ts;
  const ev = new Evaluator(view);
  const apps = view.pkg.applications.map((a) => a.entityId);
  const sites: HttpSite[] = [];

  const declaredTypeOrigin = (expr: TS.Expression): { module: string; name: string } | null => {
    const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    const decl = view.symbolAt(target)?.valueDeclaration;
    if (!decl) return null;
    const typeNode = (ts.isPropertyDeclaration(decl) || ts.isParameter(decl) || ts.isVariableDeclaration(decl)) ? decl.type : undefined;
    if (typeNode && ts.isTypeReferenceNode(typeNode)) return view.importOrigin(ts.isQualifiedName(typeNode.typeName) ? typeNode.typeName.right : typeNode.typeName);
    const init = (ts.isPropertyDeclaration(decl) || ts.isVariableDeclaration(decl)) ? decl.initializer : undefined;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "inject" && init.arguments[0] && ts.isIdentifier(init.arguments[0])) return view.importOrigin(init.arguments[0]);
    return null;
  };
  const isAxiosImport = (e: TS.Expression) => ts.isIdentifier(e) && view.importOrigin(e)?.module === "axios";
  /** An axios instance created with axios.create(config): returns the evaluated baseURL. */
  const axiosInstanceBase = (expr: TS.Expression): Val | null => {
    const sources: TS.Expression[] = [];
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = ts.findAncestor(expr, ts.isClassLike);
      const name = expr.name.text;
      const visit = (n: TS.Node) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) sources.push(n.right);
        if (ts.isPropertyDeclaration(n) && n.name.getText() === name && n.initializer) sources.push(n.initializer);
        ts.forEachChild(n, visit);
      };
      if (cls) cls.members.forEach(visit);
    } else {
      const decl = view.symbolAt(ts.isPropertyAccessExpression(expr) ? expr.name : expr)?.valueDeclaration;
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) sources.push(decl.initializer);
    }
    if (sources.length !== 1) return null;
    const init = sources[0]!;
    if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== "create" || !isAxiosImport(init.expression.expression)) return null;
    const cfg = init.arguments[0];
    if (!cfg) return [];
    if (!ts.isObjectLiteralExpression(cfg)) return dyn(cfg.getText());
    const baseURL = objectProperty(ts, cfg, "baseURL");
    return baseURL ? ev.eval(baseURL) : [];
  };
  const objectArg = (e: TS.Expression | undefined): TS.ObjectLiteralExpression | null => {
    if (!e) return null;
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isIdentifier(e)) {
      const decl = view.symbolAt(e)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) return decl.initializer;
    }
    return null;
  };
  const typeArg = (n: TS.CallExpression) => (n.typeArguments?.[0] ? n.typeArguments[0].getText().slice(0, 120) : null);

  const envRefs = new Set<string>();
  const visit = (node: TS.Node) => {
    if (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const env = /^(import\.meta\.env|process\.env)\.([A-Za-z_]\w*)$/.exec(node.getText().replace(/\s+/g, ""));
      const owner = env ? ownerId(ctx, rec, view, node, ID) : null;
      if (env && owner && !envRefs.has(`${owner}|${env[2]}`)) {
        envRefs.add(`${owner}|${env[2]}`);
        const l = view.loc(node);
        const p = frontendProvenance(ctx, ID, VERSION, "env-reference", "typescript-compiler", l.file, l.line, l.column);
        const configId = rec.entity({ key: `config-ref|${ctx.repository.id}|frontend-env|${env[2]}`, kind: "ConfigurationReference", layer: "application", name: env[2]!, qualifiedName: `frontend-env:${env[2]}`, repositoryId: ctx.repository.id, language: "typescript", metadata: { source: "frontend-env", configurationKind: "build-time-environment", secretLikeName: isSecretName(env[2]!) }, provenance: p });
        rec.relate({ type: "REFERENCES_CONFIG", sourceId: owner, targetId: configId, repositoryId: ctx.repository.id, evidence: "COMPILER_RESOLVED", metadata: { accessor: env[1]! }, provenance: p });
        if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_|NG_APP_)/.test(env[2]!) && isSecretName(env[2]!)) rec.diagnostic({ repositoryId: ctx.repository.id, category: "framework", plugin: ID, file: l.file, severity: "warning", recoverable: true, code: "public-env-secret-name", message: `${env[2]} looks like a secret but its prefix exposes it to browser bundles (${l.file}:${l.line}); the value is not recorded` });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "fetch" && !view.symbolAt(callee)?.valueDeclaration && node.arguments[0]) {
        const init = objectArg(node.arguments[1]);
        const method = init ? objectProperty(ts, init, "method") : null;
        sites.push({ node, api: "fetch", verb: method ? ev.eval(method) : null, url: ev.eval(node.arguments[0]), base: null, responseType: null });
      } else if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const recv = callee.expression;
        if (name === "fetch" && node.arguments[0]) {
          const decl = view.symbolAt(callee.name)?.valueDeclaration;
          const global = ts.isIdentifier(recv) && /^(window|globalThis|self)$/.test(recv.text);
          if (global || (decl && (ts.isMethodSignature(decl) || ts.isPropertySignature(decl)) && ts.isTypeLiteralNode(decl.parent))) {
            const init = objectArg(node.arguments[1]);
            const method = init ? objectProperty(ts, init, "method") : null;
            sites.push({ node, api: "fetch", verb: method ? ev.eval(method) : null, url: ev.eval(node.arguments[0]), base: null, responseType: null });
          }
        } else if (VERBS.has(name) || name === "request" || name === "jsonp") {
          const origin = declaredTypeOrigin(recv);
          if (origin?.module === "@angular/common/http" && origin.name === "HttpClient") {
            if (name === "request") sites.push({ node, api: "angular-http-client", verb: ev.eval(node.arguments[0]), url: ev.eval(node.arguments[1]), base: null, responseType: typeArg(node) });
            else sites.push({ node, api: "angular-http-client", verb: lit(name === "jsonp" ? "GET" : name), url: ev.eval(node.arguments[0]), base: null, responseType: typeArg(node) });
          } else {
            const axiosBase = isAxiosImport(recv) ? [] : axiosInstanceBase(recv);
            if (axiosBase !== null) {
              if (name === "request") {
                const cfg = objectArg(node.arguments[0]);
                const method = cfg ? objectProperty(ts, cfg, "method") : null;
                const url = cfg ? objectProperty(ts, cfg, "url") : null;
                const base = cfg ? objectProperty(ts, cfg, "baseURL") : null;
                sites.push({ node, api: "axios", verb: method ? ev.eval(method) : null, url: url ? ev.eval(url) : [], base: base ? ev.eval(base) : axiosBase, responseType: typeArg(node) });
              } else if (name !== "jsonp") sites.push({ node, api: "axios", verb: lit(name), url: ev.eval(node.arguments[0]), base: axiosBase, responseType: typeArg(node) });
            }
          }
        }
      } else if (isAxiosImport(callee) && node.arguments[0]) {
        const cfg = objectArg(node.arguments[0]);
        if (cfg) {
          const method = objectProperty(ts, cfg, "method");
          const url = objectProperty(ts, cfg, "url");
          sites.push({ node, api: "axios", verb: method ? ev.eval(method) : null, url: url ? ev.eval(url) : [], base: null, responseType: null });
        } else sites.push({ node, api: "axios", verb: null, url: ev.eval(node.arguments[0]), base: null, responseType: null });
      }
    }
    ts.forEachChild(node, visit);
  };
  view.eachFile(fileFailed, visit);

  let callIndex: Map<string, TS.CallExpression[]> | null = null;
  const callersOf = (key: string) => {
    if (!callIndex) {
      callIndex = new Map();
      const idx = callIndex;
      const walk = (n: TS.Node) => {
        if (ts.isCallExpression(n)) {
          const target = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
          for (const ref of view.declRefs(view.symbolAt(target))) idx.set(ref.key, [...(idx.get(ref.key) ?? []), n]);
        }
        ts.forEachChild(n, walk);
      };
      view.eachFile(fileFailed, walk);
    }
    return callIndex.get(key) ?? [];
  };
  const classKeyChain = (cls: TS.ClassLikeDeclaration): TS.ClassLikeDeclaration[] => {
    const out = [cls];
    for (let cur: TS.ClassLikeDeclaration | undefined = cls; cur && out.length < 6; ) {
      const ext: TS.ExpressionWithTypeArguments | undefined = cur.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      const decl: TS.Declaration | undefined = ext ? view.symbolAt(ext.expression)?.valueDeclaration : undefined;
      cur = decl && ts.isClassLike(decl) ? decl : undefined;
      if (cur) out.push(cur);
    }
    return out;
  };
  /** Bind constructor holes of every class in the hierarchy of `cls` given `new cls(args)` evaluated in the caller's scope. */
  const ctorBindings = (cls: TS.ClassLikeDeclaration, args: Val[]): Map<string, Val> => {
    const out = new Map<string, Val>();
    let current: { cls: TS.ClassLikeDeclaration; args: Val[] } | null = { cls, args };
    for (let i = 0; current && i < 6; i++) {
      const key = view.keyOf(current.cls)?.key;
      if (key) current.args.forEach((a, idx) => out.set(`${key}#${idx}`, a));
      const ctor = current.cls.members.find(ts.isConstructorDeclaration);
      const chain = classKeyChain(current.cls);
      const base = chain[1];
      if (!base) break;
      if (!ctor) {
        current = { cls: base, args: current.args };
        continue;
      }
      let superCall: TS.CallExpression | undefined;
      ctor.body?.statements.forEach((s) => {
        if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword) superCall = s.expression;
      });
      if (!superCall) break;
      const own = new Map<string, Val>(current.args.map((a, idx): [string, Val] => [`${key}#${idx}`, a]));
      const next: Val[] = superCall.arguments.map((a: TS.Expression): Val => substitute(ev.eval(a), new Map(), own));
      current = { cls: base, args: next };
    }
    return out;
  };
  const constructionOf = (recv: TS.Expression): { cls: TS.ClassLikeDeclaration; args: TS.NodeArray<TS.Expression> } | null => {
    let init: TS.Expression | undefined;
    if (ts.isNewExpression(recv)) init = recv;
    else {
      const decl = view.symbolAt(ts.isPropertyAccessExpression(recv) ? recv.name : recv)?.valueDeclaration;
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) init = decl.initializer;
    }
    while (init && (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
    if (!init || !ts.isNewExpression(init)) return null;
    const decl = view.symbolAt(init.expression)?.valueDeclaration;
    return decl && ts.isClassLike(decl) ? { cls: decl, args: init.arguments ?? ts.factory.createNodeArray() } : null;
  };

  const emit = (site: HttpSite, at: TS.CallExpression, value: Val, verb: Val | null, extra: Record<string, string>) => {
    const owner = ownerId(ctx, rec, view, at, ID);
    if (!owner) return;
    const l = view.loc(at);
    const ownerRef = view.ownerOf(at);
    const variants = expand(value);
    for (const variant of variants) {
    const f = finalize(verb, variant);
    rec.http.push({
      callerEntityId: owner,
      callerDisplay: ownerRef ? `${ownerRef.file}:${ownerRef.path}` : l.file,
      projectId: view.pkg.entityId,
      verb: f.verb,
      url: f.url,
      urlKind: f.urlKind,
      configurationKey: f.configurationKey,
      clientEntityId: null,
      baseAddress: f.baseAddress,
      baseConfigurationKey: f.baseConfigurationKey,
      api: site.api,
      requestType: null,
      responseType: null,
      location: { file: l.file, line: l.line, column: l.column },
      applications: apps,
      details: { ...f.details, ...extra, ...(site.responseType ? { tsResponseType: site.responseType } : {}), ...(f.reason && !f.url ? { urlReason: f.reason } : {}), ...(variants.length > 1 ? { urlVariant: `${variants.indexOf(variant) + 1}/${variants.length}` } : {}) },
    });
    for (const key of [f.baseConfigurationKey, f.configurationKey]) {
      if (!key) continue;
      const configId = rec.entity({
        key: `config-ref|${ctx.repository.id}|frontend-env|${key}`,
        kind: "ConfigurationReference",
        layer: "application",
        name: key,
        qualifiedName: `frontend-env:${key}`,
        repositoryId: ctx.repository.id,
        language: "typescript",
        metadata: { source: "frontend-env", configurationKind: "build-time-environment", secretLikeName: isSecretName(key) },
        provenance: frontendProvenance(ctx, ID, VERSION, "env-reference", "typescript-compiler", l.file, l.line, l.column),
      });
      rec.relate({ type: "REFERENCES_CONFIG", sourceId: owner, targetId: configId, repositoryId: ctx.repository.id, evidence: "COMPILER_RESOLVED", metadata: { kind: "http-base-url" }, provenance: frontendProvenance(ctx, ID, VERSION, "env-reference", "typescript-compiler", l.file, l.line, l.column) });
    }
    }
  };

  /** Specialize an instance- or argument-bound URL at the call sites of its enclosing method. */
  const specialize = (site: HttpSite, at: TS.CallExpression, value: Val, verb: Val | null, depth: number, trail: string[]): number => {
    const owner = view.ownerOf(at);
    if (!owner || depth > MAX_SPECIALIZATION_DEPTH) return 0;
    let produced = 0;
    for (const call of callersOf(owner.key)) {
      const ownerNode = ts.findAncestor(at, (n) => view.keyOf(n)?.key === owner.key);
      const fn = ownerNode && (ts.isFunctionLike(ownerNode) ? ownerNode : ts.isVariableDeclaration(ownerNode) || ts.isPropertyDeclaration(ownerNode) ? ownerNode.initializer : undefined);
      const params = new Map<string, Val>();
      if (fn && ts.isFunctionLike(fn)) fn.parameters.forEach((_, i) => params.set(`${owner.key}#${i}`, call.arguments[i] ? ev.eval(call.arguments[i]) : []));
      let ctors = new Map<string, Val>();
      const recv = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : null;
      if (recv && recv.kind !== ts.SyntaxKind.ThisKeyword) {
        const built = constructionOf(recv);
        if (built) ctors = ctorBindings(built.cls, [...built.args].map((a) => ev.eval(a)));
      }
      const v = substitute(value, params, ctors);
      const vb = verb ? substitute(verb, params, ctors) : null;
      const caller = view.ownerOf(call);
      const nextTrail = [...trail, `${owner.file}:${owner.path}`];
      if (needsBinding(vb, v)) {
        const n = specialize(site, call, v, vb, depth + 1, nextTrail);
        produced += n;
        if (n) continue;
      }
      if (!caller && !ctx.fileEntityId(view.repoPath(call.getSourceFile()))) continue;
      emit(site, call, v, vb, { specializedFrom: nextTrail.join(" <- "), specializationDepth: String(depth + 1) });
      produced++;
    }
    return produced;
  };

  const rewrite = interceptorPrefix();
  for (const site of sites) {
    if (site.api === "angular-http-client" && rewrite && !(site.url[0]?.t === "lit" && /^[a-z][\w+.-]*:\/\//i.test(site.url[0].v))) {
      site.url = concat(rewrite.prefix, site.url);
      site.interceptor = rewrite.name;
    }
    const value = joinBase(site.base, site.url);
    if (needsBinding(site.verb, value)) {
      const n = specialize(site, site.node, value, site.verb, 0, []);
      if (n) {
        const owner = ownerId(ctx, rec, view, site.node, ID);
        if (owner) rec.annotate(owner, { httpRequestSite: true, httpUrlBinding: "per-call-site" }, frontendProvenance(ctx, ID, VERSION, "http-call", "typescript-compiler", view.loc(site.node).file, view.loc(site.node).line));
        continue;
      }
    }
    emit(site, site.node, value, site.verb, site.interceptor ? { urlRewrittenBy: site.interceptor } : {});
  }

  /** Angular interceptors registered for HttpClient that unconditionally rewrite every request URL as `<prefix>${req.url}`. */
  function interceptorPrefix(): { prefix: Val; name: string } | null {
    if (!view.pkg.frameworks.includes("angular")) return null;
    const fns: TS.Node[] = [];
    const find = (n: TS.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "withInterceptors" && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
        for (const e of n.arguments[0].elements) {
          const decl = view.symbolAt(e)?.valueDeclaration;
          if (decl) fns.push(decl);
        }
      }
      if (ts.isObjectLiteralExpression(n)) {
        const provide = objectProperty(ts, n, "provide");
        const cls = objectProperty(ts, n, "useClass");
        if (provide && ts.isIdentifier(provide) && provide.text === "HTTP_INTERCEPTORS" && cls) {
          const decl = view.symbolAt(cls)?.valueDeclaration;
          if (decl && ts.isClassLike(decl)) fns.push(...decl.members.filter((m) => m.name?.getText() === "intercept"));
        }
      }
      ts.forEachChild(n, find);
    };
    view.eachFile(fileFailed, find);
    const found: { prefix: Val; name: string }[] = [];
    for (const fn of fns) {
      const scan = (n: TS.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "clone" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
          const url = objectProperty(ts, n.arguments[0], "url");
          const conditional = !!ts.findAncestor(n, (a) => a === fn || ts.isIfStatement(a) || ts.isConditionalExpression(a)) && ts.findAncestor(n, (a) => a === fn || ts.isIfStatement(a) || ts.isConditionalExpression(a)) !== fn;
          const v = url ? ev.eval(url) : [];
          const last = v[v.length - 1];
          if (!conditional && last?.t === "hole" && /(^|\.)url$/.test(last.name) && v.slice(0, -1).every((p) => p.t === "lit")) found.push({ prefix: v.slice(0, -1), name: view.keyOf(fn)?.path ?? (ts.isVariableDeclaration(fn) ? fn.name.getText() : "interceptor") });
        }
        ts.forEachChild(n, scan);
      };
      scan(fn);
    }
    return found.length === 1 ? found[0]! : null;
  }
}

/** Statically evaluate an expression to a string when it is fully determined by literals and constants. */
export function staticString(view: TsProgramView, expr: TS.Expression | null | undefined): string | null {
  if (!expr) return null;
  const v = new Evaluator(view).eval(expr);
  return v.every((p) => p.t === "lit") ? text(v) : null;
}
