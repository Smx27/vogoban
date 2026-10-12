import type { Entity, Relationship } from "../graph/model.ts";
import type { TraversalStep } from "../query/graph-query.ts";

export function label(e: Entity | null | undefined): string {
  if (!e) return "(missing)";
  const kind = typeof e.metadata.symbolKind === "string" && e.kind !== e.metadata.symbolKind ? `${e.kind}:${e.metadata.symbolKind}` : e.kind;
  return `${kind} ${e.qualifiedName ?? e.name}${e.external ? " [external]" : ""}`;
}

export function where(e: Entity | null | undefined): string {
  return e?.location ? `${e.location.file}:${e.location.startLine}` : "";
}

export function relLine(rel: Relationship, other: Entity | null | undefined, direction: "out" | "in"): string {
  const arrow = direction === "out" ? `-[${rel.type}]->` : `<-[${rel.type}]-`;
  const loc = rel.provenance[0]?.location;
  const count = Number(rel.metadata.occurrences ?? 1);
  return `${arrow} ${label(other)}  (${rel.evidence}${count > 1 ? `, x${count}` : ""}${loc ? ` @ ${loc.file}:${loc.startLine}` : ""})`;
}

export function tree(steps: TraversalStep[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    const indent = "  ".repeat(step.depth);
    const via = step.via ? `[${step.via.type}/${step.via.evidence}] ` : "";
    lines.push(`${indent}${via}${label(step.entity)}${where(step.entity) ? `  ${where(step.entity)}` : ""}`);
  }
  return lines.join("\n");
}

export function table(rows: (string | number)[][], header: string[]): string {
  const all = [header, ...rows.map((r) => r.map(String))];
  const widths = header.map((_, i) => Math.min(80, Math.max(...all.map((r) => String(r[i] ?? "").length))));
  return all.map((r, idx) => {
    const line = r.map((c, i) => String(c).slice(0, 80).padEnd(widths[i]!)).join("  ").trimEnd();
    return idx === 0 ? `${line}\n${widths.map((w) => "-".repeat(w)).join("  ")}` : line;
  }).join("\n");
}
