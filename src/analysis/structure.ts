import type { Entity, EntityKind, RelationshipType } from "../graph/model.ts";
import { ref, type AnalysisGraph, type Edge, type EntityRef } from "./graph.ts";
import { cyclesIn, type Cycle } from "./traversal.ts";

export const CYCLE_KINDS = ["project", "repository", "service", "relationship"] as const;
export type CycleKind = (typeof CYCLE_KINDS)[number];

const CODE_USAGE: RelationshipType[] = ["CALLS", "CONSTRUCTS", "USES_TYPE", "USES_MEMBER", "READS_FIELD", "WRITES_FIELD", "RETURNS_TYPE", "INHERITS", "IMPLEMENTS", "EXTENDS", "OVERRIDES", "ATTRIBUTED_WITH", "THROWS"];

const toEdge = (r: { id: string; type: RelationshipType; sourceId: string; targetId: string; evidence: Edge["evidence"]; confidence: number; repositoryId: string | null; metadata: Edge["metadata"]; provenance: Edge["provenance"][] }, scope: "repository" | "meta" = "repository", targetRepositoryId?: string | null, environment: string | null = null): Edge => ({
  id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId, evidence: r.evidence, confidence: r.confidence, graphScope: scope,
  repositoryId: r.repositoryId, targetRepositoryId: targetRepositoryId ?? r.repositoryId, environment, provenance: r.provenance[0] ?? null, metadata: r.metadata,
});

export function serviceDependencyEdges(graph: AnalysisGraph, repositoryId?: string): { nodes: string[]; edges: Edge[] } {
  const apps = graph.ofKind(["Application"], repositoryId);
  const byProject = new Map<string, string>();
  for (const a of apps) if (a.projectId) byProject.set(a.projectId, a.id);
  const appOf = (e: Entity | undefined) => (e?.projectId ? byProject.get(e.projectId) : undefined);
  const calls = graph.store.findRelationships({ types: ["CALLS_ENDPOINT"], repositoryId }).map((r) => toEdge(r));
  if (graph.options.scope !== "repository") calls.push(...graph.store.findMetaRelationships({ types: ["CALLS_ENDPOINT"], repositoryId }).map((r) => toEdge({ ...r, repositoryId: r.sourceRepositoryId }, "meta", r.targetRepositoryId, r.environment)));
  const opOwner = new Map<string, string>();
  const ops = [...new Set(calls.map((c) => c.targetId))];
  const implemented = graph.out(ops, ["IMPLEMENTED_BY"]);
  const endpoints = graph.entities([...implemented.values()].flat().map((e) => e.targetId));
  for (const [op, edges] of implemented) for (const e of edges) {
    const owner = appOf(endpoints.get(e.targetId));
    if (owner) opOwner.set(op, owner);
  }
  const pubs = graph.store.findRelationships({ types: ["PUBLISHES"], repositoryId });
  const cons = graph.store.findRelationships({ types: ["CONSUMED_BY", "HANDLED_BY"], repositoryId });
  const ents = graph.entities([...calls.map((c) => c.sourceId), ...pubs.map((p) => p.sourceId), ...cons.map((c) => c.targetId)]);
  const edges: Edge[] = [];
  for (const c of calls) {
    const from = appOf(ents.get(c.sourceId));
    const to = opOwner.get(c.targetId);
    if (from && to && from !== to) edges.push({ ...c, id: `derived:service:${c.id}`, sourceId: from, targetId: to, metadata: { derivedFrom: c.id, via: "CALLS_ENDPOINT" } });
  }
  const publishers = new Map<string, Set<string>>();
  for (const p of pubs) {
    const app = appOf(ents.get(p.sourceId));
    if (app) publishers.set(p.targetId, (publishers.get(p.targetId) ?? new Set()).add(app));
  }
  for (const c of cons) {
    const consumer = appOf(ents.get(c.targetId));
    for (const publisher of publishers.get(c.sourceId) ?? []) {
      if (consumer && consumer !== publisher) edges.push({ ...toEdge(c), id: `derived:service:${c.id}:${publisher}`, sourceId: consumer, targetId: publisher, metadata: { derivedFrom: c.id, via: "message", message: c.sourceId } });
    }
  }
  const unique = new Map(edges.map((e) => [`${e.sourceId}|${e.targetId}|${e.metadata.via}`, e]));
  return { nodes: apps.map((a) => a.id).sort(), edges: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function findCycleSet(graph: AnalysisGraph, kind: CycleKind, repositoryId: string | undefined, types: RelationshipType[] = []): Cycle[] {
  if (kind === "project") {
    const projects = graph.ofKind(["Project"], repositoryId);
    const refs = graph.store.findRelationships({ types: ["PROJECT_REFERENCES"], repositoryId }).map((r) => toEdge(r));
    return cyclesIn(graph, projects.map((p) => p.id).sort(), refs);
  }
  if (kind === "repository") {
    const repos = graph.store.findEntities({ kinds: ["Repository"] });
    const rels = graph.store.findMetaRelationships({ types: ["CALLS_REPOSITORY", "DEPENDS_ON_REPOSITORY", "CONSUMES_REPOSITORY_CONTRACT", "DEPLOYS_REPOSITORY"] });
    return cyclesIn(graph, repos.map((r) => r.id).sort(), rels.map((r) => toEdge({ ...r, repositoryId: r.sourceRepositoryId }, "meta", r.targetRepositoryId, r.environment)));
  }
  if (kind === "service") {
    const { nodes, edges } = serviceDependencyEdges(graph, repositoryId);
    return cyclesIn(graph, nodes, edges);
  }
  const rels = graph.store.findRelationships({ types, repositoryId }).map((r) => toEdge(r));
  const nodes = [...new Set(rels.flatMap((r) => [r.sourceId, r.targetId]))].sort();
  return cyclesIn(graph, nodes, rels);
}

export const ORPHAN_LABELS = ["NO_OBSERVED_CONSUMER", "NO_OBSERVED_PUBLISHER", "UNREFERENCED", "UNREACHABLE", "ORPHANED"] as const;

export interface OrphanFinding {
  label: (typeof ORPHAN_LABELS)[number];
  entity: EntityRef;
  repository: string | null;
  reason: string;
  evidence: string[];
}

export function findOrphans(graph: AnalysisGraph, repositoryId?: string): OrphanFinding[] {
  const findings: OrphanFinding[] = [];
  const repoName = (id: string | null) => (id ? (graph.store.getCatalog(id)?.name ?? id) : null);
  const add = (label: OrphanFinding["label"], e: Entity, reason: string, evidence: string[]) => findings.push({ label, entity: ref(e), repository: repoName(e.repositoryId), reason, evidence });
  const hasIn = (ids: string[], types: RelationshipType[]) => {
    const m = graph.in(ids, types);
    return (id: string) => (m.get(id) ?? []).length > 0;
  };
  const hasOut = (ids: string[], types: RelationshipType[]) => {
    const m = graph.out(ids, types);
    return (id: string) => (m.get(id) ?? []).length > 0;
  };
  const of = (kinds: EntityKind[]) => graph.ofKind(kinds, repositoryId);

  const ops = of(["ApiOperation"]);
  const called = hasIn(ops.map((o) => o.id), ["CALLS_ENDPOINT"]);
  for (const op of ops) if (!called(op.id)) add("NO_OBSERVED_CONSUMER", op, "no HTTP client call in any analyzed repository resolves to this operation; clients outside the catalog are not represented", ["CALLS_ENDPOINT: none (repository + MetaGraph)"]);

  const messages = of(["Message"]);
  const ids = messages.map((m) => m.id);
  const published = hasIn(ids, ["PUBLISHES"]);
  const consumed = hasOut(ids, ["CONSUMED_BY", "HANDLED_BY"]);
  const shared = hasIn(ids, ["CONTAINS"]);
  for (const m of messages) {
    if (published(m.id) && !consumed(m.id) && !shared(m.id)) add("NO_OBSERVED_CONSUMER", m, "message is published but no handler or consumer is registered in the analyzed repositories", ["PUBLISHES: present", "CONSUMED_BY/HANDLED_BY: none"]);
    if (!published(m.id) && consumed(m.id) && !shared(m.id)) add("NO_OBSERVED_PUBLISHER", m, "message has consumers but no publisher in the analyzed repositories", ["CONSUMED_BY/HANDLED_BY: present", "PUBLISHES: none"]);
  }

  const schemas = of(["ApiSchema"]);
  const usedSchema = hasIn(schemas.map((s) => s.id), ["ACCEPTS_REQUEST", "PRODUCES_RESPONSE", "USES_TYPE", "REFERENCES"]);
  for (const s of schemas) if (!usedSchema(s.id)) add("UNREFERENCED", s, "contract schema is not referenced by any operation or schema", ["ACCEPTS_REQUEST/PRODUCES_RESPONSE/USES_TYPE: none"]);

  const services = of(["KubernetesService"]);
  const routed = hasOut(services.map((s) => s.id), ["ROUTES_TO"]);
  for (const s of services) if (!routed(s.id) && s.metadata.serviceType !== "ExternalName") add("UNREACHABLE", s, "service selects no workload declared in the same namespace and deployment scope", ["ROUTES_TO: none"]);

  const configMaps = of(["KubernetesConfigMap"]);
  const referenced = hasIn(configMaps.map((c) => c.id), ["REFERENCES_CONFIG"]);
  for (const c of configMaps) if (!referenced(c.id)) add("UNREFERENCED", c, "ConfigMap is not referenced by any declared workload, container or environment variable", ["REFERENCES_CONFIG: none"]);

  const workloads = of(["Deployment"]);
  const runsApp = hasOut(workloads.map((w) => w.id), ["RUNS"]);
  const containers = graph.out(workloads.map((w) => w.id), ["CONTAINS"]);
  const images = graph.out([...containers.values()].flat().map((e) => e.targetId), ["RUNS_IMAGE"]);
  const built = hasIn([...images.values()].flat().map((e) => e.targetId), ["BUILDS"]);
  for (const w of workloads) {
    if (runsApp(w.id)) continue;
    const ownImages = (containers.get(w.id) ?? []).flatMap((c) => (images.get(c.targetId) ?? []).map((i) => i.targetId));
    if (ownImages.some(built)) add("ORPHANED", w, "workload runs an image built from an analyzed repository, but no application could be linked to it", ["RUNS: none", "image BUILDS: present"]);
  }

  const apps = of(["Application"]);
  const appIds = apps.map((a) => a.id);
  const run = hasIn(appIds, ["RUNS"]);
  const exposedApis = graph.out(appIds, ["CONTAINS"]);
  const apiOps = graph.out([...exposedApis.values()].flat().map((e) => e.targetId), ["CONTAINS"]);
  const opCalled = hasIn([...apiOps.values()].flat().map((e) => e.targetId), ["CALLS_ENDPOINT"]);
  for (const a of apps) {
    const ownOps = (exposedApis.get(a.id) ?? []).flatMap((api) => (apiOps.get(api.targetId) ?? []).map((o) => o.targetId));
    if (!run(a.id) && !ownOps.some(opCalled)) add("NO_OBSERVED_CONSUMER", a, "application is neither run by a declared workload nor called by any analyzed client", ["RUNS: none", `CALLS_ENDPOINT into ${ownOps.length} operations: none`]);
  }

  for (const repo of (repositoryId ? [repositoryId] : graph.store.listCatalog().map((c) => c.repositoryId)).filter((r) => graph.store.getCatalog(r)?.semantic)) {
    const usage = new Set(graph.store.crossProjectUsage(repo, CODE_USAGE).flatMap((u) => [`${u.sourceProjectId}|${u.targetProjectId}`, `${u.sourceProjectId}|asm:${(u.targetAssembly ?? "").toLowerCase()}`]));
    const refs = graph.store.findRelationships({ types: ["PROJECT_REFERENCES"], repositoryId: repo });
    const projects = graph.entities(refs.flatMap((r) => [r.sourceId, r.targetId]));
    const unresolvedSources = graph.entities(graph.store.findUnresolved({ repositoryId: repo }).map((u) => u.sourceId));
    const incomplete = new Set([...unresolvedSources.values()].map((e) => e.projectId ?? (e.kind === "Project" ? e.id : null)).filter((p): p is string => !!p));
    for (const r of refs) {
      const source = projects.get(r.sourceId);
      const target = projects.get(r.targetId);
      if (!source || !target || usage.has(`${r.sourceId}|${r.targetId}`) || usage.has(`${r.sourceId}|asm:${String(target.metadata.assemblyName ?? "").toLowerCase()}`) || incomplete.has(r.sourceId)) continue;
      if (!graph.store.findEntities({ projectId: r.sourceId, kinds: ["Method"], limit: 1 }).length || !graph.store.findEntities({ projectId: r.targetId, kinds: ["Type"], limit: 1 }).length) continue;
      add("UNREFERENCED", source, `project reference to ${target.name} has no observed compiler-resolved usage`, [`PROJECT_REFERENCES ${r.id}`, "no code relationship from this project's symbols to the referenced project's symbols", "project has no unresolved references, so its semantic picture is complete"]);
    }
  }
  return findings.sort((a, b) => a.label.localeCompare(b.label) || (a.repository ?? "").localeCompare(b.repository ?? "") || (a.entity.qualifiedName ?? a.entity.name).localeCompare(b.entity.qualifiedName ?? b.entity.name));
}
