import type {
  Entity,
  EntityKind,
  Relationship,
  RelationshipType,
} from "../graph/model.ts";
import { GraphQuery } from "../query/graph-query.ts";
import type { GraphStore } from "../store/store.ts";
import { AnalysisGraph } from "../analysis/graph.ts";
import { propagate } from "../analysis/impact.ts";

export interface GraphView {
  repositories: {
    id: string;
    name: string;
    status: string;
    graphVersion: string | null;
  }[];
  entities: Entity[];
  relationships: Relationship[];
  categories: { kind: EntityKind; count: number }[];
  truncated: boolean;
  coverage?: {
    mode: "projection" | "complete";
    storedRelationships: number;
    includedRelationships: number;
    missingEndpointIds: string[];
  };
}

/** Deliberately architectural: lower-level routes, projects and cloud declarations are reached through focused views. */
const ARCHITECTURE_KINDS: EntityKind[] = [
  "Repository",
  "Application",
  "Api",
  "Message",
  "Topic",
  "Queue",
  "AzureFunction",
  "Database",
  "DataStore",
  "Deployment",
  "KubernetesService",
  "ExternalSystem",
  "SharedContract",
];
const VIEWS: Record<string, EntityKind[]> = {
  architecture: ARCHITECTURE_KINDS,
  dependencies: [
    "Repository",
    "Project",
    "Application",
    "Api",
    "Endpoint",
    "ExternalApi",
    "ExternalSystem",
    "Package",
    "Database",
    "DataStore",
  ],
  infrastructure: [
    "Repository",
    "Application",
    "Deployment",
    "KubernetesService",
    "KubernetesIngress",
    "AzureResource",
    "AzureFunction",
    "Database",
    "DataStore",
    "Topic",
    "Queue",
    "ContainerImage",
  ],
  messaging: [
    "Repository",
    "Application",
    "Message",
    "Topic",
    "Queue",
    "AzureFunction",
    "HostedService",
  ],
  frontend: [
    "Repository",
    "FrontendRoute",
    "Application",
    "Api",
    "Endpoint",
    "HttpClient",
    "ExternalApi",
  ],
  meta: [
    "Repository",
    "Api",
    "SharedContract",
    "Message",
    "Topic",
    "Queue",
    "AzureResource",
    "Database",
    "DataStore",
    "ExternalSystem",
    "Package",
  ],
};

export class LocalGraphPresentation {
  private readonly query: GraphQuery;
  constructor(private readonly store: GraphStore) {
    this.query = new GraphQuery(store);
  }

  view(
    options: {
      repositoryId?: string;
      view?: string;
      kinds?: EntityKind[];
      limit?: number;
      complete?: boolean;
    } = {},
  ): GraphView {
    if (options.complete) {
      const meta = options.view === "meta";
      const relationships = meta
        ? this.store.findMetaRelationships({})
        : [...this.store.iterateRelationships(options.repositoryId)];
      const owned = meta
        ? this.store.findMetaEntities({})
        : [...this.store.iterateEntities(options.repositoryId)];
      const endpoints = this.readEntities(
        relationships.flatMap((relationship) => [
          relationship.sourceId,
          relationship.targetId,
        ]),
      );
      const entities = [
        ...new Map(
          [...owned, ...endpoints].map((entity) => [entity.id, entity]),
        ).values(),
      ];
      const ids = new Set(entities.map((entity) => entity.id));
      const counts = new Map<EntityKind, number>();
      for (const entity of entities)
        counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
      return {
        repositories: this.store
          .listCatalog()
          .filter(
            (entry) =>
              meta ||
              !options.repositoryId ||
              entry.repositoryId === options.repositoryId,
          )
          .map((entry) => ({
            id: entry.repositoryId,
            name: entry.name,
            status: entry.status,
            graphVersion: entry.graphVersion,
          })),
        entities,
        relationships,
        categories: [...counts]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count),
        truncated: false,
        coverage: {
          mode: "complete",
          storedRelationships: relationships.length,
          includedRelationships: relationships.length,
          missingEndpointIds: [
            ...new Set(
              relationships
                .flatMap((edge) => [edge.sourceId, edge.targetId])
                .filter((id) => !ids.has(id)),
            ),
          ],
        },
      };
    }
    const kinds = options.kinds?.length
      ? options.kinds
      : (VIEWS[options.view ?? "architecture"] ?? ARCHITECTURE_KINDS);
    if (options.view === "meta") {
      const metaRelationships = this.store.findMetaRelationships({});
      const meta = this.store.findMetaEntities({ kinds });
      const referencedIds = [
        ...new Set(
          metaRelationships.flatMap((edge) => [edge.sourceId, edge.targetId]),
        ),
      ];
      const repositoryEntities = this.store
        .findEntities({ ids: referencedIds })
        .filter((entity) => kinds.includes(entity.kind));
      const all = [
        ...new Map(
          [...meta, ...repositoryEntities].map((entity) => [entity.id, entity]),
        ).values(),
      ];
      const entities = all.slice(0, options.limit ?? 500);
      const ids = new Set(entities.map((entity) => entity.id));
      const relationships = metaRelationships.filter(
        (edge) => ids.has(edge.sourceId) && ids.has(edge.targetId),
      );
      const counts = new Map<EntityKind, number>();
      for (const entity of all)
        counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
      return {
        repositories: this.store
          .listCatalog()
          .map((r) => ({
            id: r.repositoryId,
            name: r.name,
            status: r.status,
            graphVersion: r.graphVersion,
          })),
        entities,
        relationships,
        categories: [...counts]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
        truncated: all.length > entities.length,
        coverage: {
          mode: "projection",
          storedRelationships: metaRelationships.length,
          includedRelationships: relationships.length,
          missingEndpointIds: [],
        },
      };
    }
    const all = this.store.findEntities({
      repositoryId: options.repositoryId,
      kinds,
      limit: Math.max(1, (options.limit ?? 500) * 3),
    });
    const entities = this.aggregate(all, options.repositoryId).slice(
      0,
      options.limit ?? 500,
    );
    const ids = new Set(entities.map((entity) => entity.id));
    const relationships: Relationship[] = [];
    for (let offset = 0; offset < entities.length; offset += 400) {
      relationships.push(
        ...this.store
          .findRelationships({
            repositoryId: options.repositoryId,
            sourceIds: entities
              .slice(offset, offset + 400)
              .map((entity) => entity.id),
          })
          .filter((edge) => ids.has(edge.targetId)),
      );
    }
    const counts = new Map<EntityKind, number>();
    for (const entity of all)
      counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
    const storedRelationships = Object.values(
      this.store.stats(options.repositoryId).relationshipsByType,
    ).reduce((sum, count) => sum + count, 0);
    return {
      repositories: this.store
        .listCatalog()
        .filter(
          (r) =>
            !options.repositoryId || r.repositoryId === options.repositoryId,
        )
        .map((r) => ({
          id: r.repositoryId,
          name: r.name,
          status: r.status,
          graphVersion: r.graphVersion,
        })),
      entities,
      relationships,
      categories: [...counts]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      truncated: all.length > entities.length,
      coverage: {
        mode: "projection",
        storedRelationships,
        includedRelationships: relationships.length,
        missingEndpointIds: [],
      },
    };
  }

  search(text: string, repositoryId?: string): Entity[] {
    const architectural = this.store.findEntities({
      repositoryId,
      kinds: [
        ...ARCHITECTURE_KINDS,
        "FrontendRoute",
        "AzureResource",
        "Project",
      ],
      nameLike: text,
      limit: 30,
    });
    const other = this.store.findEntities({
      repositoryId,
      nameLike: text,
      limit: 30,
    });
    const preferred = new Set(architectural.map((entity) => entity.id));
    const query = text.trim().toLowerCase();
    const score = (entity: Entity) =>
      (entity.name.toLowerCase() === query ? 4 : 0) +
      (preferred.has(entity.id) ? 2 : 0) +
      (ARCHITECTURE_KINDS.includes(entity.kind) ? 1 : 0) +
      (entity.name.toLowerCase().includes(query) ? 1 : 0);
    return [
      ...new Map(
        [...architectural, ...other].map((entity) => [entity.id, entity]),
      ).values(),
    ]
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          (a.qualifiedName ?? a.name).localeCompare(b.qualifiedName ?? b.name),
      )
      .slice(0, 30);
  }

  entity(id: string, meta = false) {
    const entity =
      this.store.getEntity(id) ??
      this.store.findMetaEntities({ ids: [id] })[0] ??
      null;
    if (!entity) return null;
    if (meta || entity.layer === "meta") {
      const outgoing = this.store.findMetaRelationships({ sourceIds: [id] });
      const incoming = this.store.findMetaRelationships({ targetIds: [id] });
      const relatedIds = [
        ...new Set([
          ...outgoing.map((r) => r.targetId),
          ...incoming.map((r) => r.sourceId),
        ]),
      ];
      const related = new Map(
        [
          ...this.store.findEntities({ ids: relatedIds }),
          ...this.store.findMetaEntities({ ids: relatedIds }),
        ].map((e) => [e.id, e]),
      );
      return {
        entity,
        outgoing: outgoing.map((relationship) => ({
          relationship,
          entity: related.get(relationship.targetId) ?? null,
        })),
        incoming: incoming.map((relationship) => ({
          relationship,
          entity: related.get(relationship.sourceId) ?? null,
        })),
        provenance: {
          subject: entity,
          subjectType: "entity" as const,
          provenance: entity.provenance,
          temporal: null,
        },
      };
    }
    const outgoing = this.query.outgoing(id);
    const incoming = this.query.incoming(id);
    const relatedIds = [
      ...new Set([
        ...outgoing.map((r) => r.targetId),
        ...incoming.map((r) => r.sourceId),
      ]),
    ];
    const related = new Map(
      this.store.findEntities({ ids: relatedIds }).map((e) => [e.id, e]),
    );
    return {
      entity,
      outgoing: outgoing.map((relationship) => ({
        relationship,
        entity: related.get(relationship.targetId) ?? null,
      })),
      incoming: incoming.map((relationship) => ({
        relationship,
        entity: related.get(relationship.sourceId) ?? null,
      })),
      provenance: this.query.provenance(id),
    };
  }

  neighborhood(id: string, depth = 1, meta = false) {
    if (!meta)
      return this.query.neighborhood(id, Math.min(Math.max(depth, 1), 3));
    const ids = new Set([id]);
    let frontier = [id];
    const relationships = new Map<string, Relationship>();
    for (
      let level = 0;
      level < Math.min(Math.max(depth, 1), 3) && frontier.length;
      level++
    ) {
      const next = new Set<string>();
      for (let offset = 0; offset < frontier.length; offset += 400) {
        const chunk = frontier.slice(offset, offset + 400);
        const incident = [
          ...this.store.findMetaRelationships({ sourceIds: chunk }),
          ...this.store.findMetaRelationships({ targetIds: chunk }),
        ];
        for (const relationship of incident) {
          relationships.set(relationship.id, relationship);
          for (const endpoint of [relationship.sourceId, relationship.targetId])
            if (!ids.has(endpoint)) {
              ids.add(endpoint);
              next.add(endpoint);
            }
        }
      }
      frontier = [...next];
    }
    return {
      entities: this.readEntities([...ids]),
      relationships: [...relationships.values()],
    };
  }

  private readEntities(ids: string[]): Entity[] {
    const unique = [...new Set(ids)];
    const entities = new Map<string, Entity>();
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      for (const entity of [
        ...this.store.findEntities({ ids: chunk }),
        ...this.store.findMetaEntities({ ids: chunk }),
      ])
        entities.set(entity.id, entity);
    }
    return [...entities.values()];
  }

  impact(id: string) {
    const entity = this.store.getEntity(id);
    if (!entity) return null;
    return propagate(
      new AnalysisGraph(this.store, { scope: "all" }),
      [entity],
      { mode: "impact", maxDepth: 4, maxNodes: 300, expandSeeds: true },
    );
  }

  private aggregate(entities: Entity[], repositoryId?: string): Entity[] {
    const high = entities.filter(
      (e) => e.kind !== "Endpoint" || e.repositoryId === repositoryId,
    );
    const selected = high.length ? high : entities;
    return selected.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.qualifiedName ?? a.name).localeCompare(b.qualifiedName ?? b.name),
    );
  }
}

export const graphViews = Object.keys(VIEWS);
export const graphRelationshipTypes = (
  relationships: Relationship[],
): RelationshipType[] => [...new Set(relationships.map((r) => r.type))].sort();
