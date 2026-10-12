import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

export interface Row {
  [key: string]: string | number | null;
}

/** Copy a fixture tree to a scratch directory (outside the repository), analyze it into a fresh store, return the store. */
export function analyzeFixture(fixture: string, prepare?: (dir: string) => void, env: Record<string, string> = {}): { db: Database; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vogoban-azure-"));
  cpSync(join(ROOT, "test/azure/fixtures", fixture), join(dir, "repo"), { recursive: true });
  prepare?.(join(dir, "repo"));
  const store = join(dir, "graph.db");
  const result = Bun.spawnSync(["bun", join(ROOT, "src/cli/main.ts"), "analyze", join(dir, "repo"), "--db", store, "--log-level", "error"], { cwd: ROOT, env: { ...process.env, VOGOBAN_OFFLINE: "1", ...env }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`analyze failed (${result.exitCode}): ${result.stderr.toString()}\n${result.stdout.toString()}`);
  const db = new Database(store, { readonly: true });
  return { db, dir, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

export const rows = (db: Database, sql: string, ...params: (string | number)[]): Row[] => db.query(sql).all(...params) as Row[];

/** Every persisted text column of the store, for secret-leak assertions. */
export function storedText(db: Database): string {
  const out: string[] = [];
  for (const table of ["entities", "relationships", "unresolved", "diagnostics", "fact_cache", "conflicts"]) out.push(...rows(db, `SELECT * FROM ${table}`).map((r) => JSON.stringify(r)));
  return out.join("\n");
}

/** Outgoing relationships of an entity: type, target kind, target qualified name. */
export function edgesFrom(db: Database, entityId: string): [string, string, string][] {
  return rows(db, "SELECT r.type AS type, t.kind AS kind, t.qualified_name AS qn FROM relationships r JOIN entities t ON t.id = r.target_id WHERE r.source_id = ? ORDER BY r.type, t.qualified_name", entityId).map((r) => [String(r.type), String(r.kind), String(r.qn)]);
}
