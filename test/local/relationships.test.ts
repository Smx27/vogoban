import { describe, expect, test } from "bun:test";
import type {
  Entity,
  GraphBatch,
  MetaRelationship,
  Relationship,
} from "../../src/graph/model.ts";
import { LocalGraphPresentation } from "../../src/local/presentation.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";
import {
  relationshipCurve,
  relationshipLanes,
} from "../../src/local/web/relationship-path.ts";

const entity = (
  id: string,
  kind: Entity["kind"] = "Application",
  repositoryId: string | null = "repo",
): Entity => ({
  id,
  key: id,
  kind,
  layer: repositoryId ? "application" : "meta",
  name: id,
  qualifiedName: id,
  repositoryId,
  projectId: null,
  assembly: null,
  language: null,
  symbolKey: null,
  location: null,
  external: repositoryId === null,
  metadata: {},
  provenance: [],
});
const edge = (
  id: string,
  sourceId: string,
  targetId: string,
  type: Relationship["type"] = "CALLS",
): Relationship => ({
  id,
  sourceId,
  targetId,
  type,
  repositoryId: "repo",
  evidence: "EXACT",
  confidence: 1,
  metadata: {},
  provenance: [],
});
function save(
  store: SqliteGraphStore,
  entities: Entity[],
  relationships: Relationship[],
) {
  const batch: GraphBatch = {
    entities,
    relationships,
    unresolved: [],
    diagnostics: [],
    conflicts: [],
  };
  store.saveRepositoryGraph(
    {
      id: "repo",
      name: "repo",
      rootPath: "/repo",
      remoteUrl: null,
      branch: null,
      commit: null,
      dirty: false,
    },
    {
      id: "run",
      repositoryId: "repo",
      commit: null,
      startedAt: "2026-10-13",
      finishedAt: "2026-10-13",
      schemaVersion: 1,
      analyzerVersion: "test",
      pluginVersions: {},
      stats: {},
    },
    [],
    batch,
  );
}

describe("complete relationship access", () => {
  test("complete graph preserves off-projection endpoints and external nodes without adding unrelated repositories", () => {
    const store = new SqliteGraphStore(":memory:");
    try {
      save(
        store,
        [
          entity("app"),
          entity("method", "Method"),
          entity("external", "Type", null),
          entity("foreign", "Application", "other"),
        ],
        [
          edge("calls", "app", "method"),
          edge("external-call", "method", "external"),
        ],
      );
      const graph = new LocalGraphPresentation(store);
      const projected = graph.view({ repositoryId: "repo" });
      expect(projected.relationships).toHaveLength(0);
      expect(projected.coverage?.storedRelationships).toBe(2);
      const complete = graph.view({
        repositoryId: "repo",
        complete: true,
        limit: 1,
      });
      expect(
        complete.relationships.map((relationship) => relationship.id).sort(),
      ).toEqual(["calls", "external-call"]);
      expect(complete.entities.map((item) => item.id).sort()).toEqual([
        "app",
        "external",
        "method",
      ]);
      expect(complete.coverage?.missingEndpointIds).toEqual([]);
      expect(complete.truncated).toBe(false);
    } finally {
      store.close();
    }
  });

  test("edges beyond the old 5,000-row prefilter remain in the projection and complete graph", () => {
    const store = new SqliteGraphStore(":memory:");
    try {
      const unrelated = Array.from({ length: 5100 }, (_, index) =>
        edge(`code-${index}`, "type-a", "type-b"),
      );
      save(
        store,
        [
          entity("app-a"),
          entity("app-b"),
          entity("type-a", "Type"),
          entity("type-b", "Type"),
        ],
        [
          ...unrelated,
          edge("architecture-link", "app-a", "app-b", "ROUTES_TO"),
        ],
      );
      const graph = new LocalGraphPresentation(store);
      expect(
        graph
          .view({ repositoryId: "repo" })
          .relationships.map((relationship) => relationship.id),
      ).toEqual(["architecture-link"]);
      const complete = graph.view({ repositoryId: "repo", complete: true });
      expect(complete.relationships).toHaveLength(5101);
      expect(complete.coverage?.storedRelationships).toBe(5101);
      expect(
        complete.relationships.find(
          (relationship) => relationship.id === "architecture-link",
        ),
      ).toEqual(store.getRelationship("architecture-link")!);
    } finally {
      store.close();
    }
  });

  test("direct neighborhoods retain more than 120 endpoint entities", () => {
    const store = new SqliteGraphStore(":memory:");
    try {
      const targets = Array.from({ length: 180 }, (_, index) =>
        entity(`target-${index}`, "Method"),
      );
      save(
        store,
        [entity("app"), ...targets],
        targets.map((target) => edge(`call-${target.id}`, "app", target.id)),
      );
      const neighborhood = new LocalGraphPresentation(store).neighborhood(
        "app",
      );
      expect(neighborhood.entities).toHaveLength(181);
      expect(neighborhood.relationships).toHaveLength(180);
    } finally {
      store.close();
    }
  });

  test("missing endpoints are reported rather than replaced with fabricated entities", () => {
    const store = new SqliteGraphStore(":memory:");
    try {
      save(store, [entity("app")], [edge("missing-target", "app", "missing")]);
      const complete = new LocalGraphPresentation(store).view({
        repositoryId: "repo",
        complete: true,
      });
      expect(complete.relationships).toHaveLength(1);
      expect(complete.entities.map((item) => item.id)).toEqual(["app"]);
      expect(complete.coverage?.missingEndpointIds).toEqual(["missing"]);
    } finally {
      store.close();
    }
  });

  test("MetaGraph completeness and neighborhood inspection retain repository-to-bridge edges", () => {
    const store = new SqliteGraphStore(":memory:");
    try {
      save(
        store,
        [
          entity("repo-a", "Repository"),
          entity("repo-b", "Repository", "other"),
        ],
        [],
      );
      const relationships: MetaRelationship[] = [
        {
          ...edge("publishes", "repo-a", "shared", "PUBLISHES_MESSAGE"),
          repositoryId: null,
          category: "message",
          sourceRepositoryId: "repo",
          targetRepositoryId: null,
          environment: null,
          snapshotId: "snapshot",
        },
        {
          ...edge("consumes", "repo-b", "shared", "CONSUMES_MESSAGE"),
          repositoryId: null,
          category: "message",
          sourceRepositoryId: "other",
          targetRepositoryId: null,
          environment: null,
          snapshotId: "snapshot",
        },
      ];
      store.replaceMetaCategory("message", "fingerprint", {
        entities: [entity("shared", "SharedContract", null)],
        relationships,
        unresolved: [],
        conflicts: [],
      });
      const graph = new LocalGraphPresentation(store);
      expect(
        graph.view({ view: "meta", complete: true }).relationships,
      ).toHaveLength(2);
      expect(
        graph
          .view({ view: "meta", complete: true })
          .entities.map((item) => item.id)
          .sort(),
      ).toEqual(["repo-a", "repo-b", "shared"]);
      expect(graph.entity("repo-a", true)?.outgoing).toHaveLength(1);
      expect(graph.neighborhood("shared", 1, true).relationships).toHaveLength(
        2,
      );
    } finally {
      store.close();
    }
  });
});

describe("distinct relationship rendering", () => {
  test("parallel and reciprocal edges receive distinct paths", () => {
    const relationships = [
      edge("one", "a", "b"),
      edge("two", "a", "b", "CONTAINS"),
      edge("reverse", "b", "a"),
    ];
    const lanes = relationshipLanes(relationships);
    expect(new Set(lanes.values()).size).toBe(3);
    const paths = relationships.map(
      (relationship) =>
        relationshipCurve(240, 54, 500, 54, lanes.get(relationship.id)!).path,
    );
    expect(new Set(paths).size).toBe(3);
  });
  test("parallel self-relationships receive distinct loops", () => {
    const relationships = [
      edge("one", "a", "a"),
      edge("two", "a", "a", "CONTAINS"),
    ];
    const lanes = relationshipLanes(relationships);
    const paths = relationships.map(
      (relationship) =>
        relationshipCurve(240, 54, 0, 54, lanes.get(relationship.id)!, true)
          .path,
    );
    expect(new Set(paths).size).toBe(2);
  });
});
