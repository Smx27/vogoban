import { keys } from "../../../graph/identity.ts";
import type { EvidenceLevel } from "../../../graph/model.ts";
import type { AnalysisContext } from "../../../plugins/types.ts";
import type { DotnetProject } from "../../artifacts.ts";
import type { FactLocation, SymRef } from "../../semantic-facts.ts";
import type { ApplicationModel } from "../applications.ts";
import { entityIdOf, frameworkProvenance, refs, relate, unresolvedFramework } from "../shared.ts";
import { authorizationEntity, effectiveAuthorization, type AuthRequirement } from "./authorization.ts";
import type { ParameterBinding } from "./binding.ts";
import { resolvePayload } from "./response-types.ts";

export const PLUGIN = "dotnet.aspnetcore";
export const VERSION = "2";

export type HandlerKind = "action" | "method" | "lambda" | "local-function" | "framework" | "unresolved";

export interface EndpointSpec {
  verb: string;
  route: string;
  routeResolved: boolean;
  framework: "aspnetcore-mvc" | "aspnetcore-minimal";
  evidenceKind: string;
  evidence: EvidenceLevel;
  project: DotnetProject;
  owners: { app: ApplicationModel; evidence: EvidenceLevel; attribution: string }[];
  handlerKey: string | null;
  handlerKind: HandlerKind;
  handlerDisplay: string;
  handlerLocation?: FactLocation;
  discriminator: string;
  controllerKey: string | null;
  groupId: string | null;
  location?: FactLocation;
  authorization: AuthRequirement[];
  parameters: ParameterBinding[];
  declaredReturn?: SymRef;
  producesTypes: { type: SymRef; rule: string }[];
  routeName: string | null;
  endpointName: string | null;
  tags: string[];
  produces: string[];
  consumes: string[];
  apiVersions: string[];
}

export function apiVersionFrom(args: { kind: string; value?: string; items?: { kind: string; value?: string }[] }[]): string | null {
  const scalar = args.filter((a) => a.kind === "number" || a.kind === "string").map((a) => a.value ?? "");
  const fromNew = args.find((a) => a.kind === "new")?.items?.filter((a) => a.kind === "number" || a.kind === "string").map((a) => a.value ?? "") ?? [];
  const parts = scalar.length ? scalar : fromNew;
  if (!parts.length) return null;
  const joined = parts.length >= 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!) ? `${parts[0]}.${parts[1]}` : parts[0]!;
  const match = /^v?(\d+)(?:\.(\d+))?/i.exec(joined);
  return match ? `${match[1]}.${match[2] ?? "0"}` : joined;
}

export function normalizeRoute(route: string): string {
  return `/${route.replace(/^~/, "").replace(/^\/+|\/+$/g, "")}`;
}

export function combineRoute(prefix: string | null, template: string | null): string {
  if (template && (template.startsWith("/") || template.startsWith("~/"))) return normalizeRoute(template);
  return normalizeRoute([prefix, template].filter((s) => s !== null && s !== "").map((s) => s!.replace(/^\/+|\/+$/g, "")).join("/"));
}

export function joinRoute(prefix: string | null, pattern: string): string {
  return normalizeRoute([prefix ?? "", pattern].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
}

export function routeShape(route: string): string {
  return route.toLowerCase().replace(/\{[^}]+\}/g, "{}");
}

export function emitEndpoint(ctx: AnalysisContext, spec: EndpointSpec, policies: Map<string, FactLocation>): string {
  const repoId = ctx.repository.id;
  const prov = frameworkProvenance(ctx, PLUGIN, spec.evidenceKind, VERSION, spec.location);
  const symbolRefs = refs(ctx, VERSION);
  const authorization = effectiveAuthorization(spec.authorization);
  const endpointId = ctx.graph.entity({
    key: keys.endpoint(repoId, spec.project.entityId, spec.verb, spec.route, spec.discriminator),
    kind: "Endpoint",
    layer: "application",
    name: `${spec.verb} ${spec.route}`,
    qualifiedName: `${spec.project.name}:${spec.verb} ${spec.route}`,
    repositoryId: repoId,
    projectId: spec.project.entityId,
    assembly: spec.project.assemblyName,
    language: "csharp",
    location: spec.location ? { file: spec.location.file, startLine: spec.location.line, startColumn: spec.location.column, endLine: spec.location.endLine, endColumn: spec.location.endColumn } : null,
    metadata: {
      verb: spec.verb,
      route: spec.route,
      routeShape: routeShape(spec.route),
      routeResolved: spec.routeResolved,
      framework: spec.framework,
      handler: spec.handlerDisplay,
      handlerKind: spec.handlerKind,
      handlerLocation: spec.handlerLocation ? `${spec.handlerLocation.file}:${spec.handlerLocation.line}` : null,
      authorization,
      authorizationSources: [...new Set(spec.authorization.map((a) => a.source))],
      parameters: spec.parameters.map((p) => `${p.name}:${p.source}${p.explicit ? "" : "?"}:${p.type?.display ?? "?"}`),
      declaredReturnType: spec.declaredReturn?.display ?? null,
      routeName: spec.routeName,
      endpointName: spec.endpointName,
      tags: spec.tags,
      produces: spec.produces,
      consumes: spec.consumes,
      apiVersions: [...new Set(spec.apiVersions)].sort(),
      applications: spec.owners.map((o) => o.app.project.name),
    },
    provenance: prov,
  });

  if (spec.handlerKey) {
    const handlerId = entityIdOf(ctx, spec.handlerKey);
    const handlerMeta = { handlerKind: spec.handlerKind, ...(spec.handlerLocation ? { lambdaLocation: `${spec.handlerLocation.file}:${spec.handlerLocation.line}:${spec.handlerLocation.column}` } : {}) };
    relate(ctx, "IMPLEMENTED_BY", endpointId, handlerId, spec.handlerKind === "lambda" || spec.handlerKind === "local-function" ? "STRUCTURALLY_RESOLVED" : "COMPILER_RESOLVED", prov, handlerMeta);
    relate(ctx, "ROUTES_TO", endpointId, handlerId, spec.evidence, prov, handlerMeta);
  } else if (spec.handlerKind !== "framework") {
    unresolvedFramework(ctx, PLUGIN, {
      type: "IMPLEMENTED_BY", sourceId: endpointId, display: spec.handlerDisplay, reason: "endpoint handler is not a statically resolvable method, lambda or local function",
      category: "unresolved-handler", location: spec.location, version: VERSION,
    });
  }
  if (!spec.routeResolved) {
    unresolvedFramework(ctx, PLUGIN, {
      type: "EXPOSES_ENDPOINT", sourceId: endpointId, display: spec.route, reason: "part of the route (group prefix or template) is not a compile-time constant",
      category: "dynamic-route", location: spec.location, version: VERSION,
    });
  }
  if (spec.controllerKey) relate(ctx, "EXPOSES_ENDPOINT", entityIdOf(ctx, spec.controllerKey), endpointId, spec.evidence, prov);
  if (spec.groupId) relate(ctx, "CONTAINS", spec.groupId, endpointId, "COMPILER_RESOLVED", prov);
  if (spec.owners.length) {
    for (const owner of spec.owners) relate(ctx, "EXPOSES_ENDPOINT", owner.app.entityId, endpointId, owner.evidence, prov, { attribution: owner.attribution });
  } else {
    relate(ctx, "EXPOSES_ENDPOINT", spec.project.entityId, endpointId, spec.evidence, prov, { attribution: "project-without-application" });
  }

  for (const p of spec.parameters) {
    if ((p.source !== "body" && p.source !== "form" && p.source !== "as-parameters") || !p.type) continue;
    for (const payload of resolvePayload(p.type, "parameter")) {
      const typeId = symbolRefs.ensureRef(payload.type, spec.location);
      if (typeId) {
        relate(ctx, "ACCEPTS_REQUEST", endpointId, typeId, p.explicit ? "COMPILER_RESOLVED" : "STRUCTURALLY_RESOLVED", prov, {
          parameter: p.name, bindingSource: p.source, rule: p.explicit ? "binding-attribute" : "binding-inference", collection: payload.collection,
        });
      }
    }
  }
  const responses = [
    ...resolvePayload(spec.declaredReturn).map((p) => ({ ...p, rule: `return-type:${p.rule}` })),
    ...spec.producesTypes.flatMap((t) => resolvePayload(t.type).map((p) => ({ ...p, rule: t.rule }))),
  ];
  for (const payload of responses) {
    const typeId = symbolRefs.ensureRef(payload.type, spec.location);
    if (typeId) relate(ctx, "PRODUCES_RESPONSE", endpointId, typeId, "COMPILER_RESOLVED", prov, { rule: payload.rule, collection: payload.collection });
  }
  for (const requirement of spec.authorization) {
    const authId = authorizationEntity(ctx, requirement, policies, PLUGIN, VERSION);
    relate(
      ctx,
      requirement.kind === "anonymous" ? "ALLOWS_ANONYMOUS" : "REQUIRES_AUTHORIZATION",
      endpointId,
      authId,
      requirement.source.startsWith("attribute") ? "COMPILER_RESOLVED" : "STRUCTURALLY_RESOLVED",
      frameworkProvenance(ctx, PLUGIN, requirement.source.startsWith("attribute") ? "AUTHORIZATION_ATTRIBUTE" : "AUTHORIZATION_CONVENTION", VERSION, requirement.location ?? spec.location),
      { source: requirement.source },
    );
  }
  return endpointId;
}
