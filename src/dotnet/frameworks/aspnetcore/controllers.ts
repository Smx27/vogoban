import type { EvidenceLevel } from "../../../graph/model.ts";
import type { AnalysisContext } from "../../../plugins/types.ts";
import type { SymRef, SymbolFact } from "../../semantic-facts.ts";
import type { ApplicationIndex } from "../applications.ts";
import { arg, attr, attrValue, constant, entityIdOf, methodName, frameworkProvenance, receiverChain, stringArgs, stripGenerics, unresolvedFramework, type SemanticIndex } from "../shared.ts";
import { fromAttributes, fromRequireAuthorization, type AuthRequirement } from "./authorization.ts";
import { bindParameters, routeTokens } from "./binding.ts";
import { apiVersionFrom, combineRoute, PLUGIN, VERSION, type EndpointSpec } from "./endpoints.ts";

const CONTROLLER_BASES = ["Microsoft.AspNetCore.Mvc.ControllerBase", "Microsoft.AspNetCore.Mvc.Controller"];
const ROUTE = "Microsoft.AspNetCore.Mvc.RouteAttribute";
const HTTP_VERBS: Record<string, string> = {
  "Microsoft.AspNetCore.Mvc.HttpGetAttribute": "GET",
  "Microsoft.AspNetCore.Mvc.HttpPostAttribute": "POST",
  "Microsoft.AspNetCore.Mvc.HttpPutAttribute": "PUT",
  "Microsoft.AspNetCore.Mvc.HttpDeleteAttribute": "DELETE",
  "Microsoft.AspNetCore.Mvc.HttpPatchAttribute": "PATCH",
  "Microsoft.AspNetCore.Mvc.HttpHeadAttribute": "HEAD",
  "Microsoft.AspNetCore.Mvc.HttpOptionsAttribute": "OPTIONS",
};
const ACCEPT_VERBS = "Microsoft.AspNetCore.Mvc.AcceptVerbsAttribute";

interface ConventionalRoute {
  template: string;
  appId: string;
}

function signature(method: SymbolFact): string {
  return `${method.name}(${method.parameters.map((p) => p.typeDisplay).join(",")})`;
}

function conventionalRoutes(index: SemanticIndex, apps: ApplicationIndex): ConventionalRoute[] {
  const routes: ConventionalRoute[] = [];
  for (const { invocation, project, method } of index.invocations) {
    if (method !== "MapControllerRoute" && method !== "MapDefaultControllerRoute" && method !== "MapAreaControllerRoute") continue;
    const template = method === "MapDefaultControllerRoute" ? "{controller=Home}/{action=Index}/{id?}" : constant(arg(invocation.arguments, "pattern"));
    if (!template) continue;
    for (const owner of apps.owners(invocation.caller, project)) routes.push({ template, appId: owner.app.entityId });
  }
  return routes;
}

function applyConvention(template: string, controller: string, action: string, area: string | null): string | null {
  let route = template
    .replace(/\{controller(=[^}]*)?\}/gi, controller)
    .replace(/\{action(=[^}]*)?\}/gi, action);
  if (/\{area(:[^}=]*)?(=[^}]*)?\}/i.test(route)) {
    if (!area) return null;
    route = route.replace(/\{area(:[^}=]*)?(=[^}]*)?\}/gi, area);
  } else if (area) {
    return null;
  }
  return route.replace(/\{([A-Za-z_]\w*)[^}]*\?\}\/?/g, "{$1?}");
}

export function controllerEndpoints(ctx: AnalysisContext, index: SemanticIndex, apps: ApplicationIndex, serviceKeys: Set<string>): EndpointSpec[] {
  const specs: EndpointSpec[] = [];
  const conventions = conventionalRoutes(index, apps);
  const conventionAuth = new Map<string, AuthRequirement[]>();
  for (const { invocation, project, method } of index.invocations) {
    if (method !== "RequireAuthorization" && method !== "AllowAnonymous") continue;
    const target = receiverChain(invocation.receiver).find((r) => r.invocationTarget && /^Map(Controllers|ControllerRoute|DefaultControllerRoute|AreaControllerRoute)$/.test(methodName(r.invocationTarget)));
    if (!target) continue;
    const reqs = method === "AllowAnonymous"
      ? [{ kind: "anonymous" as const, policy: null, roles: null, schemes: null, source: "convention:MapControllers", location: invocation.location }]
      : fromRequireAuthorization(invocation.arguments, "convention:MapControllers", invocation.location);
    for (const owner of apps.owners(invocation.caller, project)) conventionAuth.set(owner.app.entityId, [...(conventionAuth.get(owner.app.entityId) ?? []), ...reqs]);
  }

  for (const { symbol: type, project } of index.symbols.values()) {
    if (!["Class", "Record"].includes(type.kind) || type.accessibility !== "Public" || type.modifiers.includes("abstract") || type.arity > 0) continue;
    const ancestors = type.baseTypeChain.map((name) => index.symbolsByQualifiedName.get(name)).filter((s): s is SymbolFact => !!s);
    const inherited = [type, ...ancestors];
    if (inherited.some((t) => attr(t, "Microsoft.AspNetCore.Mvc.NonControllerAttribute").length)) continue;
    const derives = type.baseTypeChain.some((b) => CONTROLLER_BASES.includes(b));
    const attributed = inherited.some((t) => attr(t, "Microsoft.AspNetCore.Mvc.ControllerAttribute", "Microsoft.AspNetCore.Mvc.ApiControllerAttribute").length > 0);
    const ownMembers = index.members.get(type.key) ?? [];
    const routedBySuffix = !derives && !attributed && type.name.endsWith("Controller") &&
      (attr(type, ROUTE).length > 0 || ownMembers.some((m) => m.attributes.some((a) => HTTP_VERBS[stripGenerics(a.type.qualifiedName)])));
    if (!derives && !attributed && !routedBySuffix) continue;
    const controllerEvidence: EvidenceLevel = routedBySuffix ? "INFERRED" : "COMPILER_RESOLVED";
    const rule = derives ? "derives-from-ControllerBase" : attributed ? "controller-attribute" : "name-suffix-with-routing-attributes";
    const apiController = inherited.some((t) => attr(t, "Microsoft.AspNetCore.Mvc.ApiControllerAttribute").length > 0);
    const controllerId = entityIdOf(ctx, type.key);
    ctx.graph.annotate(controllerId, { frameworkRole: "aspnetcore-controller", controllerRule: rule, apiController }, frameworkProvenance(ctx, PLUGIN, "CONTROLLER_DETECTED", VERSION, type.location));

    const controllerName = type.name.replace(/Controller$/, "");
    const area = inherited.flatMap((t) => attr(t, "Microsoft.AspNetCore.Mvc.AreaAttribute")).map((a) => attrValue(a, "RouteValue", 0)).find(Boolean) ?? null;
    const routeSource = inherited.find((t) => attr(t, ROUTE).length > 0);
    const prefixes = routeSource ? attr(routeSource, ROUTE).map((a) => ({ template: attrValue(a, "Template", 0) ?? "", name: attrValue(a, "Name") })) : [];
    const controllerAuth = inherited.flatMap((t, i) => fromAttributes(t, i === 0 ? "attribute:controller" : "attribute:base-controller", t.location));
    const controllerTags = inherited.flatMap((t) => attr(t, "Microsoft.AspNetCore.Http.TagsAttribute")).flatMap((a) => a.arguments.flatMap(stringArgs));
    const controllerProduces = inherited.flatMap((t) => attr(t, "Microsoft.AspNetCore.Mvc.ProducesAttribute")).flatMap((a) => a.arguments.filter((x) => x.kind === "string").map((x) => x.value!));
    const controllerConsumes = inherited.flatMap((t) => attr(t, "Microsoft.AspNetCore.Mvc.ConsumesAttribute")).flatMap((a) => a.arguments.filter((x) => x.kind === "string").map((x) => x.value!));

    const ownSignatures = new Set(ownMembers.filter((m) => m.kind === "Method").map(signature));
    const actions = [
      ...ownMembers,
      ...ancestors.flatMap((a) => (index.members.get(a.key) ?? []).filter((m) => !ownSignatures.has(signature(m)))),
    ].filter((m) => m.kind === "Method" && m.accessibility === "Public" && !m.modifiers.includes("static") && !m.modifiers.includes("abstract") && !attr(m, "Microsoft.AspNetCore.Mvc.NonActionAttribute").length);

    for (const action of actions) {
      const actionName = attrValue(attr(action, "Microsoft.AspNetCore.Mvc.ActionNameAttribute")[0] ?? { arguments: [] }, "Name", 0) ?? action.name.replace(/Async$/, "");
      const verbs: { verb: string; template: string | null; name: string | null; evidenceKind: string }[] = [];
      for (const a of action.attributes) {
        const verb = HTTP_VERBS[stripGenerics(a.type.qualifiedName)];
        if (verb) verbs.push({ verb, template: attrValue(a, "Template", 0), name: attrValue(a, "Name"), evidenceKind: `HTTP_${verb}_ATTRIBUTE` });
      }
      for (const a of attr(action, ACCEPT_VERBS)) {
        const methods = a.arguments.filter((x) => !x.name).flatMap(stringArgs);
        for (const verb of methods) verbs.push({ verb: verb.toUpperCase(), template: attrValue(a, "Route"), name: attrValue(a, "Name"), evidenceKind: "ACCEPT_VERBS_ATTRIBUTE" });
      }
      const actionRoutes = attr(action, ROUTE).map((a) => ({ template: attrValue(a, "Template", 0), name: attrValue(a, "Name") }));
      if (!verbs.length) for (const r of actionRoutes) verbs.push({ verb: "ANY", template: r.template, name: r.name, evidenceKind: "ROUTE_ATTRIBUTE" });
      else if (actionRoutes.length) for (const v of verbs) if (v.template === null) (v.template = actionRoutes[0]!.template), (v.name ??= actionRoutes[0]!.name);

      const attributeRouted = prefixes.length > 0 || verbs.some((v) => v.template !== null);
      const routes: { route: string; verb: string; name: string | null; evidenceKind: string; evidence: EvidenceLevel; apps: string[] | null }[] = [];
      const substitute = (route: string) => route.replace(/\[controller\]/gi, controllerName).replace(/\[action\]/gi, actionName).replace(/\[area\]/gi, area ?? "[area]");
      if (attributeRouted) {
        for (const prefix of prefixes.length ? prefixes : [{ template: "", name: null }]) {
          for (const v of verbs.length ? verbs : []) {
            routes.push({ route: substitute(combineRoute(prefix.template, v.template)), verb: v.verb, name: v.name ?? prefix.name, evidenceKind: v.evidenceKind, evidence: "STRUCTURALLY_RESOLVED", apps: null });
          }
        }
      } else if (!apiController) {
        const owners = apps.owners(action.key, project).map((o) => o.app.entityId);
        const applicable = conventions.filter((c) => owners.includes(c.appId));
        for (const c of applicable) {
          const route = applyConvention(c.template, controllerName, actionName, area);
          if (!route) continue;
          for (const v of verbs.length ? verbs : [{ verb: "ANY", template: null, name: null, evidenceKind: "CONVENTIONAL_ROUTE" }]) {
            routes.push({ route: combineRoute(null, route), verb: v.verb, name: v.name, evidenceKind: "CONVENTIONAL_ROUTE", evidence: "STRUCTURALLY_RESOLVED", apps: [c.appId] });
          }
        }
        if (!applicable.length && verbs.length) {
          unresolvedFramework(ctx, PLUGIN, {
            type: "EXPOSES_ENDPOINT", sourceId: entityIdOf(ctx, action.key), display: `${controllerName}.${actionName}`,
            reason: "action has no attribute route and no conventional route template was found for its application", category: "conventional-route-unknown",
            location: action.location, version: VERSION,
          });
        }
      }
      if (!routes.length) continue;

      const producesTypes: { type: SymRef; rule: string }[] = [];
      for (const a of attr(action, "Microsoft.AspNetCore.Mvc.ProducesResponseTypeAttribute", "Microsoft.AspNetCore.Mvc.ProducesAttribute")) {
        const typeArg = a.arguments.find((x) => x.kind === "type")?.type ?? a.type.typeArguments?.[0];
        if (typeArg) producesTypes.push({ type: typeArg, rule: "produces-attribute" });
      }
      const allOwners = apps.owners(action.key, project);
      for (const r of routes) {
        const owners = r.apps ? allOwners.filter((o) => r.apps!.includes(o.app.entityId)) : allOwners;
        specs.push({
          verb: r.verb,
          route: r.route,
          routeResolved: !r.route.includes("[area]"),
          framework: "aspnetcore-mvc",
          evidenceKind: r.evidenceKind,
          evidence: controllerEvidence === "INFERRED" ? "INFERRED" : r.evidence,
          project,
          owners,
          handlerKey: action.key,
          handlerKind: "action",
          handlerDisplay: action.qualifiedName,
          discriminator: `${type.key}|${action.key}`,
          controllerKey: type.key,
          groupId: null,
          location: action.location,
          authorization: [
            ...controllerAuth,
            ...fromAttributes(action, "attribute:action", action.location),
            ...owners.flatMap((o) => conventionAuth.get(o.app.entityId) ?? []),
          ],
          parameters: bindParameters(
            action.parameters.map((p) => ({ name: p.name, type: p.type, attributes: p.attributes })),
            routeTokens(r.route),
            { minimal: false, apiController, serviceKeys },
          ),
          declaredReturn: action.returnType,
          producesTypes,
          routeName: r.name,
          endpointName: null,
          tags: [...controllerTags, ...attr(action, "Microsoft.AspNetCore.Http.TagsAttribute").flatMap((a) => a.arguments.flatMap(stringArgs))],
          produces: [...controllerProduces, ...attr(action, "Microsoft.AspNetCore.Mvc.ProducesAttribute").flatMap((a) => a.arguments.filter((x) => x.kind === "string").map((x) => x.value!))],
          apiVersions: (() => {
            const mapped = attr(action, "Asp.Versioning.MapToApiVersionAttribute").map((a) => apiVersionFrom(a.arguments)).filter((v): v is string => !!v);
            return mapped.length ? mapped : inherited.flatMap((t) => attr(t, "Asp.Versioning.ApiVersionAttribute", "Microsoft.AspNetCore.Mvc.ApiVersionAttribute")).concat(attr(action, "Asp.Versioning.ApiVersionAttribute", "Microsoft.AspNetCore.Mvc.ApiVersionAttribute")).map((a) => apiVersionFrom(a.arguments)).filter((v): v is string => !!v);
          })(),
          consumes: [...controllerConsumes, ...attr(action, "Microsoft.AspNetCore.Mvc.ConsumesAttribute").flatMap((a) => a.arguments.filter((x) => x.kind === "string").map((x) => x.value!))],
        });
      }
    }
  }
  return specs;
}
