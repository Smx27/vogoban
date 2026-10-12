import type { GraphStore } from "../store/store.ts";
import { collectConfigUrls, type ConfigUrl } from "./apis.ts";
import type { MetaEmitter, RepoView } from "./emitter.ts";
import { collectInfrastructure, composeHostIndex, hostIndex, resolveOwnership, type InfraInputs } from "./infrastructure.ts";
import { facts, hostOf, isFqdn, isPlaceholderHost, links, str, strs, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

export interface ExternalInputs {
  infra: InfraInputs;
  applications: string[];
  externalCalls: Link[];
  externalApis: Fact[];
  configUrls: ConfigUrl[];
  connections: Fact[];
}

const SYSTEM_KIND: [RegExp, string][] = [
  [/^https?$/i, "api"],
  [/^(amqps?|sb|kafka|nats|mqtt)$/i, "message-broker"],
  [/^(mongodb(\+srv)?|postgres(ql)?|mysql|sqlserver|redis|rediss)$/i, "database"],
];

export const externalSystemResolver: CrossRepositoryResolver<ExternalInputs> = {
  id: "external-systems",
  version: "3",
  category: "external",
  collect(store: GraphStore, repo: RepoView): ExternalInputs {
    const repoId = repo.entry.repositoryId;
    const externalCalls = links(store, repoId, ["CALLS_EXTERNAL_API"]);
    return {
      infra: collectInfrastructure(store, repoId),
      applications: store.findEntities({ kinds: ["Application"], repositoryId: repoId }).map((a) => a.id).sort(),
      externalCalls,
      externalApis: store.findEntities({ ids: [...new Set(externalCalls.map((l) => l.targetId))] }).map((e) => ({ id: e.id, name: e.name, qualifiedName: e.qualifiedName, kind: e.kind, repositoryId: null, projectId: null, assembly: null, symbolKey: null, metadata: e.metadata, provenance: [] })),
      configUrls: collectConfigUrls(store, repoId).filter((c) => c.valueKind === "url"),
      connections: facts(store, repoId, ["Configuration", "EnvironmentVariable"]).filter((c) => c.metadata.valueKind === "connection-string" && strs(c.metadata.hosts).length),
    };
  },
  resolve(inputs, emit: MetaEmitter) {
    const infra = new Map([...inputs].map(([r, i]) => [r, i.infra]));
    const ownership = resolveOwnership(infra, new Set([...inputs.values()].flatMap((i) => i.applications)));
    const internal = new Set(hostIndex(infra, ownership, composeHostIndex(infra)).keys());
    for (const i of infra.values()) {
      for (const s of i.services) internal.add(s.name.toLowerCase());
      for (const ing of i.ingresses) for (const h of strs(ing.metadata.hosts)) internal.add(h.toLowerCase());
    }
    const external = (host: string | null): host is string => !!host && isFqdn(host) && !internal.has(host);
    const system = (host: string, systemKind: string) =>
      emit.entity({ key: `external-system|${host}`, kind: "ExternalSystem", name: host, qualifiedName: `external:${host}`, metadata: { host, systemKinds: [systemKind] }, extractor: "EXTERNAL_SYSTEM" });

    for (const [repoId, input] of inputs) {
      const apis = new Map(input.externalApis.map((a) => [a.id, a]));
      for (const call of input.externalCalls) {
        const api = apis.get(call.targetId);
        const host = str(api?.metadata.host);
        if (!external(host)) continue;
        const id = system(host, "api");
        const target = { id, repositoryId: null };
        emit.relate({ type: "REFERENCES", source: target, target: { id: call.targetId, repositoryId: null }, evidence: "EXACT", confidence: 1, evidenceKinds: ["external-api-host"], extractor: "EXTERNAL_API_IDENTITY" });
        emit.relate({ type: "CALLS_EXTERNAL_SYSTEM", source: { id: call.sourceId, repositoryId: repoId, provenance: call.provenance }, target, evidence: call.evidence, confidence: 1, evidenceKinds: ["http-call-host"], extractor: "EXTERNAL_HTTP_CALL", metadata: { verbs: str(call.metadata.verb) ? [String(call.metadata.verb)] : [], paths: str(call.metadata.path) ? [String(call.metadata.path)] : [] } });
        emit.relate({ type: "USES_EXTERNAL_SYSTEM", source: { ...emit.repositoryEntity(repoId), provenance: call.provenance }, target, evidence: "STRUCTURALLY_RESOLVED", confidence: 1, evidenceKinds: ["http-call-host"], extractor: "EXTERNAL_HTTP_CALL" });
      }
      for (const c of input.configUrls) {
        const host = hostOf(c.value);
        if (host && !internal.has(host) && !isFqdn(host) && !isPlaceholderHost(host) && host.includes(".")) {
          emit.unresolved({ type: "USES_EXTERNAL_SYSTEM", source: { id: c.id, repositoryId: repoId, provenance: c.provenance }, display: c.value ?? host, reason: `host ${host} is neither a service declared in the catalog nor a public DNS name`, category: "service-host-unknown", extractor: "EXTERNAL_CONFIGURATION", metadata: { key: c.key, environment: c.environment } });
          continue;
        }
        if (!external(host)) continue;
        const scheme = /^([a-z][\w+.-]*):/i.exec(c.value ?? "")?.[1] ?? "";
        const kind = SYSTEM_KIND.find(([re]) => re.test(scheme))?.[1] ?? "service";
        const target = { id: system(host, kind), repositoryId: null };
        emit.relate({ type: "USES_EXTERNAL_SYSTEM", source: { id: c.id, repositoryId: repoId, provenance: c.provenance }, target, evidence: "DECLARED", confidence: 0.9, evidenceKinds: ["configuration-url"], extractor: "EXTERNAL_CONFIGURATION", environment: c.environment, metadata: { key: c.key, url: c.value } });
        emit.relate({ type: "USES_EXTERNAL_SYSTEM", source: { ...emit.repositoryEntity(repoId), provenance: c.provenance }, target, evidence: "DECLARED", confidence: 0.9, evidenceKinds: ["configuration-url"], extractor: "EXTERNAL_CONFIGURATION", environment: c.environment, metadata: { keys: [c.key] } });
      }
      for (const c of input.connections) {
        for (const host of strs(c.metadata.hosts).map((h) => h.toLowerCase().replace(/[,:].*$/, ""))) {
          if (!external(host)) continue;
          const db = { id: emit.entity({ key: `database|${host}`, kind: "Database", name: host, qualifiedName: `database:${host}`, metadata: { host, identity: "connection-string-host" }, extractor: "DATABASE_IDENTITY" }), repositoryId: null };
          const environment = str(c.metadata.environment);
          emit.relate({ type: "USES_DATABASE", source: { id: c.id, repositoryId: repoId, provenance: c.provenance }, target: db, evidence: "DECLARED", confidence: 0.85, evidenceKinds: ["connection-string-host"], extractor: "DATABASE_REFERENCE", environment, metadata: { key: c.name } });
          emit.relate({ type: "USES_DATABASE", source: { ...emit.repositoryEntity(repoId), provenance: c.provenance }, target: db, evidence: "DECLARED", confidence: 0.85, evidenceKinds: ["connection-string-host"], extractor: "DATABASE_REFERENCE", environment, metadata: { keys: [c.name] } });
        }
      }
    }
  },
};
