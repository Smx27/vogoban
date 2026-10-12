import type { SymRef } from "../../semantic-facts.ts";
import { stripGenerics } from "../shared.ts";

export interface ResolvedPayload {
  type: SymRef;
  collection: string | null;
  rule: string;
}

type Resolver = (ref: SymRef, resolve: (ref: SymRef, rule: string) => ResolvedPayload[]) => ResolvedPayload[] | null;

const WRAPPERS = new Set([
  "System.Threading.Tasks.Task", "System.Threading.Tasks.ValueTask", "Microsoft.AspNetCore.Mvc.ActionResult",
]);
const COLLECTIONS = new Set([
  "System.Collections.Generic.IEnumerable", "System.Collections.Generic.List", "System.Collections.Generic.IList", "System.Collections.Generic.ICollection",
  "System.Collections.Generic.IReadOnlyList", "System.Collections.Generic.IReadOnlyCollection", "System.Collections.Generic.IAsyncEnumerable",
  "System.Linq.IQueryable", "System.Collections.Immutable.ImmutableArray", "System.Collections.Immutable.ImmutableList",
]);
const TYPED_RESULTS = /^Microsoft\.AspNetCore\.Http\.HttpResults\.(Ok|Created|CreatedAtRoute|Accepted|AcceptedAtRoute|JsonHttpResult|BadRequest|Conflict|NotFound|UnprocessableEntity|ValidationProblem)$/;
const UNTYPED = /^(Microsoft\.AspNetCore\.Mvc\.(IActionResult|ActionResult|IConvertToActionResult|\w+Result)|Microsoft\.AspNetCore\.Http\.(IResult|HttpResults\.\w+)|System\.Threading\.Tasks\.(Task|ValueTask)|void)$/;
const PRIMITIVE = /^(string|int|long|short|byte|bool|double|float|decimal|object|char|uint|ulong|System\.(Guid|DateTime|DateTimeOffset|TimeSpan|DateOnly|TimeOnly|Uri))$/;

export const RESPONSE_RESOLVERS: Resolver[] = [
  (ref, resolve) => (WRAPPERS.has(stripGenerics(ref.qualifiedName)) && ref.typeArguments?.[0] ? resolve(ref.typeArguments[0], "unwrap") : null),
  (ref, resolve) => (stripGenerics(ref.qualifiedName) === "Microsoft.AspNetCore.Http.HttpResults.Results" ? (ref.typeArguments ?? []).flatMap((t) => resolve(t, "results-union")) : null),
  (ref, resolve) => (TYPED_RESULTS.test(stripGenerics(ref.qualifiedName)) ? (ref.typeArguments?.[0] ? resolve(ref.typeArguments[0], "typed-result") : []) : null),
  (ref, resolve) => {
    if (!COLLECTIONS.has(stripGenerics(ref.qualifiedName)) || !ref.typeArguments?.[0]) return null;
    return resolve(ref.typeArguments[0], "collection").map((p) => ({ ...p, collection: p.collection ?? stripGenerics(ref.qualifiedName).split(".").pop()! }));
  },
  (ref) => (UNTYPED.test(stripGenerics(ref.qualifiedName)) || PRIMITIVE.test(ref.qualifiedName) || ref.kind === "TypeParameter" ? [] : null),
];

export function resolvePayload(ref: SymRef | undefined, rule = "declared"): ResolvedPayload[] {
  if (!ref) return [];
  for (const resolver of RESPONSE_RESOLVERS) {
    const result = resolver(ref, resolvePayload);
    if (result) return result;
  }
  return [{ type: ref, collection: null, rule }];
}
