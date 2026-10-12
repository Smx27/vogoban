import { Language, Parser, type Node } from "web-tree-sitter";
import { artifactKey, type LanguagePlugin, type ParseResult, type SyntaxError } from "../plugins/types.ts";
import { FRONTEND_VERSION } from "./common.ts";

export type ImportKind = "static" | "type" | "side-effect" | "dynamic" | "require" | "re-export" | "re-export-type" | "reference";
export type TsDeclKind = "class" | "interface" | "function" | "type" | "enum" | "variable" | "method" | "property";

export interface TsImport {
  specifier: string;
  kind: ImportKind;
  /** imported name -> local binding; "*" for namespace, "default" for default. */
  names: [imported: string, local: string][];
  line: number;
  column: number;
}

export interface TsDecl {
  name: string;
  kind: TsDeclKind;
  container: string | null;
  exported: boolean;
  isDefault: boolean;
  /** "arrow-function" / "function-expression" for variables holding functions; "constructor" / "static" / "abstract" flags. */
  form: string | null;
  line: number;
  column: number;
  endLine: number;
}

export interface TsSyntaxFacts {
  imports: TsImport[];
  /** Local names exported via `export { a as b }` / `export default a` (exported name -> local name). */
  exportNames: [exported: string, local: string][];
  declarations: TsDecl[];
}

export const TS_SYNTAX = artifactKey<Map<string, TsSyntaxFacts>>("frontend.ts-syntax");

const grammars = new Map<string, Language>();
let parser: Parser | null = null;

const grammarFor = (path: string) => (/\.tsx$/i.test(path) ? "tsx" : /\.(ts|mts|cts)$/i.test(path) ? "typescript" : "javascript");
const unquote = (node: Node | null | undefined) => (node ? node.text.replace(/^['"`]|['"`]$/g, "") : null);
const named = (node: Node) => node.namedChildren.filter((c): c is Node => c !== null);

/** Declaration path used as the identity of a TS/JS symbol inside its module: "Name" or "Container.member". Shared by the syntax and semantic plugins. */
export const declPath = (container: string | null, name: string) => (container ? `${container}.${name}` : name);

function memberName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "computed_property_name") return null;
  if (node.type === "private_property_identifier") return node.text;
  return unquote(node);
}

export function extractTsFacts(root: Node): TsSyntaxFacts {
  const imports: TsImport[] = [];
  const exportNames: [string, string][] = [];
  const declarations: TsDecl[] = [];
  const pos = (n: Node) => ({ line: n.startPosition.row + 1, column: n.startPosition.column + 1, endLine: n.endPosition.row + 1 });

  const addClassMembers = (body: Node | null, className: string) => {
    if (!body) return;
    for (const m of named(body)) {
      const t = m.type;
      if (t === "method_definition" || t === "method_signature" || t === "abstract_method_signature") {
        const name = memberName(m.childForFieldName("name"));
        if (!name) continue;
        const isStatic = m.children.some((c) => c?.type === "static");
        declarations.push({ name, kind: "method", container: className, exported: false, isDefault: false, form: name === "constructor" ? "constructor" : isStatic ? "static" : null, ...pos(m) });
      } else if (t === "public_field_definition" || t === "field_definition" || t === "property_signature") {
        const name = memberName(m.childForFieldName("name") ?? m.childForFieldName("property"));
        if (!name) continue;
        const value = m.childForFieldName("value");
        const isStatic = m.children.some((c) => c?.type === "static");
        declarations.push({ name, kind: value && /^(arrow_function|function_expression|function)$/.test(value.type) ? "method" : "property", container: className, exported: false, isDefault: false, form: isStatic ? "static" : value?.type === "arrow_function" ? "arrow-function" : null, ...pos(m) });
      }
    }
  };

  const visitDecl = (node: Node, exported: boolean, isDefault: boolean) => {
    const t = node.type;
    if (t === "class_declaration" || t === "abstract_class_declaration" || t === "class") {
      const name = unquote(node.childForFieldName("name")) ?? (isDefault ? "default" : null);
      if (!name) return;
      declarations.push({ name, kind: "class", container: null, exported, isDefault, form: t === "abstract_class_declaration" ? "abstract" : null, ...pos(node) });
      addClassMembers(node.childForFieldName("body"), name);
    } else if (t === "function_declaration" || t === "generator_function_declaration" || t === "function_signature" || ((t === "function_expression" || t === "function" || t === "arrow_function") && isDefault)) {
      const name = unquote(node.childForFieldName("name")) ?? (isDefault ? "default" : null);
      if (name) declarations.push({ name, kind: "function", container: null, exported, isDefault, form: null, ...pos(node) });
    } else if (t === "interface_declaration") {
      const name = unquote(node.childForFieldName("name"));
      if (name) declarations.push({ name, kind: "interface", container: null, exported, isDefault, form: null, ...pos(node) });
    } else if (t === "type_alias_declaration") {
      const name = unquote(node.childForFieldName("name"));
      if (name) declarations.push({ name, kind: "type", container: null, exported, isDefault, form: null, ...pos(node) });
    } else if (t === "enum_declaration") {
      const name = unquote(node.childForFieldName("name"));
      if (name) declarations.push({ name, kind: "enum", container: null, exported, isDefault, form: null, ...pos(node) });
    } else if (t === "lexical_declaration" || t === "variable_declaration") {
      for (const d of named(node).filter((c) => c.type === "variable_declarator")) {
        const nameNode = d.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") continue;
        const value = d.childForFieldName("value");
        const fn = value && /^(arrow_function|function_expression|function)$/.test(value.type);
        declarations.push({ name: nameNode.text, kind: fn ? "function" : "variable", container: null, exported, isDefault, form: fn ? (value!.type === "arrow_function" ? "arrow-function" : "function-expression") : node.text.startsWith("const") ? "const" : null, ...pos(d) });
        if (value?.type === "class") addClassMembers(value.childForFieldName("body"), nameNode.text);
      }
    } else if (t === "ambient_declaration" || t === "internal_module" || t === "module") {
      for (const c of named(node)) visitDecl(c, exported, false);
    } else if (isDefault && t === "identifier") {
      exportNames.push(["default", node.text]);
    }
  };

  const walkCalls = (node: Node) => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      const first = args ? named(args)[0] : null;
      if (fn && first && (first.type === "string" || (first.type === "template_string" && !named(first).some((c) => c.type === "template_substitution")))) {
        if (fn.type === "import") imports.push({ specifier: unquote(first)!, kind: "dynamic", names: [], ...pos(node) });
        else if (fn.type === "identifier" && fn.text === "require") imports.push({ specifier: unquote(first)!, kind: "require", names: [], ...pos(node) });
        else if (fn.type === "member_expression" && fn.text === "require.resolve") imports.push({ specifier: unquote(first)!, kind: "reference", names: [], ...pos(node) });
      }
    } else if (node.type === "new_expression" && node.childForFieldName("constructor")?.text === "URL") {
      const args = node.childForFieldName("arguments");
      const [first, second] = args ? named(args) : [];
      if (first?.type === "string" && second?.text === "import.meta.url") imports.push({ specifier: unquote(first)!, kind: "reference", names: [], ...pos(node) });
    }
    for (const c of named(node)) walkCalls(c);
  };

  for (const stmt of named(root)) {
    if (stmt.type === "comment") {
      const ref = /^\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/.exec(stmt.text);
      if (ref) imports.push({ specifier: ref[1]!.startsWith(".") || ref[1]!.startsWith("/") ? ref[1]! : `./${ref[1]}`, kind: "reference", names: [], ...pos(stmt) });
      continue;
    }
    if (stmt.type === "import_statement") {
      const source = unquote(stmt.childForFieldName("source"));
      if (!source) continue;
      const typeOnly = stmt.children.some((c) => c?.type === "type");
      const names: [string, string][] = [];
      const clause = named(stmt).find((c) => c.type === "import_clause");
      for (const part of clause ? named(clause) : []) {
        if (part.type === "identifier") names.push(["default", part.text]);
        else if (part.type === "namespace_import") {
          const id = named(part).find((c) => c.type === "identifier");
          if (id) names.push(["*", id.text]);
        } else if (part.type === "named_imports") {
          for (const spec of named(part).filter((c) => c.type === "import_specifier")) {
            const name = spec.childForFieldName("name")?.text;
            const alias = spec.childForFieldName("alias")?.text;
            if (name) names.push([name, alias ?? name]);
          }
        }
      }
      imports.push({ specifier: source, kind: typeOnly ? "type" : clause ? "static" : "side-effect", names, ...pos(stmt) });
      continue;
    }
    if (stmt.type === "export_statement") {
      const source = unquote(stmt.childForFieldName("source"));
      const isDefault = stmt.children.some((c) => c?.type === "default");
      const typeOnly = stmt.children.some((c) => c?.type === "type");
      const clause = named(stmt).find((c) => c.type === "export_clause");
      if (source) {
        const names: [string, string][] = [];
        for (const spec of clause ? named(clause).filter((c) => c.type === "export_specifier") : []) {
          const name = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (name) names.push([name, alias ?? name]);
        }
        const ns = named(stmt).find((c) => c.type === "namespace_export");
        if (!clause) names.push(["*", ns ? (named(ns)[0]?.text ?? "*") : "*"]);
        imports.push({ specifier: source, kind: typeOnly ? "re-export-type" : "re-export", names, ...pos(stmt) });
        continue;
      }
      if (clause) {
        for (const spec of named(clause).filter((c) => c.type === "export_specifier")) {
          const name = spec.childForFieldName("name")?.text;
          const alias = spec.childForFieldName("alias")?.text;
          if (name) exportNames.push([alias ?? name, name]);
        }
        continue;
      }
      const decl = stmt.childForFieldName("declaration") ?? stmt.childForFieldName("value");
      if (decl) visitDecl(decl, true, isDefault);
      walkCalls(stmt);
      continue;
    }
    if (stmt.type === "expression_statement") {
      const expr = named(stmt)[0];
      if (expr?.type === "assignment_expression") {
        const left = expr.childForFieldName("left")?.text ?? "";
        if (left === "module.exports" || left.startsWith("exports.")) exportNames.push([left === "module.exports" ? "default" : left.slice(8), expr.childForFieldName("right")?.text.slice(0, 120) ?? ""]);
      }
    }
    visitDecl(stmt, false, false);
    walkCalls(stmt);
  }
  return { imports, exportNames, declarations };
}

function collectErrors(root: Node): SyntaxError[] {
  const out: SyntaxError[] = [];
  const visit = (n: Node) => {
    if (out.length >= 5) return;
    if (n.isError || n.isMissing) {
      out.push({ message: n.isMissing ? `missing ${n.type}` : "unexpected syntax", line: n.startPosition.row + 1, column: n.startPosition.column + 1 });
      return;
    }
    if (!n.hasError) return;
    for (const c of n.children) if (c) visit(c);
  };
  visit(root);
  return out;
}

export const typescriptSyntaxPlugin: LanguagePlugin<TsSyntaxFacts> = {
  id: "typescript.tree-sitter",
  version: FRONTEND_VERSION,
  category: "language",
  language: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  syntaxArtifact: TS_SYNTAX,
  async init() {
    if (parser) return;
    await Parser.init();
    for (const [name, wasm] of [["typescript", "tree-sitter-typescript/tree-sitter-typescript.wasm"], ["tsx", "tree-sitter-typescript/tree-sitter-tsx.wasm"], ["javascript", "tree-sitter-javascript/tree-sitter-javascript.wasm"]] as const) {
      grammars.set(name, await Language.load(Bun.fileURLToPath(import.meta.resolve(wasm))));
    }
    parser = new Parser();
  },
  parse(path: string, source: string): ParseResult<TsSyntaxFacts> {
    if (!parser) throw new Error("TypeScript grammar not initialised");
    let grammar = grammarFor(path);
    parser.setLanguage(grammars.get(grammar)!);
    let tree = parser.parse(source);
    if (grammar === "javascript" && tree?.rootNode.hasError) {
      parser.setLanguage(grammars.get("tsx")!);
      const retry = parser.parse(source);
      if (retry && !retry.rootNode.hasError) {
        tree.delete();
        tree = retry;
        grammar = "tsx";
      } else retry?.delete();
    }
    if (!tree) throw new Error("tree-sitter returned no tree");
    try {
      return { facts: extractTsFacts(tree.rootNode), errors: collectErrors(tree.rootNode) };
    } finally {
      tree.delete();
    }
  },
};
