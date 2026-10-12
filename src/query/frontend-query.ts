import type { Entity, Relationship, RelationshipType } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

const FRONTEND_LANGUAGES = new Set(["typescript", "javascript"]);
/** Relationship types followed when tracing a frontend entry point to the backend that serves it. */
export const CHAIN_TYPES: RelationshipType[] = [
  "ROUTES_TO_COMPONENT", "LOADS_COMPONENT", "RENDERS", "USES_HOOK", "INJECTS", "CALLS", "CONSTRUCTS", "CONSUMES_CONTEXT",
  "CALLS_ENDPOINT", "CALLS_EXTERNAL_API", "IMPLEMENTED_BY", "PUBLISHES", "HANDLED_BY", "SENDS_TO", "CONSUMED_BY",
];

export interface ChainHop {
  entity: Entity;
  via: Relationship | null;
  depth: number;
  parent: string | null;
}

export interface FrontendChain {
  root: Entity;
  operations: { operation: Entity; path: ChainHop[] }[];
  external: { target: Entity; path: ChainHop[] }[];
  backend: { entity: Entity; path: ChainHop[] }[];
  unresolvedCalls: { caller: Entity; display: string; reason: string; location: string | null }[];
  visited: number;
  truncated: boolean;
}

export class FrontendQuery {
  constructor(private readonly store: GraphStore) {}

  isFrontend(e: Entity): boolean {
    return FRONTEND_LANGUAGES.has(e.language ?? "") || e.metadata.ecosystem === "npm" || e.metadata.applicationType === "frontend";
  }

  summary(repositoryId?: string) {
    const packages = this.store.findEntities({ kinds: ["Project"], repositoryId, limit: 100_000 }).filter((p) => p.metadata.ecosystem === "npm");
    const applications = this.store.findEntities({ kinds: ["Application"], repositoryId }).filter((a) => a.metadata.applicationType === "frontend");
    const symbols = this.store.findEntities({ kinds: ["Type", "Method", "Field", "Property"], repositoryId, limit: 1_000_000 }).filter((e) => this.isFrontend(e));
    const roles: Record<string, number> = {};
    for (const s of symbols) if (typeof s.metadata.frontendRole === "string") roles[s.metadata.frontendRole] = (roles[s.metadata.frontendRole] ?? 0) + 1;
    const routes = this.store.findEntities({ kinds: ["FrontendRoute"], repositoryId, limit: 100_000 });
    const files = this.store.findEntities({ kinds: ["File"], repositoryId, limit: 1_000_000 }).filter((f) => FRONTEND_LANGUAGES.has(f.language ?? ""));
    const symbolIds = new Set(symbols.map((s) => s.id));
    const calls = this.store.findRelationships({ types: ["CALLS_ENDPOINT", "CALLS_EXTERNAL_API"], repositoryId }).filter((r) => symbolIds.has(r.sourceId));
    const unresolved = this.store.findUnresolved({ repositoryId }).filter((u) => u.type === "CALLS_ENDPOINT" && symbolIds.has(u.sourceId));
    const imports = this.store.findRelationships({ types: ["IMPORTS", "TYPE_IMPORTS", "DYNAMIC_IMPORTS", "REQUIRES", "REFERENCES_MODULE", "RE_EXPORTS"], repositoryId, limit: 1_000_000 });
    return { packages, applications, files: files.length, symbols: symbols.length, roles, routes: routes.length, httpCalls: { resolved: calls.filter((c) => c.type === "CALLS_ENDPOINT").length, external: calls.filter((c) => c.type === "CALLS_EXTERNAL_API").length, unresolved: unresolved.length }, imports: imports.length };
  }

  components(repositoryId?: string, role?: string): Entity[] {
    return this.store
      .findEntities({ kinds: ["Type", "Method", "Field"], repositoryId, limit: 1_000_000 })
      .filter((e) => typeof e.metadata.frontendRole === "string" && (!role || e.metadata.frontendRole === role))
      .sort((a, b) => String(a.metadata.frontendRole).localeCompare(String(b.metadata.frontendRole)) || (a.qualifiedName ?? a.name).localeCompare(b.qualifiedName ?? b.name));
  }

  routes(repositoryId?: string, application?: string) {
    const routes = this.store.findEntities({ kinds: ["FrontendRoute"], repositoryId, limit: 100_000 });
    const out = this.store.findRelationships({ sourceIds: routes.map((r) => r.id), types: ["ROUTES_TO_COMPONENT", "LOADS_COMPONENT", "LOADS_MODULE", "GUARDED_BY", "RESOLVED_BY"] });
    const exposed = this.store.findRelationships({ targetIds: routes.map((r) => r.id), types: ["EXPOSES_ROUTE"] });
    const ents = new Map(this.store.findEntities({ ids: [...new Set([...out.map((r) => r.targetId), ...exposed.map((r) => r.sourceId)])] }).map((e) => [e.id, e]));
    return routes
      .map((route) => {
        const rels = out.filter((r) => r.sourceId === route.id);
        const pick = (t: RelationshipType) => rels.filter((r) => r.type === t).map((r) => ents.get(r.targetId)).filter((e): e is Entity => !!e);
        return { route, applications: exposed.filter((r) => r.targetId === route.id).map((r) => ents.get(r.sourceId)).filter((e): e is Entity => !!e), components: [...pick("ROUTES_TO_COMPONENT"), ...pick("LOADS_COMPONENT")], modules: pick("LOADS_MODULE"), guards: pick("GUARDED_BY"), resolvers: pick("RESOLVED_BY") };
      })
      .filter((r) => !application || r.applications.some((a) => a.name === application || a.id === application))
      .sort((a, b) => (a.applications[0]?.name ?? "").localeCompare(b.applications[0]?.name ?? "") || a.route.name.localeCompare(b.route.name));
  }

  /**
   * Trace from a frontend entry point (route, component, hook, service) forward through the graph to the API
   * operations it calls and the backend code that implements them. Only stored relationships are followed;
   * every hop carries its evidence level, and unresolved HTTP calls on the way are reported, not guessed.
   */
  /** A frontend variable used as a component (e.g. `const Page = withTelemetry(HomePage)`): its initializer's references are what actually renders. */
  private isComponentAlias(hop: ChainHop): boolean {
    return hop.entity.kind === "Field" && this.isFrontend(hop.entity) && !!hop.via && ["ROUTES_TO_COMPONENT", "LOADS_COMPONENT", "RENDERS", "USES_COMPONENT"].includes(hop.via.type);
  }

  chain(rootId: string, maxDepth = 12, maxNodes = 5000): FrontendChain | null {
    const root = this.store.getEntity(rootId);
    if (!root) return null;
    const hops = new Map<string, ChainHop>([[root.id, { entity: root, via: null, depth: 0, parent: null }]]);
    let frontier = [root.id];
    let truncated = false;
    for (let depth = 1; depth <= maxDepth && frontier.length && !truncated; depth++) {
      const rels = [...this.store.findRelationships({ sourceIds: frontier, types: CHAIN_TYPES }), ...this.store.findMetaRelationships({ sourceIds: frontier, types: ["CALLS_ENDPOINT", "CONSUMES_API"] })];
      const declares = this.store.findRelationships({ sourceIds: frontier.filter((id) => hops.get(id)!.via?.type === "HANDLED_BY" || (hops.get(id)!.entity.kind === "Type" && this.isFrontend(hops.get(id)!.entity))), types: ["DECLARES"] });
      const aliases = this.store.findRelationships({ sourceIds: frontier.filter((id) => this.isComponentAlias(hops.get(id)!)), types: ["REFERENCES"] });
      const extra = [...declares, ...aliases];
      const targets = new Map(this.store.findEntities({ ids: [...new Set([...rels, ...extra].map((r) => r.targetId))] }).map((e) => [e.id, e]));
      const next: string[] = [];
      for (const r of [...rels, ...extra].sort((a, b) => a.id.localeCompare(b.id))) {
        const target = targets.get(r.targetId);
        if (!target || hops.has(target.id) || target.kind === "Parameter") continue;
        hops.set(target.id, { entity: target, via: r, depth, parent: r.sourceId });
        next.push(target.id);
        if (hops.size >= maxNodes) {
          truncated = true;
          break;
        }
      }
      frontier = next;
    }
    const pathTo = (id: string): ChainHop[] => {
      const out: ChainHop[] = [];
      for (let cur: string | null = id; cur; cur = hops.get(cur)!.parent) out.unshift(hops.get(cur)!);
      return out;
    };
    const all = [...hops.values()];
    const sourceIds = all.filter((h) => this.isFrontend(h.entity)).map((h) => h.entity.id);
    const unresolved = sourceIds.length ? this.store.findUnresolved({ sourceIds }).filter((u) => u.type === "CALLS_ENDPOINT") : [];
    return {
      root,
      operations: all.filter((h) => h.entity.kind === "ApiOperation").map((h) => ({ operation: h.entity, path: pathTo(h.entity.id) })),
      external: all.filter((h) => h.entity.kind === "ExternalApi").map((h) => ({ target: h.entity, path: pathTo(h.entity.id) })),
      backend: all.filter((h) => (h.entity.kind === "Endpoint" || (h.entity.kind === "Method" && !h.entity.external && !this.isFrontend(h.entity))) && h.via && ["IMPLEMENTED_BY", "HANDLED_BY", "DECLARES", "CALLS"].includes(h.via.type) && pathTo(h.entity.id).some((p) => p.via?.type === "CALLS_ENDPOINT")).map((h) => ({ entity: h.entity, path: pathTo(h.entity.id) })),
      unresolvedCalls: unresolved.map((u) => ({ caller: hops.get(u.sourceId)!.entity, display: u.targetDisplay, reason: u.reason, location: u.provenance[0]?.location ? `${u.provenance[0].location.file}:${u.provenance[0].location.startLine}` : null })),
      visited: hops.size,
      truncated,
    };
  }
}
