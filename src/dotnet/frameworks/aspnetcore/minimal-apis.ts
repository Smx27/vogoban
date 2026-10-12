import type { AnalysisContext } from "../../../plugins/types.ts";
import type { ArgValue, FactLocation, InvocationFact, ReceiverFact, SymRef } from "../../semantic-facts.ts";
import type { ApplicationIndex } from "../applications.ts";
import { arg, constant, entityIdOf, frameworkProvenance, locationKey, methodName, receiverChain, relate, stringArgs, unresolvedFramework, type IndexedInvocation, type SemanticIndex } from "../shared.ts";
import { fromAttributes, fromRequireAuthorization, type AuthRequirement } from "./authorization.ts";
import { bindParameters, routeTokens, type BindableParameter } from "./binding.ts";
import { apiVersionFrom, joinRoute, PLUGIN, VERSION, type EndpointSpec } from "./endpoints.ts";

const ROUTE_BUILDER = "Microsoft.AspNetCore.Builder.EndpointRouteBuilderExtensions";
const MAP_VERBS: Record<string, string> = { MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH", Map: "ANY", MapMethods: "*" };
const FLUENT = /^(RequireAuthorization|AllowAnonymous|WithTags|WithName|WithDisplayName|Produces|ProducesProblem|ProducesValidationProblem|Accepts|HasApiVersion|MapToApiVersion)$/;

interface FluentMetadata {
  authorization: AuthRequirement[];
  tags: string[];
  name: string | null;
  produces: string[];
  consumes: string[];
  producesTypes: { type: SymRef; rule: string }[];
  accepts: { type: SymRef }[];
  apiVersions: string[];
  mappedVersions: string[];
}

interface Group {
  id: string;
  prefix: string;
  resolved: boolean;
  metadata: FluentMetadata;
  parent: Group | null;
}

const emptyMetadata = (): FluentMetadata => ({ authorization: [], tags: [], name: null, produces: [], consumes: [], producesTypes: [], accepts: [], apiVersions: [], mappedVersions: [] });

function isMapping(target: SymRef | undefined, owner: string | null): boolean {
  const name = methodName(target);
  return (owner === ROUTE_BUILDER && name in MAP_VERBS) || name === "MapGroup" || /^Map(Controllers|ControllerRoute|DefaultControllerRoute)$/.test(name);
}

function nearestMapping(receiver: ReceiverFact | undefined): ReceiverFact | undefined {
  return receiverChain(receiver).find((r) => r.invocationTarget && r.location && isMapping(r.invocationTarget, r.invocationTarget.containingType?.qualifiedName.replace(/<.*$/, "") ?? null));
}

function groupsCreatedIn(index: SemanticIndex): Map<string, string[]> {
  const byMethod = new Map<string, string[]>();
  for (const { invocation, owner, method } of index.invocations) {
    if (method !== "MapGroup") continue;
    byMethod.set(invocation.caller, [...(byMethod.get(invocation.caller) ?? []), locationKey(invocation.location)]);
  }
  return byMethod;
}

function collectFluent(index: SemanticIndex): Map<string, FluentMetadata> {
  const byTarget = new Map<string, FluentMetadata>();
  const createdIn = groupsCreatedIn(index);
  for (const { invocation, method } of index.invocations) {
    if (!FLUENT.test(method)) continue;
    const target = nearestMapping(invocation.receiver);
    let key = target?.location ? locationKey(target.location) : null;
    let via: string | null = null;
    const helper = invocation.receiver?.invocationTarget;
    if (!key && helper && !helper.external) {
      const created = createdIn.get(helper.key) ?? [];
      if (created.length === 1) {
        key = created[0]!;
        via = methodName(helper);
      }
    }
    if (!key) continue;
    const meta = byTarget.get(key) ?? emptyMetadata();
    byTarget.set(key, meta);
    const args = invocation.arguments;
    switch (method) {
      case "RequireAuthorization":
        meta.authorization.push(...fromRequireAuthorization(args, via ? `fluent:RequireAuthorization(via ${via})` : "fluent:RequireAuthorization", invocation.location));
        break;
      case "AllowAnonymous":
        meta.authorization.push({ kind: "anonymous", policy: null, roles: null, schemes: null, source: via ? `fluent:AllowAnonymous(via ${via})` : "fluent:AllowAnonymous", location: invocation.location });
        break;
      case "WithTags":
        meta.tags.push(...args.flatMap(stringArgs));
        break;
      case "WithName":
      case "WithDisplayName":
        meta.name ??= constant(args[0]);
        break;
      case "Produces":
      case "ProducesProblem":
      case "ProducesValidationProblem": {
        const type = invocation.typeArguments.find((t) => t.kind !== "TypeParameter") ?? arg(args, "responseType")?.type;
        if (type) meta.producesTypes.push({ type, rule: `fluent:${method}` });
        meta.produces.push(...stringArgs(arg(args, "contentType")), ...stringArgs(arg(args, "additionalContentTypes")));
        break;
      }
      case "HasApiVersion":
      case "MapToApiVersion": {
        const version = apiVersionFrom(args);
        if (version) (method === "HasApiVersion" ? meta.apiVersions : meta.mappedVersions).push(version);
        break;
      }
      case "Accepts": {
        const type = invocation.typeArguments.find((t) => t.kind !== "TypeParameter") ?? arg(args, "requestType")?.type;
        if (type) meta.accepts.push({ type });
        meta.consumes.push(...stringArgs(arg(args, "contentType")), ...stringArgs(arg(args, "additionalContentTypes")));
        break;
      }
    }
  }
  return byTarget;
}

function httpMethods(value: ArgValue | undefined): string[] {
  if (!value) return ["*"];
  const literal = stringArgs(value);
  if (literal.length) return literal.map((m) => m.toUpperCase());
  const fromText = value.value?.match(/"(\w+)"/g)?.map((v) => v.replace(/"/g, "").toUpperCase());
  return fromText?.length ? fromText : ["*"];
}

export function minimalApiEndpoints(ctx: AnalysisContext, index: SemanticIndex, apps: ApplicationIndex, serviceKeys: Set<string>): EndpointSpec[] {
  const fluent = collectFluent(index);
  const groups = new Map<string, Group>();
  const repoId = ctx.repository.id;

  const groupFor = (receiver: ReceiverFact | undefined, entry: IndexedInvocation, depth = 0): Group | null => {
    const chain = receiverChain(receiver);
    const mapGroup = chain.find((r) => r.invocationTarget && r.location && methodName(r.invocationTarget) === "MapGroup");
    if (!mapGroup?.location) {
      const root = chain.at(-1);
      const caller = index.symbols.get(entry.invocation.caller)?.symbol;
      if (depth > 3 || !root || root.invocationTarget || root.expression !== caller?.parameters[0]?.name) return null;
      const isGroup = (r: ReceiverFact) => !!r.invocationTarget && methodName(r.invocationTarget) === "MapGroup";
      const sites = new Map<string, { receiver: ReceiverFact | undefined; entry: IndexedInvocation }>();
      for (const i of index.invocations) {
        if (i.invocation.target.key === entry.invocation.caller && receiverChain(i.invocation.receiver).some(isGroup)) sites.set(locationKey(i.invocation.location), { receiver: i.invocation.receiver, entry: i });
        for (const r of receiverChain(i.invocation.receiver)) {
          if (r.invocationTarget?.key === entry.invocation.caller && r.location && receiverChain(r.receiver).some(isGroup)) sites.set(locationKey(r.location), { receiver: r.receiver, entry: i });
        }
      }
      const [site] = sites.values();
      return sites.size === 1 ? groupFor(site!.receiver, site!.entry, depth + 1) : null;
    }
    const key = locationKey(mapGroup.location);
    const existing = groups.get(key);
    if (existing) return existing;
    const parent = groupFor(mapGroup.receiver, entry, depth);
    const prefixValue = constant(arg(mapGroup.invocationArguments ?? [], "prefix", 0));
    const prefix = joinRoute(parent?.prefix ?? null, prefixValue ?? "{dynamic}");
    const metadata = fluent.get(key) ?? emptyMetadata();
    const prov = frameworkProvenance(ctx, PLUGIN, "MINIMAL_API_ROUTE_GROUP", VERSION, mapGroup.location);
    const id = ctx.graph.entity({
      key: `route-group|${repoId}|${key}`,
      kind: "RouteGroup",
      layer: "application",
      name: prefix,
      qualifiedName: `${entry.project.name}:${prefix}`,
      repositoryId: repoId,
      projectId: entry.project.entityId,
      language: "csharp",
      location: { file: mapGroup.location.file, startLine: mapGroup.location.line, startColumn: mapGroup.location.column },
      metadata: { prefix, prefixResolved: prefixValue !== null && (parent?.resolved ?? true), tags: metadata.tags, authorization: metadata.authorization.map((a) => a.kind === "anonymous" ? "anonymous" : `authorize${a.policy ? `:${a.policy}` : ""}`) },
      provenance: prov,
    });
    if (parent) relate(ctx, "CONTAINS", parent.id, id, "COMPILER_RESOLVED", prov);
    for (const owner of apps.owners(entry.invocation.caller, entry.project)) relate(ctx, "CONTAINS", owner.app.entityId, id, owner.evidence, prov, { attribution: owner.attribution });
    if (prefixValue === null) {
      unresolvedFramework(ctx, PLUGIN, { type: "CONTAINS", sourceId: id, display: mapGroup.expression ?? "MapGroup", reason: "route group prefix is not a compile-time constant", category: "dynamic-route", location: mapGroup.location, version: VERSION });
    }
    const group: Group = { id, prefix, resolved: prefixValue !== null && (parent?.resolved ?? true), metadata, parent };
    groups.set(key, group);
    return group;
  };

  const specs: EndpointSpec[] = [];
  for (const entry of index.invocations) {
    const { invocation, owner, method, project } = entry;
    if (method === "MapGroup") {
      groupFor({ invocationTarget: invocation.target, invocationArguments: invocation.arguments, location: invocation.location, receiver: invocation.receiver }, entry);
      continue;
    }
    if (owner !== ROUTE_BUILDER) {
      const framework = frameworkEndpoint(entry);
      if (framework) specs.push({ ...framework, owners: apps.owners(invocation.caller, project), groupId: groupFor(invocation.receiver, entry)?.id ?? null });
      continue;
    }
    const verbBase = MAP_VERBS[method];
    if (!verbBase) continue;
    const callerId = entityIdOf(ctx, invocation.caller);
    const patternArg = arg(invocation.arguments, "pattern", 0);
    const pattern = constant(patternArg);
    if (pattern === null) {
      unresolvedFramework(ctx, PLUGIN, {
        type: "EXPOSES_ENDPOINT", sourceId: callerId, display: `${method}(${patternArg?.value ?? "?"})`, reason: "route pattern is not a compile-time constant",
        category: "dynamic-route", location: invocation.location, version: VERSION,
      });
      continue;
    }
    const group = groupFor(invocation.receiver, entry);
    const route = joinRoute(group?.prefix ?? null, pattern);
    const handler = invocation.arguments.find((a) => a.parameter === "handler" || a.parameter === "requestDelegate") ?? invocation.arguments.find((a) => a.kind === "lambda" || a.kind === "method");
    const resolved = resolveHandler(index, invocation, handler);
    const own = fluent.get(locationKey(invocation.location)) ?? emptyMetadata();
    const groupChain: Group[] = [];
    for (let g = group; g; g = g.parent) groupChain.push(g);
    const owners = apps.owners(invocation.caller, project);
    const handlerSymbol = resolved.handlerKind === "method" && resolved.handlerKey ? index.symbols.get(resolved.handlerKey)?.symbol : undefined;
    for (const verb of verbBase === "*" ? httpMethods(arg(invocation.arguments, "httpMethods")) : [verbBase]) {
      specs.push({
        verb,
        route,
        routeResolved: group?.resolved ?? true,
        framework: "aspnetcore-minimal",
        evidenceKind: "MINIMAL_API_MAPPING",
        evidence: "COMPILER_RESOLVED",
        project,
        owners,
        handlerKey: resolved.handlerKey,
        handlerKind: resolved.handlerKind,
        handlerDisplay: resolved.display,
        handlerLocation: resolved.location,
        discriminator: locationKey(invocation.location),
        controllerKey: null,
        groupId: group?.id ?? null,
        location: invocation.location,
        authorization: [
          ...groupChain.flatMap((g) => g.metadata.authorization.map((a) => ({ ...a, source: `group:${a.source}` }))),
          ...(handlerSymbol ? fromAttributes(handlerSymbol, "attribute:handler", handlerSymbol.location) : []),
          ...(handler?.kind === "lambda" ? fromAttributes({ attributes: handler.attributes ?? [] }, "attribute:lambda", handler.location) : []),
          ...own.authorization,
        ],
        parameters: [
          ...bindParameters(resolved.parameters, routeTokens(route), { minimal: true, apiController: false, serviceKeys }),
          ...own.accepts.map((a) => ({ name: "(Accepts)", source: "body" as const, type: a.type, explicit: true })),
        ],
        declaredReturn: resolved.returnType,
        producesTypes: [...groupChain.flatMap((g) => g.metadata.producesTypes), ...own.producesTypes],
        routeName: null,
        endpointName: own.name,
        tags: [...groupChain.flatMap((g) => g.metadata.tags), ...own.tags],
        produces: own.produces,
        consumes: own.consumes,
        apiVersions: own.mappedVersions.length ? own.mappedVersions : [...own.apiVersions, ...groupChain.flatMap((g) => g.metadata.apiVersions)],
      });
    }
  }
  return specs;
}

function frameworkEndpoint(entry: IndexedInvocation): Omit<EndpointSpec, "owners" | "groupId"> | null {
  const { invocation, owner, method, project } = entry;
  if (!owner?.endsWith("EndpointRouteBuilderExtensions") || !/^Map[A-Z]\w*$/.test(method) || /ControllerRoute$/.test(method) || !invocation.target.external) return null;
  const pattern = constant(invocation.arguments.find((a) => a.parameter === "pattern"));
  if (pattern === null) return null;
  const typeArg = invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
  return {
    verb: "ANY",
    route: joinRoute(null, pattern),
    routeResolved: true,
    framework: "aspnetcore-minimal",
    evidenceKind: "FRAMEWORK_ENDPOINT_MAPPING",
    evidence: "COMPILER_RESOLVED",
    project,
    handlerKey: null,
    handlerKind: "framework",
    handlerDisplay: `${owner.split(".").pop()}.${method}${typeArg ? `<${typeArg.display}>` : ""}`,
    discriminator: locationKey(invocation.location),
    controllerKey: null,
    location: invocation.location,
    authorization: [],
    parameters: [],
    producesTypes: [],
    routeName: null,
    endpointName: null,
    tags: [],
    produces: [],
    consumes: [],
    apiVersions: [],
  };
}

function resolveHandler(index: SemanticIndex, invocation: InvocationFact, handler: ArgValue | undefined): {
  handlerKey: string | null;
  handlerKind: EndpointSpec["handlerKind"];
  display: string;
  location?: FactLocation;
  parameters: BindableParameter[];
  returnType?: SymRef;
} {
  const caller = index.symbols.get(invocation.caller)?.symbol;
  if (handler?.kind === "method" && handler.symbol) {
    const symbol = index.symbols.get(handler.symbol.key)?.symbol;
    return {
      handlerKey: symbol ? symbol.key : null,
      handlerKind: symbol ? "method" : "unresolved",
      display: handler.symbol.qualifiedName,
      parameters: (symbol?.parameters ?? []).map((p) => ({ name: p.name, type: p.type, attributes: p.attributes })),
      returnType: symbol?.returnType,
    };
  }
  if (handler?.kind === "lambda") {
    const local = handler.value?.startsWith("local-function:") ? handler.value.slice("local-function:".length) : null;
    return {
      handlerKey: caller ? caller.key : null,
      handlerKind: local ? "local-function" : "lambda",
      display: `${local ? `local function ${local}` : "lambda"} in ${caller?.qualifiedName ?? invocation.caller}`,
      location: handler.location,
      parameters: (handler.items ?? []).map((p) => ({ name: p.name ?? "?", type: p.type, attributes: (p.items ?? []).flatMap((a) => (a.type ? [{ type: a.type }] : [])) })),
      returnType: handler.type,
    };
  }
  return { handlerKey: null, handlerKind: "unresolved", display: handler?.value ?? "(no handler argument)", parameters: [] };
}
