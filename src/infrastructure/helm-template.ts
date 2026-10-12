export const HELM_TEMPLATE_ENGINE_VERSION = "1";

export class Unresolved {
  constructor(readonly expr: string, readonly missing: boolean) {}
  get text(): string {
    return `\${helm:${this.expr.replace(/\s+/g, " ").replace(/[{}"]/g, "").trim()}}`;
  }
}

type Value = unknown;

type Term =
  | { type: "field"; base: "dot" | "var"; name: string; path: string[]; text: string }
  | { type: "ident"; name: string; path: string[] }
  | { type: "lit"; value: Value }
  | { type: "sub"; pipeline: Pipeline; path: string[]; text: string };

interface Pipeline {
  decl: { vars: string[]; op: ":=" | "=" } | null;
  cmds: Term[][];
  text: string;
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "output"; pipeline: Pipeline }
  | { kind: "if"; branches: { cond: Pipeline; body: Node[] }[]; otherwise: Node[] | null }
  | { kind: "with"; pipeline: Pipeline; body: Node[]; otherwise: Node[] | null }
  | { kind: "range"; pipeline: Pipeline; body: Node[]; otherwise: Node[] | null }
  | { kind: "define"; name: string; body: Node[] }
  | { kind: "template"; name: string; pipeline: Pipeline | null };

export class TemplateError extends Error {}

function lexAction(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      tokens.push(src.slice(i, j < 0 ? src.length : j + 1));
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (src.startsWith(":=", i)) {
      tokens.push(":=");
      i += 2;
      continue;
    }
    if ("()|=,".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()|,"`]/.test(src[j]!) && !(src[j] === "=" && j > i) && !src.startsWith(":=", j)) j++;
    if (j === i) j++;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

function parsePipeline(tokens: string[], pos: { i: number }, stop: string[] = []): Pipeline {
  const start = pos.i;
  let decl: Pipeline["decl"] = null;
  const vars: string[] = [];
  let k = pos.i;
  while (tokens[k]?.startsWith("$") && (tokens[k + 1] === "," || tokens[k + 1] === ":=" || tokens[k + 1] === "=")) {
    vars.push(tokens[k]!);
    if (tokens[k + 1] === ",") k += 2;
    else {
      decl = { vars, op: tokens[k + 1] as ":=" | "=" };
      pos.i = k + 2;
      break;
    }
  }
  const cmds: Term[][] = [[]];
  while (pos.i < tokens.length && !stop.includes(tokens[pos.i]!)) {
    const t = tokens[pos.i]!;
    if (t === "|") {
      cmds.push([]);
      pos.i++;
      continue;
    }
    if (t === "(") {
      pos.i++;
      const inner = parsePipeline(tokens, pos, [")"]);
      pos.i++;
      let path: string[] = [];
      if (tokens[pos.i]?.startsWith(".") && tokens[pos.i] !== ".") path = tokens[pos.i++]!.slice(1).split(".");
      cmds[cmds.length - 1]!.push({ type: "sub", pipeline: inner, path, text: `(${inner.text})` });
      continue;
    }
    pos.i++;
    cmds[cmds.length - 1]!.push(term(t));
  }
  return { decl, cmds, text: tokens.slice(start, pos.i).join(" ") };
}

function term(t: string): Term {
  if (t.startsWith('"')) return { type: "lit", value: JSON.parse(t.replace(/\\([^"\\/bfnrtu])/g, "$1")) };
  if (t.startsWith("`")) return { type: "lit", value: t.slice(1, -1) };
  if (t.startsWith("'")) return { type: "lit", value: t.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { type: "lit", value: Number(t) };
  if (t === "true" || t === "false") return { type: "lit", value: t === "true" };
  if (t === "nil") return { type: "lit", value: null };
  if (t === ".") return { type: "field", base: "dot", name: "", path: [], text: "." };
  if (t.startsWith(".")) return { type: "field", base: "dot", name: "", path: t.slice(1).split("."), text: t };
  if (t.startsWith("$")) {
    const [name, ...path] = t.split(".");
    return { type: "field", base: "var", name: name!, path: path.filter(Boolean), text: t };
  }
  const [name, ...path] = t.split(".");
  return { type: "ident", name: name!, path };
}

interface RawAction {
  text: string;
}

export function parseTemplate(source: string): Node[] {
  const pieces: (string | RawAction)[] = [];
  let last = 0;
  let trimNext = false;
  let pos = 0;
  while ((pos = source.indexOf("{{", pos)) >= 0) {
    let j = pos + 2;
    let quote: string | null = null;
    const comment = /^-?\s*\/\*/.exec(source.slice(j, j + 8));
    if (comment) {
      const close = source.indexOf("*/", j);
      j = close < 0 ? source.length : close + 2;
    }
    while (j < source.length) {
      const c = source[j]!;
      if (quote) {
        if (c === "\\" && quote === '"') j++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "`") quote = c;
      else if (c === "}" && source[j + 1] === "}") break;
      j++;
    }
    if (j >= source.length) throw new TemplateError("unterminated action");
    const inner = source.slice(pos + 2, j);
    const trimLeft = /^-\s/.test(inner);
    const trimRight = /\s-$/.test(inner);
    let text = source.slice(last, pos);
    if (trimNext) text = text.replace(/^\s+/, "");
    if (trimLeft) text = text.replace(/\s+$/, "");
    if (text) pieces.push(text);
    const body = inner.slice(trimLeft ? 2 : 0, trimRight ? inner.length - 2 : inner.length).trim();
    if (!body.startsWith("/*")) pieces.push({ text: body });
    trimNext = trimRight;
    last = pos = j + 2;
  }
  let tail = source.slice(last);
  if (trimNext) tail = tail.replace(/^\s+/, "");
  if (tail) pieces.push(tail);

  let idx = 0;
  const parseList = (terminators: string[]): { nodes: Node[]; end: string } => {
    const nodes: Node[] = [];
    while (idx < pieces.length) {
      const piece = pieces[idx++]!;
      if (typeof piece === "string") {
        nodes.push({ kind: "text", text: piece });
        continue;
      }
      const tokens = lexAction(piece.text);
      const head = tokens[0] ?? "";
      if (terminators.includes(head)) {
        idx--;
        return { nodes, end: head };
      }
      const rest = () => {
        const pos = { i: 1 };
        return parsePipeline(tokens, pos);
      };
      switch (head) {
        case "if": {
          const branches = [{ cond: rest(), body: [] as Node[] }];
          let otherwise: Node[] | null = null;
          for (;;) {
            const r = parseList(["else", "end"]);
            const target = otherwise ?? branches[branches.length - 1]!.body;
            target.push(...r.nodes);
            const term = pieces[idx++] as RawAction | undefined;
            if (!term) throw new TemplateError("unterminated if");
            const tt = lexAction(term.text);
            if (tt[0] === "end") break;
            if (tt[1] === "if") branches.push({ cond: parsePipeline(tt, { i: 2 }), body: [] });
            else otherwise = [];
          }
          nodes.push({ kind: "if", branches, otherwise });
          break;
        }
        case "with":
        case "range": {
          const pipeline = rest();
          const body = parseList(["else", "end"]);
          let otherwise: Node[] | null = null;
          let term = pieces[idx++] as RawAction | undefined;
          if (term && lexAction(term.text)[0] === "else") {
            otherwise = parseList(["end"]).nodes;
            term = pieces[idx++] as RawAction | undefined;
          }
          if (!term) throw new TemplateError(`unterminated ${head}`);
          nodes.push({ kind: head, pipeline, body: body.nodes, otherwise });
          break;
        }
        case "define":
        case "block": {
          const name = JSON.parse(tokens[1] ?? '""') as string;
          const body = parseList(["end"]).nodes;
          idx++;
          nodes.push({ kind: "define", name, body });
          if (head === "block") nodes.push({ kind: "template", name, pipeline: tokens.length > 2 ? parsePipeline(tokens, { i: 2 }) : null });
          break;
        }
        case "template":
          nodes.push({ kind: "template", name: JSON.parse(tokens[1] ?? '""') as string, pipeline: tokens.length > 2 ? parsePipeline(tokens, { i: 2 }) : null });
          break;
        case "end":
        case "else":
          throw new TemplateError(`unexpected ${head}`);
        default:
          nodes.push({ kind: "output", pipeline: parsePipeline(tokens, { i: 0 }) });
      }
    }
    return { nodes, end: "" };
  };
  const { nodes } = parseList([]);
  if (idx < pieces.length) throw new TemplateError("unbalanced template actions");
  return nodes;
}

export function collectDefines(nodes: Node[], into: Map<string, Node[]>): void {
  for (const n of nodes) {
    if (n.kind === "define") into.set(n.name, n.body);
    else if (n.kind === "if") {
      n.branches.forEach((b) => collectDefines(b.body, into));
      if (n.otherwise) collectDefines(n.otherwise, into);
    }
  }
}

const isUnresolved = (v: Value): v is Unresolved => v instanceof Unresolved;
const isMap = (v: Value): v is Record<string, Value> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Unresolved);

function truthy(v: Value): boolean | "unknown" {
  if (isUnresolved(v)) return v.missing ? false : "unknown";
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isMap(v)) return Object.keys(v).length > 0;
  return true;
}

export function toText(v: Value): string {
  if (isUnresolved(v)) return v.text;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, (_k, x) => (x instanceof Unresolved ? x.text : x));
}

function indentText(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}

function sprintf(format: string, args: Value[]): string {
  let i = 0;
  return format.replace(/%([-+ #0]*\d*(?:\.\d+)?)([svdqtfx%])/g, (_m, _flags: string, verb: string) => {
    if (verb === "%") return "%";
    const a = args[i++];
    if (verb === "q") return JSON.stringify(toText(a));
    return toText(a);
  });
}

interface Scope {
  dot: Value;
  vars: Map<string, Value>[];
}

export interface RenderState {
  defines: Map<string, Node[]>;
  root: Value;
  conditional: boolean;
  depth: number;
}

export class HelmRenderer {
  constructor(private readonly state: RenderState) {}

  get conditional(): boolean {
    return this.state.conditional;
  }

  render(nodes: Node[], dot: Value = this.state.root): string {
    return this.exec(nodes, { dot, vars: [new Map([["$", this.state.root]])] });
  }

  private exec(nodes: Node[], scope: Scope): string {
    let out = "";
    for (const n of nodes) {
      switch (n.kind) {
        case "text":
          out += n.text;
          break;
        case "define":
          break;
        case "output": {
          const v = this.evalPipeline(n.pipeline, scope);
          if (!n.pipeline.decl) out += toText(v);
          break;
        }
        case "template":
          out += this.include(n.name, n.pipeline ? this.evalPipeline(n.pipeline, scope) : null);
          break;
        case "if": {
          let done = false;
          for (const b of n.branches) {
            const t = truthy(this.evalPipeline(b.cond, scope));
            if (t === "unknown") this.state.conditional = true;
            if (t) {
              out += this.exec(b.body, this.child(scope, scope.dot));
              done = true;
              break;
            }
          }
          if (!done && n.otherwise) out += this.exec(n.otherwise, this.child(scope, scope.dot));
          break;
        }
        case "with": {
          const v = this.evalPipeline(n.pipeline, scope);
          const t = truthy(v);
          if (t === "unknown") this.state.conditional = true;
          if (t) out += this.exec(n.body, this.child(scope, v));
          else if (n.otherwise) out += this.exec(n.otherwise, this.child(scope, scope.dot));
          break;
        }
        case "range": {
          const v = this.evalPipeline({ ...n.pipeline, decl: null }, scope);
          const vars = n.pipeline.decl?.vars ?? [];
          if (isUnresolved(v)) {
            if (!v.missing) this.state.conditional = true;
            if (n.otherwise) out += this.exec(n.otherwise, this.child(scope, scope.dot));
            break;
          }
          const entries: [Value, Value][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : isMap(v) ? Object.keys(v).sort().map((k) => [k, v[k]]) : typeof v === "number" ? Array.from({ length: Math.min(v, 1000) }, (_x, i) => [i, i]) : [];
          if (!entries.length && n.otherwise) out += this.exec(n.otherwise, this.child(scope, scope.dot));
          for (const [k, item] of entries.slice(0, 1000)) {
            const s = this.child(scope, item);
            if (vars.length === 1) s.vars[0]!.set(vars[0]!, item);
            if (vars.length === 2) {
              s.vars[0]!.set(vars[0]!, k);
              s.vars[0]!.set(vars[1]!, item);
            }
            out += this.exec(n.body, s);
          }
          break;
        }
      }
    }
    return out;
  }

  private child(scope: Scope, dot: Value): Scope {
    return { dot, vars: [new Map(), ...scope.vars] };
  }

  private include(name: string, dot: Value): string {
    const body = this.state.defines.get(name);
    if (!body) return new Unresolved(`include "${name}"`, false).text;
    if (this.state.depth > 25) throw new TemplateError(`template recursion too deep at ${name}`);
    this.state.depth++;
    try {
      return this.exec(body, { dot, vars: [new Map([["$", dot]])] });
    } finally {
      this.state.depth--;
    }
  }

  private lookupVar(name: string, scope: Scope): Value {
    for (const m of scope.vars) if (m.has(name)) return m.get(name);
    return new Unresolved(name, false);
  }

  private access(base: Value, path: string[], text: string): Value {
    let cur = base;
    for (const p of path) {
      if (isUnresolved(cur)) return new Unresolved(text, cur.missing);
      if (isMap(cur) && p in cur) cur = cur[p];
      else return new Unresolved(text, true);
    }
    return cur === undefined ? new Unresolved(text, true) : cur;
  }

  private evalTerm(t: Term, scope: Scope): Value {
    switch (t.type) {
      case "lit":
        return t.value;
      case "field":
        return this.access(t.base === "dot" ? scope.dot : this.lookupVar(t.name, scope), t.path, t.text);
      case "sub":
        return this.access(this.evalPipeline(t.pipeline, scope), t.path, t.text);
      case "ident":
        return this.call(t.name, [], scope);
    }
  }

  evalPipeline(p: Pipeline, scope: Scope): Value {
    let value: Value = undefined;
    let first = true;
    for (const cmd of p.cmds) {
      if (!cmd.length) continue;
      const head = cmd[0]!;
      if (head.type === "ident") {
        const args = cmd.slice(1).map((t) => this.evalTerm(t, scope));
        if (!first) args.push(value);
        value = this.call(head.name, args, scope);
      } else {
        value = this.evalTerm(head, scope);
      }
      first = false;
    }
    if (p.decl) {
      const target = p.decl.op === ":=" ? scope.vars[0]! : (scope.vars.find((m) => m.has(p.decl!.vars[0]!)) ?? scope.vars[0]!);
      target.set(p.decl.vars[p.decl.vars.length - 1]!, value);
    }
    return value;
  }

  private call(name: string, args: Value[], _scope: Scope): Value {
    const text = (v: Value) => toText(v);
    const anyUnknown = args.some((a) => isUnresolved(a) && !a.missing);
    const unknown = () => new Unresolved(`${name} ${args.map((a) => (isUnresolved(a) ? a.expr : JSON.stringify(a))).join(" ")}`, false);
    switch (name) {
      case "include":
        return this.include(String(args[0]), args[1]);
      case "default": {
        const given = args[1];
        return truthy(given) === false ? args[0] : given;
      }
      case "required":
        return args[1];
      case "coalesce":
        return args.find((a) => truthy(a) !== false) ?? null;
      case "ternary":
        return truthy(args[2]) === "unknown" ? unknown() : truthy(args[2]) ? args[0] : args[1];
      case "quote":
        return args.map((a) => JSON.stringify(text(a))).join(" ");
      case "squote":
        return args.map((a) => `'${text(a)}'`).join(" ");
      case "upper":
        return isUnresolved(args[0]) ? args[0] : text(args[0]).toUpperCase();
      case "lower":
        return isUnresolved(args[0]) ? args[0] : text(args[0]).toLowerCase();
      case "title":
        return isUnresolved(args[0]) ? args[0] : text(args[0]).replace(/\b\w/g, (c) => c.toUpperCase());
      case "trim":
        return isUnresolved(args[0]) ? args[0] : text(args[0]).trim();
      case "trunc": {
        const s = args[1];
        if (isUnresolved(s) || text(s).includes("${helm:")) return s;
        const n = Number(args[0]);
        return n >= 0 ? text(s).slice(0, n) : text(s).slice(n);
      }
      case "trimSuffix":
        return isUnresolved(args[1]) ? args[1] : text(args[1]).endsWith(text(args[0])) ? text(args[1]).slice(0, -text(args[0]).length || undefined) : text(args[1]);
      case "trimPrefix":
        return isUnresolved(args[1]) ? args[1] : text(args[1]).startsWith(text(args[0])) ? text(args[1]).slice(text(args[0]).length) : text(args[1]);
      case "replace":
        return isUnresolved(args[2]) ? args[2] : text(args[2]).split(text(args[0])).join(text(args[1]));
      case "printf":
        return sprintf(text(args[0]), args.slice(1));
      case "print":
        return args.map(text).join("");
      case "cat":
        return args.filter((a) => a !== null).map(text).join(" ");
      case "toString":
        return text(args[0]);
      case "int":
      case "int64":
      case "float64":
        return isUnresolved(args[0]) ? args[0] : Number(args[0]);
      case "toYaml":
      case "toJson":
      case "toPrettyJson":
        return toText(args[0] ?? null);
      case "indent":
        return indentText(text(args[1]), Number(args[0]));
      case "nindent":
        return `\n${indentText(text(args[1]), Number(args[0]))}`;
      case "b64enc":
      case "b64dec":
      case "sha256sum":
      case "randAlphaNum":
      case "randAlpha":
      case "uuidv4":
      case "now":
      case "lookup":
      case "tpl":
      case "genCA":
      case "genSelfSignedCert":
      case "semverCompare":
      case "fromYaml":
      case "fromJson":
        return unknown();
      case "eq":
        return anyUnknown ? unknown() : args.slice(1).some((a) => norm(a) === norm(args[0]));
      case "ne":
        return anyUnknown ? unknown() : norm(args[0]) !== norm(args[1]);
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        if (anyUnknown) return unknown();
        const [a, b] = [Number(norm(args[0])), Number(norm(args[1]))];
        return name === "lt" ? a < b : name === "le" ? a <= b : name === "gt" ? a > b : a >= b;
      }
      case "and": {
        let unknownSeen = false;
        for (const a of args) {
          const t = truthy(a);
          if (t === false) return a;
          if (t === "unknown") unknownSeen = true;
        }
        return unknownSeen ? unknown() : args[args.length - 1];
      }
      case "or": {
        let unknownSeen = false;
        for (const a of args) {
          const t = truthy(a);
          if (t === true) return a;
          if (t === "unknown") unknownSeen = true;
        }
        return unknownSeen ? unknown() : args[args.length - 1];
      }
      case "not": {
        const t = truthy(args[0]);
        return t === "unknown" ? unknown() : !t;
      }
      case "empty": {
        const t = truthy(args[0]);
        return t === "unknown" ? unknown() : !t;
      }
      case "contains":
        return anyUnknown ? unknown() : text(args[1]).includes(text(args[0]));
      case "hasPrefix":
        return anyUnknown ? unknown() : text(args[1]).startsWith(text(args[0]));
      case "hasSuffix":
        return anyUnknown ? unknown() : text(args[1]).endsWith(text(args[0]));
      case "hasKey":
        return isMap(args[0]) ? text(args[1]) in args[0] : isUnresolved(args[0]) && !args[0].missing ? unknown() : false;
      case "get":
        return isMap(args[0]) ? (args[0][text(args[1])] ?? "") : unknown();
      case "list":
        return args;
      case "dict": {
        const d: Record<string, Value> = {};
        for (let i = 0; i + 1 < args.length; i += 2) d[text(args[i])] = args[i + 1];
        return d;
      }
      case "first":
        return Array.isArray(args[0]) ? args[0][0] : unknown();
      case "last":
        return Array.isArray(args[0]) ? args[0][args[0].length - 1] : unknown();
      case "join":
        return Array.isArray(args[1]) ? args[1].map(text).join(text(args[0])) : unknown();
      case "splitList":
        return isUnresolved(args[1]) ? unknown() : text(args[1]).split(text(args[0]));
      case "keys":
        return isMap(args[0]) ? Object.keys(args[0]).sort() : unknown();
      case "kindIs":
        return isUnresolved(args[1]) ? unknown() : kindOf(args[1]) === text(args[0]);
      case "typeIs":
        return unknown();
      case "merge":
      case "mergeOverwrite":
        return Object.assign({}, ...args.filter(isMap).reverse());
      case "len":
        return Array.isArray(args[0]) ? args[0].length : isMap(args[0]) ? Object.keys(args[0]).length : isUnresolved(args[0]) ? unknown() : text(args[0]).length;
      default:
        return unknown();
    }
  }
}

function norm(v: Value): Value {
  if (isUnresolved(v)) return null;
  return v === undefined ? null : v;
}

function kindOf(v: Value): string {
  if (v === null || v === undefined) return "invalid";
  if (Array.isArray(v)) return "slice";
  if (typeof v === "object") return "map";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float64";
  if (typeof v === "boolean") return "bool";
  return "string";
}

export function deepMerge(base: Value, overlay: Value): Value {
  if (!isMap(base) || !isMap(overlay)) return overlay === undefined ? base : overlay;
  const out: Record<string, Value> = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}
