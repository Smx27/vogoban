import type { AttributeFact, SymbolFact } from "../dotnet/semantic-facts.ts";

/** Attribute short name without namespace, generic arity or the `Attribute` suffix. */
export function attributeName(a: AttributeFact): string {
  return (a.type.qualifiedName.split("<")[0]!.split(".").pop() ?? "").replace(/Attribute$/, "");
}

const NAMESPACES = /^(Microsoft\.Azure\.(Functions\.Worker|WebJobs)(\.[\w.]+)?|Microsoft\.DurableTask(\.[\w.]+)?)\.\w+$/;

/** True for attributes of the Functions isolated worker, the in-process WebJobs SDK and Durable, or an unbound attribute (packages not restored) with a Functions-shaped name. */
export function isFunctionsAttribute(a: AttributeFact, names: RegExp): boolean {
  if (!names.test(attributeName(a))) return false;
  return NAMESPACES.test(a.type.qualifiedName.split("<")[0]!) || a.unbound === true || a.type.kind === "Error";
}

/** `[Function("Name")]` (isolated worker) or `[FunctionName("Name")]` (in-process); returns the declared function name. */
export function functionDeclaration(symbol: Pick<SymbolFact, "attributes" | "kind">): { name: string | null; model: "isolated" | "in-process"; attribute: AttributeFact } | null {
  if (symbol.kind !== "Method") return null;
  for (const a of symbol.attributes) {
    if (!isFunctionsAttribute(a, /^(Function|FunctionName)$/)) continue;
    const value = a.arguments.find((x) => !x.name);
    const name = value && value.kind === "string" ? (value.value ?? null) : null;
    return { name, model: attributeName(a) === "FunctionName" ? "in-process" : "isolated", attribute: a };
  }
  return null;
}
