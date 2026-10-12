import { createHash } from "node:crypto";
import { classifyFile } from "../pipeline/discovery.ts";
import type { FileCategory } from "../graph/model.ts";

/**
 * A normalized, Git-independent description of what changed in a repository
 * between two states. Git, CI, hooks, and manual CLI invocations are only
 * different ways of constructing this value; the incremental engine consumes
 * nothing else and never shells out to Git itself.
 */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  /** Current repository-relative path (for a deletion this is the path that no longer exists). */
  path: string;
  /** Previous path for a rename/move, otherwise null. */
  previousPath: string | null;
  status: ChangeStatus;
  /** Classification of the current path (or previous path for a deletion). */
  category: FileCategory;
}

export type ChangeSource = "working-tree" | "staged" | "commit-range" | "since" | "manual";

export interface ChangeSet {
  repositoryId: string;
  repositoryIdentity: string;
  source: ChangeSource;
  previousCommit: string | null;
  currentCommit: string | null;
  /** The working tree had uncommitted changes when the set was built. */
  dirty: boolean;
  changes: FileChange[];
}

/** Categories whose change can invalidate more than the file itself. */
const STRUCTURAL: ReadonlySet<FileCategory> = new Set<FileCategory>(["project", "solution", "config"]);

export interface ChangeSetSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  byCategory: Record<string, number>;
  /** True when a project/solution/build/config file changed, which widens invalidation. */
  structural: boolean;
  contracts: boolean;
  infrastructure: boolean;
}

export function classifyChange(path: string): FileCategory {
  return classifyFile(path).category;
}

export function normalizeChange(input: { path: string; previousPath?: string | null; status: ChangeStatus }): FileChange {
  const previousPath = input.previousPath ?? null;
  const classifyPath = input.status === "deleted" ? input.path : input.path;
  return { path: input.path, previousPath, status: input.status, category: classifyChange(classifyPath) };
}

/** Build a deterministic change set from raw, source-agnostic change records. */
export function buildChangeSet(input: {
  repositoryId: string;
  repositoryIdentity: string;
  source: ChangeSource;
  previousCommit: string | null;
  currentCommit: string | null;
  dirty: boolean;
  changes: Array<{ path: string; previousPath?: string | null; status: ChangeStatus }>;
}): ChangeSet {
  const seen = new Map<string, FileChange>();
  for (const raw of input.changes) {
    const change = normalizeChange(raw);
    // Last write wins per path, then order deterministically by path.
    seen.set(`${change.status}:${change.path}:${change.previousPath ?? ""}`, change);
  }
  const changes = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  return { ...input, changes };
}

export function summarizeChangeSet(set: ChangeSet): ChangeSetSummary {
  const byCategory: Record<string, number> = {};
  let structural = false;
  let contracts = false;
  let infrastructure = false;
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const c of set.changes) {
    counts[c.status]++;
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
    if (STRUCTURAL.has(c.category)) structural = true;
    if (c.category === "contract") contracts = true;
    if (c.category === "infrastructure") infrastructure = true;
  }
  return { total: set.changes.length, ...counts, byCategory, structural, contracts, infrastructure };
}

/** A stable fingerprint of the change set, used to make planning reproducible and cacheable. */
export function changeSetFingerprint(set: ChangeSet): string {
  const h = createHash("sha256");
  h.update(`${set.repositoryIdentity}|${set.previousCommit ?? ""}|${set.currentCommit ?? ""}|${set.dirty ? 1 : 0}\n`);
  for (const c of set.changes) h.update(`${c.status}|${c.path}|${c.previousPath ?? ""}\n`);
  return h.digest("hex").slice(0, 16);
}
