import { IAC_LIMITS, type IacExpr, type IacFileFacts, type IacLanguage, type IacLocation, type IacObjectEntry, type IacParser, type IacSymbolKind } from "./model.ts";

type Reference = Extract<IacExpr, { kind: "unknown" }>["references"][number];

interface Tok {
  kind: "ident" | "number" | "string" | "strHead" | "strMid" | "strTail" | "op" | "nl" | "eof";
  value: string;
  start: number;
  end: number;
}

interface Owner {
  symbol: string;
  type: string;
  apiVersion: string | null;
}

interface Decorator {
  name: string;
  args: IacExpr[];
}

class ParseError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
  }
}

const OPS = ["...", "??", "::", "=>", "==", "!=", "=~", "!~", "<=", ">=", "&&", "||", ".?"];
const OP1 = "{}[](),:=.?@<>+-*/%!|&";
const ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", n: "\n", r: "\r", t: "\t", $: "$" };
const LEVELS = [["??"], ["||"], ["&&"], ["==", "!=", "=~", "!~"], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];
const DECLARATIONS = new Set(["targetScope", "metadata", "param", "var", "resource", "module", "output", "import", "using", "type", "func", "extension", "provider", "assert", "extends"]);
const SYMBOL_KINDS: Record<string, IacSymbolKind> = { param: "parameter", var: "variable", resource: "resource", module: "module" };
const OPEN = new Set(["{", "[", "("]);
const CLOSE = new Set(["}", "]", ")"]);

/** Empty facts for a file, the starting point of every IaC parser. */
export function emptyFacts(language: IacLanguage, file: string, fileKind: IacFileFacts["fileKind"]): IacFileFacts {
  return { language, file, fileKind, usingTemplate: null, targetScope: null, generatedBy: null, parameters: [], variables: [], resources: [], modules: [], outputs: [], providers: [], errors: [] };
}

/** Maps a character offset of `text` to its 1-based line and column. */
export function lineIndex(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo]! + 1 };
  };
}

/** Every symbolic reference inside the expressions, deduplicated, in source order. */
export function iacReferences(exprs: IacExpr[]): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (r: Reference) => {
    const key = `${r.target.kind}\u0000${r.target.name}\u0000${r.path.join("\u0000")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ target: r.target, path: r.path });
  };
  const stack: IacExpr[] = [];
  const push = (items: IacExpr[]) => {
    for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]!);
  };
  push(exprs);
  while (stack.length) {
    const e = stack.pop()!;
    if (e.kind === "reference") add(e);
    else if (e.kind === "unknown") e.references.forEach(add);
    else if (e.kind === "call") push(e.args);
    else if (e.kind === "array") push(e.items);
    else if (e.kind === "object") push(e.entries.map((x) => x.value));
    else if (e.kind === "interpolation") push(e.parts.filter((p): p is IacExpr => typeof p !== "string"));
    else if (e.kind === "conditional") push([e.condition, e.whenTrue, e.whenFalse]);
  }
  return out;
}

/** Resolves a path written relative to `file`'s directory to a repository-relative path; null for registry/spec references or paths escaping the repository. */
export function repoPath(file: string, rel: string): string | null {
  if (!rel || rel.includes(":") || rel.includes("\\") || rel.startsWith("/")) return null;
  const parts = file.split("/").slice(0, -1).filter((p) => p && p !== ".");
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg !== "..") parts.push(seg);
    else if (!parts.pop()) return null;
  }
  return parts.length ? parts.join("/") : null;
}

function lex(src: string, error: (message: string, offset: number) => void): Tok[] {
  const toks: Tok[] = [];
  const holes: number[] = [];
  const str = (from: number, head: boolean): number => {
    let value = "";
    let run = from;
    let i = from;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "'" || (c === "$" && src[i + 1] === "{")) {
        value += src.slice(run, i);
        const hole = c === "$";
        toks.push({ kind: hole ? (head ? "strHead" : "strMid") : head ? "string" : "strTail", value, start: from - 1, end: i + (hole ? 2 : 1) });
        if (hole) holes.push(0);
        return i + (hole ? 2 : 1);
      }
      if (c === "\n") break;
      if (c !== "\\") {
        i++;
        continue;
      }
      value += src.slice(run, i);
      const e = src[i + 1] ?? "";
      const unicode = e === "u" ? /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2, i + 10)) : null;
      const code = unicode ? parseInt(unicode[1]!, 16) : -1;
      if (ESCAPES[e] !== undefined) {
        value += ESCAPES[e];
        i += 2;
      } else if (unicode && code <= 0x10ffff) {
        value += String.fromCodePoint(code);
        i += 2 + unicode[0].length;
      } else {
        error(`invalid escape sequence '\\${e}'`, i);
        value += e;
        i += e ? 2 : 1;
      }
      run = i;
    }
    value += src.slice(run, i);
    error("unterminated string", from - 1);
    toks.push({ kind: head ? "string" : "strTail", value, start: from - 1, end: i });
    return i;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\uFEFF") i++;
    else if (c === "\n") toks.push({ kind: "nl", value: "\n", start: i, end: ++i });
    else if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? src.length : e;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) {
        error("unterminated comment", i);
        break;
      }
      const nl = src.indexOf("\n", i);
      if (nl >= 0 && nl < e) toks.push({ kind: "nl", value: "\n", start: i, end: e + 2 });
      i = e + 2;
    } else if (src.startsWith("'''", i)) {
      const e = src.indexOf("'''", i + 3);
      if (e < 0) {
        error("unterminated multi-line string", i);
        break;
      }
      const raw = src.slice(i + 3, e);
      toks.push({ kind: "string", value: raw.startsWith("\r\n") ? raw.slice(2) : raw.startsWith("\n") ? raw.slice(1) : raw, start: i, end: e + 3 });
      i = e + 3;
    } else if (c === "'") i = str(i + 1, true);
    else if (c === "}" && holes.length && holes[holes.length - 1] === 0) {
      holes.pop();
      i = str(i + 1, false);
    } else if (/[0-9A-Za-z_]/.test(c)) {
      const m = /[0-9]/.test(c) ? /[0-9]+/y : /[A-Za-z0-9_]+/y;
      m.lastIndex = i;
      m.exec(src);
      toks.push({ kind: /[0-9]/.test(c) ? "number" : "ident", value: src.slice(i, m.lastIndex), start: i, end: m.lastIndex });
      i = m.lastIndex;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i)) ?? (OP1.includes(c) ? c : null);
      if (!op) {
        error(`unexpected character '${c}'`, i);
        i++;
        continue;
      }
      if (holes.length && op === "{") holes[holes.length - 1]!++;
      if (holes.length && op === "}") holes[holes.length - 1]!--;
      toks.push({ kind: "op", value: op, start: i, end: i + op.length });
      i += op.length;
    }
  }
  toks.push({ kind: "eof", value: "", start: src.length, end: src.length });
  return toks;
}

function nesting(t: Tok): number {
  if (t.kind === "strHead") return 1;
  if (t.kind === "strTail") return -1;
  if (t.kind !== "op") return 0;
  return OPEN.has(t.value) ? 1 : CLOSE.has(t.value) ? -1 : 0;
}

function declaredSymbols(toks: Tok[]): Map<string, IacSymbolKind> {
  const out = new Map<string, IacSymbolKind>();
  let level = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    level += nesting(t);
    const kind = t.kind === "ident" ? SYMBOL_KINDS[t.value] : undefined;
    const prev = toks[i - 1];
    const name = toks[i + 1];
    if (level !== 0 || !kind || name?.kind !== "ident" || out.has(name.value)) continue;
    if (!prev || prev.kind === "nl" || (prev.kind === "op" && prev.value === ")")) out.set(name.value, kind);
  }
  return out;
}

function entry(body: IacExpr, key: string): IacExpr | undefined {
  return body.kind === "object" ? body.entries.find((e) => e.key === key)?.value : undefined;
}

function dependencies(e: IacExpr | undefined): string[] {
  if (e?.kind !== "array") return [];
  return e.items.flatMap((i) => (i.kind === "reference" && (i.target.kind === "resource" || i.target.kind === "module") ? [i.target.name] : []));
}

function decorator(decorators: Decorator[], name: string): Decorator | undefined {
  return decorators.find((d) => d.name === name || d.name === `sys.${name}`);
}

class Parser {
  pos = 0;
  last: Tok;
  depth = 0;
  nl: boolean[] = [false];
  scopes: Map<string, IacSymbolKind>[] = [];
  readonly at: (offset: number) => { line: number; column: number };

  constructor(
    readonly src: string,
    readonly toks: Tok[],
    readonly symbols: Map<string, IacSymbolKind>,
    readonly facts: IacFileFacts,
    readonly paramsFile: boolean,
  ) {
    this.last = toks[0]!;
    this.at = lineIndex(src);
  }

  loc(start: Tok, end: Tok): IacLocation {
    const s = this.at(start.start);
    const e = this.at(Math.max(start.start, end.end));
    return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column };
  }

  cur(): Tok {
    if (this.nl[this.nl.length - 1]) while (this.toks[this.pos]!.kind === "nl") this.pos++;
    return this.toks[this.pos]!;
  }

  next(): Tok {
    const t = this.cur();
    if (t.kind !== "eof") this.pos++;
    this.last = t;
    return t;
  }

  is(value: string, kind: Tok["kind"] = "op"): boolean {
    const t = this.cur();
    return t.kind === kind && t.value === value;
  }

  newline(): boolean {
    return this.cur().kind === "nl";
  }

  fail(message: string): ParseError {
    const t = this.cur();
    const near = t.kind === "eof" ? "end of file" : t.kind === "nl" ? "end of line" : `'${this.src.slice(t.start, Math.min(t.end, t.start + 24))}'`;
    return new ParseError(`${message}, found ${near}`, this.pos);
  }

  expect(value: string, kind: Tok["kind"] = "op"): Tok {
    if (!this.is(value, kind)) throw this.fail(`expected '${value}'`);
    return this.next();
  }

  ident(): Tok {
    if (this.cur().kind !== "ident") throw this.fail("expected identifier");
    return this.next();
  }

  leave(close: string): Tok {
    this.cur();
    this.nl.pop();
    return this.expect(close);
  }

  continues(ops: string[]): boolean {
    this.cur();
    let i = this.pos;
    while (this.toks[i]!.kind === "nl") i++;
    const t = this.toks[i]!;
    if (t.kind !== "op" || !ops.includes(t.value) || (i !== this.pos && t.value === "-")) return false;
    this.pos = i;
    return true;
  }

  classify(name: string): IacSymbolKind {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const kind = this.scopes[i]!.get(name);
      if (kind) return kind;
    }
    return this.symbols.get(name) ?? "unknown";
  }

  unknown(start: Tok, parts: IacExpr[]): IacExpr {
    return { kind: "unknown", text: this.src.slice(start.start, Math.max(start.start, this.last.end)), references: iacReferences(parts) };
  }

  program(): void {
    for (;;) {
      while (this.newline()) this.next();
      if (this.cur().kind === "eof") return;
      const start = this.pos;
      const { parameters, variables, resources, modules, outputs } = this.facts;
      const marks = [parameters.length, variables.length, resources.length, modules.length, outputs.length] as const;
      try {
        this.statement();
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.facts.errors.push({ message: err.message, ...this.at(this.toks[err.index]!.start) });
        [parameters.length, variables.length, resources.length, modules.length, outputs.length] = marks;
        this.nl = [false];
        this.scopes = [];
        this.depth = 0;
        this.recover(start, err.index);
      }
    }
  }

  recover(start: number, failed: number): void {
    let i = Math.max(failed, start + 1);
    while (i > start + 1 && this.toks[i - 1]!.kind !== "nl") i--;
    for (; this.toks[i]!.kind !== "eof"; i++) {
      const t = this.toks[i]!;
      const lineStart = t.start === 0 || this.src[t.start - 1] === "\n";
      if (lineStart && ((t.kind === "ident" && DECLARATIONS.has(t.value)) || (t.kind === "op" && t.value === "@"))) break;
    }
    this.pos = i;
  }

  skipLine(): void {
    let level = 0;
    for (;;) {
      const t = this.toks[this.pos]!;
      if (t.kind === "eof" || (t.kind === "nl" && level <= 0)) return;
      level += nesting(t);
      this.last = t;
      this.pos++;
    }
  }

  typeText(): string | null {
    const first = this.pos;
    let level = 0;
    for (;;) {
      const t = this.toks[this.pos]!;
      if (t.kind === "eof" || (level <= 0 && (t.kind === "nl" || (t.kind === "op" && t.value === "=")))) break;
      level += nesting(t);
      this.last = t;
      this.pos++;
    }
    return this.pos > first ? this.src.slice(this.toks[first]!.start, this.last.end) : null;
  }

  statement(): void {
    const decorators = this.decorators();
    const t = this.cur();
    if (t.kind !== "ident" || !DECLARATIONS.has(t.value)) throw this.fail("expected declaration");
    if (t.value === "targetScope") {
      this.next();
      this.expect("=");
      const e = this.expr();
      this.facts.targetScope = e.kind === "string" ? e.value : null;
    } else if (t.value === "param") this.param(decorators);
    else if (t.value === "var") this.variable();
    else if (t.value === "resource") this.resource(null);
    else if (t.value === "module") this.module();
    else if (t.value === "output") this.output(decorators);
    else if (t.value === "using" && this.paramsFile) {
      this.next();
      const target = this.cur();
      if (target.kind === "string") this.facts.usingTemplate = repoPath(this.facts.file, target.value);
      this.skipLine();
    } else this.skipLine();
    if (!this.newline() && this.cur().kind !== "eof") throw this.fail("expected end of line");
  }

  decorators(): Decorator[] {
    const out: Decorator[] = [];
    while (this.is("@")) {
      this.next();
      let name = this.ident().value;
      if (this.is(".")) {
        this.next();
        name += `.${this.ident().value}`;
      }
      out.push({ name, args: this.is("(") ? this.args() : [] });
      while (this.newline()) this.next();
    }
    return out;
  }

  param(decorators: Decorator[]): void {
    const start = this.next();
    const name = this.ident().value;
    const type = this.typeText();
    const value = this.is("=") ? (this.next(), this.expr()) : null;
    const secure = !!decorator(decorators, "secure");
    const allowed = decorator(decorators, "allowed")?.args[0];
    const description = decorator(decorators, "description")?.args[0];
    this.facts.parameters.push({
      name,
      type,
      defaultValue: secure ? null : value,
      secure,
      allowed: allowed?.kind === "array" ? allowed.items : null,
      description: description?.kind === "string" ? description.value : null,
      location: this.loc(start, this.last),
    });
  }

  variable(): void {
    const start = this.next();
    const name = this.ident().value;
    this.typeText();
    this.expect("=");
    this.facts.variables.push({ name, value: this.expr(), location: this.loc(start, this.last) });
  }

  output(decorators: Decorator[]): void {
    const start = this.next();
    const name = this.ident().value;
    const type = this.typeText();
    this.expect("=");
    const value = this.expr();
    this.facts.outputs.push({ name, type, value, secure: !!decorator(decorators, "secure"), location: this.loc(start, this.last) });
  }

  resource(owner: Owner | null): void {
    const start = this.next();
    const name = this.ident().value;
    const typeTok = this.cur();
    if (typeTok.kind !== "string") throw this.fail("expected resource type string");
    this.next();
    const existing = this.is("existing", "ident");
    if (existing) this.next();
    this.expect("=");
    const at = typeTok.value.indexOf("@");
    const written = at < 0 ? typeTok.value : typeTok.value.slice(0, at);
    const self: Owner = {
      symbol: owner ? `${owner.symbol}::${name}` : name,
      type: owner && !written.includes("/") ? `${owner.type}/${written}` : written,
      apiVersion: at < 0 ? (owner?.apiVersion ?? null) : typeTok.value.slice(at + 1),
    };
    const d = this.declaration(self);
    const parent = entry(d.body, "parent");
    this.facts.resources.push({
      ...self,
      name: entry(d.body, "name") ?? { kind: "null" },
      parent: owner ? owner.symbol : parent?.kind === "reference" && parent.target.kind === "resource" && !parent.path.length ? parent.target.name : null,
      existing,
      condition: d.condition,
      loop: d.loop,
      loopSource: d.loopSource,
      body: d.body,
      dependsOn: dependencies(entry(d.body, "dependsOn")),
      location: this.loc(start, this.last),
    });
  }

  module(): void {
    const start = this.next();
    const symbol = this.ident().value;
    const source = this.cur();
    if (source.kind !== "string") throw this.fail("expected module path string");
    this.next();
    this.expect("=");
    const d = this.declaration(null);
    this.facts.modules.push({
      symbol,
      source: source.value,
      localPath: /^(br|ts)[:/]/.test(source.value) ? null : repoPath(this.facts.file, source.value),
      name: entry(d.body, "name") ?? null,
      params: entry(d.body, "params") ?? { kind: "object", entries: [] },
      condition: d.condition,
      loop: d.loop,
      dependsOn: dependencies(entry(d.body, "dependsOn")),
      scope: entry(d.body, "scope") ?? null,
      location: this.loc(start, this.last),
    });
  }

  declaration(owner: Owner | null): { body: IacExpr; condition: IacExpr | null; loop: boolean; loopSource: IacExpr | null } {
    if (this.is("if", "ident")) {
      const condition = this.condition();
      return { body: this.body(owner), condition, loop: false, loopSource: null };
    }
    if (!this.is("[")) return { body: this.body(owner), condition: null, loop: false, loopSource: null };
    this.next();
    this.nl.push(false);
    while (this.newline()) this.next();
    if (!this.is("for", "ident")) throw this.fail("expected 'for'");
    const l = this.loop(() => this.body(owner));
    this.leave("]");
    return { body: l.body, condition: l.condition, loop: true, loopSource: l.source };
  }

  body(owner: Owner | null): IacExpr {
    if (!this.is("{")) throw this.fail("expected '{'");
    return this.object(owner);
  }

  condition(): IacExpr {
    this.next();
    this.expect("(");
    this.nl.push(true);
    const e = this.expr();
    this.leave(")");
    return e;
  }

  loop<T>(body: () => T): { source: IacExpr; condition: IacExpr | null; body: T } {
    this.next();
    const names: string[] = [];
    if (this.is("(")) {
      this.next();
      this.nl.push(true);
      names.push(this.ident().value);
      while (this.is(",")) {
        this.next();
        names.push(this.ident().value);
      }
      this.leave(")");
    } else names.push(this.ident().value);
    this.expect("in", "ident");
    const source = this.expr();
    this.expect(":");
    this.scopes.push(new Map(names.map((n) => [n, "loop"])));
    const condition = this.is("if", "ident") ? this.condition() : null;
    const value = body();
    this.scopes.pop();
    while (this.newline()) this.next();
    return { source, condition, body: value };
  }

  expr(): IacExpr {
    if (this.depth >= IAC_LIMITS.maxDepth) return this.skipDeep();
    this.depth++;
    const e = this.ternary();
    this.depth--;
    return e;
  }

  skipDeep(): IacExpr {
    const first = this.pos;
    const refs: IacExpr[] = [];
    let level = 0;
    let pending = 0;
    for (;;) {
      const t = this.toks[this.pos]!;
      const op = t.kind === "op" ? t.value : "";
      if (t.kind === "eof") break;
      if (level === 0 && ((t.kind === "nl" && !this.nl[this.nl.length - 1]) || t.kind === "strMid" || t.kind === "strTail" || op === "," || CLOSE.has(op))) break;
      if (level === 0 && op === "?") pending++;
      if (level === 0 && op === ":" && !pending--) break;
      level += nesting(t);
      const prev = this.toks[this.pos - 1];
      const kind = t.kind === "ident" ? this.classify(t.value) : "unknown";
      if (kind !== "unknown" && !(prev?.kind === "op" && (prev.value === "." || prev.value === ".?"))) refs.push({ kind: "reference", target: { kind, name: t.value }, path: [] });
      this.last = t;
      this.pos++;
    }
    return { kind: "unknown", text: this.pos > first ? this.src.slice(this.toks[first]!.start, this.last.end) : "", references: iacReferences(refs) };
  }

  ternary(): IacExpr {
    const condition = this.binary(0);
    if (!this.continues(["?"])) return condition;
    this.next();
    const whenTrue = this.expr();
    if (!this.continues([":"])) throw this.fail("expected ':'");
    this.next();
    return { kind: "conditional", condition, whenTrue, whenFalse: this.expr() };
  }

  binary(level: number): IacExpr {
    const ops = LEVELS[level];
    if (!ops) return this.unary();
    const start = this.cur();
    const parts = [this.binary(level + 1)];
    while (this.continues(ops)) {
      this.next();
      parts.push(this.binary(level + 1));
    }
    return parts.length === 1 ? parts[0]! : this.unknown(start, parts);
  }

  unary(): IacExpr {
    const start = this.cur();
    let ops = 0;
    while (this.is("!") || this.is("-")) {
      this.next();
      ops++;
    }
    const e = this.postfix();
    if (!ops) return e;
    if (ops === 1 && start.value === "-" && e.kind === "number") return { kind: "number", value: -e.value };
    return this.unknown(start, [e]);
  }

  extend(e: IacExpr, segment: string, start: Tok, extra: IacExpr[]): IacExpr {
    if (e.kind === "reference") return { ...e, path: [...e.path, segment] };
    if (e.kind === "call") return { ...e, path: [...(e.path ?? []), segment] };
    return this.unknown(start, [e, ...extra]);
  }

  postfix(): IacExpr {
    const start = this.cur();
    let e = this.primary();
    for (;;) {
      if (this.continues([".", ".?"])) {
        this.next();
        const name = this.ident().value;
        e = this.is("(") ? this.unknown(start, [e, ...this.args()]) : this.extend(e, name, start, []);
      } else if (this.is("[")) {
        this.next();
        if (this.is("?")) this.next();
        this.nl.push(true);
        const index = this.expr();
        this.leave("]");
        e = this.extend(e, index.kind === "string" ? index.value : index.kind === "number" ? String(index.value) : "*", start, [index]);
      } else if (this.is("::")) {
        this.next();
        const name = this.ident().value;
        e = e.kind === "reference" && e.target.kind === "resource" && !e.path.length ? { kind: "reference", target: { kind: "resource", name: `${e.target.name}::${name}` }, path: [] } : this.unknown(start, [e]);
      } else if (this.is("!")) this.next();
      else return e;
    }
  }

  primary(): IacExpr {
    const t = this.cur();
    if (t.kind === "number") {
      this.next();
      return { kind: "number", value: Number(t.value) };
    }
    if (t.kind === "string") {
      this.next();
      return { kind: "string", value: t.value };
    }
    if (t.kind === "strHead") return this.interpolation();
    if (t.kind === "ident") return this.word();
    if (t.kind === "op" && t.value === "(") return this.isLambda() ? this.lambda() : this.paren();
    if (t.kind === "op" && t.value === "{") return this.object(null);
    if (t.kind === "op" && t.value === "[") return this.array();
    throw this.fail("expected expression");
  }

  word(): IacExpr {
    const following = this.toks[this.pos + 1]!;
    if (following.kind === "op" && following.value === "=>") return this.lambda();
    const t = this.next();
    if (t.value === "true" || t.value === "false") return { kind: "bool", value: t.value === "true" };
    if (t.value === "null") return { kind: "null" };
    if (this.is("(")) return { kind: "call", name: t.value, args: this.args() };
    const kind = this.classify(t.value);
    const [dot, member, paren] = [this.toks[this.pos], this.toks[this.pos + 1], this.toks[this.pos + 2]];
    if (kind === "unknown" && dot?.kind === "op" && dot.value === "." && member?.kind === "ident" && paren?.kind === "op" && paren.value === "(") {
      this.next();
      this.next();
      return { kind: "call", name: `${t.value}.${member.value}`, args: this.args() };
    }
    return { kind: "reference", target: { kind, name: t.value }, path: [] };
  }

  isLambda(): boolean {
    let i = this.pos + 1;
    const skippable = (t: Tok) => t.kind === "ident" || t.kind === "nl" || (t.kind === "op" && t.value === ",");
    while (skippable(this.toks[i]!)) i++;
    if (this.toks[i]!.kind !== "op" || this.toks[i]!.value !== ")") return false;
    i++;
    while (this.toks[i]!.kind === "nl") i++;
    return this.toks[i]!.kind === "op" && this.toks[i]!.value === "=>";
  }

  lambda(): IacExpr {
    const start = this.cur();
    const names: string[] = [];
    if (this.is("(")) {
      this.next();
      this.nl.push(true);
      while (!this.is(")")) {
        names.push(this.ident().value);
        if (this.is(",")) this.next();
      }
      this.leave(")");
    } else names.push(this.ident().value);
    this.expect("=>");
    this.scopes.push(new Map(names.map((n) => [n, "unknown"])));
    const body = this.expr();
    this.scopes.pop();
    return this.unknown(start, [body]);
  }

  paren(): IacExpr {
    this.next();
    this.nl.push(true);
    const e = this.expr();
    this.leave(")");
    return e;
  }

  args(): IacExpr[] {
    this.expect("(");
    this.nl.push(true);
    const args: IacExpr[] = [];
    while (!this.is(")")) {
      args.push(this.expr());
      if (!this.is(",")) break;
      this.next();
    }
    this.leave(")");
    return args;
  }

  interpolation(): IacExpr {
    const head = this.next();
    const parts: (string | IacExpr)[] = head.value ? [head.value] : [];
    this.nl.push(true);
    for (;;) {
      parts.push(this.expr());
      const t = this.cur();
      if (t.kind !== "strMid" && t.kind !== "strTail") throw this.fail("expected end of interpolation");
      this.next();
      if (t.value) parts.push(t.value);
      if (t.kind === "strTail") break;
    }
    this.nl.pop();
    return { kind: "interpolation", parts };
  }

  separator(close: string): void {
    if (!this.is(",") && !this.is(close) && !this.newline()) throw this.fail("expected new line or ','");
  }

  object(owner: Owner | null): IacExpr {
    const start = this.next();
    this.nl.push(false);
    const entries: IacObjectEntry[] = [];
    const values: IacExpr[] = [];
    let dynamic = false;
    for (;;) {
      while (this.is(",") || this.newline()) this.next();
      const t = this.cur();
      if (this.is("}")) break;
      if (owner && (this.is("@") || (t.kind === "ident" && t.value === "resource" && this.toks[this.pos + 1]!.kind === "ident"))) {
        this.decorators();
        if (!this.is("resource", "ident")) throw this.fail("expected nested resource");
        this.resource(owner);
      } else if (this.is("...")) {
        this.next();
        dynamic = true;
        values.push(this.expr());
      } else if (t.kind === "strHead") {
        dynamic = true;
        values.push(this.interpolation());
        this.expect(":");
        values.push(this.expr());
      } else {
        if (t.kind !== "ident" && t.kind !== "string") throw this.fail("expected property name");
        this.next();
        this.expect(":");
        const value = this.expr();
        values.push(value);
        entries.push({ key: t.value, value, location: this.loc(t, this.last) });
      }
      this.separator("}");
    }
    this.leave("}");
    return dynamic ? this.unknown(start, values) : { kind: "object", entries };
  }

  array(): IacExpr {
    const start = this.next();
    this.nl.push(false);
    while (this.newline()) this.next();
    if (this.is("for", "ident")) {
      const l = this.loop(() => this.expr());
      this.leave("]");
      return this.unknown(start, [l.source, ...(l.condition ? [l.condition] : []), l.body]);
    }
    const items: IacExpr[] = [];
    let spread = false;
    for (;;) {
      while (this.is(",") || this.newline()) this.next();
      if (this.is("]")) break;
      if (this.is("...")) {
        this.next();
        spread = true;
      }
      items.push(this.expr());
      this.separator("]");
    }
    this.leave("]");
    return spread ? this.unknown(start, items) : { kind: "array", items };
  }
}

/** Parses a .bicep template or a .bicepparam parameters file (decided by extension) into IaC facts. Never throws. */
export const parseBicep: IacParser = (file, text) => {
  const paramsFile = file.toLowerCase().endsWith(".bicepparam");
  const facts = emptyFacts("bicep", file, paramsFile ? "parameters" : "template");
  if (Buffer.byteLength(text, "utf8") > IAC_LIMITS.maxBytes) {
    facts.errors.push({ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 });
    return facts;
  }
  const at = lineIndex(text);
  try {
    const toks = lex(text, (message, offset) => facts.errors.push({ message, ...at(offset) }));
    new Parser(text, toks, declaredSymbols(toks), facts, paramsFile).program();
  } catch (err) {
    facts.errors.push({ message: `internal parser error: ${err instanceof Error ? err.message : String(err)}`, line: 1, column: 1 });
  }
  facts.resources.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column);
  facts.errors.sort((a, b) => a.line - b.line || a.column - b.column);
  return facts;
};
