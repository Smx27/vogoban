import dagre from "@dagrejs/dagre";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import type { Entity, Relationship } from "../../graph/model.ts";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 108;

export function layoutTopology(
  entities: Entity[],
  relationships: Relationship[],
): Map<string, { x: number; y: number }> {
  const ids = new Set(entities.map((entity) => entity.id));
  const edges = relationships.filter(
    (edge) => ids.has(edge.sourceId) && ids.has(edge.targetId),
  );
  const connected = new Set(
    edges.flatMap((edge) => [edge.sourceId, edge.targetId]),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [id, other] of [
      [edge.sourceId, edge.targetId],
      [edge.targetId, edge.sourceId],
    ] as const) {
      const neighbors = adjacency.get(id) ?? new Set<string>();
      neighbors.add(other);
      adjacency.set(id, neighbors);
    }
  }
  const positions = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of connected) {
    if (visited.has(id)) continue;
    const members: string[] = [];
    const frontier = [id];
    visited.add(id);
    while (frontier.length) {
      const next = frontier.pop()!;
      members.push(next);
      for (const neighbor of adjacency.get(next) ?? [])
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          frontier.push(neighbor);
        }
    }
    components.push(members);
  }
  components.sort((a, b) => b.length - a.length);
  let offsetX = 36;
  let offsetY = 36;
  let rowHeight = 0;
  for (const members of components) {
    if (members.length > 160) {
      const nodes: (SimulationNodeDatum & { id: string })[] = members
        .toSorted()
        .map((id) => ({ id }));
      const memberIds = new Set(members);
      const links = edges
        .filter(
          (edge) =>
            memberIds.has(edge.sourceId) && memberIds.has(edge.targetId),
        )
        .map((edge) => ({ source: edge.sourceId, target: edge.targetId }));
      forceSimulation(nodes)
        .force(
          "link",
          forceLink(links)
            .id((node) => nodes[node.index!]!.id)
            .distance(314)
            .strength(0.08),
        )
        .force("charge", forceManyBody().strength(-2400))
        .force(
          "collide",
          forceCollide(Math.hypot(NODE_WIDTH, NODE_HEIGHT) / 2 + 12).iterations(
            2,
          ),
        )
        .force("x", forceX(0).strength(0.02))
        .force("y", forceY(0).strength(0.03))
        .stop()
        .tick(160);
      const minX = Math.min(...nodes.map((node) => node.x!));
      const minY = Math.min(...nodes.map((node) => node.y!));
      const width =
        Math.max(...nodes.map((node) => node.x!)) - minX + NODE_WIDTH;
      const height =
        Math.max(...nodes.map((node) => node.y!)) - minY + NODE_HEIGHT;
      if (offsetX > 36) {
        offsetX = 36;
        offsetY += rowHeight + 80;
        rowHeight = 0;
      }
      for (const node of nodes)
        positions.set(node.id, {
          x: offsetX + node.x! - minX,
          y: offsetY + node.y! - minY,
        });
      offsetX += width + 96;
      rowHeight = height;
      continue;
    }
    const component = new dagre.graphlib.Graph({ multigraph: true })
      .setGraph({
        rankdir: "LR",
        ranksep: 74,
        nodesep: 28,
        marginx: 0,
        marginy: 0,
      })
      .setDefaultEdgeLabel(() => ({}));
    const ids = new Set(members);
    for (const id of members)
      component.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of edges)
      if (ids.has(edge.sourceId) && ids.has(edge.targetId))
        component.setEdge(edge.sourceId, edge.targetId, {}, edge.id);
    dagre.layout(component);
    const { width = 0, height = 0 } = component.graph();
    if (offsetX > 36 && offsetX + width > 1660) {
      offsetX = 36;
      offsetY += rowHeight + 80;
      rowHeight = 0;
    }
    for (const id of members) {
      const node = component.node(id);
      positions.set(id, {
        x: offsetX + node.x - NODE_WIDTH / 2,
        y: offsetY + node.y - NODE_HEIGHT / 2,
      });
    }
    offsetX += width + 96;
    rowHeight = Math.max(rowHeight, height);
  }
  const bottom = connected.size
    ? Math.max(...[...positions.values()].map((position) => position.y)) +
      NODE_HEIGHT +
      100
    : 36;
  entities
    .filter((entity) => !connected.has(entity.id))
    .forEach((entity, index) => {
      positions.set(entity.id, {
        x: 36 + (index % 4) * (NODE_WIDTH + 44),
        y: bottom + Math.floor(index / 4) * (NODE_HEIGHT + 44),
      });
    });
  return positions;
}
