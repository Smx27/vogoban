import { describe, expect, test } from "bun:test";
import type { Entity, Relationship } from "../../src/graph/model.ts";
import {
  layoutTopology,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../../src/local/web/layout.ts";

function entity(id: string): Entity {
  return {
    id,
    key: id,
    kind: "Application",
    layer: "application",
    name: id,
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
  };
}
function edge(id: string, sourceId: string, targetId: string): Relationship {
  return {
    id,
    type: "CALLS",
    sourceId,
    targetId,
    repositoryId: "repo",
    evidence: "EXACT",
    confidence: 1,
    metadata: {},
    provenance: [],
  };
}

describe("graph topology layout", () => {
  test("follows relationship direction instead of arranging by entity kind", () => {
    const nodes = [entity("gateway"), entity("orders"), entity("consumer")];
    const positions = layoutTopology(nodes, [
      edge("first", "gateway", "orders"),
      edge("second", "orders", "consumer"),
    ]);
    expect(positions.get("gateway")!.x).toBeLessThan(
      positions.get("orders")!.x,
    );
    expect(positions.get("orders")!.x).toBeLessThan(
      positions.get("consumer")!.x,
    );
    expect(positions.size).toBe(3);
  });

  test("cycles, parallel edges, and dangling filtered edges do not lose entities", () => {
    const nodes = [entity("a"), entity("b"), entity("standalone")];
    const relationships = [
      edge("one", "a", "b"),
      edge("two", "b", "a"),
      edge("three", "a", "b"),
      edge("dangling", "a", "filtered"),
    ];
    const positions = layoutTopology(nodes, relationships);
    expect(positions.size).toBe(nodes.length);
    for (const position of positions.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
    expect(positions.get("standalone")!.y).toBeGreaterThan(
      positions.get("a")!.y + NODE_HEIGHT,
    );
  });

  test("disconnected entities stay inspectable without fabricated relationships", () => {
    const nodes = Array.from({ length: 18 }, (_, index) =>
      entity(`entity-${index}`),
    );
    const positions = [...layoutTopology(nodes, []).values()];
    expect(positions).toHaveLength(nodes.length);
    for (let first = 0; first < positions.length; first++)
      for (let second = first + 1; second < positions.length; second++) {
        const a = positions[first]!;
        const b = positions[second]!;
        expect(
          Math.abs(a.x - b.x) >= NODE_WIDTH ||
            Math.abs(a.y - b.y) >= NODE_HEIGHT,
        ).toBe(true);
      }
  });

  test("empty graphs have an empty layout", () => {
    expect(layoutTopology([], []).size).toBe(0);
  });

  test("large hubs use a compact deterministic layout without mutating graph facts", () => {
    const nodes = Array.from({ length: 201 }, (_, index) =>
      entity(`node-${index}`),
    );
    const relationships = nodes
      .slice(1)
      .map((node, index) => edge(`edge-${index}`, nodes[0]!.id, node.id));
    const before = JSON.stringify({ nodes, relationships });
    const positions = layoutTopology(nodes, relationships);
    expect(positions.size).toBe(nodes.length);
    expect(JSON.stringify({ nodes, relationships })).toBe(before);
    expect(layoutTopology(nodes, relationships)).toEqual(positions);
    const values = [...positions.values()];
    const width =
      Math.max(...values.map((point) => point.x)) -
      Math.min(...values.map((point) => point.x)) +
      NODE_WIDTH;
    const height =
      Math.max(...values.map((point) => point.y)) -
      Math.min(...values.map((point) => point.y)) +
      NODE_HEIGHT;
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThan(3);
    for (const point of values) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});
