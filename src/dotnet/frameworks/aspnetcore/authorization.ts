import type { AnalysisContext } from "../../../plugins/types.ts";
import type { ArgValue, FactLocation, SymbolFact } from "../../semantic-facts.ts";
import { attr, attrValue, constant, frameworkProvenance, stringArgs, type SemanticIndex } from "../shared.ts";

export interface AuthRequirement {
  kind: "authorize" | "anonymous";
  policy: string | null;
  roles: string | null;
  schemes: string | null;
  source: string;
  location?: FactLocation;
}

const AUTHORIZE = "Microsoft.AspNetCore.Authorization.AuthorizeAttribute";
const ALLOW_ANONYMOUS = "Microsoft.AspNetCore.Authorization.AllowAnonymousAttribute";

export function fromAttributes(symbol: { attributes: SymbolFact["attributes"] }, source: string, location?: FactLocation): AuthRequirement[] {
  return [
    ...attr(symbol, AUTHORIZE).map((a): AuthRequirement => ({
      kind: "authorize",
      policy: attrValue(a, "Policy", 0),
      roles: attrValue(a, "Roles"),
      schemes: attrValue(a, "AuthenticationSchemes"),
      source,
      location,
    })),
    ...attr(symbol, ALLOW_ANONYMOUS).map((): AuthRequirement => ({ kind: "anonymous", policy: null, roles: null, schemes: null, source, location })),
  ];
}

export function fromRequireAuthorization(args: ArgValue[], source: string, location: FactLocation): AuthRequirement[] {
  const policies = args.flatMap(stringArgs);
  if (policies.length) return policies.map((policy) => ({ kind: "authorize", policy, roles: null, schemes: null, source, location }));
  const inline = args.some((a) => a.kind !== "string" && a.kind !== "array");
  return [{ kind: "authorize", policy: inline ? "(inline policy)" : null, roles: null, schemes: null, source, location }];
}

export function effectiveAuthorization(requirements: AuthRequirement[]): "anonymous" | "required" | "none-declared" {
  if (requirements.some((r) => r.kind === "anonymous")) return "anonymous";
  return requirements.length ? "required" : "none-declared";
}

export function policyDefinitions(index: SemanticIndex): Map<string, FactLocation> {
  const defined = new Map<string, FactLocation>();
  for (const { invocation, owner, method } of index.invocations) {
    if (method !== "AddPolicy" || !owner || !/^Microsoft\.AspNetCore\.Authorization\.(AuthorizationOptions|AuthorizationBuilder)$/.test(owner)) continue;
    const name = constant(invocation.arguments.find((a) => a.parameter === "name") ?? invocation.arguments[0]);
    if (name && !defined.has(name)) defined.set(name, invocation.location);
  }
  return defined;
}

export function authorizationEntity(ctx: AnalysisContext, requirement: AuthRequirement, defined: Map<string, FactLocation>, plugin: string, version: string): string {
  const label = requirement.kind === "anonymous"
    ? "AllowAnonymous"
    : [requirement.policy ? `policy=${requirement.policy}` : null, requirement.roles ? `roles=${requirement.roles}` : null, requirement.schemes ? `schemes=${requirement.schemes}` : null]
        .filter(Boolean)
        .join(" ") || "Authorize (default policy)";
  const definition = requirement.policy ? defined.get(requirement.policy) : undefined;
  return ctx.graph.entity({
    key: `authorization|${ctx.repository.id}|${requirement.kind}|${requirement.policy ?? ""}|${requirement.roles ?? ""}|${requirement.schemes ?? ""}`,
    kind: "AuthorizationMetadata",
    layer: "application",
    name: label,
    qualifiedName: label,
    repositoryId: ctx.repository.id,
    location: definition ? { file: definition.file, startLine: definition.line, startColumn: definition.column } : null,
    metadata: {
      requirement: requirement.kind,
      policy: requirement.policy,
      roles: requirement.roles ? requirement.roles.split(",").map((r) => r.trim()) : [],
      schemes: requirement.schemes ? requirement.schemes.split(",").map((s) => s.trim()) : [],
      policyDefined: requirement.policy ? definition !== undefined : null,
    },
    provenance: frameworkProvenance(ctx, plugin, definition ? "AUTHORIZATION_POLICY_DEFINITION" : "AUTHORIZATION_METADATA", version, definition ?? requirement.location),
  });
}
