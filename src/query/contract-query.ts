import type { Entity, Relationship, UnresolvedReference } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export interface OperationDetail {
  operation: Entity;
  api: Entity | null;
  implementations: Entity[];
  consumers: { caller: Entity; relationship: Relationship }[];
  requests: { schema: Entity; relationship: Relationship }[];
  responses: { schema: Entity; relationship: Relationship }[];
  unresolved: UnresolvedReference[];
}

export interface MessageDetail {
  message: Entity;
  schemaType: Entity | null;
  publishers: { publisher: Entity; relationship: Relationship }[];
  consumers: { consumer: Entity; relationship: Relationship }[];
  transports: { transport: Entity; relationship: Relationship }[];
}

const CONTRACT_RESOLVERS = /^(contracts\.|dotnet\.messaging\.|dotnet\.http-clients)/;

export class ContractQuery {
  constructor(private readonly store: GraphStore) {}

  private entities(ids: string[]): Map<string, Entity> {
    return new Map(this.store.findEntities({ ids: [...new Set(ids)] }).map((e) => [e.id, e]));
  }

  apis(repositoryId?: string): { api: Entity; operations: number }[] {
    const apis = this.store.findEntities({ kinds: ["Api"], repositoryId });
    const contains = this.store.findRelationships({ sourceIds: apis.map((a) => a.id), types: ["CONTAINS"] });
    const ops = this.entities(contains.map((r) => r.targetId));
    return apis.map((api) => ({ api, operations: contains.filter((r) => r.sourceId === api.id && ops.get(r.targetId)?.kind === "ApiOperation").length }));
  }

  operations(filter: { repositoryId?: string; method?: string; path?: string; source?: string; api?: string }): Entity[] {
    let ops = this.store.findEntities({ kinds: ["ApiOperation"], repositoryId: filter.repositoryId });
    if (filter.method) ops = ops.filter((o) => String(o.metadata.method).toUpperCase() === filter.method!.toUpperCase());
    if (filter.path) ops = ops.filter((o) => String(o.metadata.path).toLowerCase().includes(filter.path!.toLowerCase()));
    if (filter.source) ops = ops.filter((o) => String(o.metadata.contractSource).includes(filter.source!));
    if (filter.api) ops = ops.filter((o) => (o.qualifiedName ?? "").toLowerCase().startsWith(filter.api!.toLowerCase()));
    return ops.sort((a, b) => String(a.metadata.path).localeCompare(String(b.metadata.path)) || String(a.metadata.method).localeCompare(String(b.metadata.method)) || (a.qualifiedName ?? "").localeCompare(b.qualifiedName ?? ""));
  }

  operation(id: string): OperationDetail | null {
    const operation = this.store.getEntity(id);
    if (!operation || operation.kind !== "ApiOperation") return null;
    const out = this.store.findRelationships({ sourceIds: [id] });
    const incoming = this.store.findRelationships({ targetIds: [id] });
    const related = this.entities([...out.map((r) => r.targetId), ...incoming.map((r) => r.sourceId)]);
    const pick = (rels: Relationship[], type: string, side: "targetId" | "sourceId") => rels.filter((r) => r.type === type).flatMap((r) => (related.get(r[side]) ? [{ entity: related.get(r[side])!, relationship: r }] : []));
    return {
      operation,
      api: pick(incoming, "CONTAINS", "sourceId").find((x) => x.entity.kind === "Api")?.entity ?? null,
      implementations: pick(out, "IMPLEMENTED_BY", "targetId").map((x) => x.entity),
      consumers: pick(incoming, "CALLS_ENDPOINT", "sourceId").map((x) => ({ caller: x.entity, relationship: x.relationship })),
      requests: pick(out, "ACCEPTS_REQUEST", "targetId").map((x) => ({ schema: x.entity, relationship: x.relationship })),
      responses: pick(out, "PRODUCES_RESPONSE", "targetId").map((x) => ({ schema: x.entity, relationship: x.relationship })),
      unresolved: this.store.findUnresolved({ sourceIds: [id] }),
    };
  }

  messages(repositoryId?: string): MessageDetail[] {
    return this.store.findEntities({ kinds: ["Message"], repositoryId }).map((m) => this.message(m.id)!).filter(Boolean);
  }

  message(id: string): MessageDetail | null {
    const message = this.store.getEntity(id);
    if (!message || message.kind !== "Message") return null;
    const out = this.store.findRelationships({ sourceIds: [id] });
    const incoming = this.store.findRelationships({ targetIds: [id] });
    const related = this.entities([...out.map((r) => r.targetId), ...incoming.map((r) => r.sourceId)]);
    const join = (rels: Relationship[], types: string[], side: "targetId" | "sourceId") =>
      rels.filter((r) => types.includes(r.type)).flatMap((r) => (related.get(r[side]) ? [{ entity: related.get(r[side])!, relationship: r }] : []));
    return {
      message,
      schemaType: join(out, ["USES_TYPE"], "targetId")[0]?.entity ?? null,
      publishers: join(incoming, ["PUBLISHES"], "sourceId").map((x) => ({ publisher: x.entity, relationship: x.relationship })),
      consumers: join(out, ["CONSUMED_BY", "HANDLED_BY"], "targetId").map((x) => ({ consumer: x.entity, relationship: x.relationship })),
      transports: join(incoming, ["CARRIES"], "sourceId").map((x) => ({ transport: x.entity, relationship: x.relationship })),
    };
  }

  transports(repositoryId?: string): { transport: Entity; senders: Entity[]; receivers: Entity[]; messages: Entity[]; routes: Entity[] }[] {
    const transports = this.store.findEntities({ kinds: ["Topic", "Queue"], repositoryId });
    const ids = transports.map((t) => t.id);
    const incoming = this.store.findRelationships({ targetIds: ids, types: ["SENDS_TO", "ROUTES_MESSAGE"] });
    const out = this.store.findRelationships({ sourceIds: ids, types: ["ROUTES_TO", "CARRIES", "ROUTES_MESSAGE"] });
    const related = this.entities([...incoming.map((r) => r.sourceId), ...out.map((r) => r.targetId)]);
    return transports.map((transport) => ({
      transport,
      senders: incoming.filter((r) => r.targetId === transport.id && r.type === "SENDS_TO").flatMap((r) => related.get(r.sourceId) ?? []),
      receivers: out.filter((r) => r.sourceId === transport.id && r.type === "ROUTES_TO").flatMap((r) => related.get(r.targetId) ?? []),
      messages: out.filter((r) => r.sourceId === transport.id && r.type === "CARRIES").flatMap((r) => related.get(r.targetId) ?? []),
      routes: out.filter((r) => r.sourceId === transport.id && r.type === "ROUTES_MESSAGE").flatMap((r) => related.get(r.targetId) ?? []),
    }));
  }

  httpClients(repositoryId?: string): { client: Entity; users: Entity[]; typedClient: Entity | null }[] {
    const clients = this.store.findEntities({ kinds: ["HttpClient"], repositoryId });
    const incoming = this.store.findRelationships({ targetIds: clients.map((c) => c.id), types: ["USES_CLIENT"] });
    const out = this.store.findRelationships({ sourceIds: clients.map((c) => c.id), types: ["RESOLVES_TO"] });
    const related = this.entities([...incoming.map((r) => r.sourceId), ...out.map((r) => r.targetId)]);
    return clients.map((client) => ({
      client,
      users: incoming.filter((r) => r.targetId === client.id && r.metadata.role !== "registration").flatMap((r) => related.get(r.sourceId) ?? []),
      typedClient: related.get(out.find((r) => r.sourceId === client.id)?.targetId ?? "") ?? null,
    }));
  }

  httpCalls(repositoryId?: string): { resolved: Relationship[]; external: Relationship[]; unresolved: UnresolvedReference[]; entities: Map<string, Entity> } {
    const resolved = this.store.findRelationships({ types: ["CALLS_ENDPOINT"], repositoryId });
    const external = this.store.findRelationships({ types: ["CALLS_EXTERNAL_API"], repositoryId }).filter((r) => r.metadata.verb !== undefined);
    const unresolved = this.store.findUnresolved({ repositoryId }).filter((u) => u.type === "CALLS_ENDPOINT");
    return { resolved, external, unresolved, entities: this.entities([...resolved, ...external].flatMap((r) => [r.sourceId, r.targetId]).concat(unresolved.map((u) => u.sourceId))) };
  }

  unresolved(repositoryId?: string): UnresolvedReference[] {
    return this.store.findUnresolved({ repositoryId }).filter((u) => CONTRACT_RESOLVERS.test(u.resolver));
  }

  statistics(repositoryId?: string): [string, number][] {
    const count = (kind: Entity["kind"], predicate: (e: Entity) => boolean = () => true) => this.store.findEntities({ kinds: [kind], repositoryId }).filter(predicate).length;
    const rels = (type: Relationship["type"]) => this.store.findRelationships({ types: [type], repositoryId });
    const unresolved = this.unresolved(repositoryId);
    const ops = this.store.findEntities({ kinds: ["ApiOperation"], repositoryId });
    const transports = this.store.findEntities({ kinds: ["Topic", "Queue"], repositoryId });
    return [
      ["APIs", count("Api")],
      ["API Operations", ops.length],
      ["  From OpenAPI", ops.filter((o) => o.metadata.contractSource === "openapi").length],
      ["  Code-first", ops.filter((o) => o.metadata.contractSource === "aspnetcore-code").length],
      ["  OpenAPI Without Implementation", ops.filter((o) => o.metadata.contractSource === "openapi" && o.metadata.implementationStatus !== "implemented").length],
      ["OpenAPI Documents", count("ContractDocument")],
      ["Schemas", count("ApiSchema")],
      ["HTTP Clients", count("HttpClient")],
      ["HTTP Client Calls", new Set(rels("CALLS_ENDPOINT").map((r) => `${r.sourceId}|${JSON.stringify(r.provenance[0]?.location)}`)).size + rels("CALLS_EXTERNAL_API").filter((r) => r.metadata.verb !== undefined).length + unresolved.filter((u) => u.type === "CALLS_ENDPOINT").length],
      ["  Resolved To Operations", new Set(rels("CALLS_ENDPOINT").map((r) => `${r.sourceId}|${JSON.stringify(r.provenance[0]?.location)}`)).size],
      ["  External APIs", count("ExternalApi")],
      ["  Unresolved API Calls", unresolved.filter((u) => u.type === "CALLS_ENDPOINT").length],
      ["Message Contracts", count("Message")],
      ["Publishers", new Set(rels("PUBLISHES").map((r) => r.sourceId)).size],
      ["Consumers", new Set([...rels("CONSUMED_BY"), ...rels("HANDLED_BY")].map((r) => r.targetId)).size],
      ["Topics / Exchanges", transports.filter((t) => t.kind === "Topic").length],
      ["Queues", transports.filter((t) => t.kind === "Queue").length],
      ["Messaging Relationships", ["PUBLISHES", "SENDS_TO", "CARRIES", "CONSUMED_BY", "HANDLED_BY", "ROUTES_TO", "ROUTES_MESSAGE"].reduce((n, t) => n + rels(t as Relationship["type"]).filter((r) => r.metadata.framework !== undefined).length, 0)],
      ["Contract Conflicts", this.store.findConflicts({ repositoryId }).filter((c) => c.kind.startsWith("conflicting-")).length],
      ["Unresolved Contracts", unresolved.length],
    ];
  }
}
