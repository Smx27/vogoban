import type { Relationship } from "../../graph/model.ts";

export function relationshipLanes(
  relationships: Relationship[],
): Map<string, number> {
  const groups = new Map<string, Relationship[]>();
  for (const relationship of relationships) {
    const key = JSON.stringify(
      [relationship.sourceId, relationship.targetId].sort(),
    );
    groups.set(key, [...(groups.get(key) ?? []), relationship]);
  }
  const lanes = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id));
    group.forEach((relationship, index) =>
      lanes.set(
        relationship.id,
        relationship.sourceId === relationship.targetId
          ? index * 34
          : (index - (group.length - 1) / 2) * 34,
      ),
    );
  }
  return lanes;
}

export function relationshipCurve(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  offset: number,
  self = false,
) {
  const reach = Math.max(60, Math.abs(targetX - sourceX) * 0.45);
  if (self) {
    const height = 110 + Math.abs(offset);
    return {
      path: `M ${sourceX} ${sourceY} C ${sourceX + 90} ${sourceY - height}, ${targetX - 90} ${targetY - height}, ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: (sourceY + targetY) / 2 - height * 0.75,
    };
  }
  return {
    path: `M ${sourceX} ${sourceY} C ${sourceX + reach} ${sourceY + offset}, ${targetX - reach} ${targetY + offset}, ${targetX} ${targetY}`,
    labelX: (sourceX + targetX) / 2,
    labelY: (sourceY + targetY) / 2 + offset * 0.75,
  };
}
