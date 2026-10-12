import { normalizePath } from "../contracts/routes.ts";
import type { Provenance } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import type { MetaEmitter, RepoView } from "./emitter.ts";
import { collectInfrastructure, composeHostIndex, hostIndex, resolveOwnership, type HostTarget, type InfraInputs } from "./infrastructure.ts";
import { facts, hostOf, isFqdn, isPlaceholderHost, links, str, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

export interface ConsumerCall {
  sourceId: string;
  verb: string | null;
  url: string | null;
  category: string;
  baseAddress: string | null;
  configurationKeys: string[];
  requestType: string | null;
  responseType: string | null;
  provenance: Provenance[];
}

export interface ConfigUrl {
  id: string;
  key: string;
  value: string | null;
  valueKind: string;
  environment: string | null;
  provenance: Provenance[];
}

export interface ApiInputs {
  infra: InfraInputs;
  applications: string[];
  apis: Fact[];
  operations: Fact[];
  contains: Link[];
  implemented: string[];
  payloads: { operationId: string; type: string; assembly: string | null }[];
  calls: ConsumerCall[];
  configUrls: ConfigUrl[];
  packageNames: string[];
}

const configKey = (k: string) => k.replace(/__/g, ":").toLowerCase();

export function collectConfigUrls(store: GraphStore, repositoryId: string): ConfigUrl[] {
  return facts(store, repositoryId, ["Configuration", "EnvironmentVariable"])
    .filter((c) => c.metadata.valueKind === "url" || (c.metadata.valueKind === "parameterized" && /(url|uri|endpoint|host|address)$/i.test(c.name)))
    .map((c) => ({ id: c.id, key: c.name, value: str(c.metadata.value), valueKind: String(c.metadata.valueKind), environment: str(c.metadata.environment), provenance: c.provenance }));
}

function shapeSegments(shape: string) {
  return shape.split("/");
}

export const apiResolver: CrossRepositoryResolver<ApiInputs> = {
  id: "apis",
  version: "1",
  category: "api",
  collect(store: GraphStore, repo: RepoView): ApiInputs {
    const repoId = repo.entry.repositoryId;
    const operations = facts(store, repoId, ["ApiOperation"]);
    const opIds = new Set(operations.map((o) => o.id));
    const payloadLinks = links(store, repoId, ["ACCEPTS_REQUEST", "PRODUCES_RESPONSE"]).filter((l) => opIds.has(l.sourceId));
    const payloadTypes = new Map(store.findEntities({ ids: [...new Set(payloadLinks.map((l) => l.targetId))] }).map((e) => [e.id, e]));
    const unresolvedCalls = store.findUnresolved({ repositoryId: repoId }).filter((u) => u.type === "CALLS_ENDPOINT");
    const externalCalls = links(store, repoId, ["CALLS_EXTERNAL_API"]).filter((l) => l.metadata.verb !== undefined);
    const externalHosts = new Map(store.findEntities({ ids: [...new Set(externalCalls.map((l) => l.targetId))] }).map((e) => [e.id, e.qualifiedName]));
    const deps = links(store, repoId, ["PACKAGE_DEPENDS_ON"]);
    return {
      infra: collectInfrastructure(store, repoId),
      applications: store.findEntities({ kinds: ["Application"], repositoryId: repoId }).map((a) => a.id).sort(),
      apis: facts(store, repoId, ["Api"]),
      operations,
      contains: links(store, repoId, ["CONTAINS"]).filter((l) => opIds.has(l.targetId) || l.metadata.role === "api-provider"),
      implemented: [...new Set(links(store, repoId, ["IMPLEMENTED_BY"]).filter((l) => opIds.has(l.sourceId)).map((l) => l.sourceId))].sort(),
      payloads: payloadLinks.flatMap((l) => {
        const t = payloadTypes.get(l.targetId);
        return t ? [{ operationId: l.sourceId, type: (t.qualifiedName ?? t.name).replace(/\(.*$/, ""), assembly: t.assembly }] : [];
      }),
      calls: [
        ...unresolvedCalls.map((u) => ({
          sourceId: u.sourceId, verb: str(u.metadata.verb), url: str(u.metadata.url), category: String(u.metadata.category ?? ""), baseAddress: str(u.metadata.baseAddress),
          configurationKeys: [str(u.metadata.configurationKey), str(u.metadata.baseConfigurationKey)].filter((k): k is string => !!k), requestType: str(u.metadata.requestType), responseType: str(u.metadata.responseType), provenance: u.provenance.slice(0, 2),
        })),
        ...externalCalls.map((l) => ({
          sourceId: l.sourceId, verb: str(l.metadata.verb), url: `${externalHosts.get(l.targetId) ?? ""}${str(l.metadata.path) ?? ""}`, category: "external-host", baseAddress: null,
          configurationKeys: [], requestType: str(l.metadata.requestType), responseType: str(l.metadata.responseType), provenance: l.provenance,
        })),
      ],
      configUrls: collectConfigUrls(store, repoId),
      packageNames: [...new Set(store.findEntities({ ids: [...new Set(deps.map((d) => d.targetId))] }).map((p) => p.name.toLowerCase()))].sort(),
    };
  },
  resolve(inputs, emit: MetaEmitter) {
    const infra = new Map([...inputs].map(([r, i]) => [r, i.infra]));
    const appIds = new Set([...inputs.values()].flatMap((i) => i.applications));
    const ownership = resolveOwnership(infra, appIds);
    const hosts = hostIndex(infra, ownership, composeHostIndex(infra));

    interface Op { repoId: string; op: Fact; apiId: string | null; ownerApp: string | null; shape: string; method: string }
    const ops: Op[] = [];
    for (const [repoId, input] of inputs) {
      const apiOf = new Map(input.contains.filter((c) => input.operations.some((o) => o.id === c.targetId)).map((c) => [c.targetId, c.sourceId]));
      const ownerOf = new Map(input.contains.filter((c) => c.metadata.role === "api-provider").map((c) => [c.targetId, c.sourceId]));
      for (const op of input.operations) {
        const apiId = apiOf.get(op.id) ?? null;
        ops.push({ repoId, op, apiId, ownerApp: apiId ? (ownerOf.get(apiId) ?? null) : null, shape: String(op.metadata.routeShape ?? normalizePath(String(op.metadata.path ?? "")).shape), method: String(op.metadata.method ?? "").toUpperCase() });
      }
      for (const api of input.apis) {
        const apiOps = input.operations.filter((o) => apiOf.get(o.id) === api.id);
        const implemented = apiOps.some((o) => input.implemented.includes(o.id));
        emit.relate({
          type: "PROVIDES_API", source: emit.repositoryEntity(repoId), target: { id: api.id, repositoryId: repoId, provenance: api.provenance }, evidence: implemented ? "EXACT" : "DECLARED", confidence: 1,
          evidenceKinds: [implemented ? "endpoint-implementation" : "api-contract-document"], extractor: "API_PROVIDER", metadata: { contractSource: str(api.metadata.contractSource), operations: apiOps.length, provider: str(api.metadata.provider) },
        });
      }
    }
    const bySegments = new Map<string, Op[]>();
    for (const o of ops) {
      const key = `${o.method}|${shapeSegments(o.shape).length}`;
      bySegments.set(key, [...(bySegments.get(key) ?? []), o]);
    }
    const matchOps = (method: string, shape: string) => {
      const segs = shapeSegments(shape);
      return [method, "ANY"].flatMap((m) => bySegments.get(`${m}|${segs.length}`) ?? []).filter((o) => shapeSegments(o.shape).every((s, i) => s === segs[i] || (s === "{}" && segs[i] !== "")));
    };
    const envCompatible = (a: string | null, b: string | null) => !a || !b || a.toLowerCase() === b.toLowerCase();

    const repoLink = (from: string, to: string, kinds: string[], confidence: number, environment: string | null, via: string, provenance: Provenance[]) =>
      emit.relate({ type: "CALLS_REPOSITORY", source: { ...emit.repositoryEntity(from), provenance }, target: emit.repositoryEntity(to), evidence: "STRUCTURALLY_RESOLVED", confidence, evidenceKinds: kinds, extractor: "REPOSITORY_CALL", environment, metadata: { via: [via] } });

    const resolveHost = (host: string, callerRepo: string, environment: string | null): HostTarget[] | "conflict" => {
      const targets = (hosts.get(host) ?? []).filter((t) => envCompatible(t.environment, environment));
      if (targets.some((t) => t.appRepo === callerRepo)) return [];
      const repos = new Set(targets.map((t) => t.appRepo));
      return repos.size > 1 ? "conflict" : targets;
    };

    for (const [repoId, input] of inputs) {
      const configByKey = new Map<string, ConfigUrl[]>();
      for (const c of input.configUrls) configByKey.set(configKey(c.key), [...(configByKey.get(configKey(c.key)) ?? []), c]);

      for (const call of input.calls) {
        const source = { id: call.sourceId, repositoryId: repoId, provenance: call.provenance };
        const absolute = call.url && /^[a-z][\w+.-]*:\/\//i.test(call.url) ? call.url : null;
        const base = !absolute && call.baseAddress && /^[a-z][\w+.-]*:\/\//i.test(call.baseAddress) ? call.baseAddress : null;
        const hostCandidates: { host: string; environment: string | null; via: string; provenance: Provenance[] }[] = [];
        const directHost = hostOf(absolute ?? base);
        if (directHost) hostCandidates.push({ host: directHost, environment: null, via: absolute ? "absolute-url" : "client-base-address", provenance: [] });
        for (const key of call.configurationKeys) {
          for (const c of configByKey.get(configKey(key)) ?? []) {
            const h = hostOf(c.value);
            if (h && c.valueKind === "url") hostCandidates.push({ host: h, environment: c.environment, via: `configuration:${c.key}`, provenance: c.provenance });
            else emit.unresolved({ type: "CALLS_ENDPOINT", source, display: `${call.verb ?? "?"} ${c.value ?? key}`, reason: `base URL configuration ${c.key} is a placeholder (${c.value})`, category: "service-url-placeholder", extractor: "API_CONSUMER", metadata: { configuration: c.key, environment: c.environment } });
          }
        }
        const rawPath = absolute ? absolute.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "") : call.url && !call.url.startsWith("{") ? call.url : null;
        const path = rawPath !== null ? `${base ? base.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "").replace(/\/+$/, "") : ""}/${rawPath.replace(/^\/+/, "")}` : null;
        const shape = path ? normalizePath(path).shape : null;
        const verb = call.verb?.toUpperCase() ?? null;
        let linked = false;

        for (const hc of hostCandidates) {
          if (isPlaceholderHost(hc.host)) continue;
          const targets = resolveHost(hc.host, repoId, hc.environment);
          if (targets === "conflict") {
            emit.conflict({ kind: "conflicting-service-host", subject: `${hc.host}|${hc.environment ?? ""}`, factIds: (hosts.get(hc.host) ?? []).map((t) => t.appId), description: `host ${hc.host} maps to applications in ${new Set((hosts.get(hc.host) ?? []).map((t) => t.appRepo)).size} repositories${hc.environment ? ` in ${hc.environment}` : ""}` });
            emit.unresolved({ type: "CALLS_ENDPOINT", source, display: `${verb ?? "?"} ${hc.host}${path ?? ""}`, reason: `host ${hc.host} is declared by more than one repository`, category: "provider-conflict", extractor: "API_CONSUMER" });
            continue;
          }
          for (const t of targets) {
            const providerOps = verb && shape ? matchOps(verb, shape).filter((o) => o.repoId === t.appRepo && (!o.ownerApp || o.ownerApp === t.appId)) : [];
            const kinds = [`service-host:${t.via}`, hc.via];
            const environment = hc.environment ?? t.environment;
            for (const o of providerOps) {
              emit.relate({ type: "CALLS_ENDPOINT", source, target: { id: o.op.id, repositoryId: o.repoId, provenance: o.op.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.85, evidenceKinds: [...kinds, "method+route"], extractor: "API_CONSUMER", environment, metadata: { host: hc.host, verb, path } });
              if (o.apiId) emit.relate({ type: "CONSUMES_API", source: emit.repositoryEntity(repoId), target: { id: o.apiId, repositoryId: o.repoId }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.85, evidenceKinds: kinds, extractor: "API_CONSUMER", environment });
            }
            if (verb && shape && !providerOps.length) emit.unresolved({ type: "CALLS_ENDPOINT", source, display: `${verb} ${hc.host}${path}`, reason: `host resolves to an application in ${emit.repos.get(t.appRepo)?.entry.name}, but no operation there matches ${verb} ${path}`, category: "operation-not-found-at-provider", extractor: "API_CONSUMER" });
            repoLink(repoId, t.appRepo, kinds, providerOps.length ? 0.85 : 0.65, environment, `${verb ?? "?"} ${hc.host}${path ?? ""}`, call.provenance);
            linked = true;
          }
        }
        if (linked || !verb || !shape) {
          if (!linked && !hostCandidates.length && call.category === "configured-url") emit.unresolved({ type: "CALLS_ENDPOINT", source, display: `${verb ?? "?"} (configured base URL ${call.configurationKeys.join(", ") || "unknown"})`, reason: "no URL value for the configuration key is declared in the repository's configuration or infrastructure", category: "configuration-value-missing", extractor: "API_CONSUMER" });
          continue;
        }
        if (directHost && isFqdn(directHost)) continue;
        const candidates = matchOps(verb, shape).filter((o) => o.repoId !== repoId);
        const typed = candidates.filter((o) => {
          const payload = inputs.get(o.repoId)!.payloads.filter((p) => p.operationId === o.op.id);
          return payload.some((p) => (p.type === call.requestType || p.type === call.responseType) && p.assembly && input.packageNames.includes(p.assembly.toLowerCase()));
        });
        if (typed.length && new Set(typed.map((o) => o.repoId)).size === 1) {
          for (const o of typed) {
            emit.relate({ type: "CALLS_ENDPOINT", source, target: { id: o.op.id, repositoryId: o.repoId, provenance: o.op.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["shared-contract-type", "method+route"], extractor: "API_CONSUMER", metadata: { verb, path } });
            if (o.apiId) emit.relate({ type: "CONSUMES_API", source: emit.repositoryEntity(repoId), target: { id: o.apiId, repositoryId: o.repoId }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["shared-contract-type"], extractor: "API_CONSUMER" });
          }
          repoLink(repoId, typed[0]!.repoId, ["shared-contract-type", "method+route"], 0.8, null, `${verb} ${path}`, call.provenance);
          continue;
        }
        emit.unresolved({
          type: "CALLS_ENDPOINT", source, display: `${verb} ${directHost ? `${directHost}` : ""}${path}`,
          reason: candidates.length ? `${new Set(candidates.map((c) => c.repoId)).size} repositories expose a matching route, but no host, configuration, or shared-contract evidence identifies the provider` : "no repository in the catalog exposes a matching operation",
          category: candidates.length ? "route-only-candidates" : "no-provider-in-catalog", extractor: "API_CONSUMER",
          metadata: { verb, path, host: directHost, candidates: [...new Set(candidates.map((c) => emit.repos.get(c.repoId)?.entry.name ?? c.repoId))].sort() },
        });
      }

      for (const c of input.configUrls) {
        const source = { id: c.id, repositoryId: repoId, provenance: c.provenance };
        if (c.valueKind !== "url") {
          emit.unresolved({ type: "ROUTES_TO", source, display: c.value ?? c.key, reason: `service URL ${c.key} is parameterized; its target is supplied outside the repository`, category: "service-url-placeholder", extractor: "SERVICE_URL", metadata: { environment: c.environment } });
          continue;
        }
        const host = hostOf(c.value);
        if (!host || isPlaceholderHost(host)) continue;
        const targets = resolveHost(host, repoId, c.environment);
        if (targets === "conflict") {
          emit.conflict({ kind: "conflicting-service-host", subject: `${host}|${c.environment ?? ""}`, factIds: (hosts.get(host) ?? []).map((t) => t.appId), description: `service URL host ${host} maps to applications in more than one repository` });
          continue;
        }
        for (const t of targets) {
          const environment = c.environment ?? t.environment;
          emit.relate({ type: "ROUTES_TO", source, target: { id: t.appId, repositoryId: t.appRepo }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.7, evidenceKinds: ["service-url-configuration", `service-host:${t.via}`], extractor: "SERVICE_URL", environment, metadata: { url: c.value, key: c.key } });
          repoLink(repoId, t.appRepo, ["service-url-configuration", `service-host:${t.via}`], 0.7, environment, `${c.key}=${c.value}`, c.provenance);
        }
      }
    }
  },
};
