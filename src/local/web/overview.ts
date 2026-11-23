import type { Relationship } from "../../graph/model.ts";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";
import { relationshipCurve, relationshipLanes } from "./relationship-path.ts";

export type OverviewNode = {
  id: string;
  position: { x: number; y: number };
  data: { connections: number; entity?: { kind: string } };
};
export type DetailMode = "auto" | "overview" | "details";
export type DetailLevel = "overview" | "details";

export function overviewRadius(connections: number): number {
  return 24 + Math.min(10, Math.log2(Math.max(0, connections || 0) + 1) * 1.5);
}

export function detailLevel(mode: DetailMode, zoom: number): DetailLevel {
  return mode === "auto" ? (zoom < 0.72 ? "overview" : "details") : mode;
}

export function useCanvasOverview(level: DetailLevel, count: number): boolean {
  return level === "overview" && count > 500;
}

export function overviewGeometry(
  nodes: OverviewNode[],
  relationships: Relationship[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const valid = relationships.filter(
    (relationship) =>
      byId.has(relationship.sourceId) && byId.has(relationship.targetId),
  );
  const lanes = relationshipLanes(valid);
  return valid.map((relationship) => {
    const source = byId.get(relationship.sourceId)!;
    const target = byId.get(relationship.targetId)!;
    const sourceX =
      source.position.x +
      NODE_WIDTH / 2 +
      overviewRadius(source.data.connections);
    const sourceY = source.position.y + NODE_HEIGHT / 2;
    const targetX =
      target.position.x +
      NODE_WIDTH / 2 -
      overviewRadius(target.data.connections);
    const targetY = target.position.y + NODE_HEIGHT / 2;
    const lane = lanes.get(relationship.id) ?? 0;
    const self = relationship.sourceId === relationship.targetId;
    return {
      id: relationship.id,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      relationship,
      lane,
      sourceX,
      sourceY,
      targetX,
      targetY,
      ...relationshipCurve(sourceX, sourceY, targetX, targetY, lane, self),
      arrowAngle: self
        ? Math.atan2(110 + Math.abs(lane), 90)
        : Math.atan2(-lane, Math.max(60, Math.abs(targetX - sourceX) * 0.45)),
    };
  });
}

export type OverviewGeometry = ReturnType<typeof overviewGeometry>[number];
