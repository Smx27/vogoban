import type { Entity, EntityKind, Provenance, Relationship, RelationshipType } from "../graph/model.ts";
import { findCycles } from "../query/graph-query.ts";
import { ref, type AnalysisGraph, type Edge, type EntityRef } from "./graph.ts";

export type TraversalDirection = "forward" | "reverse" | "both";

export interface PathStep {
  from: EntityRef;
  to: EntityRef;
  relationship: {
    id: string;
    type: RelationshipType;
    direction: "forward" | "reverse";
    evidence: string;
    confidence: number;
    graphScope: "repository" | "meta";
    repositoryId: string | null;
    targetRepositoryId: string | null;
    environment: string | null;
    crossRepository: boolean;
    provenance: Provenance | null;
    label?: string;
  };
}

export interface GraphPath {
  start: EntityRef;
  end: EntityRef;
  steps: PathStep[];
  length: number;
  direction: TraversalDirection;
  repositories: string[];
  graphScopes: ("repository" | "meta")[];
  crossRepositoryHops: number;
}

export interface TraversalFilter {
  direction: TraversalDirection;
  types?: RelationshipType[];
  kinds?: EntityKind[];
  maxDepth: number;
  maxNodes?: number;
}

export const MAX_DEPTH = 12;
export const DEFAULT_MAX_NODES = 5000;

export function step(from: Entity, to: Entity, edge: Edge, label?: string): PathStep {
  const forward = edge.sourceId === from.id;
  const fromRepo = from.repositoryId ?? edge.repositoryId;
  const toRepo = to.repositoryId ?? edge.targetRepositoryId;
  return {
    from: ref(from),
    to: ref(to),
    relationship: {
      id: edge.id, type: edge.type, direction: forward ? "forward" : "reverse", evidence: edge.evidence, confidence: edge.confidence, graphScope: edge.graphScope,
      repositoryId: edge.repositoryId, targetRepositoryId: edge.targetRepositoryId, environment: edge.environment,
      crossRepository: !!fromRepo && !!toRepo && fromRepo !== toRepo, provenance: edge.provenance, ...(label ? { label } : {}),
    },
  };
}

export function buildPath(steps: PathStep[], start: Entity, direction: TraversalDirection): GraphPath {
  let lastRepo = start.repositoryId;
  steps = steps.map((s) => {
    const repo = s.to.repositoryId;
    const crosses = !!repo && !!lastRepo && repo !== lastRepo;
    if (repo) lastRepo = repo;
    return crosses === s.relationship.crossRepository ? s : { ...s, relationship: { ...s.relationship, crossRepository: crosses } };
  });
  const end = steps.length ? steps[steps.length - 1]!.to : ref(start);
  const repositories = [...new Set([ref(start).repositoryId, ...steps.map((s) => s.to.repositoryId)].filter((r): r is string => !!r))];
  return {
    start: ref(start), end, steps, length: steps.length, direction, repositories,
    graphScopes: [...new Set(steps.map((s) => s.relationship.graphScope))].sort() as ("repository" | "meta")[],
    crossRepositoryHops: steps.filter((s) => s.relationship.crossRepository).length,
  };
}

function neighbours(graph: AnalysisGraph, ids: string[], filter: TraversalFilter): Map<string, { edge: Edge; next: string }[]> {
  const result = new Map<string, { edge: Edge; next: string }[]>(ids.map((id) => [id, []]));
  if (filter.direction !== "reverse") for (const [id, edges] of graph.out(ids, filter.types)) result.get(id)!.push(...edges.map((edge) => ({ edge, next: edge.targetId })));
  if (filter.direction !== "forward") for (const [id, edges] of graph.in(ids, filter.types)) result.get(id)!.push(...edges.map((edge) => ({ edge, next: edge.sourceId })));
  return result;
}

export interface Reached {
  entity: Entity;
  depth: number;
  path: GraphPath;
}

export function traverse(graph: AnalysisGraph, startId: string, filter: TraversalFilter): { reached: Reached[]; truncated: boolean } {
  const start = graph.entity(startId);
  if (!start) return { reached: [], truncated: false };
  const maxNodes = filter.maxNodes ?? DEFAULT_MAX_NODES;
  const parents = new Map<string, { parent: string; edge: Edge; depth: number }>();
  const seen = new Set([startId]);
  const order: string[] = [];
  let frontier = [startId];
  let truncated = false;
  for (let depth = 1; depth <= Math.min(filter.maxDepth, MAX_DEPTH) && frontier.length && !truncated; depth++) {
    const adj = neighbours(graph, frontier, filter);
    const candidates = [...adj.values()].flat();
    const ents = graph.entities(candidates.map((c) => c.next));
    const next: string[] = [];
    for (const id of frontier) {
      for (const { edge, next: n } of adj.get(id)!) {
        if (seen.has(n)) continue;
        const e = ents.get(n);
        if (!graph.visible(e) || (filter.kinds && !filter.kinds.includes(e!.kind))) continue;
        seen.add(n);
        parents.set(n, { parent: id, edge, depth });
        next.push(n);
        order.push(n);
        if (order.length >= maxNodes) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    frontier = next;
  }
  const all = graph.entities([startId, ...order]);
  const reached = order.map((id) => ({ entity: all.get(id)!, depth: parents.get(id)!.depth, path: buildPath(chain(id, startId, parents, all), start, filter.direction) }));
  return { reached, truncated };
}

function chain(id: string, startId: string, parents: Map<string, { parent: string; edge: Edge }>, ents: Map<string, Entity>): PathStep[] {
  const steps: PathStep[] = [];
  let cursor = id;
  while (cursor !== startId) {
    const p = parents.get(cursor)!;
    steps.unshift(step(ents.get(p.parent)!, ents.get(cursor)!, p.edge));
    cursor = p.parent;
  }
  return steps;
}

export function findPaths(graph: AnalysisGraph, fromId: string, toId: string, filter: TraversalFilter & { limit: number }): { paths: GraphPath[]; truncated: boolean } {
  const start = graph.entity(fromId);
  const target = graph.entity(toId);
  if (!start || !target) return { paths: [], truncated: false };
  const maxNodes = filter.maxNodes ?? DEFAULT_MAX_NODES * 4;
  const found: { nodes: string[]; edges: Edge[] }[] = [];
  let frontier: { nodes: string[]; edges: Edge[] }[] = [{ nodes: [fromId], edges: [] }];
  let expanded = 0;
  let truncated = false;
  for (let depth = 1; depth <= Math.min(filter.maxDepth, MAX_DEPTH) && frontier.length && found.length < filter.limit; depth++) {
    const adj = neighbours(graph, [...new Set(frontier.map((p) => p.nodes[p.nodes.length - 1]!))], filter);
    const ents = graph.entities([...adj.values()].flat().map((c) => c.next));
    const next: typeof frontier = [];
    for (const p of frontier) {
      for (const { edge, next: n } of adj.get(p.nodes[p.nodes.length - 1]!) ?? []) {
        if (p.nodes.includes(n)) continue;
        const e = ents.get(n);
        if (!graph.visible(e)) continue;
        if (n === toId) {
          if (found.length < filter.limit) found.push({ nodes: [...p.nodes, n], edges: [...p.edges, edge] });
          continue;
        }
        if (filter.kinds && !filter.kinds.includes(e!.kind)) continue;
        next.push({ nodes: [...p.nodes, n], edges: [...p.edges, edge] });
        if (++expanded > maxNodes) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    frontier = truncated ? [] : next;
  }
  const ents = graph.entities(found.flatMap((f) => f.nodes));
  return {
    paths: found.map((f) => buildPath(f.edges.map((edge, i) => step(ents.get(f.nodes[i]!)!, ents.get(f.nodes[i + 1]!)!, edge)), start, filter.direction)),
    truncated,
  };
}

export interface Cycle {
  nodes: EntityRef[];
  path: GraphPath;
  componentSize: number;
}

export function cyclesIn(graph: AnalysisGraph, nodes: string[], edges: Edge[]): Cycle[] {
  const components = findCycles(nodes, edges as unknown as Relationship[]);
  const bySource = new Map<string, Edge[]>();
  for (const e of edges) bySource.set(e.sourceId, [...(bySource.get(e.sourceId) ?? []), e]);
  const cycles: Cycle[] = [];
  for (const component of components) {
    const members = new Set(component);
    const startId = component[0]!;
    const parents = new Map<string, Edge>();
    let frontier = [startId];
    let closing: Edge | null = null;
    const visited = new Set([startId]);
    while (frontier.length && !closing) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of (bySource.get(id) ?? []).filter((x) => members.has(x.targetId)).sort((a, b) => a.targetId.localeCompare(b.targetId))) {
          if (e.targetId === startId) {
            closing = e;
            break;
          }
          if (visited.has(e.targetId)) continue;
          visited.add(e.targetId);
          parents.set(e.targetId, e);
          next.push(e.targetId);
        }
        if (closing) break;
      }
      frontier = next;
    }
    if (!closing) continue;
    const edgesInCycle: Edge[] = [closing];
    for (let cursor = closing.sourceId; cursor !== startId; cursor = parents.get(cursor)!.sourceId) edgesInCycle.unshift(parents.get(cursor)!);
    const ents = graph.entities([startId, ...edgesInCycle.map((e) => e.targetId)]);
    const start = ents.get(startId);
    if (!start) continue;
    const steps = edgesInCycle.map((e) => step(ents.get(e.sourceId)!, ents.get(e.targetId)!, e));
    cycles.push({ nodes: [ref(start), ...steps.slice(0, -1).map((s) => s.to)], path: buildPath(steps, start, "forward"), componentSize: component.length });
  }
  return cycles.sort((a, b) => a.path.length - b.path.length || a.nodes[0]!.id.localeCompare(b.nodes[0]!.id));
}
