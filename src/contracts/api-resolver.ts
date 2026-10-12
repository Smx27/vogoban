import type { Entity, EvidenceLevel, Provenance, Relationship } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { HTTP_CALLS, resolveUrl } from "./http-calls.ts";
import { OPENAPI_OPERATIONS } from "./openapi-plugin.ts";
import { normalizePath, normalizeVersion, pathVersion } from "./routes.ts";

const ID = "contracts.api-resolver";
const VERSION = "1";

interface OperationIndexEntry {
  id: string;
  apiId: string;
  provider: string;
  method: string;
  shape: string;
  version: string | null;
  source: "code" | "openapi";
}

const versionsMatch = (a: string | null, b: string | null) => !a || !b || normalizeVersion(a) === normalizeVersion(b);

export const apiResolverPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "resolver",
  async run(ctx: AnalysisContext) {
    const { graph } = ctx;
    const repoId = ctx.repository.id;
    const prov = (extractor: string, location: Entity["location"], resolver = ID): Provenance =>
      ctx.provenance({ plugin: ID, extractor, mechanism: "contract-resolution", resolver, version: VERSION, location });
    const relate = (type: Relationship["type"], sourceId: string, targetId: string, evidence: EvidenceLevel, provenance: Provenance, metadata: Relationship["metadata"] = {}) =>
      graph.relate({ type, sourceId, targetId, repositoryId: repoId, evidence, metadata, provenance });

    const entities = [...graph.allEntities()];
    const relationships = [...graph.allRelationships()];
    const byId = new Map(entities.map((e) => [e.id, e]));
    const endpoints = entities.filter((e) => e.kind === "Endpoint");
    const endpointOwners = new Map<string, Entity>();
    for (const r of relationships) {
      if (r.type !== "EXPOSES_ENDPOINT") continue;
      const source = byId.get(r.sourceId);
      if (source && (source.kind === "Application" || (source.kind === "Project" && !endpointOwners.has(r.targetId)))) endpointOwners.set(r.targetId, source);
    }
    const endpointPayloads = new Map<string, Relationship[]>();
    for (const r of relationships) {
      if ((r.type === "ACCEPTS_REQUEST" || r.type === "PRODUCES_RESPONSE") && byId.get(r.sourceId)?.kind === "Endpoint") {
        endpointPayloads.set(r.sourceId, [...(endpointPayloads.get(r.sourceId) ?? []), r]);
      }
    }

    const operations: OperationIndexEntry[] = [];
    const byRoute = new Map<string, OperationIndexEntry[]>();
    const bySegments = new Map<string, OperationIndexEntry[]>();
    const index = (entry: OperationIndexEntry) => {
      operations.push(entry);
      const key = `${entry.method}|${entry.shape}`;
      byRoute.set(key, [...(byRoute.get(key) ?? []), entry]);
      const segmentKey = `${entry.method}|${entry.shape.split("/").length}`;
      bySegments.set(segmentKey, [...(bySegments.get(segmentKey) ?? []), entry]);
    };
    const templateMatches = (method: string, shape: string): OperationIndexEntry[] => {
      const segments = shape.split("/");
      return [method, "ANY"].flatMap((m) => bySegments.get(`${m}|${segments.length}`) ?? []).filter((op) => {
        const opSegments = op.shape.split("/");
        return opSegments.every((s, i) => s === segments[i] || (s === "{}" && segments[i] !== ""));
      });
    };

    for (const endpoint of endpoints.sort((a, b) => a.id.localeCompare(b.id))) {
      const owner = endpointOwners.get(endpoint.id);
      const ownerName = owner?.name ?? "unattributed";
      const route = String(endpoint.metadata.route);
      const { display, shape } = normalizePath(route);
      const method = String(endpoint.metadata.verb);
      const declared = (endpoint.metadata.apiVersions as string[] | undefined) ?? [];
      const versions = declared.length ? declared : [pathVersion(display)];
      const apiKey = `api|${repoId}|code|${owner?.key ?? "unattributed"}`;
      const location = endpoint.location;
      const apiId = graph.entity({
        key: apiKey,
        kind: "Api",
        layer: "contract",
        name: `${ownerName} API`,
        qualifiedName: `${ownerName} (code-first)`,
        repositoryId: repoId,
        projectId: endpoint.projectId,
        metadata: { contractSource: "aspnetcore-code", provider: ownerName },
        provenance: prov("CODE_FIRST_API", null),
      });
      if (owner) relate("CONTAINS", owner.id, apiId, "STRUCTURALLY_RESOLVED", prov("CODE_FIRST_API", null), { role: "api-provider" });
      for (const version of versions) {
        const opProv = prov("CODE_FIRST_OPERATION", location);
        const opId = graph.entity({
          key: `api-operation|${apiKey}|${method}|${shape}|${version ?? ""}`,
          kind: "ApiOperation",
          layer: "contract",
          name: `${method} ${display}`,
          qualifiedName: `${ownerName}${version ? ` v${version}` : ""}:${method} ${display}`,
          repositoryId: repoId,
          projectId: endpoint.projectId,
          location,
          metadata: {
            contractSource: "aspnetcore-code",
            method,
            path: display,
            routeShape: shape,
            version,
            versionSource: declared.length ? "api-versioning" : version ? "path-segment" : null,
            operationId: (endpoint.metadata.endpointName as string | null) ?? (endpoint.metadata.routeName as string | null) ?? null,
            tags: (endpoint.metadata.tags as string[] | undefined) ?? [],
            parameters: ((endpoint.metadata.parameters as string[] | undefined) ?? []).filter((p) => !/:(services|keyed-services|cancellation|http-context)\??:/.test(p)),
            security: [String(endpoint.metadata.authorization ?? "none-declared")],
            implementationStatus: "implemented",
          },
          provenance: opProv,
        });
        relate("CONTAINS", apiId, opId, "EXACT", opProv);
        relate("IMPLEMENTED_BY", opId, endpoint.id, "EXACT", opProv, { matchStage: "code-first" });
        for (const payload of endpointPayloads.get(endpoint.id) ?? []) {
          relate(payload.type, opId, payload.targetId, payload.evidence, opProv, { ...payload.metadata, derivedFrom: endpoint.id });
        }
        index({ id: opId, apiId, provider: owner?.id ?? "unattributed", method, shape, version, source: "code" });
      }
    }

    const endpointsByRoute = new Map<string, Entity[]>();
    for (const e of endpoints) {
      const key = `${String(e.metadata.verb)}|${normalizePath(String(e.metadata.route)).shape}`;
      endpointsByRoute.set(key, [...(endpointsByRoute.get(key) ?? []), e]);
    }
    const documented = new Set<string>();
    for (const record of ctx.artifacts.get(OPENAPI_OPERATIONS) ?? []) {
      const op = byId.get(record.entityId) ?? graph.get(record.entityId);
      if (!op) continue;
      const shapes = record.basePaths.length ? record.basePaths.map((b) => normalizePath(`${b}/${record.path}`).shape) : [record.shape];
      const candidates = shapes
        .flatMap((shape) => [...(endpointsByRoute.get(`${record.method}|${shape}`) ?? []), ...(endpointsByRoute.get(`ANY|${shape}`) ?? [])])
        .filter((e) => {
          const versions = (e.metadata.apiVersions as string[] | undefined) ?? [];
          return !versions.length || !record.version || versions.some((v) => versionsMatch(v, record.version));
        });
      const byOperationId = record.operationId ? candidates.filter((e) => e.metadata.endpointName === record.operationId || e.metadata.routeName === record.operationId) : [];
      const matches = byOperationId.length ? byOperationId : candidates;
      const providers = new Set<string>();
      const providerIds = new Set<string>();
      for (const endpoint of [...new Set(matches)]) {
        documented.add(endpoint.id);
        const owner = endpointOwners.get(endpoint.id);
        if (owner) {
          providers.add(owner.name);
          providerIds.add(owner.id);
        }
        relate("IMPLEMENTED_BY", record.entityId, endpoint.id, "STRUCTURALLY_RESOLVED", prov(byOperationId.length ? "OPERATION_ID_AND_ROUTE_MATCH" : "METHOD_AND_ROUTE_MATCH", op.location), {
          matchStage: byOperationId.length ? "operation-id+method+route" : "method+normalized-route",
          versionChecked: record.version !== null,
        });
      }
      graph.annotate(record.entityId, { implementationStatus: matches.length ? "implemented" : "unresolved", providers: [...providers].sort() }, prov("IMPLEMENTATION_STATUS", op.location));
      if (!matches.length) {
        graph.unresolved({
          type: "IMPLEMENTED_BY", sourceId: record.entityId, repositoryId: repoId, targetDisplay: `${record.method} ${record.path}`, resolver: ID,
          reason: `no ASP.NET endpoint with the same method and route${record.version ? ` for version ${record.version}` : ""} exists in this repository`,
          metadata: { category: "unimplemented-operation", implementationStatus: "UNRESOLVED" }, provenance: prov("IMPLEMENTATION_STATUS", op.location),
        });
      }
      index({ id: record.entityId, apiId: record.apiEntityId, provider: [...providerIds].sort().join(",") || `openapi:${record.apiEntityId}`, method: record.method, shape: shapes[0]!, version: record.version, source: "openapi" });
    }
    for (const endpoint of endpoints) graph.annotate(endpoint.id, { openApiDocumented: documented.has(endpoint.id) }, prov("OPENAPI_COVERAGE", endpoint.location));

    let resolved = 0;
    let external = 0;
    let unresolved = 0;
    for (const call of ctx.artifacts.get(HTTP_CALLS) ?? []) {
      const location = { file: call.location.file, startLine: call.location.line, startColumn: call.location.column };
      const callProv = prov("HTTP_CLIENT_CALL", location);
      const meta = { api: call.api, verb: call.verb, url: call.url, client: call.clientEntityId, requestType: call.requestType, responseType: call.responseType, configurationKey: call.configurationKey, baseAddress: call.baseAddress, baseConfigurationKey: call.baseConfigurationKey, applications: call.applications, ...(call.details ?? {}) };
      const fail = (category: string, reason: string, display: string) => {
        unresolved++;
        graph.unresolved({ type: "CALLS_ENDPOINT", sourceId: call.callerEntityId, repositoryId: repoId, targetDisplay: display, resolver: ID, reason, metadata: { category, ...meta }, provenance: callProv });
      };
      if (!call.url) {
        fail(call.urlKind === "configuration" ? "configured-url" : "dynamic-url", call.urlKind === "configuration" ? `URL comes from configuration key ${call.configurationKey ?? "(dynamic)"}` : "request URL is not statically determinable", `${call.verb ?? "?"} (dynamic URL)`);
        continue;
      }
      if (call.url.startsWith("{")) {
        fail("dynamic-url", "URL prefix (host or base path) is not statically determinable", call.url);
        continue;
      }
      if (!call.verb) {
        fail("dynamic-method", "HTTP method is not statically determinable", call.url);
        continue;
      }
      const target = resolveUrl(call.baseAddress, call.url);
      if (!target) {
        fail("dynamic-url", "URL could not be parsed", call.url);
        continue;
      }
      const display = `${call.verb} ${target.host ? `${target.scheme}://${target.host}` : ""}${target.path}`;
      if (target.host && !target.logicalHost && target.host !== "localhost") {
        external++;
        const externalId = graph.entity({
          key: `external-api|${target.host.toLowerCase()}`,
          kind: "ExternalApi",
          layer: "contract",
          name: target.host.toLowerCase(),
          qualifiedName: `${target.scheme}://${target.host.toLowerCase()}`,
          repositoryId: null,
          external: true,
          metadata: { host: target.host.toLowerCase() },
          provenance: callProv,
        });
        relate("CALLS_EXTERNAL_API", call.callerEntityId, externalId, "COMPILER_RESOLVED", callProv, { ...meta, path: target.path });
        for (const app of call.applications) relate("CALLS_EXTERNAL_API", app, externalId, "STRUCTURALLY_RESOLVED", callProv, { via: call.callerDisplay });
        continue;
      }
      const shape = normalizePath(target.path).shape;
      const exact = [...(byRoute.get(`${call.verb}|${shape}`) ?? []), ...(byRoute.get(`ANY|${shape}`) ?? [])];
      const candidates = exact.length ? exact : templateMatches(call.verb, shape);
      const providers = new Set(candidates.map((c) => c.provider));
      if (!candidates.length) {
        fail("no-matching-operation", target.logicalHost ? `no API operation in this repository matches ${display} (service-discovery host '${target.host}')` : `no API operation in this repository matches ${display}`, display);
        continue;
      }
      if (providers.size > 1) {
        fail("ambiguous-operation", `${providers.size} different providers expose ${call.verb} ${target.path}`, display);
        continue;
      }
      resolved++;
      const versions = new Set(candidates.map((c) => c.version));
      for (const candidate of candidates) {
        relate("CALLS_ENDPOINT", call.callerEntityId, candidate.id, "INFERRED", callProv, {
          ...meta,
          matchStage: exact.length ? "method+normalized-route (single provider in repository)" : "method+route-template (single provider in repository)",
          host: target.host,
          versionAmbiguous: versions.size > 1,
        });
      }
    }
    ctx.log.info("contracts.api-resolution", { operations: operations.length, documentedEndpoints: documented.size, httpCallsResolved: resolved, external, unresolved });
  },
};
