import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_SCHEMA_VERSION, type Entity, type Relationship } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export type ExportFormat = "json" | "jsonl" | "csv";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const ENTITY_COLUMNS: (keyof Entity | "file" | "line")[] = ["id", "kind", "layer", "name", "qualifiedName", "repositoryId", "projectId", "assembly", "language", "symbolKey", "external", "file", "line", "metadata", "provenance"];
const RELATIONSHIP_COLUMNS: (keyof Relationship)[] = ["id", "type", "sourceId", "targetId", "repositoryId", "evidence", "confidence", "metadata", "provenance"];

export async function exportGraph(store: GraphStore, format: ExportFormat, out: string, repositoryId?: string): Promise<Record<string, number>> {
  const counts = { repositories: 0, entities: 0, relationships: 0, unresolved: 0, diagnostics: 0, conflicts: 0 };
  const repositories = store.listRepositories().filter((r) => !repositoryId || r.id === repositoryId);
  counts.repositories = repositories.length;
  const unresolved = store.findUnresolved({ repositoryId });
  const diagnostics = store.findDiagnostics({ repositoryId });
  const conflicts = store.findConflicts({ repositoryId });
  counts.unresolved = unresolved.length;
  counts.diagnostics = diagnostics.length;
  counts.conflicts = conflicts.length;

  if (format === "csv") {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "entities.csv"), "");
    writeFileSync(join(out, "relationships.csv"), "");
    const entities = Bun.file(join(out, "entities.csv")).writer();
    entities.write(`${ENTITY_COLUMNS.join(",")}\n`);
    for (const e of store.iterateEntities(repositoryId)) {
      counts.entities++;
      const row = { ...e, file: e.location?.file ?? null, line: e.location?.startLine ?? null };
      entities.write(`${ENTITY_COLUMNS.map((c) => csvCell(row[c as keyof typeof row])).join(",")}\n`);
    }
    await entities.end();
    const relationships = Bun.file(join(out, "relationships.csv")).writer();
    relationships.write(`${RELATIONSHIP_COLUMNS.join(",")}\n`);
    for (const r of store.iterateRelationships(repositoryId)) {
      counts.relationships++;
      relationships.write(`${RELATIONSHIP_COLUMNS.map((c) => csvCell(r[c])).join(",")}\n`);
    }
    await relationships.end();
    const unresolvedCols = ["id", "type", "sourceId", "repositoryId", "targetDisplay", "resolver", "reason", "confidence", "provenance"] as const;
    await Bun.write(join(out, "unresolved.csv"), [unresolvedCols.join(","), ...unresolved.map((u) => unresolvedCols.map((c) => csvCell(u[c])).join(","))].join("\n") + "\n");
    return counts;
  }

  const partial = `${out}.partial-${process.pid}`;
  writeFileSync(partial, "");
  const writer = Bun.file(partial).writer();
  try {
    if (format === "jsonl") {
      const line = (record: string, data: unknown) => writer.write(`${JSON.stringify({ record, ...(data as object) })}\n`);
      line("header", { schemaVersion: GRAPH_SCHEMA_VERSION, exportedAt: new Date().toISOString() });
      repositories.forEach((r) => line("repository", r));
      for (const e of store.iterateEntities(repositoryId)) (counts.entities++, line("entity", e));
      for (const r of store.iterateRelationships(repositoryId)) (counts.relationships++, line("relationship", r));
      unresolved.forEach((u) => line("unresolved", u));
      diagnostics.forEach((d) => line("diagnostic", d));
      conflicts.forEach((c) => line("conflict", c));
    } else {
      writer.write(`{"schemaVersion":${GRAPH_SCHEMA_VERSION},"repositories":${JSON.stringify(repositories)},"entities":[`);
      let first = true;
      for (const e of store.iterateEntities(repositoryId)) {
        writer.write(`${first ? "" : ","}\n${JSON.stringify(e)}`);
        first = false;
        counts.entities++;
      }
      writer.write(`],"relationships":[`);
      first = true;
      for (const r of store.iterateRelationships(repositoryId)) {
        writer.write(`${first ? "" : ","}\n${JSON.stringify(r)}`);
        first = false;
        counts.relationships++;
      }
      writer.write(`],"unresolved":${JSON.stringify(unresolved)},"diagnostics":${JSON.stringify(diagnostics)},"conflicts":${JSON.stringify(conflicts)}}\n`);
    }
    await writer.end();
    renameSync(partial, out);
  } finally {
    rmSync(partial, { force: true });
  }
  return counts;
}

export async function exportMetaGraph(store: GraphStore, format: ExportFormat, out: string): Promise<Record<string, number>> {
  const catalog = store.listCatalog();
  const snapshots = store.listMetaSnapshots();
  const entities = store.findMetaEntities({});
  const relationships = store.findMetaRelationships({});
  const unresolved = store.findMetaUnresolved({});
  const conflicts = store.findMetaConflicts({});
  const counts = { repositories: catalog.length, snapshots: snapshots.length, entities: entities.length, relationships: relationships.length, unresolved: unresolved.length, conflicts: conflicts.length };
  if (format === "csv") {
    mkdirSync(out, { recursive: true });
    const write = (name: string, rows: Record<string, unknown>[], columns: string[]) =>
      Bun.write(join(out, name), [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
    await write("catalog.csv", catalog as unknown as Record<string, unknown>[], ["repositoryId", "identity", "name", "url", "provider", "organization", "defaultBranch", "status", "analyzedCommit", "graphVersion", "analyzedAt", "localPath"]);
    await write("snapshots.csv", snapshots as unknown as Record<string, unknown>[], ["id", "createdAt", "schemaVersion", "resolverVersions", "repositories", "categories"]);
    await write("meta-entities.csv", entities as unknown as Record<string, unknown>[], ["id", "kind", "name", "qualifiedName", "metadata", "provenance"]);
    await write("meta-relationships.csv", relationships as unknown as Record<string, unknown>[], ["id", "category", "type", "sourceId", "sourceRepositoryId", "targetId", "targetRepositoryId", "environment", "evidence", "confidence", "snapshotId", "metadata", "provenance"]);
    await write("meta-unresolved.csv", unresolved as unknown as Record<string, unknown>[], ["id", "category", "type", "sourceId", "repositoryId", "targetDisplay", "resolver", "reason", "metadata", "provenance"]);
    await write("meta-conflicts.csv", conflicts as unknown as Record<string, unknown>[], ["id", "category", "kind", "subject", "factIds", "severity", "description"]);
    return counts;
  }
  const header = { graphScope: "meta", schemaVersion: GRAPH_SCHEMA_VERSION, latestSnapshot: snapshots[0]?.id ?? null };
  if (format === "jsonl") {
    const lines = [
      { record: "header", ...header },
      ...catalog.map((c) => ({ record: "repository", ...c })),
      ...snapshots.map((s) => ({ record: "snapshot", ...s })),
      ...entities.map((e) => ({ record: "entity", ...e })),
      ...relationships.map((r) => ({ record: "relationship", ...r })),
      ...unresolved.map((u) => ({ record: "unresolved", ...u })),
      ...conflicts.map((c) => ({ record: "conflict", ...c })),
    ];
    await Bun.write(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  } else {
    await Bun.write(out, JSON.stringify({ ...header, catalog, snapshots, entities, relationships, unresolved, conflicts }, null, 1));
  }
  return counts;
}

export async function exportAnalysis(format: ExportFormat, out: string, kind: string, result: unknown, rows: Record<string, unknown>[]): Promise<number> {
  if (format === "json") await Bun.write(out, JSON.stringify({ analysis: kind, result }, null, 1));
  else if (format === "jsonl") await Bun.write(out, [JSON.stringify({ record: "header", analysis: kind }), ...rows.map((r) => JSON.stringify({ record: kind, ...r }))].join("\n") + "\n");
  else {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    await Bun.write(out, [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
  }
  return rows.length;
}
