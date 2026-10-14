import { expect, test } from "bun:test";
import type { Entity } from "../../src/graph/model.ts";
import { LocalGraphPresentation } from "../../src/local/presentation.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";

test("architecture search surfaces an application ahead of matching source files without escaping repository scope", () => {
  const store = new SqliteGraphStore(":memory:");
  const make = (
    id: string,
    kind: Entity["kind"],
    name: string,
    qualifiedName: string,
    repositoryId = "repo",
  ): Entity => ({
    id,
    key: id,
    kind,
    name,
    qualifiedName,
    repositoryId,
    layer: "application",
    projectId: null,
    assembly: null,
    language: null,
    symbolKey: null,
    location: null,
    external: false,
    metadata: {},
    provenance: [],
  });
  const entities = [
    ...Array.from({ length: 45 }, (_, index) =>
      make(
        `file-${index}`,
        "File",
        `file-${index}.ts`,
        `admin-portal/src/${index}.ts`,
      ),
    ),
    make("app", "Application", "admin-portal", "angular:admin-portal/src"),
    make("project", "Project", "admin-portal", "admin-portal/package.json"),
    make(
      "foreign",
      "Application",
      "admin-portal",
      "angular:other-admin-portal/src",
      "other",
    ),
  ];
  try {
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
        startedAt: "2026-10-12",
        finishedAt: "2026-10-12",
        schemaVersion: 1,
        analyzerVersion: "test",
        pluginVersions: {},
        stats: {},
      },
      [],
      {
        entities,
        relationships: [],
        unresolved: [],
        diagnostics: [],
        conflicts: [],
      },
    );
    const results = new LocalGraphPresentation(store).search(
      "admin-portal",
      "repo",
    );
    expect(results[0]!.id).toBe("app");
    expect(results.length).toBeLessThanOrEqual(30);
    expect(results.every((entity) => entity.repositoryId === "repo")).toBe(
      true,
    );
    expect(new Set(results.map((entity) => entity.id)).size).toBe(
      results.length,
    );
  } finally {
    store.close();
  }
});
