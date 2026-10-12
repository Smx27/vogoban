import { IAC_LIMITS, type IacError, type IacExpr, type IacFileFacts, type IacLocation, type IacObjectEntry, type IacParser, type IacSymbolKind, type IacSymbolRef } from "./model.ts";
import { azurermMapping } from "./terraform-azurerm.ts";

type Kind = "ident" | "number" | "punct" | "nl" | "oquote" | "cquote" | "oheredoc" | "cheredoc" | "lit" | "interp" | "control" | "seqend" | "invalid" | "eof";
interface Tok {
  k: Kind;
  v: string;
  s: number;
  e: number;
  strip?: boolean;
  lineStart?: boolean;
  indent?: number;
}
type Frame = { m: "n"; depth: number } | { m: "q"; open: number } | { m: "h"; marker: string; open: number; flush: boolean; bol: boolean; min: number };
type Ref = { target: IacSymbolRef; path: string[] };
interface Seg {
  v: string;
  attr: boolean;
}
interface Attr {
  t: "attr";
  name: string;
  value: IacExpr;
  s: number;
  vs: number;
  e: number;
}
interface Block {
  t: "block";
  type: string;
  labels: string[];
  items: Item[];
  s: number;
  e: number;
  deep: Ref[] | null;
}
type Item = Attr | Block;

const MAX_ERRORS = 100;
const IDENT = /[\p{ID_Start}_][\p{ID_Continue}-]*/uy;
const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEREDOC = /<<(-?)([\p{ID_Start}_][\p{ID_Continue}-]*)[ \t]*\r?\n/uy;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const PUNCT2 = ["...", "=>", "==", "!=", "<=", ">=", "&&", "||", "::"];
const PUNCT1 = "{}[]()=:,.?!+-*/%<>";
const BINARY = new Set(["==", "!=", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%"]);
const OPEN_KINDS = new Set<Kind>(["oquote", "oheredoc", "interp", "control"]);
const CLOSE_KINDS = new Set<Kind>(["cquote", "cheredoc", "seqend"]);
const LITERALS = new Set(["true", "false", "null"]);
const SKIP_STOPS = new Set([")", "]", "}", ",", "=", "=>", "..."]);
const RESOURCE_META = new Set(["count", "for_each", "depends_on", "lifecycle", "provisioner", "connection"]);
const MODULE_META = new Set(["source", "version", "providers", "count", "for_each", "depends_on"]);
const NONE = new Set<string>();
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

class Source {
  readonly lines: number[] = [0];
  readonly errors: IacError[] = [];
  constructor(readonly text: string) {
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) this.lines.push(i + 1);
  }
  pos(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lines[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lines[lo]! + 1 };
  }
  loc(s: number, e: number): IacLocation {
    const a = this.pos(s);
    const b = this.pos(Math.max(s, e));
    return { line: a.line, column: a.column, endLine: b.line, endColumn: b.column };
  }
  error(offset: number, message: string): void {
    if (this.errors.length > MAX_ERRORS) return;
    this.errors.push({ message: this.errors.length === MAX_ERRORS ? "too many errors" : message, ...this.pos(offset) });
  }
}

function tokenize(src: Source): Tok[] {
  const text = src.text;
  const n = text.length;
  const toks: Tok[] = [];
  const stack: Frame[] = [{ m: "n", depth: 0 }];
  const add = (k: Kind, v: string, s: number, e: number, extra?: Partial<Tok>) => toks.push(extra ? { k, v, s, e, ...extra } : { k, v, s, e });
  const escape = (j: number): [string, number] => {
    const c = text[j + 1];
    if (c === undefined) return ["", 1];
    if (ESCAPES[c] !== undefined) return [ESCAPES[c]!, 2];
    const len = c === "u" ? 4 : c === "U" ? 8 : 0;
    const hex = text.slice(j + 2, j + 2 + len);
    if (len && hex.length === len && /^[0-9a-fA-F]+$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) return [String.fromCodePoint(parseInt(hex, 16)), 2 + len];
    src.error(j, `invalid escape sequence '\\${c}'`);
    return [c, 2];
  };
  const openSeq = (j: number) => {
    const strip = text[j + 2] === "~";
    add(text[j] === "$" ? "interp" : "control", text.slice(j, j + 2), j, j + (strip ? 3 : 2), { strip });
    stack.push({ m: "n", depth: 0 });
    return j + (strip ? 3 : 2);
  };
  let i = 0;
  while (i < n) {
    const f = stack[stack.length - 1]!;
    if (f.m === "q") {
      let buf = "";
      let run = i;
      let j = i;
      while (j < n) {
        const c = text[j]!;
        if (c === '"' || c === "\n") break;
        if ((c === "$" || c === "%") && text[j + 1] === "{") break;
        if ((c === "$" || c === "%") && text[j + 1] === c && text[j + 2] === "{") {
          buf += text.slice(run, j) + c + "{";
          j += 3;
          run = j;
          continue;
        }
        if (c === "\\") {
          const [v, len] = escape(j);
          buf += text.slice(run, j) + v;
          j += len;
          run = j;
          continue;
        }
        j++;
      }
      buf += text.slice(run, Math.min(j, n));
      if (j > i) add("lit", buf, i, Math.min(j, n));
      if (text[j] === '"') {
        add("cquote", '"', j, j + 1);
        stack.pop();
        i = j + 1;
      } else if (j >= n || text[j] === "\n") {
        src.error(f.open, "unterminated string");
        add("cquote", "", j, j);
        stack.pop();
        i = Math.min(j, n);
      } else i = openSeq(j);
      continue;
    }
    if (f.m === "h") {
      if (f.bol) {
        const le = text.indexOf("\n", i) < 0 ? n : text.indexOf("\n", i);
        const line = text.slice(i, le);
        if (line.trim() === f.marker) {
          const ms = i + line.indexOf(f.marker);
          add("cheredoc", f.marker, ms, ms + f.marker.length);
          toks[f.open]!.indent = f.flush && f.min !== Infinity ? f.min : 0;
          stack.pop();
          i = ms + f.marker.length;
          continue;
        }
      }
      const lineStart = f.bol;
      f.bol = false;
      let buf = "";
      let run = i;
      let j = i;
      let endsLine = false;
      while (j < n) {
        const c = text[j]!;
        if (c === "\n" || (c === "\r" && text[j + 1] === "\n")) {
          buf += text.slice(run, j) + "\n";
          j += c === "\n" ? 1 : 2;
          run = j;
          endsLine = true;
          break;
        }
        if ((c === "$" || c === "%") && text[j + 1] === "{") break;
        if ((c === "$" || c === "%") && text[j + 1] === c && text[j + 2] === "{") {
          buf += text.slice(run, j) + c + "{";
          j += 3;
          run = j;
          continue;
        }
        j++;
      }
      buf += text.slice(run, j);
      if (j > i || lineStart) add("lit", buf, i, j, lineStart ? { lineStart } : undefined);
      if (lineStart) {
        const ws = /^[ \t]*/.exec(buf)![0].length;
        if (!(ws === buf.replace(/\n$/, "").length && (endsLine || j >= n))) f.min = Math.min(f.min, ws);
      }
      i = j;
      if (endsLine) f.bol = true;
      else if (j < n) i = openSeq(j);
      continue;
    }
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "\n") {
      add("nl", "\n", i, i + 1);
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const j = text.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) src.error(i, "unterminated comment");
      i = j < 0 ? n : j + 2;
      continue;
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(text);
    if (id) {
      add("ident", id[0], i, i + id[0].length);
      i += id[0].length;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(text);
    if (num) {
      add("number", num[0], i, i + num[0].length);
      i += num[0].length;
      continue;
    }
    if (c === '"') {
      add("oquote", '"', i, i + 1);
      stack.push({ m: "q", open: i });
      i++;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      HEREDOC.lastIndex = i;
      const h = HEREDOC.exec(text);
      if (h) {
        stack.push({ m: "h", marker: h[2]!, open: toks.length, flush: h[1] === "-", bol: true, min: Infinity });
        add("oheredoc", h[2]!, i, i + h[0].length);
        i += h[0].length;
        continue;
      }
    }
    if (c === "{") f.depth++;
    if ((c === "}" || (c === "~" && text[i + 1] === "}")) && f.depth === 0 && stack.length > 1) {
      const strip = c === "~";
      add("seqend", "}", i, i + (strip ? 2 : 1), { strip });
      stack.pop();
      i += strip ? 2 : 1;
      continue;
    }
    if (c === "}" && f.depth > 0) f.depth--;
    const p2 = PUNCT2.find((p) => text.startsWith(p, i));
    if (p2) {
      add("punct", p2, i, i + p2.length);
      i += p2.length;
      continue;
    }
    if (PUNCT1.includes(c)) {
      add("punct", c, i, i + 1);
      i++;
      continue;
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    add("invalid", cp, i, i + cp.length);
    i += cp.length;
  }
  for (let k = stack.length - 1; k > 0; k--) {
    const f = stack[k]!;
    if (f.m === "q") {
      src.error(f.open, "unterminated string");
      add("cquote", "", n, n);
    } else if (f.m === "h") {
      src.error(toks[f.open]!.s, `unterminated heredoc (missing ${f.marker})`);
      toks[f.open]!.indent = f.flush && f.min !== Infinity ? f.min : 0;
      add("cheredoc", "", n, n);
    } else {
      src.error(n, "unterminated template interpolation");
      add("seqend", "", n, n);
    }
  }
  add("eof", "", n, n);
  return toks;
}

function refKey(r: Ref): string {
  return JSON.stringify([r.target.kind, r.target.name, r.path]);
}

function dedupe(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ target: { kind: r.target.kind, name: r.target.name }, path: [...r.path] });
  }
  return out;
}

function refsOf(exprs: IacExpr[]): Ref[] {
  const out: Ref[] = [];
  const walk = (e: IacExpr): void => {
    switch (e.kind) {
      case "reference":
        out.push({ target: e.target, path: e.path });
        break;
      case "unknown":
        out.push(...e.references);
        break;
      case "call":
        e.args.forEach(walk);
        break;
      case "object":
        for (const en of e.entries) walk(en.value);
        break;
      case "array":
        e.items.forEach(walk);
        break;
      case "interpolation":
        for (const p of e.parts) if (typeof p !== "string") walk(p);
        break;
      case "conditional":
        walk(e.condition);
        walk(e.whenTrue);
        walk(e.whenFalse);
        break;
    }
  };
  exprs.forEach(walk);
  return dedupe(out);
}

function classify(root: string, segs: Seg[], scopes: string[][]): IacExpr {
  const path = segs.map((s) => s.v);
  const ref = (kind: IacSymbolKind, name: string, p = path): IacExpr => ({ kind: "reference", target: { kind, name }, path: p });
  if (scopes.some((sc) => sc.includes(root))) return ref("loop", root);
  const a = segs[0]?.attr ? segs[0].v : null;
  const b = segs[1]?.attr ? segs[1].v : null;
  switch (root) {
    case "var":
      if (a) return ref("parameter", a, path.slice(1));
      break;
    case "local":
      if (a) return ref("variable", a, path.slice(1));
      break;
    case "module":
      if (a) return ref("module", a, path.slice(1));
      break;
    case "data":
      if (a && b) return ref("data", `${a}.${b}`, path.slice(2));
      break;
    case "each":
    case "count":
      return ref("loop", root);
    case "path":
    case "terraform":
      if (a) return path.length > 1 ? { kind: "call", name: `${root}.${a}`, args: [], path: path.slice(1) } : { kind: "call", name: `${root}.${a}`, args: [] };
      break;
    case "self":
      break;
    default:
      if (a) return ref("resource", `${root}.${a}`, path.slice(1));
  }
  return ref("unknown", root);
}

function stops(t: Tok): boolean {
  return t.k === "nl" || t.k === "eof" || CLOSE_KINDS.has(t.k) || (t.k === "punct" && (t.v === ")" || t.v === "]" || t.v === "}"));
}

function isOpen(t: Tok): boolean {
  return OPEN_KINDS.has(t.k) || (t.k === "punct" && (t.v === "(" || t.v === "[" || t.v === "{"));
}

function isClose(t: Tok): boolean {
  return CLOSE_KINDS.has(t.k) || (t.k === "punct" && (t.v === ")" || t.v === "]" || t.v === "}"));
}

function leadingWs(v: string): number {
  let k = 0;
  while (v[k] === " " || v[k] === "\t") k++;
  return k;
}

function isZero(e: IacExpr): boolean {
  return e.kind === "number" && e.value === 0;
}

function localPath(file: string, source: string): string | null {
  if (!/^\.\.?(\/|$)/.test(source)) return null;
  const parts = file.replace(/\\/g, "/").split("/").slice(0, -1).filter((p) => p && p !== ".");
  for (const p of source.split("/")) {
    if (!p || p === ".") continue;
    if (p !== "..") parts.push(p);
    else if (!parts.length || parts[parts.length - 1] === "..") return null;
    else parts.pop();
  }
  return parts.length ? parts.join("/") : ".";
}

function dependsOn(e: IacExpr | undefined): string[] {
  if (e?.kind !== "array") return [];
  const out: string[] = [];
  for (const it of e.items) {
    if (it.kind !== "reference") continue;
    const { kind, name } = it.target;
    if (kind === "resource") out.push(name);
    else if (kind === "module" || kind === "data") out.push(`${kind}.${name}`);
  }
  return out;
}

function attrsOf(b: Block): Map<string, Attr> {
  const m = new Map<string, Attr>();
  for (const it of b.items) if (it.t === "attr" && !m.has(it.name)) m.set(it.name, it);
  return m;
}

class Parser {
  private i = 0;
  private last = 0;
  private readonly nl: boolean[] = [true];
  private readonly scopes: string[][] = [];

  constructor(
    private readonly src: Source,
    private readonly toks: Tok[],
  ) {}

  private tok(): Tok {
    if (!this.nl[this.nl.length - 1]) while (this.toks[this.i]!.k === "nl") this.i++;
    return this.toks[this.i]!;
  }

  private peek(k: number): Tok {
    this.tok();
    const skip = !this.nl[this.nl.length - 1];
    let j = this.i;
    for (let c = 0; c < k; c++) {
      j = Math.min(j + 1, this.toks.length - 1);
      if (skip) while (this.toks[j]!.k === "nl") j++;
    }
    return this.toks[j]!;
  }

  private next(): Tok {
    const t = this.tok();
    if (t.k !== "eof") this.i++;
    this.last = t.e;
    return t;
  }

  private is(v: string, k: Kind = "punct"): boolean {
    const t = this.tok();
    return t.k === k && t.v === v;
  }

  private eat(v: string, k: Kind = "punct"): boolean {
    if (!this.is(v, k)) return false;
    this.next();
    return true;
  }

  private expect(v: string): void {
    if (!this.eat(v)) this.src.error(this.tok().s, `expected '${v}', found ${this.describe(this.tok())}`);
  }

  private close(v: string): void {
    if (this.eat(v)) return;
    this.src.error(this.tok().s, `expected '${v}', found ${this.describe(this.tok())}`);
    let level = 0;
    for (;;) {
      const t = this.toks[this.i]!;
      if (t.k === "eof") return;
      if (level === 0 && t.k === "punct" && t.v === v) {
        this.next();
        return;
      }
      if (level === 0 && isClose(t)) return;
      level += isOpen(t) ? 1 : isClose(t) ? -1 : 0;
      this.i++;
      this.last = t.e;
    }
  }

  private recover(stopComma: boolean): void {
    let level = 0;
    for (;;) {
      const t = this.toks[this.i]!;
      if (t.k === "eof") return;
      if (level === 0 && (t.k === "nl" || isClose(t) || (stopComma && t.k === "punct" && t.v === ","))) return;
      level += isOpen(t) ? 1 : isClose(t) ? -1 : 0;
      this.i++;
      this.last = t.e;
    }
  }

  private describe(t: Tok): string {
    if (t.k === "eof") return "end of file";
    if (t.k === "nl") return "newline";
    const s = this.src.text.slice(t.s, t.e);
    return `'${s.length > 20 ? `${s.slice(0, 20)}...` : s}'`;
  }

  private text(s: number): string {
    return this.src.text.slice(s, Math.max(s, this.last));
  }

  private unknown(s: number, parts: IacExpr[]): IacExpr {
    return { kind: "unknown", text: this.text(s), references: refsOf(parts) };
  }

  private ident(): string {
    const t = this.tok();
    if (t.k === "ident") return this.next().v;
    this.src.error(t.s, `expected identifier, found ${this.describe(t)}`);
    return "";
  }

  expr(d: number): IacExpr {
    if (d > IAC_LIMITS.maxDepth) return this.skipExpr();
    const condition = this.binary(d);
    if (!this.eat("?")) return condition;
    const whenTrue = this.expr(d + 1);
    this.expect(":");
    return { kind: "conditional", condition, whenTrue, whenFalse: this.expr(d + 1) };
  }

  private binary(d: number): IacExpr {
    const s = this.tok().s;
    const parts = [this.unary(d)];
    while (this.tok().k === "punct" && BINARY.has(this.tok().v)) {
      this.next();
      parts.push(this.unary(d));
    }
    return parts.length === 1 ? parts[0]! : this.unknown(s, parts);
  }

  private unary(d: number): IacExpr {
    const s = this.tok().s;
    const ops: string[] = [];
    while (this.is("!") || this.is("-")) ops.push(this.next().v);
    const e = this.postfix(d);
    if (!ops.length) return e;
    if (ops.length === 1 && ops[0] === "-" && e.kind === "number") return { kind: "number", value: -e.value };
    return this.unknown(s, [e]);
  }

  private postfix(d: number): IacExpr {
    const t = this.tok();
    const segs: Seg[] = [];
    const extra: IacExpr[] = [];
    if (t.k === "ident" && !LITERALS.has(t.v) && !(this.peek(1).k === "punct" && (this.peek(1).v === "(" || this.peek(1).v === "::"))) {
      this.next();
      this.traverse(d, segs, extra);
      return classify(t.v, segs, this.scopes);
    }
    const e = this.primary(d);
    this.traverse(d, segs, extra);
    if (!segs.length) return e;
    const path = segs.map((x) => x.v);
    if (e.kind === "reference") return { ...e, path: [...e.path, ...path] };
    if (e.kind === "call") return { ...e, path: [...(e.path ?? []), ...path] };
    return this.unknown(t.s, [e, ...extra]);
  }

  private traverse(d: number, segs: Seg[], extra: IacExpr[]): void {
    for (;;) {
      if (this.is(".")) {
        const n = this.peek(1);
        if (n.k === "ident") segs.push({ v: n.v, attr: true });
        else if (n.k === "number") for (const p of n.v.split(".")) segs.push({ v: p, attr: false });
        else if (n.k === "punct" && n.v === "*") segs.push({ v: "*", attr: false });
        else return;
        this.next();
        this.next();
        continue;
      }
      if (!this.is("[")) return;
      this.next();
      this.nl.push(false);
      if (this.is("*") && this.peek(1).k === "punct" && this.peek(1).v === "]") {
        this.next();
        segs.push({ v: "*", attr: false });
      } else {
        const ix = this.expr(d + 1);
        extra.push(ix);
        segs.push({ v: ix.kind === "string" ? ix.value : ix.kind === "number" ? String(ix.value) : "*", attr: false });
      }
      this.close("]");
      this.nl.pop();
    }
  }

  private primary(d: number): IacExpr {
    const t = this.tok();
    if (t.k === "number") {
      this.next();
      return { kind: "number", value: Number(t.v) };
    }
    if (t.k === "ident") {
      if (t.v === "true" || t.v === "false") {
        this.next();
        return { kind: "bool", value: t.v === "true" };
      }
      if (t.v === "null") {
        this.next();
        return { kind: "null" };
      }
      return this.call(d);
    }
    if (t.k === "oquote" || t.k === "oheredoc") return this.template(d);
    if (t.k === "punct" && t.v === "(") {
      this.next();
      this.nl.push(false);
      const e = this.expr(d + 1);
      this.close(")");
      this.nl.pop();
      return e;
    }
    if (t.k === "punct" && t.v === "[") return this.tuple(d);
    if (t.k === "punct" && t.v === "{") return this.object(d);
    this.src.error(t.s, `expected expression, found ${this.describe(t)}`);
    if (!stops(t)) this.next();
    return { kind: "unknown", text: "", references: [] };
  }

  private call(d: number): IacExpr {
    const s = this.tok().s;
    let name = this.next().v;
    while (this.eat("::")) {
      if (this.tok().k !== "ident") break;
      name += `::${this.next().v}`;
    }
    if (!this.is("(")) {
      this.src.error(this.tok().s, `expected '(', found ${this.describe(this.tok())}`);
      return this.unknown(s, []);
    }
    this.next();
    this.nl.push(false);
    const args: IacExpr[] = [];
    let expand = false;
    while (!stops(this.tok())) {
      args.push(this.expr(d + 1));
      if (this.eat("...")) expand = true;
      if (!this.eat(",")) break;
    }
    this.close(")");
    this.nl.pop();
    return expand ? this.unknown(s, args) : { kind: "call", name, args };
  }

  private forAhead(): boolean {
    const t = this.tok();
    return t.k === "ident" && t.v === "for" && this.peek(1).k === "ident";
  }

  private forExpr(d: number, s: number, close: string): IacExpr {
    this.next();
    const vars = [this.ident()];
    if (this.eat(",")) vars.push(this.ident());
    if (!this.eat("in", "ident")) this.src.error(this.tok().s, `expected 'in', found ${this.describe(this.tok())}`);
    const parts = [this.expr(d + 1)];
    this.expect(":");
    this.scopes.push(vars);
    parts.push(this.expr(d + 1));
    if (close === "}") {
      this.expect("=>");
      parts.push(this.expr(d + 1));
      this.eat("...");
    }
    if (this.eat("if", "ident")) parts.push(this.expr(d + 1));
    this.scopes.pop();
    this.close(close);
    return this.unknown(s, parts);
  }

  private tuple(d: number): IacExpr {
    const s = this.next().s;
    this.nl.push(false);
    if (this.forAhead()) {
      const e = this.forExpr(d, s, "]");
      this.nl.pop();
      return e;
    }
    const items: IacExpr[] = [];
    while (!stops(this.tok())) {
      items.push(this.expr(d + 1));
      if (!this.eat(",")) break;
    }
    this.close("]");
    this.nl.pop();
    return { kind: "array", items };
  }

  private object(d: number): IacExpr {
    const s = this.next().s;
    this.nl.push(false);
    if (this.forAhead()) {
      const e = this.forExpr(d, s, "}");
      this.nl.pop();
      return e;
    }
    this.nl[this.nl.length - 1] = true;
    const entries: IacObjectEntry[] = [];
    const parts: IacExpr[] = [];
    let computed = false;
    for (;;) {
      while (this.tok().k === "nl" || this.is(",")) this.next();
      const t = this.tok();
      if (stops(t)) break;
      let key: string | null;
      const after = this.peek(1);
      if (t.k === "ident" && after.k === "punct" && (after.v === "=" || after.v === ":")) key = this.next().v;
      else {
        const k = this.expr(d + 1);
        parts.push(k);
        key = k.kind === "string" ? k.value : k.kind === "number" ? String(k.value) : null;
        if (key === null) computed = true;
      }
      if (!this.eat("=") && !this.eat(":")) {
        this.src.error(this.tok().s, `expected '=' or ':', found ${this.describe(this.tok())}`);
        this.recover(true);
        continue;
      }
      const value = this.expr(d + 1);
      parts.push(value);
      entries.push({ key: key ?? "", value, location: this.src.loc(t.s, this.last) });
      if (this.tok().k === "nl" || this.is(",") || this.is("}")) continue;
      this.src.error(this.tok().s, `expected newline, ',' or '}', found ${this.describe(this.tok())}`);
      this.recover(true);
    }
    this.close("}");
    this.nl.pop();
    return computed ? this.unknown(s, parts) : { kind: "object", entries };
  }

  private template(d: number): IacExpr {
    const open = this.next();
    const close: Kind = open.k === "oquote" ? "cquote" : "cheredoc";
    const indent = open.indent ?? 0;
    const parts: (string | IacExpr)[] = [];
    const exprs: IacExpr[] = [];
    let directive = false;
    let lits = 0;
    let interps = 0;
    let trim = false;
    let fors = 0;
    const append = (v: string) => {
      const lastPart = parts[parts.length - 1];
      if (typeof lastPart === "string") parts[parts.length - 1] = lastPart + v;
      else parts.push(v);
    };
    for (;;) {
      const t = this.toks[this.i]!;
      if (t.k === "lit") {
        this.i++;
        this.last = t.e;
        let v = t.lineStart && indent ? t.v.slice(Math.min(indent, leadingWs(t.v))) : t.v;
        if (trim) v = v.trimStart();
        trim = false;
        if (t.v) lits++;
        append(v);
        continue;
      }
      if (t.k === "interp" || t.k === "control") {
        this.i++;
        this.last = t.e;
        trim = false;
        const lastPart = parts[parts.length - 1];
        if (t.strip && typeof lastPart === "string") parts[parts.length - 1] = lastPart.trimEnd();
        this.nl.push(false);
        if (t.k === "interp") {
          const e = this.expr(d + 1);
          parts.push(e);
          exprs.push(e);
          interps++;
        } else {
          directive = true;
          const r = this.directive(d, exprs);
          if (r > 0) fors++;
          else if (r < 0 && fors > 0) {
            this.scopes.pop();
            fors--;
          }
        }
        if (this.tok().k === "seqend") trim = !!this.next().strip;
        else {
          this.src.error(this.tok().s, `expected '}', found ${this.describe(this.tok())}`);
          this.skipToSeqEnd();
        }
        this.nl.pop();
        continue;
      }
      if (t.k === close) {
        this.i++;
        this.last = t.e;
        break;
      }
      this.src.error(t.s, "unterminated template");
      break;
    }
    for (; fors > 0; fors--) this.scopes.pop();
    if (directive) return this.unknown(open.s, exprs);
    const out = parts.filter((p) => p !== "");
    if (interps === 1 && lits === 0 && out.length === 1 && typeof out[0] !== "string") return out[0]!;
    if (!out.length) return { kind: "string", value: "" };
    if (out.length === 1 && typeof out[0] === "string") return { kind: "string", value: out[0] };
    return { kind: "interpolation", parts: out };
  }

  private directive(d: number, exprs: IacExpr[]): number {
    const t = this.tok();
    if (t.k === "ident" && t.v === "if") {
      this.next();
      exprs.push(this.expr(d + 1));
      return 0;
    }
    if (t.k === "ident" && (t.v === "else" || t.v === "endif")) {
      this.next();
      return 0;
    }
    if (t.k === "ident" && t.v === "endfor") {
      this.next();
      return -1;
    }
    if (t.k === "ident" && t.v === "for") {
      this.next();
      const vars = [this.ident()];
      if (this.eat(",")) vars.push(this.ident());
      if (!this.eat("in", "ident")) this.src.error(this.tok().s, `expected 'in', found ${this.describe(this.tok())}`);
      exprs.push(this.expr(d + 1));
      this.scopes.push(vars);
      return 1;
    }
    this.src.error(t.s, `expected template directive, found ${this.describe(t)}`);
    return 0;
  }

  private skipToSeqEnd(): void {
    let level = 0;
    for (;;) {
      const t = this.toks[this.i]!;
      if (t.k === "eof") return;
      if (level === 0 && t.k === "seqend") {
        this.i++;
        this.last = t.e;
        return;
      }
      if (level === 0 && isClose(t)) return;
      level += isOpen(t) ? 1 : isClose(t) ? -1 : 0;
      this.i++;
      this.last = t.e;
    }
  }

  private skipExpr(): IacExpr {
    const s = this.tok().s;
    const from = this.i;
    let level = 0;
    let pending = 0;
    for (;;) {
      const t = this.toks[this.i]!;
      if (t.k === "eof") break;
      if (level === 0) {
        if ((t.k === "nl" && this.nl[this.nl.length - 1]) || isClose(t)) break;
        if (t.k === "punct" && SKIP_STOPS.has(t.v)) break;
        if (t.k === "punct" && t.v === "?") pending++;
        if (t.k === "punct" && t.v === ":") {
          if (!pending) break;
          pending--;
        }
      }
      level += isOpen(t) ? 1 : isClose(t) ? -1 : 0;
      this.i++;
      this.last = t.e;
    }
    return { kind: "unknown", text: this.text(s), references: this.scanRefs(from, this.i) };
  }

  private scanRefs(from: number, to: number): Ref[] {
    const exprs: IacExpr[] = [];
    for (let j = from; j < to; j++) {
      const t = this.toks[j]!;
      if (t.k !== "ident" || LITERALS.has(t.v)) continue;
      const prev = this.toks[j - 1];
      if (prev?.k === "punct" && (prev.v === "." || prev.v === "::")) continue;
      const segs: Seg[] = [];
      while (j + 2 < to && this.toks[j + 1]!.k === "punct" && this.toks[j + 1]!.v === "." && this.toks[j + 2]!.k === "ident") {
        segs.push({ v: this.toks[j + 2]!.v, attr: true });
        j += 2;
      }
      const e = classify(t.v, segs, this.scopes);
      if (e.kind === "reference" && e.target.kind !== "unknown") exprs.push(e);
    }
    return refsOf(exprs);
  }

  body(d: number, top: boolean): Item[] {
    const items: Item[] = [];
    this.nl.push(true);
    for (;;) {
      const t = this.tok();
      if (t.k === "nl") {
        this.next();
        continue;
      }
      if (t.k === "eof" || (!top && t.k === "punct" && t.v === "}")) break;
      if (t.k !== "ident") {
        this.src.error(t.s, `expected attribute or block, found ${this.describe(t)}`);
        this.skipLine();
        continue;
      }
      const after = this.peek(1);
      const item = after.k === "punct" && after.v === "=" ? this.attribute() : this.block(d);
      if (item) items.push(item);
      const n = this.tok();
      if (n.k === "nl" || n.k === "eof" || (!top && n.k === "punct" && n.v === "}")) continue;
      this.src.error(n.s, `expected newline, found ${this.describe(n)}`);
      this.skipLine();
    }
    this.nl.pop();
    return items;
  }

  private skipLine(): void {
    const at = this.i;
    this.recover(false);
    if (this.i === at && this.tok().k !== "eof" && this.tok().k !== "nl") this.next();
  }

  private attribute(): Attr {
    const name = this.next();
    this.next();
    const vs = this.tok().s;
    const value = this.expr(0);
    return { t: "attr", name: name.v, value, s: name.s, vs, e: this.last };
  }

  private block(d: number): Block | null {
    const type = this.next();
    const labels: string[] = [];
    for (;;) {
      const t = this.tok();
      if (t.k === "ident") labels.push(this.next().v);
      else if (t.k === "oquote") {
        const v = this.template(0);
        if (v.kind === "string") labels.push(v.value);
        else this.src.error(t.s, "block label must be a literal string");
      } else break;
    }
    if (!this.is("{")) {
      this.src.error(this.tok().s, `expected '{', found ${this.describe(this.tok())}`);
      return null;
    }
    const from = this.i;
    this.next();
    if (d >= IAC_LIMITS.maxDepth) {
      let level = 1;
      while (level > 0 && this.toks[this.i]!.k !== "eof") {
        const t = this.toks[this.i++]!;
        this.last = t.e;
        if (t.k === "punct" && t.v === "{") level++;
        if (t.k === "punct" && t.v === "}") level--;
      }
      if (level > 0) this.src.error(type.s, `missing '}' for block '${type.v}'`);
      return { t: "block", type: type.v, labels, items: [], s: type.s, e: this.last, deep: this.scanRefs(from, this.i) };
    }
    const items = this.body(d + 1, false);
    if (!this.eat("}")) this.src.error(this.tok().s, `missing '}' for block '${type.v}' opened at line ${this.src.pos(type.s).line}`);
    return { t: "block", type: type.v, labels, items, s: type.s, e: this.last, deep: null };
  }

  private span(s: number, e: number): string {
    return this.src.text.slice(s, Math.max(s, e));
  }

  private itemRefs(items: Item[]): Ref[] {
    const out: Ref[] = [];
    for (const it of items) {
      if (it.t === "attr") out.push(...refsOf([it.value]));
      else if (it.deep) out.push(...it.deep);
      else out.push(...(it.type === "dynamic" ? this.dynamicRefs(it) : this.itemRefs(it.items)));
    }
    return dedupe(out);
  }

  private dynamicRefs(b: Block): Ref[] {
    const it = attrsOf(b).get("iterator")?.value;
    const name = it?.kind === "reference" && it.target.kind === "unknown" && !it.path.length ? it.target.name : (b.labels[0] ?? "");
    const refs = this.itemRefs(b.items.filter((x) => !(x.t === "attr" && x.name === "iterator")));
    return dedupe(
      refs.map((r): Ref => {
        if (r.target.kind === "resource" && r.target.name.startsWith(`${name}.`)) return { target: { kind: "loop", name }, path: [r.target.name.slice(name.length + 1), ...r.path] };
        if (r.target.kind === "unknown" && r.target.name === name) return { target: { kind: "loop", name }, path: r.path };
        return r;
      }),
    );
  }

  private bodyObject(items: Item[], skip: ReadonlySet<string>): IacExpr {
    const entries: IacObjectEntry[] = [];
    const groups = new Map<string, { index: number; blocks: Block[] }>();
    for (const it of items) {
      if (skip.has(it.t === "attr" ? it.name : it.type)) continue;
      if (it.t === "attr") {
        const value: IacExpr = it.name === "provider" && skip === RESOURCE_META ? { kind: "string", value: this.span(it.vs, it.e) } : it.value;
        entries.push({ key: it.name, value, location: this.src.loc(it.s, it.e) });
        continue;
      }
      const key = it.type === "dynamic" ? (it.labels[0] ?? "") : it.type;
      const g = groups.get(key);
      if (g) g.blocks.push(it);
      else {
        groups.set(key, { index: entries.length, blocks: [it] });
        entries.push({ key, value: { kind: "null" }, location: this.src.loc(it.s, it.e) });
      }
    }
    for (const { index, blocks } of groups.values()) {
      const entry = entries[index]!;
      entry.location = this.src.loc(blocks[0]!.s, blocks[blocks.length - 1]!.e);
      if (blocks.some((b) => b.type === "dynamic")) {
        entry.value = { kind: "unknown", text: "dynamic", references: dedupe(blocks.flatMap((b) => (b.type === "dynamic" ? this.dynamicRefs(b) : this.itemRefs([b])))) };
        continue;
      }
      const values = blocks.map((b): IacExpr => (b.deep || b.labels.length ? { kind: "unknown", text: this.span(b.s, b.e), references: this.itemRefs([b]) } : this.bodyObject(b.items, NONE)));
      entry.value = values.length === 1 ? values[0]! : { kind: "array", items: values };
    }
    return { kind: "object", entries };
  }

  declarations(items: Item[], facts: IacFileFacts): void {
    const providers = new Set<string>();
    for (const it of items) {
      if (it.t === "attr") {
        this.src.error(it.s, `unexpected top-level attribute '${it.name}'`);
        continue;
      }
      const location = this.src.loc(it.s, it.e);
      const labels = (count: number): boolean => {
        if (it.labels.length === count) return true;
        this.src.error(it.s, `'${it.type}' block requires ${count} label${count === 1 ? "" : "s"}`);
        return false;
      };
      const a = attrsOf(it);
      switch (it.type) {
        case "terraform":
          for (const b of it.items) if (b.t === "block" && b.type === "required_providers") for (const p of b.items) if (p.t === "attr") providers.add(p.name);
          break;
        case "provider":
          if (labels(1)) providers.add(it.labels[0]!);
          break;
        case "variable": {
          if (!labels(1)) break;
          const sensitive = a.get("sensitive")?.value;
          const secure = sensitive?.kind === "bool" && sensitive.value;
          const type = a.get("type");
          const description = a.get("description")?.value;
          facts.parameters.push({
            name: it.labels[0]!,
            type: type ? this.span(type.vs, type.e) : null,
            defaultValue: secure ? null : (a.get("default")?.value ?? null),
            secure,
            allowed: null,
            description: description?.kind === "string" ? description.value : null,
            location,
          });
          break;
        }
        case "locals":
          for (const l of it.items) {
            if (l.t === "attr") facts.variables.push({ name: l.name, value: l.value, location: this.src.loc(l.s, l.e) });
            else this.src.error(l.s, "blocks are not allowed in locals");
          }
          break;
        case "resource":
        case "data": {
          if (!labels(2)) break;
          const [type, name] = it.labels as [string, string];
          const count = a.get("count")?.value ?? null;
          const loopSource = a.get("for_each")?.value ?? count;
          const nameAttribute = azurermMapping(type)?.nameAttribute ?? (azurermMapping(type) ? null : "name");
          facts.resources.push({
            symbol: it.type === "data" ? `data.${type}.${name}` : `${type}.${name}`,
            type,
            apiVersion: null,
            name: (nameAttribute && a.get(nameAttribute)?.value) || { kind: "null" },
            parent: null,
            existing: it.type === "data",
            condition: count?.kind === "conditional" && (isZero(count.whenTrue) || isZero(count.whenFalse)) ? count : null,
            loop: loopSource !== null,
            loopSource,
            body: this.bodyObject(it.items, RESOURCE_META),
            dependsOn: dependsOn(a.get("depends_on")?.value),
            location,
          });
          break;
        }
        case "module": {
          if (!labels(1)) break;
          const src = a.get("source");
          const source = src ? (src.value.kind === "string" ? src.value.value : this.span(src.vs, src.e)) : "";
          if (!src) this.src.error(it.s, `module '${it.labels[0]}' has no source`);
          const count = a.get("count")?.value ?? null;
          facts.modules.push({
            symbol: it.labels[0]!,
            source,
            localPath: src?.value.kind === "string" ? localPath(facts.file, source) : null,
            name: null,
            params: this.bodyObject(it.items, MODULE_META),
            condition: count?.kind === "conditional" && (isZero(count.whenTrue) || isZero(count.whenFalse)) ? count : null,
            loop: a.has("count") || a.has("for_each"),
            dependsOn: dependsOn(a.get("depends_on")?.value),
            scope: null,
            location,
          });
          break;
        }
        case "output": {
          if (!labels(1)) break;
          const sensitive = a.get("sensitive")?.value;
          const value = a.get("value")?.value;
          if (!value) this.src.error(it.s, `output '${it.labels[0]}' has no value`);
          facts.outputs.push({
            name: it.labels[0]!,
            type: null,
            value: value ?? { kind: "unknown", text: "", references: [] },
            secure: sensitive?.kind === "bool" && sensitive.value,
            location,
          });
          break;
        }
      }
    }
    facts.providers = [...providers].sort();
  }

  tfvars(items: Item[], facts: IacFileFacts): void {
    for (const it of items) {
      if (it.t === "block") {
        this.src.error(it.s, "blocks are not allowed in a variable definitions file");
        continue;
      }
      facts.parameters.push({ name: it.name, type: null, defaultValue: it.value, secure: false, allowed: null, description: null, location: this.src.loc(it.s, it.e) });
    }
  }
}

class JsonError {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

class JsonParser {
  private i = 0;
  constructor(private readonly src: Source) {}

  private ws(): void {
    const t = this.src.text;
    while (this.i < t.length && (t[this.i] === " " || t[this.i] === "\t" || t[this.i] === "\r" || t[this.i] === "\n")) this.i++;
  }

  private fail(message: string): never {
    throw new JsonError(message, this.i);
  }

  document(): IacObjectEntry[] {
    this.ws();
    if (this.src.text[this.i] !== "{") this.fail("expected a JSON object");
    const v = this.value(0);
    this.ws();
    if (this.i < this.src.text.length) this.fail("unexpected content after JSON value");
    return v.kind === "object" ? v.entries : [];
  }

  private value(d: number): IacExpr {
    this.ws();
    const t = this.src.text;
    const c = t[this.i];
    if (c === "{" || c === "[") return d > IAC_LIMITS.maxDepth ? this.skip() : c === "{" ? this.object(d) : this.array(d);
    if (c === '"') return { kind: "string", value: this.string() };
    for (const [word, v] of [["true", { kind: "bool", value: true }], ["false", { kind: "bool", value: false }], ["null", { kind: "null" }]] as const) {
      if (!t.startsWith(word, this.i)) continue;
      this.i += word.length;
      return { ...v };
    }
    JSON_NUMBER.lastIndex = this.i;
    const m = JSON_NUMBER.exec(t);
    if (!m) this.fail(c === undefined ? "unexpected end of JSON" : `unexpected character '${c}'`);
    this.i += m[0].length;
    return { kind: "number", value: Number(m[0]) };
  }

  private object(d: number): IacExpr {
    const t = this.src.text;
    const entries: IacObjectEntry[] = [];
    this.i++;
    this.ws();
    if (t[this.i] === "}") {
      this.i++;
      return { kind: "object", entries };
    }
    for (;;) {
      this.ws();
      const ks = this.i;
      if (t[this.i] !== '"') this.fail("expected property name");
      const key = this.string();
      this.ws();
      if (t[this.i] !== ":") this.fail("expected ':'");
      this.i++;
      const value = this.value(d + 1);
      entries.push({ key, value, location: this.src.loc(ks, this.i) });
      this.ws();
      if (t[this.i] === ",") {
        this.i++;
        continue;
      }
      if (t[this.i] !== "}") this.fail("expected ',' or '}'");
      this.i++;
      return { kind: "object", entries };
    }
  }

  private array(d: number): IacExpr {
    const t = this.src.text;
    const items: IacExpr[] = [];
    this.i++;
    this.ws();
    if (t[this.i] === "]") {
      this.i++;
      return { kind: "array", items };
    }
    for (;;) {
      items.push(this.value(d + 1));
      this.ws();
      if (t[this.i] === ",") {
        this.i++;
        continue;
      }
      if (t[this.i] !== "]") this.fail("expected ',' or ']'");
      this.i++;
      return { kind: "array", items };
    }
  }

  private string(): string {
    const t = this.src.text;
    let j = this.i + 1;
    while (j < t.length && t[j] !== '"') {
      if (t.charCodeAt(j) < 0x20) this.fail("control character in string");
      j += t[j] === "\\" ? 2 : 1;
    }
    if (j >= t.length) this.fail("unterminated string");
    let v: unknown;
    try {
      v = JSON.parse(t.slice(this.i, j + 1));
    } catch {
      this.fail("invalid string escape");
    }
    this.i = j + 1;
    return v as string;
  }

  private skip(): IacExpr {
    const t = this.src.text;
    const s = this.i;
    let level = 0;
    while (this.i < t.length) {
      const c = t[this.i]!;
      if (c === '"') {
        this.string();
        continue;
      }
      this.i++;
      if (c === "{" || c === "[") level++;
      if (c === "}" || c === "]") level--;
      if (level === 0) return { kind: "unknown", text: t.slice(s, this.i), references: [] };
    }
    this.fail("unexpected end of JSON");
  }
}

function emptyFacts(file: string, fileKind: IacFileFacts["fileKind"]): IacFileFacts {
  return { language: "terraform", file, fileKind, usingTemplate: null, targetScope: null, generatedBy: null, parameters: [], variables: [], resources: [], modules: [], outputs: [], providers: [], errors: [] };
}

/** Parses a Terraform .tf template, .tfvars or .tfvars.json file into language-neutral IaC facts. Never throws. */
export const parseTerraform: IacParser = (file, text) => {
  const lower = file.toLowerCase();
  const facts = emptyFacts(file, lower.endsWith(".tfvars") || lower.endsWith(".tfvars.json") ? "parameters" : "template");
  if (Buffer.byteLength(text, "utf8") > IAC_LIMITS.maxBytes) {
    facts.errors.push({ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 });
    return facts;
  }
  const src = new Source(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  try {
    if (lower.endsWith(".tf.json")) src.error(0, "Terraform JSON configuration syntax (.tf.json) is not supported");
    else if (lower.endsWith(".json")) {
      for (const en of new JsonParser(src).document()) facts.parameters.push({ name: en.key, type: null, defaultValue: en.value, secure: false, allowed: null, description: null, location: en.location });
    } else {
      const parser = new Parser(src, tokenize(src));
      const items = parser.body(0, true);
      if (facts.fileKind === "parameters") parser.tfvars(items, facts);
      else parser.declarations(items, facts);
    }
  } catch (e) {
    if (e instanceof JsonError) src.error(e.offset, e.message);
    else {
      Object.assign(facts, emptyFacts(file, facts.fileKind));
      src.error(0, `internal parser error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  facts.errors = src.errors;
  return facts;
};
