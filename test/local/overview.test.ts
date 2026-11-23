import { describe, expect, test } from "bun:test";
import type { Entity, Relationship } from "../../src/graph/model.ts";
import {
  layoutTopology,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../../src/local/web/layout.ts";
import {
  detailLevel,
  overviewGeometry,
  overviewRadius,
  useCanvasOverview,
  type OverviewNode,
} from "../../src/local/web/overview.ts";

const node = (id: string, x = 0): OverviewNode => ({
  id,
  position: { x, y: 0 },
  data: { connections: 4 },
});
const edge = (
  id: string,
  sourceId: string,
  targetId: string,
): Relationship => ({
  id,
  sourceId,
  targetId,
  type: "CALLS",
  repositoryId: "repo",
  evidence: "EXACT",
  confidence: 1,
  metadata: {},
  provenance: [],
});

describe("semantic overview policy", () => {
  test("automatic detail follows the zoom threshold and manual modes override it", () => {
    expect(detailLevel("auto", 0.719)).toBe("overview");
    expect(detailLevel("auto", 0.72)).toBe("details");
    expect(detailLevel("auto", 1)).toBe("details");
    expect(detailLevel("overview", 2)).toBe("overview");
    expect(detailLevel("details", 0.1)).toBe("details");
  });

  test("canvas is used only above 500 overview relationships", () => {
    expect(useCanvasOverview("overview", 500)).toBe(false);
    expect(useCanvasOverview("overview", 501)).toBe(true);
    expect(useCanvasOverview("details", 10000)).toBe(false);
  });

  test("degree changes circle size without exceeding world-space bounds", () => {
    expect(overviewRadius(0)).toBe(24);
    expect(overviewRadius(-10)).toBe(24);
    expect(overviewRadius(Number.NaN)).toBe(24);
    expect(overviewRadius(10)).toBeGreaterThan(overviewRadius(1));
    expect(overviewRadius(1e12)).toBe(34);
    expect(overviewRadius(Infinity)).toBe(34);
  });
});

describe("complete overview geometry", () => {
  test("overview packs mid-sized hubs and disconnected nodes without a long card hierarchy", () => {
    const entities: Entity[] = Array.from({ length: 90 }, (_, i) => ({
      id: `n${i}`,
      key: `n${i}`,
      kind: "Application",
      layer: "application",
      name: `n${i}`,
      qualifiedName: null,
      repositoryId: "repo",
      projectId: null,
      assembly: null,
      language: null,
      symbolKey: null,
      location: null,
      external: false,
      metadata: {},
      provenance: [],
    }));
    const relationships = entities
      .slice(1)
      .map((e, i) => edge(`e${i}`, "n0", e.id));
    const before = structuredClone({ entities, relationships });
    const compact = [
      ...layoutTopology(entities, relationships, "overview").values(),
    ];
    const detailed = [
      ...layoutTopology(entities, relationships, "details").values(),
    ];
    const compactHeight =
      Math.max(...compact.map((p) => p.y)) -
      Math.min(...compact.map((p) => p.y));
    const detailedHeight =
      Math.max(...detailed.map((p) => p.y)) -
      Math.min(...detailed.map((p) => p.y));
    expect(compact).toHaveLength(90);
    expect(compactHeight).toBeLessThan(detailedHeight / 2);
    const isolated = [...layoutTopology(entities, [], "overview").values()];
    const width = Math.max(...isolated.map((p) => p.x)) + NODE_WIDTH;
    const height = Math.max(...isolated.map((p) => p.y)) + NODE_HEIGHT;
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThan(2);
    expect({ entities, relationships }).toEqual(before);
  });
  test("all relationships survive beyond the canvas threshold, including parallels and loops", () => {
    const nodes = [node("a"), node("b", 500)];
    const relationships = [
      ...Array.from({ length: 601 }, (_, index) =>
        edge(`parallel-${index}`, "a", "b"),
      ),
      edge("reciprocal", "b", "a"),
      edge("self-one", "a", "a"),
      edge("self-two", "a", "a"),
    ];
    const geometry = overviewGeometry(nodes, relationships);
    expect(geometry).toHaveLength(604);
    expect(
      geometry.map(({ id, sourceId, targetId }) => ({
        id,
        sourceId,
        targetId,
      })),
    ).toEqual(
      relationships.map(({ id, sourceId, targetId }) => ({
        id,
        sourceId,
        targetId,
      })),
    );
    expect(new Set(geometry.map((item) => item.path)).size).toBe(604);
    expect(new Set(geometry.slice(0, 602).map((item) => item.lane)).size).toBe(
      602,
    );
  });

  test("handles use circle radius inside unchanged reserved node dimensions", () => {
    const geometry = overviewGeometry(
      [node("a"), node("b", 500)],
      [edge("ab", "a", "b")],
    )[0]!;
    expect(NODE_WIDTH).toBe(240);
    expect(NODE_HEIGHT).toBe(108);
    expect(geometry.sourceX).toBe(120 + overviewRadius(4));
    expect(geometry.targetX).toBe(620 - overviewRadius(4));
    expect(geometry.sourceY).toBe(54);
    expect(geometry.targetY).toBe(54);
  });

  test("missing endpoints are skipped without influencing valid lanes", () => {
    const relationships = [
      edge("valid", "a", "b"),
      edge("missing-target", "a", "missing"),
      edge("missing-source", "missing", "b"),
    ];
    const geometry = overviewGeometry([node("a"), node("b")], relationships);
    expect(geometry.map((item) => item.id)).toEqual(["valid"]);
    expect(geometry[0]!.lane).toBe(0);
    expect(relationships).toHaveLength(3);
  });

  test("lanes are deterministic and graph facts and positions are not mutated", () => {
    const nodes = [node("a"), node("b", 500)];
    const relationships = [
      edge("z", "a", "b"),
      edge("a", "a", "b"),
      edge("loop", "a", "a"),
    ];
    const before = structuredClone({ nodes, relationships });
    const geometry = overviewGeometry(nodes, relationships);
    const reversed = overviewGeometry(
      [...nodes].reverse(),
      [...relationships].reverse(),
    );
    expect(geometry.map((item) => [item.id, item.path]).sort()).toEqual(
      reversed.map((item) => [item.id, item.path]).sort(),
    );
    expect({ nodes, relationships }).toEqual(before);
    expect(geometry[0]!.relationship).toBe(relationships[0]!);
  });
});
