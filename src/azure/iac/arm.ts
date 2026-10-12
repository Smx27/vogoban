import { emptyFacts, iacReferences, lineIndex } from "./bicep.ts";
import { IAC_LIMITS, type IacExpr, type IacFileFacts, type IacLocation, type IacParser } from "./model.ts";

type JNode = { start: number; end: number } & (
  | { kind: "object"; entries: { key: string; start: number; value: JNode }[] }
  | { kind: "array"; items: JNode[] }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "deep" }
);

interface ATok {
  kind: "ident" | "string" | "number" | "op";
  value: string;
  start: number;
  end: number;
}

class SyntaxFailure extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const JSON_DEPTH = IAC_LIMITS.maxDepth * 4;
const JSON_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const KEYVAULT: IacExpr = { kind: "unknown", text: "keyvault-reference", references: [] };
const SCOPES: [string, string][] = [
  ["subscriptiondeploymenttemplate", "subscription"],
  ["managementgroupdeploymenttemplate", "managementGroup"],
  ["tenantdeploymenttemplate", "tenant"],
  ["deploymenttemplate", "resourceGroup"],
];

function schemaKind(schema: string): "template" | "parameters" | null {
  const s = schema.toLowerCase();
  return /deploymentparameters\.json/.test(s) ? "parameters" : /deploymenttemplate\.json/.test(s) ? "template" : null;
}

/** Cheap discovery check: classifies JSON text as an ARM deployment template or parameters file by its "$schema". */
export function isArmTemplate(text: string): "template" | "parameters" | null {
  const m = /"\$schema"\s*:\s*"([^"]*)"/.exec(text.length > 65536 ? text.slice(0, 65536) : text);
  return m ? schemaKind(m[1]!) : null;
}

function parseJson(src: string): JNode {
  let i = 0;
  const fail = (message: string): never => {
    throw new SyntaxFailure(message, Math.min(i, src.length));
  };
  const ws = () => {
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
      else if (c === 47 && src[i + 1] === "/") {
        const e = src.indexOf("\n", i);
        i = e < 0 ? src.length : e;
      } else if (c === 47 && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        i = e + 2;
      } else return;
    }
  };
  const string = (): string => {
    let value = "";
    let run = ++i;
    for (;;) {
      if (i >= src.length) fail("unterminated string");
      const c = src[i]!;
      if (c === '"') {
        value += src.slice(run, i++);
        return value;
      }
      if (c !== "\\") {
        i++;
        continue;
      }
      value += src.slice(run, i);
      const e = src[i + 1] ?? "";
      if (JSON_ESCAPES[e] !== undefined) {
        value += JSON_ESCAPES[e];
        i += 2;
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
        value += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
        i += 6;
      } else fail(`invalid escape sequence '\\${e}'`);
      run = i;
    }
  };
  const skip = () => {
    let level = 0;
    do {
      const c = src[i];
      if (c === undefined) fail("unterminated JSON value");
      if (c === '"') string();
      else if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) ws();
      else {
        if (c === "{" || c === "[") level++;
        if (c === "}" || c === "]") level--;
        i++;
      }
    } while (level > 0);
  };
  const value = (depth: number): JNode => {
    ws();
    const start = i;
    const c = src[i];
    if ((c === "{" || c === "[") && depth > JSON_DEPTH) {
      skip();
      return { kind: "deep", start, end: i };
    }
    if (c === "{") {
      i++;
      const entries: { key: string; start: number; value: JNode }[] = [];
      for (ws(); src[i] !== "}"; ws()) {
        if (src[i] !== '"') fail("expected property name");
        const keyStart = i;
        const key = string();
        ws();
        if (src[i] !== ":") fail("expected ':'");
        i++;
        entries.push({ key, start: keyStart, value: value(depth + 1) });
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "}") fail("expected ',' or '}'");
      }
      i++;
      return { kind: "object", entries, start, end: i };
    }
    if (c === "[") {
      i++;
      const items: JNode[] = [];
      for (ws(); src[i] !== "]"; ws()) {
        items.push(value(depth + 1));
        ws();
        if (src[i] === ",") i++;
        else if (src[i] !== "]") fail("expected ',' or ']'");
      }
      i++;
      return { kind: "array", items, start, end: i };
    }
    if (c === '"') return { kind: "string", value: string(), start, end: i };
    for (const [word, node] of [["true", { kind: "bool", value: true }], ["false", { kind: "bool", value: false }], ["null", { kind: "null" }]] as const) {
      if (!src.startsWith(word, i)) continue;
      i += word.length;
      return { ...node, start, end: i };
    }
    const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    m.lastIndex = i;
    if (!m.exec(src)) fail(c === undefined ? "unexpected end of input" : `unexpected character '${c}'`);
    i = m.lastIndex;
    return { kind: "number", value: Number(src.slice(start, i)), start, end: i };
  };
  const root = value(0);
  ws();
  if (i < src.length) fail("unexpected content after JSON value");
  return root;
}

function armTokens(s: string): ATok[] {
  const out: ATok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    const start = i;
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let value = "";
      for (i++; ; ) {
        const e = s.indexOf("'", i);
        if (e < 0) throw new SyntaxFailure("unterminated string literal", start);
        value += s.slice(i, e);
        i = e + 1;
        if (s[i] !== "'") break;
        value += "'";
        i++;
      }
      out.push({ kind: "string", value, start, end: i });
    } else if (/[-0-9]/.test(c)) {
      const m = /-?\d+(?:\.\d+)?/y;
      m.lastIndex = i;
      if (!m.exec(s)) throw new SyntaxFailure(`unexpected character '${c}'`, i);
      i = m.lastIndex;
      out.push({ kind: "number", value: s.slice(start, i), start, end: i });
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /[A-Za-z0-9_$]+/y;
      m.lastIndex = i;
      m.exec(s);
      i = m.lastIndex;
      out.push({ kind: "ident", value: s.slice(start, i), start, end: i });
    } else if ("(),.[]".includes(c)) out.push({ kind: "op", value: c, start, end: ++i });
    else throw new SyntaxFailure(`unexpected character '${c}'`, i);
  }
  return out;
}

function flatten(parts: IacExpr[]): IacExpr {
  const out: (string | IacExpr)[] = [];
  for (const p of parts.flatMap((x) => (x.kind === "interpolation" ? x.parts : [x]))) {
    const value = typeof p === "string" ? p : p.kind === "string" ? p.value : null;
    if (value === null) out.push(p);
    else if (typeof out[out.length - 1] === "string") out[out.length - 1] += value;
    else if (value) out.push(value);
  }
  return out.every((p) => typeof p === "string") ? { kind: "string", value: out.join("") } : { kind: "interpolation", parts: out };
}

function formatParts(format: string, args: IacExpr[]): IacExpr[] | null {
  const out: IacExpr[] = [];
  const re = /\{\{|\}\}|\{(\d+)\}|[{}]|[^{}]+/g;
  for (const m of format.matchAll(re)) {
    if (m[0] === "{{" || m[0] === "}}") out.push({ kind: "string", value: m[0][0]! });
    else if (m[1] !== undefined) {
      const arg = args[Number(m[1])];
      if (!arg) return null;
      out.push(arg);
    } else if (m[0] === "{" || m[0] === "}") return null;
    else out.push({ kind: "string", value: m[0] });
  }
  return out;
}

function armCall(name: string, args: IacExpr[]): IacExpr {
  const fn = name.toLowerCase();
  const first = args[0]?.kind === "string" ? args[0].value : null;
  if ((fn === "parameters" || fn === "variables") && args.length === 1 && first !== null) return { kind: "reference", target: { kind: fn === "parameters" ? "parameter" : "variable", name: first }, path: [] };
  if (fn === "copyindex" && (!args.length || (args.length === 1 && first !== null))) return { kind: "reference", target: { kind: "loop", name: first ?? "copyIndex" }, path: [] };
  if (fn === "concat" && args.some((a) => a.kind === "string")) return flatten(args);
  const parts = fn === "format" && first !== null ? formatParts(first, args.slice(1)) : null;
  if (parts) return flatten(parts);
  if ((fn === "true" || fn === "false") && !args.length) return { kind: "bool", value: fn === "true" };
  if (fn === "null" && !args.length) return { kind: "null" };
  return { kind: "call", name, args };
}

function armExpression(text: string): IacExpr {
  const toks = armTokens(text);
  let i = 0;
  const fail = (message: string): never => {
    throw new SyntaxFailure(message, toks[i]?.start ?? text.length);
  };
  const is = (value: string, at = i) => toks[at]?.kind === "op" && toks[at]!.value === value;
  const expect = (value: string) => {
    if (!is(value)) fail(`expected '${value}'`);
    i++;
  };
  const unknown = (start: number, parts: IacExpr[]): IacExpr => ({ kind: "unknown", text: text.slice(start, toks[i - 1]?.end ?? start), references: iacReferences(parts) });
  const skipDeep = (): IacExpr => {
    const start = toks[i]?.start ?? text.length;
    for (let level = 0; i < toks.length; i++) {
      if (level === 0 && (is(",") || is(")") || is("]"))) break;
      if (is("(") || is("[")) level++;
      if (is(")") || is("]")) level--;
    }
    return { kind: "unknown", text: text.slice(start, toks[i - 1]?.end ?? start), references: [] };
  };
  const args = (depth: number): IacExpr[] => {
    expect("(");
    const out: IacExpr[] = [];
    while (!is(")")) {
      out.push(expr(depth + 1));
      if (!is(",")) break;
      i++;
    }
    expect(")");
    return out;
  };
  const primary = (depth: number): IacExpr => {
    const t = toks[i];
    if (!t) return fail("unexpected end of expression");
    i++;
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "number") return { kind: "number", value: Number(t.value) };
    if (t.kind !== "ident") return fail(`unexpected '${t.value}'`);
    if (is("(")) return armCall(t.value, args(depth));
    if (is(".") && toks[i + 1]?.kind === "ident" && is("(", i + 2)) {
      const name = `${t.value}.${toks[i + 1]!.value}`;
      i += 2;
      return { kind: "call", name, args: args(depth) };
    }
    if (t.value === "true" || t.value === "false") return { kind: "bool", value: t.value === "true" };
    if (t.value === "null") return { kind: "null" };
    return fail(`unexpected identifier '${t.value}'`);
  };
  const expr = (depth: number): IacExpr => {
    if (depth > IAC_LIMITS.maxDepth) return skipDeep();
    const start = toks[i]?.start ?? text.length;
    let e = primary(depth);
    for (;;) {
      let segment: string;
      let index: IacExpr | null = null;
      if (is(".")) {
        i++;
        const t = toks[i++];
        if (t?.kind !== "ident") return fail("expected property name");
        segment = t.value;
      } else if (is("[")) {
        i++;
        index = expr(depth + 1);
        expect("]");
        segment = index.kind === "string" ? index.value : index.kind === "number" ? String(index.value) : "*";
      } else return e;
      if (e.kind === "reference") e = { ...e, path: [...e.path, segment] };
      else if (e.kind === "call") e = { ...e, path: [...(e.path ?? []), segment] };
      else e = unknown(start, index ? [e, index] : [e]);
    }
  };
  const e = expr(0);
  if (i < toks.length) fail(`unexpected '${toks[i]!.value}'`);
  return e;
}

function get(node: JNode | undefined, key: string): JNode | undefined {
  if (node?.kind !== "object") return undefined;
  const k = key.toLowerCase();
  return node.entries.findLast((e) => e.key.toLowerCase() === k)?.value;
}

function text(node: JNode | undefined): string | null {
  return node?.kind === "string" ? node.value : null;
}

function pointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

class Template {
  readonly at: (offset: number) => { line: number; column: number };

  constructor(
    readonly src: string,
    readonly facts: IacFileFacts,
  ) {
    this.at = lineIndex(src);
  }

  loc(start: number, end: number): IacLocation {
    const s = this.at(start);
    const e = this.at(end);
    return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column };
  }

  string(node: Extract<JNode, { kind: "string" }>): IacExpr {
    const v = node.value;
    if (!v.startsWith("[") || !v.endsWith("]")) return { kind: "string", value: v };
    if (v.startsWith("[[")) return { kind: "string", value: v.slice(1) };
    try {
      return armExpression(v.slice(1, -1));
    } catch (err) {
      if (!(err instanceof SyntaxFailure)) throw err;
      this.facts.errors.push({ message: `invalid template expression: ${err.message}`, ...this.at(node.start) });
      return { kind: "unknown", text: v, references: [] };
    }
  }

  expr(node: JNode, literal: boolean, depth = 0): IacExpr {
    if (node.kind === "deep" || depth > IAC_LIMITS.maxDepth) return this.opaque(node, literal);
    if (node.kind === "string") return literal ? { kind: "string", value: node.value } : this.string(node);
    if (node.kind === "number") return { kind: "number", value: node.value };
    if (node.kind === "bool") return { kind: "bool", value: node.value };
    if (node.kind === "null") return { kind: "null" };
    if (node.kind === "array") return { kind: "array", items: node.items.map((n) => this.expr(n, literal, depth + 1)) };
    return { kind: "object", entries: node.entries.map((e) => ({ key: e.key, value: this.expr(e.value, literal, depth + 1), location: this.loc(e.start, e.value.end) })) };
  }

  opaque(node: JNode, literal: boolean): IacExpr {
    const strings: IacExpr[] = [];
    const stack = [node];
    const push = (items: JNode[]) => {
      for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]!);
    };
    while (!literal && stack.length) {
      const n = stack.pop()!;
      if (n.kind === "string") strings.push(this.string(n));
      else if (n.kind === "array") push(n.items);
      else if (n.kind === "object") push(n.entries.map((e) => e.value));
      else if (n.kind === "deep") {
        for (const m of this.src.slice(n.start, n.end).matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          const value = m[1]!.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => (e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (JSON_ESCAPES[e] ?? e)));
          strings.push(this.string({ kind: "string", value, start: n.start + m.index, end: n.start + m.index + m[0].length }));
        }
      }
    }
    return { kind: "unknown", text: node.kind === "string" ? node.value : this.src.slice(node.start, node.end), references: iacReferences(strings) };
  }

  run(root: JNode): void {
    if (root.kind !== "object") {
      this.facts.errors.push({ message: "ARM file must be a JSON object", ...this.at(root.start) });
      return;
    }
    const schema = text(get(root, "$schema")) ?? "";
    this.facts.fileKind = schemaKind(schema) === "parameters" ? "parameters" : "template";
    const params = get(root, "parameters");
    if (this.facts.fileKind === "parameters") {
      for (const e of params?.kind === "object" ? params.entries : []) {
        this.facts.parameters.push({ name: e.key, type: null, defaultValue: this.parameterValue(e.value, true), secure: false, allowed: null, description: null, location: this.loc(e.start, e.value.end) });
      }
      return;
    }
    const lower = schema.toLowerCase();
    this.facts.targetScope = SCOPES.find(([k]) => lower.includes(k))?.[1] ?? null;
    this.facts.generatedBy = text(get(get(get(root, "metadata"), "_generator"), "name"));
    for (const e of params?.kind === "object" ? params.entries : []) {
      const type = text(get(e.value, "type"));
      const secure = /^secure(string|object)$/i.test(type ?? "");
      const value = get(e.value, "defaultValue");
      const allowed = get(e.value, "allowedValues");
      this.facts.parameters.push({
        name: e.key,
        type,
        defaultValue: secure || !value ? null : this.expr(value, false),
        secure,
        allowed: allowed?.kind === "array" ? allowed.items.map((n) => this.expr(n, false)) : null,
        description: text(get(get(e.value, "metadata"), "description")),
        location: this.loc(e.start, e.value.end),
      });
    }
    const variables = get(root, "variables");
    for (const e of variables?.kind === "object" ? variables.entries : []) {
      if (e.key.toLowerCase() !== "copy" || e.value.kind !== "array") {
        this.facts.variables.push({ name: e.key, value: this.expr(e.value, false), location: this.loc(e.start, e.value.end) });
        continue;
      }
      for (const item of e.value.items) {
        const name = text(get(item, "name"));
        if (name !== null) this.facts.variables.push({ name, value: this.opaque(item, false), location: this.loc(item.start, item.end) });
      }
    }
    this.resources(get(root, "resources"), "/resources", null);
    const outputs = get(root, "outputs");
    for (const e of outputs?.kind === "object" ? outputs.entries : []) {
      const type = text(get(e.value, "type"));
      const copy = get(e.value, "copy");
      const value = get(e.value, "value");
      this.facts.outputs.push({
        name: e.key,
        type,
        value: copy ? this.opaque(copy, false) : value ? this.expr(value, false) : { kind: "null" },
        secure: /^secure(string|object)$/i.test(type ?? ""),
        location: this.loc(e.start, e.value.end),
      });
    }
  }

  parameterValue(node: JNode, literal: boolean): IacExpr | null {
    const value = get(node, "value");
    if (value) return this.expr(value, literal);
    if (get(node, "reference")) return KEYVAULT;
    return literal ? null : this.opaque(node, false);
  }

  resources(list: JNode | undefined, base: string, parent: { symbol: string; type: string } | null): void {
    const items: [string, JNode][] = list?.kind === "array" ? list.items.map((n, i) => [`${base}/${i}`, n]) : list?.kind === "object" ? list.entries.map((e) => [`${base}/${pointer(e.key)}`, e.value]) : [];
    for (const [symbol, node] of items) {
      if (node.kind !== "object") continue;
      const written = text(get(node, "type"));
      if (written === null) {
        this.facts.errors.push({ message: "resource without a string 'type'", ...this.at(node.start) });
        continue;
      }
      const type = parent && !written.includes("/") ? `${parent.type}/${written}` : written;
      const propsEntry = node.entries.findLast((e) => e.key.toLowerCase() === "properties");
      const templateEntry = propsEntry?.value.kind === "object" ? propsEntry.value.entries.findLast((e) => e.key.toLowerCase() === "template") : undefined;
      const link = get(propsEntry?.value, "templateLink");
      const condition = get(node, "condition");
      const copy = get(node, "copy");
      const count = get(copy, "count");
      const dependsOn = get(node, "dependsOn");
      const name = get(node, "name");
      const existing = get(node, "existing");
      const common = {
        condition: condition ? this.expr(condition, false) : null,
        loop: !!copy,
        dependsOn: dependsOn?.kind === "array" ? dependsOn.items.flatMap((n) => (n.kind === "string" ? [n.value] : [])) : [],
      };
      if (type.toLowerCase() === "microsoft.resources/deployments" && (templateEntry?.value.kind === "object" || link?.kind === "object")) {
        const inner = templateEntry?.value.kind === "object" ? `${symbol}/${pointer(propsEntry!.key)}/${pointer(templateEntry.key)}` : null;
        const params = get(propsEntry?.value, "parameters");
        this.facts.modules.push({
          symbol,
          source: inner ? `inline:${inner}` : (text(get(link, "uri")) ?? text(get(link, "id")) ?? ""),
          localPath: null,
          name: null,
          params:
            params?.kind === "object"
              ? { kind: "object", entries: params.entries.map((e) => ({ key: e.key, value: this.parameterValue(e.value, false)!, location: this.loc(e.start, e.value.end) })) }
              : params
                ? this.opaque(params, false)
                : { kind: "object", entries: [] },
          ...common,
          scope: null,
          location: this.loc(node.start, node.end),
        });
        if (inner) this.resources(get(templateEntry!.value, "resources"), `${inner}/resources`, null);
        continue;
      }
      this.facts.resources.push({
        symbol,
        type,
        apiVersion: text(get(node, "apiVersion")),
        name: name ? this.expr(name, false) : { kind: "null" },
        parent: parent?.symbol ?? null,
        existing: existing?.kind === "bool" && existing.value,
        condition: common.condition,
        loop: common.loop,
        loopSource: count ? this.expr(count, false) : null,
        body: this.expr({ ...node, entries: node.entries.filter((e) => e.key.toLowerCase() !== "resources") }, false),
        dependsOn: common.dependsOn,
        location: this.loc(node.start, node.end),
      });
      const children = node.entries.findLast((e) => e.key.toLowerCase() === "resources");
      if (children) this.resources(children.value, `${symbol}/${pointer(children.key)}`, { symbol, type });
    }
  }
}

/** Parses an ARM deployment template or deploymentParameters JSON file (comments and trailing commas allowed) into IaC facts. Never throws. */
export const parseArm: IacParser = (file, src) => {
  const facts = emptyFacts("arm", file, isArmTemplate(src) === "parameters" ? "parameters" : "template");
  if (Buffer.byteLength(src, "utf8") > IAC_LIMITS.maxBytes) {
    facts.errors.push({ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 });
    return facts;
  }
  const template = new Template(src, facts);
  try {
    template.run(parseJson(src));
  } catch (err) {
    const syntax = err instanceof SyntaxFailure;
    facts.errors.push({ message: syntax ? err.message : `internal parser error: ${err instanceof Error ? err.message : String(err)}`, ...(syntax ? template.at(err.offset) : { line: 1, column: 1 }) });
  }
  return facts;
};
