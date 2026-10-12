import type { Conflict, Entity, EntityKind, UnresolvedReference } from "../graph/model.ts";
import { catalogStatus } from "../metagraph/catalog.ts";
import { isConfirmed, ref, type AnalysisGraph, type Edge, type EntityRef } from "./graph.ts";
import { categoryOf, levelFor, ruleFor, type ImpactCategory, type ImpactLevel, type Propagation } from "./semantics.ts";
import { buildPath, MAX_DEPTH, step, type GraphPath, type PathStep } from "./traversal.ts";

export type PropagationMode = "impact" | "dependents" | "dependencies";

export interface ImpactOptions {
  mode: PropagationMode;
  maxDepth: number;
  maxNodes: number;
  expandSeeds: boolean;
}

export interface ImpactedEntity {
  entity: EntityRef;
  category: ImpactCategory;
  level: ImpactLevel;
  depth: number;
  confirmed: boolean;
  crossRepository: boolean;
  reason: string;
  path: GraphPath;
}

export interface GraphState {
  repositories: { repositoryId: string; name: string; commit: string | null; graphVersion: string | null; status: string; note: string | null }[];
  metaSnapshot: string | null;
  warnings: string[];
}

export interface ImpactResult {
  mode: PropagationMode;
  seeds: EntityRef[];
  changeScope: { entity: EntityRef; reason: string }[];
  impacted: ImpactedEntity[];
  byCategory: Record<string, number>;
  byLevel: Record<string, number>;
  repositories: { repositoryId: string; name: string; impacted: number }[];
  unresolved: { id: string; type: string; source: string; target: string; reason: string; scope: "repository" | "meta" }[];
  conflicts: { id: string; kind: string; description: string; scope: "repository" | "meta" }[];
  truncated: boolean;
  limits: { maxDepth: number; maxNodes: number };
  graphState: GraphState;
}

interface Visit {
  depth: number;
  potential: boolean;
  confirmed: boolean;
  parent: string | null;
  edge: Edge | null;
  label: string;
  continues: boolean;
  dispatch: boolean;
}

const MEMBER_KINDS: EntityKind[] = ["Method", "Property", "Field", "Event"];
const CONTAINMENT_LABEL = "contains changed element";

export function expandSeeds(graph: AnalysisGraph, seeds: Entity[]): { entity: Entity; reason: string }[] {
  const out: { entity: Entity; reason: string }[] = [];
  for (const seed of seeds) {
    let ids: { id: string; reason: string }[] = [];
    if (seed.kind === "Type") {
      ids = (graph.out([seed.id], ["CONTAINS", "DECLARES"]).get(seed.id) ?? []).map((e) => ({ id: e.targetId, reason: `member of changed type ${seed.name}` }));
    } else if (seed.kind === "Application") {
      ids = (graph.out([seed.id], ["EXPOSES_ENDPOINT", "CONTAINS"]).get(seed.id) ?? []).map((e) => ({ id: e.targetId, reason: `endpoint or API of changed application ${seed.name}` }));
    } else if (seed.kind === "Api" || seed.kind === "SharedContract") {
      ids = (graph.out([seed.id], ["CONTAINS"]).get(seed.id) ?? []).map((e) => ({ id: e.targetId, reason: `member of changed ${seed.kind} ${seed.name}` }));
    } else if (seed.kind === "Repository" && seed.repositoryId) {
      const repoId = seed.repositoryId;
      const owned = graph.ofKind(["Application", "Api"], repoId);
      const publishedMessages = graph.store.findRelationships({ types: ["PUBLISHES"], repositoryId: repoId }).map((r) => r.targetId);
      const producers = graph.store.findMetaRelationships({ types: ["PRODUCES_PACKAGE"], repositoryId: repoId }).filter((r) => r.sourceRepositoryId === repoId).map((r) => r.sourceId);
      ids = [...owned.map((e) => e.id), ...publishedMessages, ...producers].map((id) => ({ id, reason: `owned by changed repository ${seed.name}` }));
    }
    const ents = graph.entities(ids.map((i) => i.id));
    for (const i of ids) {
      const e = ents.get(i.id);
      if (!e || (seed.kind === "Type" && !MEMBER_KINDS.includes(e.kind))) continue;
      out.push({ entity: e, reason: i.reason });
    }
  }
  return out.sort((a, b) => a.entity.id.localeCompare(b.entity.id));
}

export function propagate(graph: AnalysisGraph, seedEntities: Entity[], options: ImpactOptions): ImpactResult {
  const maxDepth = Math.min(options.maxDepth, MAX_DEPTH);
  const changeScope = options.mode === "impact" && options.expandSeeds ? expandSeeds(graph, seedEntities).filter((s) => !seedEntities.some((x) => x.id === s.entity.id)) : [];
  const visits = new Map<string, Visit>();
  for (const s of [...seedEntities, ...changeScope.map((c) => c.entity)]) visits.set(s.id, { depth: 0, potential: false, confirmed: true, parent: null, edge: null, label: "changed", continues: true, dispatch: false });
  const seedRepoIds = new Set(seedEntities.map((s) => s.repositoryId).filter(Boolean));
  let frontier = [...visits.keys()].sort();
  let truncated = false;
  const projectApps = new Map<string, string[]>();

  for (let depth = 1; depth <= maxDepth && frontier.length && !truncated; depth++) {
    const ins = graph.in(frontier);
    const outs = graph.out(frontier);
    const ents = graph.entities([...frontier, ...[...ins.values()].flat().map((e) => e.sourceId), ...[...outs.values()].flat().map((e) => e.targetId)]);
    const next = new Set<string>();
    const consider = (fromId: string, toId: string, edge: Edge, prop: Propagation) => {
      if (options.mode !== "impact" && prop.label === CONTAINMENT_LABEL) return;
      const from = ents.get(fromId);
      const to = ents.get(toId);
      if (!from || !to || !graph.visible(to) || to.kind === "Parameter") return;
      if (visits.get(fromId)!.dispatch && (edge.type === "IMPLEMENTS" || edge.type === "OVERRIDES" || edge.type === "INHERITS" || edge.type === "EXTENDS")) return;
      const parent = visits.get(fromId)!;
      const potential = parent.potential || prop.potential || !isConfirmed(edge);
      const existing = visits.get(toId);
      if (existing && (existing.depth < depth || (existing.depth === depth && (!existing.potential || potential)))) return;
      const repositoryBoundary = to.kind === "Repository" && from.kind !== "Repository" && !seedRepoIds.has(to.repositoryId);
      visits.set(toId, { depth, potential, confirmed: parent.confirmed && isConfirmed(edge), parent: fromId, edge, label: prop.label, continues: prop.continues && !repositoryBoundary, dispatch: prop.label.startsWith("dispatched") });
      if (prop.continues && !repositoryBoundary) next.add(toId);
      if (visits.size >= options.maxNodes) truncated = true;
    };
    for (const id of frontier) {
      const node = ents.get(id);
      if (!node || !visits.get(id)!.continues) continue;
      for (const edge of ins.get(id) ?? []) {
        const source = ents.get(edge.sourceId);
        if (!source) continue;
        const rule = ruleFor(edge.type, source.kind, node.kind);
        const prop = options.mode === "dependencies" ? rule?.toTarget : rule?.toSource;
        if (prop) consider(id, edge.sourceId, edge, prop);
        if (truncated) break;
      }
      for (const edge of outs.get(id) ?? []) {
        const target = ents.get(edge.targetId);
        if (!target) continue;
        const rule = ruleFor(edge.type, node.kind, target.kind);
        const prop = options.mode === "dependencies" ? rule?.toSource : rule?.toTarget;
        if (prop) consider(id, edge.targetId, edge, prop);
        if (truncated) break;
      }
      if (truncated) break;
    }
    if (options.mode === "impact" && !truncated) {
      const candidates = [...next, ...(depth === 1 ? seedEntities.map((e) => e.id) : [])];
      const code = candidates.map((id) => ents.get(id) ?? graph.entity(id)).filter((e): e is Entity => !!e && categoryOf(e.kind) === "CODE" && !!e.projectId);
      const projects = [...new Set(code.map((e) => e.projectId!))].filter((p) => !projectApps.has(p));
      for (const [p, edges] of graph.out(projects, ["DEFINES_APPLICATION"])) projectApps.set(p, edges.map((e) => e.targetId));
      const apps = graph.entities(code.flatMap((e) => projectApps.get(e.projectId!) ?? []));
      for (const e of code) {
        const parent = visits.get(e.id)!;
        for (const appId of projectApps.get(e.projectId!) ?? []) {
          const existing = visits.get(appId);
          const appDepth = parent.depth + 1;
          if (!apps.has(appId) || (existing && (existing.depth < appDepth || (existing.depth === appDepth && !existing.potential) || (existing.potential && parent.potential)))) continue;
          const edge: Edge = { id: `derived:project-membership:${e.projectId}`, type: "CONTAINS", sourceId: appId, targetId: e.id, evidence: "STRUCTURALLY_RESOLVED", confidence: 1, graphScope: "repository", repositoryId: e.repositoryId, targetRepositoryId: e.repositoryId, environment: null, provenance: null, metadata: { derived: "code compiled into the application's project" } };
          visits.set(appId, { depth: appDepth, potential: parent.potential, confirmed: parent.confirmed, parent: e.id, edge, label: "application built from changed code", continues: true, dispatch: false });
          next.add(appId);
          ents.set(appId, apps.get(appId)!);
        }
      }
    }
    frontier = [...next].sort();
  }

  const ids = [...visits.keys()];
  const all = graph.entities(ids);
  const pathCache = new Map<string, PathStep[]>();
  const stepsTo = (id: string): PathStep[] => {
    const cached = pathCache.get(id);
    if (cached) return cached;
    const v = visits.get(id)!;
    if (!v.parent || !v.edge) return [];
    const parentEntity = all.get(v.parent);
    const self = all.get(id);
    if (!parentEntity || !self) return [];
    const s = [...stepsTo(v.parent), step(parentEntity, self, v.edge, v.label)];
    pathCache.set(id, s);
    return s;
  };
  const rootOf = (id: string): string => {
    let cursor = id;
    while (visits.get(cursor)?.parent) cursor = visits.get(cursor)!.parent!;
    return cursor;
  };
  const impacted: ImpactedEntity[] = ids
    .filter((id) => visits.get(id)!.depth > 0 && all.has(id))
    .map((id) => {
      const v = visits.get(id)!;
      const e = all.get(id)!;
      const steps = stepsTo(id);
      const path = buildPath(steps, all.get(rootOf(id)) ?? e, options.mode === "dependencies" ? "forward" : "reverse");
      return { entity: ref(e), category: categoryOf(e.kind), level: levelFor(v.depth, v.potential), depth: v.depth, confirmed: v.confirmed, crossRepository: path.crossRepositoryHops > 0, reason: v.label, path };
    })
    .sort((a, b) => a.depth - b.depth || a.category.localeCompare(b.category) || (a.entity.qualifiedName ?? a.entity.name).localeCompare(b.entity.qualifiedName ?? b.entity.name) || a.entity.id.localeCompare(b.entity.id));

  const count = (f: (i: ImpactedEntity) => string) => {
    const out: Record<string, number> = {};
    for (const i of impacted) out[f(i)] = (out[f(i)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const repoCounts = new Map<string, number>();
  for (const i of impacted) if (i.entity.repositoryId) repoCounts.set(i.entity.repositoryId, (repoCounts.get(i.entity.repositoryId) ?? 0) + 1);

  const touched = [...seedEntities.map((s) => s.id), ...impacted.map((i) => i.entity.id)];
  return {
    mode: options.mode,
    seeds: seedEntities.map(ref),
    changeScope: changeScope.map((c) => ({ entity: ref(c.entity), reason: c.reason })),
    impacted,
    byCategory: count((i) => i.category),
    byLevel: count((i) => i.level),
    repositories: [...repoCounts].map(([repositoryId, n]) => ({ repositoryId, name: graph.store.getCatalog(repositoryId)?.name ?? repositoryId, impacted: n })).sort((a, b) => b.impacted - a.impacted || a.name.localeCompare(b.name)),
    unresolved: unresolvedAt(graph, touched),
    conflicts: conflictsAt(graph, new Set(touched)),
    truncated,
    limits: { maxDepth, maxNodes: options.maxNodes },
    graphState: graphState(graph, [...seedEntities.map((s) => s.repositoryId), ...impacted.map((i) => i.entity.repositoryId)], impacted.some((i) => i.path.graphScopes.includes("meta"))),
  };
}

function unresolvedAt(graph: AnalysisGraph, ids: string[]): ImpactResult["unresolved"] {
  const out: ImpactResult["unresolved"] = [];
  const set = new Set(ids);
  for (let i = 0; i < ids.length; i += 400) {
    for (const u of graph.store.findUnresolved({ sourceIds: ids.slice(i, i + 400) }) as UnresolvedReference[]) out.push({ id: u.id, type: u.type, source: u.sourceId, target: u.targetDisplay, reason: u.reason, scope: "repository" });
  }
  if (graph.options.scope !== "repository") for (const u of graph.store.findMetaUnresolved({})) if (set.has(u.sourceId)) out.push({ id: u.id, type: u.type, source: u.sourceId, target: u.targetDisplay, reason: u.reason, scope: "meta" });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function conflictsAt(graph: AnalysisGraph, ids: Set<string>): ImpactResult["conflicts"] {
  const hit = (c: Conflict) => c.factIds.some((f) => ids.has(f));
  return [
    ...graph.store.findConflicts({}).filter(hit).map((c) => ({ id: c.id, kind: c.kind, description: c.description, scope: "repository" as const })),
    ...(graph.options.scope === "repository" ? [] : graph.store.findMetaConflicts({}).filter(hit).map((c) => ({ id: c.id, kind: c.kind, description: c.description, scope: "meta" as const }))),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function graphState(graph: AnalysisGraph, repositoryIds: (string | null)[], usesMeta: boolean): GraphState {
  const warnings: string[] = [];
  const repositories = [...new Set(repositoryIds.filter((r): r is string => !!r))].sort().map((id) => {
    const entry = graph.store.getCatalog(id);
    if (!entry) return { repositoryId: id, name: id, commit: null, graphVersion: null, status: "UNCATALOGED", note: "repository graph is not registered in the catalog" };
    const s = catalogStatus(entry);
    if (s.status !== "READY") warnings.push(`${entry.name} graph is ${s.status}${s.reason ? `: ${s.reason}` : ""}`);
    return { repositoryId: id, name: entry.name, commit: entry.analyzedCommit, graphVersion: entry.graphVersion, status: s.status, note: s.reason };
  });
  const meta = graph.store.listMetaSnapshots()[0] ?? null;
  if (usesMeta && !meta) warnings.push("MetaGraph relationships were used but no MetaGraph snapshot is recorded");
  return { repositories, metaSnapshot: meta?.id ?? null, warnings };
}
