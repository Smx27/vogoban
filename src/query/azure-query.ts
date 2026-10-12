import type { Entity, Relationship, RelationshipType } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

/**
 * Azure views over the existing graph. Nothing here derives new facts: every row is a stored
 * entity or relationship, and traversals follow stored relationships only.
 */

/** Relationships followed downstream ("what happens next"), in message/data flow direction. */
const FORWARD: RelationshipType[] = [
  "TRIGGERS", "CHANGE_FEED", "SUBSCRIBES_TO", "IMPLEMENTED_BY", "ROUTES_TO", "CALLS", "INJECTS", "RESOLVES_TO", "PUBLISHES_TO", "SENDS_TO", "SENDS_MESSAGE", "PUBLISHES_EVENT", "PUBLISHES",
  "WRITES_TO", "READS_FROM", "CONSUMED_BY", "HANDLED_BY", "INVOKES_ACTIVITY", "STARTS_ORCHESTRATION", "CALLS_SUB_ORCHESTRATION", "USES_DURABLE_ENTITY", "USES_DATABASE", "READS_SECRET_FROM",
  "CALLS_ENDPOINT", "ROUTES_TO_COMPONENT", "LOADS_COMPONENT", "RENDERS", "USES_HOOK", "ROUTES_TRAFFIC_TO", "SHARES_RESOURCE", "DECLARED_BY", "HOSTED_ON", "DEPLOYED_TO",
];
/** Relationships whose reverse direction is also flow (interface dispatch: CALLS → interface member ← IMPLEMENTS implementation). */
const FORWARD_REVERSED: RelationshipType[] = ["IMPLEMENTS", "OVERRIDES"];
const BACKWARD: RelationshipType[] = FORWARD.filter((t) => !["HOSTED_ON", "DEPLOYED_TO"].includes(t)).concat(["EXPOSES_ROUTE", "DECLARES", "CREATES"]);
/** Upstream from a data/messaging resource also lists what consumes it (it depends on the resource as much as producers do). */
const CONSUMERS: RelationshipType[] = ["TRIGGERS", "CHANGE_FEED", "SUBSCRIBES_TO", "CONSUMED_BY"];
const RESOURCE_KINDS = new Set(["Topic", "Queue", "Database", "Storage", "AzureResource"]);

export interface FlowHop {
  entity: Entity;
  via: { id: string; type: string; evidence: string; reversed: boolean; scope: "repository" | "meta" } | null;
  depth: number;
  parent: string | null;
}

export interface FlowResult {
  root: Entity;
  direction: "downstream" | "upstream";
  hops: FlowHop[];
  paths: { target: Entity; path: FlowHop[] }[];
  truncated: boolean;
}

const TERMINALS_DOWN = new Set(["AzureResource", "Database", "Storage", "Topic", "Queue", "AzureFunction", "ApiOperation", "Endpoint", "ExternalSystem", "Message"]);
const TERMINALS_UP = new Set(["FrontendRoute", "ApiOperation", "Endpoint", "AzureFunction", "Application", "Topic", "Queue"]);

export class AzureQuery {
  constructor(private readonly store: GraphStore) {}

  private byIds(ids: string[]): Map<string, Entity> {
    const unique = [...new Set(ids)];
    const found = this.store.findEntities({ ids: unique });
    const missing = unique.filter((id) => !found.some((e) => e.id === id));
    return new Map([...found, ...(missing.length ? this.store.findMetaEntities({ ids: missing }) : [])].map((e) => [e.id, e]));
  }

  private rels(ids: string[], types: RelationshipType[], direction: "out" | "in"): Relationship[] {
    if (!ids.length) return [];
    const out: Relationship[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const batch = ids.slice(i, i + 400);
      out.push(...this.store.findRelationships(direction === "out" ? { sourceIds: batch, types } : { targetIds: batch, types }));
      out.push(...this.store.findMetaRelationships(direction === "out" ? { sourceIds: batch, types } : { targetIds: batch, types }));
    }
    return out;
  }

  functions(repositoryId?: string) {
    const fns = this.store.findEntities({ kinds: ["AzureFunction"], repositoryId, limit: 100_000 });
    const ids = fns.map((f) => f.id);
    const incoming = this.rels(ids, ["TRIGGERS", "CHANGE_FEED"], "in");
    const outgoing = this.rels(ids, ["READS_FROM", "WRITES_TO", "PUBLISHES_TO", "PUBLISHES_EVENT", "HOSTED_ON", "INVOKES_ACTIVITY", "STARTS_ORCHESTRATION", "CALLS_SUB_ORCHESTRATION", "USES_DURABLE_ENTITY"], "out");
    const ents = this.byIds([...incoming.map((r) => r.sourceId), ...outgoing.map((r) => r.targetId)]);
    return fns
      .map((fn) => ({
        function: fn,
        triggers: incoming.filter((r) => r.targetId === fn.id).map((r) => ({ type: r.type, source: ents.get(r.sourceId) ?? null, evidence: r.evidence, metadata: r.metadata })),
        bindings: outgoing.filter((r) => r.sourceId === fn.id && !["HOSTED_ON"].includes(r.type)).map((r) => ({ type: r.type, target: ents.get(r.targetId) ?? null, evidence: r.evidence, metadata: r.metadata })),
        hosting: outgoing.filter((r) => r.sourceId === fn.id && r.type === "HOSTED_ON").map((r) => ents.get(r.targetId)).filter((e): e is Entity => !!e),
      }))
      .sort((a, b) => (a.function.qualifiedName ?? a.function.name).localeCompare(b.function.qualifiedName ?? b.function.name));
  }

  resources(repositoryId?: string, kind?: string) {
    const list = this.store.findEntities({ kinds: ["AzureResource"], repositoryId, limit: 1_000_000 }).filter((e) => !kind || e.metadata.azureKind === kind || e.metadata.service === kind || String(e.metadata.armType ?? "").toLowerCase() === kind.toLowerCase());
    const declared = this.rels(list.map((e) => e.id), ["DECLARED_BY"], "in");
    return list
      .map((resource) => ({ resource, codeReferences: declared.filter((r) => r.targetId === resource.id).length }))
      .sort((a, b) => String(a.resource.metadata.armType ?? "").localeCompare(String(b.resource.metadata.armType ?? "")) || a.resource.name.localeCompare(b.resource.name));
  }

  triggers(repositoryId?: string) {
    return this.functions(repositoryId).flatMap((f) => (f.triggers.length ? f.triggers : [{ type: "TRIGGERS", source: null, evidence: "UNKNOWN", metadata: {} }]).map((t) => ({ function: f.function, ...t })));
  }

  messaging(repositoryId?: string) {
    const transports = this.store.findEntities({ kinds: ["Topic", "Queue"], repositoryId, limit: 100_000 }).filter((t) => /^azure-/.test(String(t.metadata.broker ?? "")));
    const ids = transports.map((t) => t.id);
    const inRels = this.rels(ids, ["PUBLISHES_TO", "SENDS_TO", "SENDS_MESSAGE", "PUBLISHES_EVENT", "CONSUMES_FROM", "RECEIVES_MESSAGE", "SUBSCRIBES_TO", "WRITES_TO"], "in");
    const outRels = this.rels(ids, ["TRIGGERS", "SUBSCRIBES_TO", "CONSUMED_BY", "ROUTES_TO", "CARRIES", "DECLARED_BY", "CHANGE_FEED"], "out");
    const ents = this.byIds([...inRels.map((r) => r.sourceId), ...outRels.map((r) => r.targetId)]);
    const pick = (list: Relationship[], side: "sourceId" | "targetId") => list.map((r) => ({ type: r.type, entity: ents.get(r[side]) ?? null, evidence: r.evidence }));
    return transports
      .map((t) => ({
        transport: t,
        publishers: pick(inRels.filter((r) => r.targetId === t.id && ["PUBLISHES_TO", "SENDS_TO", "SENDS_MESSAGE", "PUBLISHES_EVENT", "WRITES_TO"].includes(r.type)), "sourceId"),
        receivers: pick(inRels.filter((r) => r.targetId === t.id && ["CONSUMES_FROM", "RECEIVES_MESSAGE"].includes(r.type)), "sourceId"),
        subscriptions: pick(outRels.filter((r) => r.sourceId === t.id && r.type === "SUBSCRIBES_TO"), "targetId"),
        consumers: pick(outRels.filter((r) => r.sourceId === t.id && ["TRIGGERS", "CONSUMED_BY", "ROUTES_TO"].includes(r.type)), "targetId"),
        messages: pick(outRels.filter((r) => r.sourceId === t.id && r.type === "CARRIES"), "targetId"),
        declaredBy: pick(outRels.filter((r) => r.sourceId === t.id && r.type === "DECLARED_BY"), "targetId"),
      }))
      .sort((a, b) => String(a.transport.metadata.broker).localeCompare(String(b.transport.metadata.broker)) || a.transport.name.localeCompare(b.transport.name));
  }

  infrastructure(repositoryId?: string) {
    const files = this.store.findEntities({ kinds: ["File"], repositoryId, limit: 1_000_000 }).filter((f) => /\.(bicep|bicepparam|tf|tfvars)$|\.tfvars\.json$/i.test(f.qualifiedName ?? "") || f.language === "arm");
    const creates = this.rels(files.map((f) => f.id), ["CREATES", "REFERENCES_RESOURCE", "USES_MODULE"], "out");
    const ents = this.byIds(creates.map((r) => r.targetId));
    const resources = this.store.findEntities({ kinds: ["AzureResource"], repositoryId, limit: 1_000_000 });
    const ids = resources.map((r) => r.id);
    const relationships = this.rels(ids, ["HOSTED_ON", "USES_IDENTITY", "HAS_ROLE_ON", "PRIVATE_ENDPOINT_FOR", "IN_SUBNET", "OBSERVED_BY", "LOGS_TO", "ROUTES_TRAFFIC_TO", "READS_SECRET_FROM", "DEPENDS_ON_RESOURCE", "PUBLISHES_EVENT", "SUBSCRIBES_TO"], "out");
    const hostedApps = this.rels(ids, ["HOSTED_ON", "DEPLOYED_TO"], "in");
    const targets = this.byIds([...relationships.map((r) => r.targetId), ...hostedApps.map((r) => r.sourceId)]);
    return {
      files: files.map((f) => ({ file: f, creates: creates.filter((r) => r.sourceId === f.id && r.type === "CREATES").map((r) => ents.get(r.targetId)).filter((e): e is Entity => !!e), references: creates.filter((r) => r.sourceId === f.id && r.type === "REFERENCES_RESOURCE").length, modules: creates.filter((r) => r.sourceId === f.id && r.type === "USES_MODULE").map((r) => ents.get(r.targetId)?.qualifiedName ?? r.targetId) })).filter((f) => f.creates.length || f.references || f.modules.length),
      relationships: relationships.map((r) => ({ type: r.type, source: resources.find((x) => x.id === r.sourceId)!, target: targets.get(r.targetId) ?? null, evidence: r.evidence, metadata: r.metadata })),
      hosting: hostedApps.map((r) => ({ type: r.type, application: targets.get(r.sourceId) ?? null, resource: resources.find((x) => x.id === r.targetId)!, evidence: r.evidence, metadata: r.metadata })),
    };
  }

  /**
   * Architecture flow through stored relationships. Downstream follows message/data/call flow
   * ("what happens when this event enters the system"); upstream walks it backwards ("what reaches
   * this Function", up to frontend routes). Paths end at architectural terminals.
   */
  flow(rootId: string, direction: "downstream" | "upstream", maxDepth = 14, maxNodes = 4000, exclude: RelationshipType[] = []): FlowResult | null {
    const root = this.byIds([rootId]).get(rootId);
    if (!root) return null;
    const hops = new Map<string, FlowHop>([[root.id, { entity: root, via: null, depth: 0, parent: null }]]);
    let frontier = [root.id];
    let truncated = false;
    for (let depth = 1; depth <= maxDepth && frontier.length && !truncated; depth++) {
      const edges: { rel: Relationship; next: string; reversed: boolean }[] = [];
      if (direction === "downstream") {
        for (const r of this.rels(frontier, FORWARD, "out")) edges.push({ rel: r, next: r.targetId, reversed: false });
        for (const r of this.rels(frontier, FORWARD_REVERSED, "in")) edges.push({ rel: r, next: r.sourceId, reversed: true });
      } else {
        for (const r of this.rels(frontier, BACKWARD, "in")) edges.push({ rel: r, next: r.sourceId, reversed: true });
        for (const r of this.rels(frontier.filter((id) => RESOURCE_KINDS.has(hops.get(id)!.entity.kind)), CONSUMERS, "out")) edges.push({ rel: r, next: r.targetId, reversed: false });
        for (const r of this.rels(frontier, FORWARD_REVERSED, "out")) edges.push({ rel: r, next: r.targetId, reversed: false });
      }
      const ents = this.byIds(edges.map((e) => e.next));
      const next: string[] = [];
      for (const e of edges.sort((a, b) => a.rel.id.localeCompare(b.rel.id))) {
        if (exclude.includes(e.rel.type)) continue;
        const target = ents.get(e.next);
        if (!target || hops.has(target.id) || target.kind === "Parameter" || target.kind === "File" || (target.external && target.kind !== "ExternalSystem")) continue;
        if (direction === "upstream" && e.rel.type === "DECLARES" && target.kind !== "Type") continue;
        hops.set(target.id, { entity: target, via: { id: e.rel.id, type: e.rel.type, evidence: e.rel.evidence, reversed: e.reversed, scope: e.rel.metadata.graphScope === "meta" ? "meta" : "repository" }, depth, parent: hops.get(e.rel.sourceId === target.id ? e.rel.targetId : e.rel.sourceId)?.entity.id ?? null });
        next.push(target.id);
        if (hops.size >= maxNodes) {
          truncated = true;
          break;
        }
      }
      frontier = next;
    }
    const pathTo = (id: string): FlowHop[] => {
      const out: FlowHop[] = [];
      for (let cur: string | null = id; cur; cur = hops.get(cur)?.parent ?? null) out.unshift(hops.get(cur)!);
      return out;
    };
    const terminals = direction === "downstream" ? TERMINALS_DOWN : TERMINALS_UP;
    const all = [...hops.values()].filter((h) => h.depth > 0);
    return {
      root, direction, hops: all, truncated,
      paths: all.filter((h) => terminals.has(h.entity.kind)).map((h) => ({ target: h.entity, path: pathTo(h.entity.id) })).sort((a, b) => a.path.length - b.path.length || a.target.name.localeCompare(b.target.name)),
    };
  }

  summary(repositoryId?: string) {
    const count = (kinds: Entity["kind"][], pred: (e: Entity) => boolean = () => true) => this.store.findEntities({ kinds, repositoryId, limit: 1_000_000 }).filter(pred).length;
    const fns = this.functions(repositoryId);
    const resources = this.store.findEntities({ kinds: ["AzureResource"], repositoryId, limit: 1_000_000 });
    const byService: Record<string, number> = {};
    for (const r of resources) byService[String(r.metadata.service ?? "other")] = (byService[String(r.metadata.service ?? "other")] ?? 0) + 1;
    const unresolved = this.store.findUnresolved({ repositoryId, limit: 1_000_000 }).filter((u) => u.resolver.startsWith("azure."));
    return {
      functions: fns.length,
      triggers: Object.fromEntries([...new Set(fns.map((f) => String(f.function.metadata.triggerType)))].sort().map((t) => [t, fns.filter((f) => String(f.function.metadata.triggerType) === t).length])),
      resources: resources.length,
      byService,
      declaredBy: Object.fromEntries(["bicep", "arm", "terraform", "aspire"].map((l) => [l, resources.filter((r) => (r.metadata.declaredIn as string[] | undefined)?.includes(l)).length])),
      logicalResources: count(["Topic", "Queue", "Database", "Storage"], (e) => typeof e.metadata.azureKind === "string"),
      unresolved: unresolved.length,
      unresolvedByCategory: unresolved.reduce<Record<string, number>>((acc, u) => ((acc[String(u.metadata.category ?? "other")] = (acc[String(u.metadata.category ?? "other")] ?? 0) + 1), acc), {}),
    };
  }
}
