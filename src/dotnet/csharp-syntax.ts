import { Language, Parser, type Node } from "web-tree-sitter";
import type { LanguagePlugin, ParseResult, SyntaxError } from "../plugins/types.ts";
import { CSHARP_SYNTAX } from "./artifacts.ts";

export type SyntaxDeclKind =
  | "class" | "interface" | "struct" | "record" | "record struct" | "enum" | "delegate"
  | "method" | "constructor" | "property" | "field" | "event" | "indexer" | "operator";

export interface SyntaxDecl {
  kind: SyntaxDeclKind;
  name: string;
  namespace: string;
  containerPath: string[];
  arity: number;
  modifiers: string[];
  baseTypes: string[];
  attributes: string[];
  parameterTypes: string[];
  returnType: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface CSharpSyntaxFacts {
  usings: string[];
  namespaces: string[];
  declarations: SyntaxDecl[];
}

const TYPE_NODES: Record<string, SyntaxDeclKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  struct_declaration: "struct",
  record_declaration: "record",
  record_struct_declaration: "record struct",
  enum_declaration: "enum",
};
const MEMBER_NODES: Record<string, SyntaxDeclKind> = {
  method_declaration: "method",
  constructor_declaration: "constructor",
  property_declaration: "property",
  field_declaration: "field",
  event_field_declaration: "event",
  event_declaration: "event",
  indexer_declaration: "indexer",
  operator_declaration: "operator",
  delegate_declaration: "delegate",
};

let language: Language | null = null;
let parser: Parser | null = null;

function modifiers(node: Node): string[] {
  return node.namedChildren.filter((c): c is Node => c !== null && c.type === "modifier").map((c) => c.text);
}

function attributes(node: Node): string[] {
  const out: string[] = [];
  for (const list of node.namedChildren) {
    if (list?.type !== "attribute_list") continue;
    for (const attr of list.namedChildren) {
      const name = attr?.type === "attribute" ? attr.childForFieldName("name")?.text : null;
      if (name) out.push(name);
    }
  }
  return out;
}

function parameterTypes(node: Node): string[] {
  const list = node.childForFieldName("parameters") ?? node.namedChildren.find((c) => c?.type === "parameter_list") ?? null;
  if (!list) return [];
  return list.namedChildren
    .filter((p): p is Node => p !== null && p.type === "parameter")
    .map((p) => p.childForFieldName("type")?.text ?? "?");
}

function collectErrors(root: Node, errors: SyntaxError[]) {
  const stack: Node[] = [root];
  while (stack.length && errors.length < 20) {
    const node = stack.pop()!;
    if (!node.hasError) continue;
    if (node.type === "ERROR" || node.isMissing) {
      errors.push({
        message: node.isMissing ? `missing ${node.type}` : `unexpected syntax '${node.text.slice(0, 40).replace(/\s+/g, " ")}'`,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
      });
      continue;
    }
    for (const child of node.children) if (child) stack.push(child);
  }
}

function extract(root: Node): CSharpSyntaxFacts {
  const facts: CSharpSyntaxFacts = { usings: [], namespaces: [], declarations: [] };
  const push = (node: Node, kind: SyntaxDeclKind, name: string, ns: string, path: string[], extra: Partial<SyntaxDecl> = {}) => {
    facts.declarations.push({
      kind, name, namespace: ns, containerPath: path, arity: 0, modifiers: modifiers(node), baseTypes: [], attributes: attributes(node),
      parameterTypes: [], returnType: null,
      line: node.startPosition.row + 1, column: node.startPosition.column + 1, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1,
      ...extra,
    });
  };

  const visitMembers = (nodes: (Node | null)[], ns: string, path: string[]) => {
    let currentNs = ns;
    for (const node of nodes) {
      if (!node) continue;
      if (node.type === "using_directive") {
        const name = node.namedChildren.find((c) => c?.type === "qualified_name" || c?.type === "identifier")?.text;
        if (name) facts.usings.push(name);
      } else if (node.type === "file_scoped_namespace_declaration") {
        currentNs = [ns, node.childForFieldName("name")?.text].filter(Boolean).join(".");
        facts.namespaces.push(currentNs);
      } else if (node.type === "namespace_declaration") {
        const name = [currentNs, node.childForFieldName("name")?.text].filter(Boolean).join(".");
        facts.namespaces.push(name);
        visitMembers(node.childForFieldName("body")?.namedChildren ?? [], name, []);
      } else if (node.type in TYPE_NODES) {
        const name = node.childForFieldName("name")?.text ?? "?";
        const typeParams = node.namedChildren.find((c) => c?.type === "type_parameter_list");
        const arity = typeParams ? typeParams.namedChildren.filter((c) => c?.type === "type_parameter").length : 0;
        const baseList = node.namedChildren.find((c) => c?.type === "base_list");
        const kind = node.type === "record_declaration" && node.children.some((c) => c?.type === "struct") ? "record struct" : TYPE_NODES[node.type]!;
        push(node, kind, name, currentNs, path, {
          arity,
          baseTypes: baseList ? baseList.namedChildren.filter((c): c is Node => c !== null && c.type !== "argument_list").map((c) => c.text) : [],
          parameterTypes: kind.startsWith("record") ? parameterTypes(node) : [],
        });
        const body = node.childForFieldName("body") ?? node.namedChildren.find((c) => c?.type === "declaration_list") ?? null;
        if (body) visitMembers(body.namedChildren, currentNs, [...path, arity ? `${name}\`${arity}` : name]);
      } else if (node.type in MEMBER_NODES) {
        const kind = MEMBER_NODES[node.type]!;
        if (kind === "field" || kind === "event") {
          const declaration = node.namedChildren.find((c) => c?.type === "variable_declaration");
          const type = declaration?.childForFieldName("type")?.text ?? null;
          for (const v of declaration?.namedChildren ?? []) {
            if (v?.type === "variable_declarator") push(node, kind, v.childForFieldName("name")?.text ?? v.namedChildren[0]?.text ?? "?", currentNs, path, { returnType: type });
          }
          if (node.type === "event_declaration") push(node, kind, node.childForFieldName("name")?.text ?? "?", currentNs, path, { returnType: node.childForFieldName("type")?.text ?? null });
          continue;
        }
        const name = kind === "constructor" ? ".ctor" : kind === "indexer" ? "this[]" : node.childForFieldName("name")?.text ?? node.childForFieldName("operator")?.text ?? "?";
        const typeParams = node.namedChildren.find((c) => c?.type === "type_parameter_list");
        push(node, kind, name, currentNs, path, {
          arity: typeParams ? typeParams.namedChildren.filter((c) => c?.type === "type_parameter").length : 0,
          parameterTypes: parameterTypes(node),
          returnType: (node.childForFieldName("returns") ?? node.childForFieldName("type"))?.text ?? null,
        });
      } else if (node.type === "global_statement" || node.type === "declaration_list") {
        continue;
      }
    }
  };
  visitMembers(root.namedChildren, "", []);
  return facts;
}

export const csharpSyntaxPlugin: LanguagePlugin<CSharpSyntaxFacts> = {
  id: "csharp.tree-sitter",
  version: "1",
  category: "language",
  language: "csharp",
  extensions: [".cs"],
  syntaxArtifact: CSHARP_SYNTAX,
  async init() {
    if (language) return;
    await Parser.init();
    language = await Language.load(Bun.fileURLToPath(import.meta.resolve("tree-sitter-c-sharp/tree-sitter-c_sharp.wasm")));
    parser = new Parser();
    parser.setLanguage(language);
  },
  parse(_path: string, source: string): ParseResult<CSharpSyntaxFacts> {
    if (!parser) throw new Error("C# grammar not initialised");
    const tree = parser.parse(source);
    if (!tree) throw new Error("tree-sitter returned no tree");
    try {
      const errors: SyntaxError[] = [];
      collectErrors(tree.rootNode, errors);
      return { facts: extract(tree.rootNode), errors };
    } finally {
      tree.delete();
    }
  },
};
