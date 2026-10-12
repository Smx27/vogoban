import type { Entity, EntityKind, Provenance, Relationship, RelationshipType, UnresolvedReference } from "../graph/model.ts";
import type { GraphStore, TemporalInfo } from "../store/store.ts";

export type Direction = "out" | "in" | "both";

export interface TraversalStep {
  entity: Entity;
  depth: number;
  via: Relationship | null;
  parentId: string | null;
}

export interface Subgraph {
  entities: Entity[];
  relationships: Relationship[];
}

export interface ProvenanceReport {
  subject: Entity | Relationship | UnresolvedReference;
  subjectType: "entity" | "relationship" | "unresolved";
  provenance: Provenance[];
  temporal: TemporalInfo | null;
}

export const DEFAULT_DEPENDENCY_TYPES: Partial<Record<EntityKind, RelationshipType[]>> = {
  Project: ["PROJECT_REFERENCES", "PACKAGE_DEPENDS_ON", "ASSEMBLY_REFERENCES"],
  Method: ["CALLS", "CONSTRUCTS", "USES_TYPE", "USES_MEMBER", "READS_FIELD", "WRITES_FIELD", "RETURNS_TYPE", "PUBLISHES"],
  Type: ["INHERITS", "IMPLEMENTS", "EXTENDS", "INJECTS", "USES_TYPE"],
  Property: ["USES_TYPE", "CALLS", "USES_MEMBER"],
  Field: ["USES_TYPE"],
  Endpoint: ["ROUTES_TO", "ACCEPTS_REQUEST", "PRODUCES_RESPONSE"],
};

const MAX_FRONTIER = 5000;
export const REFERENCE_TYPES: RelationshipType[] = [
  "USES_TYPE", "CONSTRUCTS", "RETURNS_TYPE", "INHERITS", "IMPLEMENTS", "EXTENDS", "THROWS", "ATTRIBUTED_WITH",
  "CALLS", "USES_MEMBER", "READS_FIELD", "WRITES_FIELD", "OVERRIDES",
];
const FRAMEWORK_ASSEMBLY = /^(System|Microsoft\.(AspNetCore|Extensions|NETCore|Win32|CSharp|VisualBasic|JSInterop)|netstandard|mscorlib|WindowsBase)(\.|$)/;

export class GraphQuery {
  constructor(private readonly store: GraphStore) {}

  entity(id: string): Entity | null {
    return this.store.getEntity(id);
  }

  resolve(ref: string, options: { kinds?: EntityKind[]; repositoryId?: string } = {}): Entity[] {
    const scoped = { kinds: options.kinds, repositoryId: options.repositoryId, limit: 50 };
    const byId = this.store.getEntity(ref);
    if (byId) return [byId];
    for (const filter of [{ symbolKey: ref }, { qualifiedName: ref }]) {
      const found = this.store.findEntities({ ...scoped, ...filter });
      if (found.length) return found;
    }
    const exactName = this.store.findEntities({ ...scoped, nameLike: ref }).filter((e) => e.name === ref || e.qualifiedName?.split("(")[0] === ref);
    if (exactName.length) return exactName;
    return this.store.findEntities({ ...scoped, nameLike: ref });
  }

  find(filter: Parameters<GraphStore["findEntities"]>[0]): Entity[] {
    return this.store.findEntities(filter);
  }

  outgoing(id: string, types?: RelationshipType[]): Relationship[] {
    return this.store.findRelationships({ sourceIds: [id], types });
  }

  incoming(id: string, types?: RelationshipType[]): Relationship[] {
    return this.store.findRelationships({ targetIds: [id], types });
  }

  traverse(startId: string, options: { direction: Direction; types?: RelationshipType[]; maxDepth: number }): TraversalStep[] {
    const start = this.store.getEntity(startId);
    if (!start) return [];
    const steps: TraversalStep[] = [{ entity: start, depth: 0, via: null, parentId: null }];
    const seen = new Set([startId]);
    let frontier = [startId];
    for (let depth = 1; depth <= options.maxDepth && frontier.length; depth++) {
      const rels: { rel: Relationship; next: string; parent: string }[] = [];
      if (options.direction !== "in") {
        for (const rel of this.store.findRelationships({ sourceIds: frontier, types: options.types })) rels.push({ rel, next: rel.targetId, parent: rel.sourceId });
      }
      if (options.direction !== "out") {
        for (const rel of this.store.findRelationships({ targetIds: frontier, types: options.types })) rels.push({ rel, next: rel.sourceId, parent: rel.targetId });
      }
      const nextIds = rels.filter((r) => !seen.has(r.next)).map((r) => r.next);
      const entities = new Map(this.store.findEntities({ ids: [...new Set(nextIds)] }).map((e) => [e.id, e]));
      frontier = [];
      for (const { rel, next, parent } of rels) {
        if (seen.has(next)) continue;
        const entity = entities.get(next);
        if (!entity) continue;
        seen.add(next);
        frontier.push(next);
        steps.push({ entity, depth, via: rel, parentId: parent });
      }
      if (frontier.length > MAX_FRONTIER) frontier = frontier.slice(0, MAX_FRONTIER);
    }
    return steps;
  }

  neighborhood(id: string, depth = 1, types?: RelationshipType[]): Subgraph {
    const steps = this.traverse(id, { direction: "both", types, maxDepth: depth });
    const ids = new Set(steps.map((s) => s.entity.id));
    const relationships = this.store
      .findRelationships({ sourceIds: [...ids], types })
      .filter((r) => ids.has(r.targetId));
    return { entities: steps.map((s) => s.entity), relationships };
  }

  dependencies(id: string, options: { reverse?: boolean; depth?: number; types?: RelationshipType[] } = {}): TraversalStep[] {
    const entity = this.store.getEntity(id);
    if (!entity) return [];
    const types = options.types ?? DEFAULT_DEPENDENCY_TYPES[entity.kind];
    return this.traverse(id, { direction: options.reverse ? "in" : "out", types, maxDepth: options.depth ?? 1 });
  }

  callers(id: string, depth = 1, dispatch = false): TraversalStep[] {
    const steps = this.traverse(id, { direction: "in", types: ["CALLS"], maxDepth: depth });
    if (!dispatch) return steps;
    const seen = new Set(steps.map((s) => s.entity.id));
    for (const contract of this.traverse(id, { direction: "out", types: ["IMPLEMENTS", "OVERRIDES"], maxDepth: 10 }).slice(1)) {
      for (const step of this.traverse(contract.entity.id, { direction: "in", types: ["CALLS"], maxDepth: depth }).slice(1)) {
        if (seen.has(step.entity.id)) continue;
        seen.add(step.entity.id);
        steps.push({ ...step, parentId: id });
      }
    }
    return steps;
  }

  implementations(id: string): TraversalStep[] {
    return this.traverse(id, { direction: "in", types: ["IMPLEMENTS", "INHERITS", "EXTENDS", "OVERRIDES"], maxDepth: 10 });
  }

  inheritance(id: string): { ancestors: TraversalStep[]; descendants: TraversalStep[] } {
    const types: RelationshipType[] = ["INHERITS", "IMPLEMENTS", "EXTENDS", "OVERRIDES"];
    return {
      ancestors: this.traverse(id, { direction: "out", types, maxDepth: 20 }),
      descendants: this.traverse(id, { direction: "in", types, maxDepth: 20 }),
    };
  }

  references(id: string, types: RelationshipType[] = REFERENCE_TYPES): { relationship: Relationship; source: Entity }[] {
    const rels = this.store.findRelationships({ targetIds: [id], types });
    const sources = new Map(this.store.findEntities({ ids: [...new Set(rels.map((r) => r.sourceId))] }).map((e) => [e.id, e]));
    return rels
      .map((relationship) => ({ relationship, source: sources.get(relationship.sourceId)! }))
      .filter((r) => r.source && r.source.kind !== "Parameter")
      .sort((a, b) => (a.source.qualifiedName ?? a.source.name).localeCompare(b.source.qualifiedName ?? b.source.name) || a.relationship.type.localeCompare(b.relationship.type));
  }

  callees(id: string, depth = 1): TraversalStep[] {
    return this.traverse(id, { direction: "out", types: ["CALLS"], maxDepth: depth });
  }

  path(fromId: string, toId: string, options: { maxDepth?: number; types?: RelationshipType[]; direction?: Direction } = {}): Relationship[] | null {
    const maxDepth = options.maxDepth ?? 8;
    const direction = options.direction ?? "out";
    const previous = new Map<string, Relationship | null>([[fromId, null]]);
    let frontier = [fromId];
    for (let depth = 0; depth < maxDepth && frontier.length && !previous.has(toId); depth++) {
      const next: string[] = [];
      const consider = (rel: Relationship, nodeId: string) => {
        if (previous.has(nodeId)) return;
        previous.set(nodeId, rel);
        next.push(nodeId);
      };
      if (direction !== "in") for (const rel of this.store.findRelationships({ sourceIds: frontier, types: options.types })) consider(rel, rel.targetId);
      if (direction !== "out") for (const rel of this.store.findRelationships({ targetIds: frontier, types: options.types })) consider(rel, rel.sourceId);
      frontier = next.slice(0, MAX_FRONTIER);
    }
    if (!previous.has(toId)) return null;
    const chain: Relationship[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const rel = previous.get(cursor);
      if (!rel) break;
      chain.unshift(rel);
      cursor = rel.targetId === cursor ? rel.sourceId : rel.targetId;
    }
    return chain;
  }

  provenance(id: string): ProvenanceReport | null {
    const entity = this.store.getEntity(id);
    if (entity) return { subject: entity, subjectType: "entity", provenance: entity.provenance, temporal: this.store.temporal(id) };
    const rel = this.store.getRelationship(id);
    if (rel) return { subject: rel, subjectType: "relationship", provenance: rel.provenance, temporal: this.store.temporal(id) };
    const unresolved = this.store.findUnresolved({}).find((u) => u.id === id);
    if (unresolved) return { subject: unresolved, subjectType: "unresolved", provenance: unresolved.provenance, temporal: null };
    return null;
  }

  projectGraph(repositoryId: string): { projects: Entity[]; references: Relationship[]; cycles: string[][] } {
    const projects = this.store.findEntities({ repositoryId, kinds: ["Project"] });
    const references = this.store.findRelationships({ repositoryId, types: ["PROJECT_REFERENCES"] });
    return { projects, references, cycles: findCycles(projects.map((p) => p.id), references) };
  }

  sharedAcrossRepositories(includeFramework = false): { entity: Entity; repositories: string[] }[] {
    const repositories = new Map<string, Set<string>>();
    for (const rel of this.store.iterateRelationships()) {
      if (!rel.repositoryId) continue;
      const set = repositories.get(rel.targetId) ?? new Set<string>();
      set.add(rel.repositoryId);
      repositories.set(rel.targetId, set);
    }
    const shared = [...repositories].filter(([, repos]) => repos.size > 1);
    const entities = new Map(this.store.findEntities({ ids: shared.map(([id]) => id) }).map((e) => [e.id, e]));
    const results = shared
      .map(([id, repos]) => ({ entity: entities.get(id)!, repositories: [...repos].sort() }))
      .filter((r) => r.entity && (r.entity.repositoryId === null || r.entity.external || r.repositories.some((repo) => repo !== r.entity.repositoryId)))
      .filter((r) => includeFramework || r.entity.kind === "Package" || (r.entity.kind === "Type" && !FRAMEWORK_ASSEMBLY.test(r.entity.assembly ?? "")));
    const bySymbol = new Map<string, Entity[]>();
    for (const e of this.store.iterateEntities()) {
      if (!e.symbolKey || e.external || !e.repositoryId) continue;
      bySymbol.set(e.symbolKey, [...(bySymbol.get(e.symbolKey) ?? []), e]);
    }
    for (const group of bySymbol.values()) {
      const repos = new Set(group.map((e) => e.repositoryId!));
      if (repos.size > 1) results.push({ entity: group[0]!, repositories: [...repos].sort() });
    }
    return results.sort((a, b) => (a.entity.qualifiedName ?? a.entity.name).localeCompare(b.entity.qualifiedName ?? b.entity.name));
  }
}

export function findCycles(nodes: string[], edges: Relationship[]): string[][] {
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) adjacency.get(e.sourceId)?.push(e.targetId);
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const connect = (v: string) => {
    indices.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, indices.get(w)!));
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (adjacency.get(v) ?? []).includes(v)) cycles.push(component.sort());
    }
  };
  for (const n of nodes) if (!indices.has(n)) connect(n);
  return cycles;
}
