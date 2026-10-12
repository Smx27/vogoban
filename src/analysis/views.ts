import type { Entity, RelationshipType } from "../graph/model.ts";
import { ref, type AnalysisGraph, type Edge, type EntityRef } from "./graph.ts";
import { propagate, type ImpactOptions, type ImpactResult } from "./impact.ts";
import { blastRadius, type Score } from "./risk.ts";
import { buildPath, step, type GraphPath } from "./traversal.ts";

export interface Linked {
  entity: EntityRef;
  relationship: { id: string; type: string; evidence: string; graphScope: "repository" | "meta"; environment: string | null; metadata?: Record<string, unknown> };
  repository: string | null;
}

const linked = (graph: AnalysisGraph, e: Entity, edge: Edge): Linked => ({
  entity: ref(e),
  relationship: { id: edge.id, type: edge.type, evidence: edge.evidence, graphScope: edge.graphScope, environment: edge.environment },
  repository: e.repositoryId ? (graph.store.getCatalog(e.repositoryId)?.name ?? e.repositoryId) : null,
});

function neighbours(graph: AnalysisGraph, ids: string[], direction: "out" | "in", types: RelationshipType[]): Linked[] {
  const edges = [...(direction === "out" ? graph.out(ids, types) : graph.in(ids, types)).values()].flat();
  const ents = graph.entities(edges.map((e) => (direction === "out" ? e.targetId : e.sourceId)));
  return edges.flatMap((e) => {
    const other = ents.get(direction === "out" ? e.targetId : e.sourceId);
    return other ? [linked(graph, other, e)] : [];
  });
}

const projectApps = new Map<string, string[]>();
export function applicationsOf(graph: AnalysisGraph, entities: EntityRef[]): Map<string, Entity[]> {
  const ents = graph.entities(entities.map((e) => e.id));
  const projects = [...new Set([...ents.values()].map((e) => (e.kind === "Application" ? null : e.projectId)).filter((p): p is string => !!p))].filter((p) => !projectApps.has(p));
  for (const [p, edges] of graph.out(projects, ["DEFINES_APPLICATION"])) projectApps.set(p, edges.map((e) => e.targetId));
  const apps = graph.entities([...projectApps.values()].flat());
  const out = new Map<string, Entity[]>();
  for (const e of ents.values()) out.set(e.id, e.kind === "Application" ? [e] : (projectApps.get(e.projectId ?? "") ?? []).map((a) => apps.get(a)!).filter(Boolean));
  return out;
}

function deploymentsOf(graph: AnalysisGraph, appIds: string[]): { workload: Linked; services: Linked[]; ingresses: Linked[] }[] {
  return neighbours(graph, appIds, "in", ["RUNS"]).map((w) => {
    const services = neighbours(graph, [w.entity.id], "in", ["ROUTES_TO"]).filter((s) => s.entity.kind === "KubernetesService");
    return { workload: w, services, ingresses: neighbours(graph, services.map((s) => s.entity.id), "in", ["ROUTES_TO"]).filter((i) => i.entity.kind === "KubernetesIngress") };
  });
}

const BREAKING: Record<string, { breaking: boolean; affects: "all" | "request" | "response" }> = {
  removed: { breaking: true, affects: "all" },
  route: { breaking: true, affects: "all" },
  method: { breaking: true, affects: "all" },
  version: { breaking: true, affects: "all" },
  "request-field": { breaking: true, affects: "request" },
  "required-field": { breaking: true, affects: "request" },
  parameter: { breaking: true, affects: "request" },
  "request-contract": { breaking: true, affects: "request" },
  "response-field": { breaking: true, affects: "response" },
  "response-contract": { breaking: true, affects: "response" },
  "additive-field": { breaking: false, affects: "all" },
};
export const API_CHANGE_KINDS = Object.keys(BREAKING);

export interface ApiImpact {
  operation: EntityRef;
  api: Linked | null;
  provider: Linked | null;
  endpoints: Linked[];
  handlers: Linked[];
  requestContracts: Linked[];
  responseContracts: Linked[];
  consumers: (Linked & { applications: EntityRef[]; deployments: string[]; client: EntityRef | null; breakingPotential: boolean | null; path: GraphPath })[];
  consumerRepositories: string[];
  change: { kind: string; breaking: boolean; affects: string } | null;
  impact: ImpactResult;
  blastRadius: Score;
}

export function apiImpact(graph: AnalysisGraph, operation: Entity, changeKind: string | null, options: ImpactOptions): ApiImpact {
  const change = changeKind ? { kind: changeKind, ...BREAKING[changeKind]! } : null;
  const endpoints = neighbours(graph, [operation.id], "out", ["IMPLEMENTED_BY"]);
  const api = neighbours(graph, [operation.id], "in", ["CONTAINS"]).find((l) => l.entity.kind === "Api") ?? null;
  const provider = api ? (neighbours(graph, [api.entity.id], "in", ["CONTAINS"]).find((l) => l.entity.kind === "Application") ?? null) : null;
  const callEdges = graph.in([operation.id], ["CALLS_ENDPOINT"]).get(operation.id) ?? [];
  const callers = graph.entities(callEdges.map((e) => e.sourceId));
  const apps = applicationsOf(graph, [...callers.values()].map(ref));
  const clients = graph.entities(callEdges.map((e) => String(e.metadata.client ?? "")).filter((c) => c.startsWith("e_")));
  const consumers = callEdges.flatMap((edge) => {
    const caller = callers.get(edge.sourceId);
    if (!caller) return [];
    const consumerApps = apps.get(caller.id) ?? [];
    const hasRequest = typeof edge.metadata.requestType === "string";
    const hasResponse = typeof edge.metadata.responseType === "string";
    const breakingPotential = !change ? null : !change.breaking ? false : change.affects === "all" ? true : change.affects === "request" ? (hasRequest || null) : (hasResponse || null);
    return [{
      ...linked(graph, caller, edge),
      applications: consumerApps.map(ref),
      deployments: deploymentsOf(graph, consumerApps.map((a) => a.id)).map((d) => d.workload.entity.qualifiedName ?? d.workload.entity.name),
      client: clients.get(String(edge.metadata.client ?? "")) ? ref(clients.get(String(edge.metadata.client))!) : null,
      breakingPotential,
      path: buildPath([step(operation, caller, edge, "calls endpoint")], operation, "reverse"),
    }];
  });
  const impact = propagate(graph, [operation], options);
  return {
    operation: ref(operation),
    api,
    provider,
    endpoints,
    handlers: neighbours(graph, endpoints.map((e) => e.entity.id), "out", ["ROUTES_TO"]),
    requestContracts: neighbours(graph, [operation.id], "out", ["ACCEPTS_REQUEST"]),
    responseContracts: neighbours(graph, [operation.id], "out", ["PRODUCES_RESPONSE"]),
    consumers,
    consumerRepositories: [...new Set(consumers.map((c) => c.repository).filter((r): r is string => !!r))].sort(),
    change: change ? { kind: change.kind, breaking: change.breaking, affects: change.affects } : null,
    impact,
    blastRadius: blastRadius(impact),
  };
}

export interface MessageImpact {
  message: EntityRef;
  members: Linked[];
  producerSide: (Linked & { applications: EntityRef[] })[];
  consumerSide: (Linked & { applications: EntityRef[] })[];
  transports: { transport: Linked; senders: Linked[]; deliversTo: Linked[] }[];
  repositories: string[];
  impact: ImpactResult;
  blastRadius: Score;
}

export function messageImpact(graph: AnalysisGraph, message: Entity, options: ImpactOptions): MessageImpact {
  const members = message.kind === "SharedContract" ? neighbours(graph, [message.id], "out", ["CONTAINS"]) : neighbours(graph, [message.id], "in", ["CONTAINS"]).filter((l) => l.entity.kind === "SharedContract").flatMap((c) => neighbours(graph, [c.entity.id], "out", ["CONTAINS"]));
  const messageIds = [...new Set([message.id, ...members.map((m) => m.entity.id)])].filter((id) => id !== message.id || message.kind === "Message");
  const withApps = (list: Linked[]) => {
    const apps = applicationsOf(graph, list.map((l) => l.entity));
    return list.map((l) => ({ ...l, applications: (apps.get(l.entity.id) ?? []).map(ref) }));
  };
  const producerSide = withApps(neighbours(graph, messageIds, "in", ["PUBLISHES"]));
  const consumerSide = withApps(neighbours(graph, messageIds, "out", ["CONSUMED_BY", "HANDLED_BY"]));
  const transports = neighbours(graph, messageIds, "in", ["CARRIES"]).map((t) => ({
    transport: t,
    senders: neighbours(graph, [t.entity.id], "in", ["SENDS_TO"]),
    deliversTo: neighbours(graph, [t.entity.id], "out", ["ROUTES_TO"]),
  }));
  const impact = propagate(graph, [message], options);
  return {
    message: ref(message),
    members,
    producerSide,
    consumerSide,
    transports,
    repositories: [...new Set([...producerSide, ...consumerSide, ...members].map((l) => l.repository).filter((r): r is string => !!r))].sort(),
    impact,
    blastRadius: blastRadius(impact),
  };
}

function projectEdges(graph: AnalysisGraph, app: Entity, types: RelationshipType[], direction: "out" | "in"): Linked[] {
  if (!app.projectId || !app.repositoryId) return [];
  const rels = graph.store.findRelationships({ types, repositoryId: app.repositoryId });
  const ends = graph.entities(rels.flatMap((r) => [r.sourceId, r.targetId]));
  return rels
    .filter((r) => ends.get(direction === "out" ? r.sourceId : r.targetId)?.projectId === app.projectId)
    .flatMap((r) => {
      const other = ends.get(direction === "out" ? r.targetId : r.sourceId);
      return other ? [{ entity: ref(other), relationship: { id: r.id, type: r.type, evidence: r.evidence, graphScope: "repository" as const, environment: null }, repository: other.repositoryId ? (graph.store.getCatalog(other.repositoryId)?.name ?? other.repositoryId) : null }] : [];
    });
}

export interface ServiceImpact {
  service: EntityRef;
  apis: Linked[];
  operations: number;
  apiConsumers: Linked[];
  publishes: Linked[];
  consumes: Linked[];
  outgoingCalls: Linked[];
  externalSystems: Linked[];
  configuration: Linked[];
  deployments: { workload: Linked; services: Linked[]; ingresses: Linked[] }[];
  upstream: ImpactResult;
  downstream: ImpactResult;
  blastRadius: Score;
}

export function serviceImpact(graph: AnalysisGraph, app: Entity, options: ImpactOptions): ServiceImpact {
  const apis = neighbours(graph, [app.id], "out", ["CONTAINS"]).filter((l) => l.entity.kind === "Api");
  const ops = neighbours(graph, apis.map((a) => a.entity.id), "out", ["CONTAINS"]).filter((l) => l.entity.kind === "ApiOperation");
  const upstream = propagate(graph, [app], { ...options, mode: "impact" });
  return {
    service: ref(app),
    apis,
    operations: ops.length,
    apiConsumers: neighbours(graph, ops.map((o) => o.entity.id), "in", ["CALLS_ENDPOINT"]),
    publishes: projectEdges(graph, app, ["PUBLISHES", "SENDS_TO"], "out"),
    consumes: projectEdges(graph, app, ["CONSUMED_BY", "HANDLED_BY"], "in"),
    outgoingCalls: [...projectEdges(graph, app, ["CALLS_ENDPOINT", "CALLS_EXTERNAL_API"], "out"), ...neighbours(graph, [app.id], "out", ["CALLS_EXTERNAL_API"])],
    externalSystems: neighbours(graph, [app.id], "out", ["USES_EXTERNAL_SYSTEM", "USES_DATABASE", "CALLS_EXTERNAL_SYSTEM"]),
    configuration: projectEdges(graph, app, ["REFERENCES_CONFIG"], "out").concat(neighbours(graph, [app.id], "out", ["REFERENCES_CONFIG", "USES_SECRET"])),
    deployments: deploymentsOf(graph, [app.id]),
    upstream,
    downstream: propagate(graph, [app], { ...options, mode: "dependencies", expandSeeds: false }),
    blastRadius: blastRadius(upstream),
  };
}

export interface RepositoryImpact {
  repository: EntityRef;
  dependsOn: Linked[];
  dependents: Linked[];
  providedApis: Linked[];
  consumedApis: Linked[];
  sharedPackages: Linked[];
  producedPackages: Linked[];
  sharedContracts: Linked[];
  messages: Linked[];
  externalSystems: Linked[];
  deployedBy: Linked[];
  deploys: Linked[];
  infrastructure: Record<string, number>;
  impact: ImpactResult;
  blastRadius: Score;
}

const REPO_EDGES: RelationshipType[] = ["CALLS_REPOSITORY", "DEPENDS_ON_REPOSITORY", "CONSUMES_REPOSITORY_CONTRACT", "SHARES_CONTRACT_WITH"];

export function repositoryImpact(graph: AnalysisGraph, repo: Entity, options: ImpactOptions): RepositoryImpact {
  const stats = graph.store.stats(repo.repositoryId!).entitiesByKind;
  const producedProjects = graph.store.findMetaRelationships({ types: ["PRODUCES_PACKAGE"], repositoryId: repo.repositoryId! }).filter((r) => r.sourceRepositoryId === repo.repositoryId).map((r) => r.sourceId);
  const impact = propagate(graph, [repo], options);
  return {
    repository: ref(repo),
    dependsOn: neighbours(graph, [repo.id], "out", REPO_EDGES),
    dependents: neighbours(graph, [repo.id], "in", REPO_EDGES),
    providedApis: neighbours(graph, [repo.id], "out", ["PROVIDES_API"]),
    consumedApis: neighbours(graph, [repo.id], "out", ["CONSUMES_API"]),
    sharedPackages: neighbours(graph, [repo.id], "out", ["USES_SHARED_PACKAGE"]),
    producedPackages: neighbours(graph, producedProjects, "out", ["PRODUCES_PACKAGE"]),
    sharedContracts: neighbours(graph, [repo.id], "out", ["SHARES_CONTRACT_WITH"]).concat(neighbours(graph, [repo.id], "in", ["SHARES_CONTRACT_WITH"])),
    messages: neighbours(graph, [repo.id], "out", ["PUBLISHES_MESSAGE", "CONSUMES_MESSAGE"]),
    externalSystems: neighbours(graph, [repo.id], "out", ["USES_EXTERNAL_SYSTEM", "USES_DATABASE"]),
    deployedBy: neighbours(graph, [repo.id], "in", ["DEPLOYS_REPOSITORY"]),
    deploys: neighbours(graph, [repo.id], "out", ["DEPLOYS_REPOSITORY"]),
    infrastructure: Object.fromEntries(["Pipeline", "Dockerfile", "ContainerImage", "HelmChart", "Deployment", "KubernetesService", "KubernetesIngress"].map((k) => [k, stats[k] ?? 0])),
    impact,
    blastRadius: blastRadius(impact),
  };
}
