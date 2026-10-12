import { GitStateError } from "../pipeline/discovery.ts";
import { buildChangeSet, type ChangeSet, type ChangeSource, type ChangeStatus } from "./changeset.ts";

/**
 * Git adapter: constructs the engine's normalized ChangeSet from Git state.
 * This is the only file here that knows Git exists. The incremental engine
 * depends on ChangeSet, never on Git, so CI and future adapters can produce
 * the same value without touching the engine.
 */
function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() || `exit code ${r.exitCode}` };
  } catch (error) {
    return { ok: false, out: "", err: `git could not be executed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A command whose failure means the change set cannot be known: an empty result would be a guess, so it throws instead. */
function gitRequired(root: string, args: string[]): string {
  const r = git(root, args);
  if (r.ok) return r.out;
  const detail = r.err.split("\n").find((line) => line.trim())?.trim() ?? "unknown error";
  throw new GitStateError(`Git state of ${root} cannot be determined (git ${args.join(" ")}: ${detail}); whether the repository changed is unknown. Fix or restore the Git checkout and retry.`);
}

export function isGitRepository(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function resolveCommit(root: string, ref: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok ? r.out.trim() || null : null;
}

export function headCommit(root: string): string | null {
  return resolveCommit(root, "HEAD");
}

export function isDirty(root: string): boolean {
  return gitRequired(root, ["status", "--porcelain"]).trim() !== "";
}

const STATUS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };

/** Parse `git diff --name-status -z -M` output into raw change records. */
function parseNameStatus(out: string): Array<{ path: string; previousPath: string | null; status: ChangeStatus }> {
  const fields = out.split("\0").filter((s) => s.length > 0);
  const changes: Array<{ path: string; previousPath: string | null; status: ChangeStatus }> = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i]!;
    const letter = code[0]!;
    const status = STATUS[letter];
    if (letter === "R" || letter === "C") {
      const previousPath = fields[i + 1] ?? "";
      const path = fields[i + 2] ?? "";
      i += 3;
      if (status) changes.push({ path, previousPath: letter === "R" ? previousPath : null, status });
    } else {
      const path = fields[i + 1] ?? "";
      i += 2;
      if (status) changes.push({ path, previousPath: null, status });
    }
  }
  return changes;
}

function untracked(root: string): Array<{ path: string; previousPath: null; status: ChangeStatus }> {
  const out = gitRequired(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean).map((path) => ({ path, previousPath: null, status: "added" as ChangeStatus }));
}

export interface GitChangeOptions {
  repositoryId: string;
  repositoryIdentity: string;
  root: string;
  /** working-tree / since compare a base commit to the current tree; commit-range / staged use Git refs directly. */
  mode: "working-tree" | "since" | "commit-range" | "staged";
  baseCommit?: string | null;
  fromCommit?: string | null;
  toCommit?: string | null;
}

export type ChangeSetErrorCode = "not_a_git_repository" | "missing_base_commit" | "missing_head_commit" | "git_state_unreadable";

/**
 * Build a ChangeSet from Git. Returns an error (with a stable code) when a required ref cannot be resolved, or
 * `git_state_unreadable` when Git exists but cannot answer: that is not "no changes" and callers must not treat it as such.
 */
export function changeSetFromGit(opts: GitChangeOptions): { changeSet: ChangeSet } | { error: string; code: ChangeSetErrorCode } {
  try {
    return changeSetFromGitUnchecked(opts);
  } catch (error) {
    if (error instanceof GitStateError) return { error: error.message, code: "git_state_unreadable" };
    throw error;
  }
}

function changeSetFromGitUnchecked(opts: GitChangeOptions): { changeSet: ChangeSet } | { error: string; code: ChangeSetErrorCode } {
  const { root } = opts;
  if (!isGitRepository(root)) return { error: "not a Git repository; supply a change set from another adapter", code: "not_a_git_repository" };
  const head = headCommit(root);
  const dirty = isDirty(root);
  let raw: Array<{ path: string; previousPath: string | null; status: ChangeStatus }> = [];
  let previousCommit: string | null = null;
  let currentCommit: string | null = head;
  let source: ChangeSource;

  if (opts.mode === "commit-range") {
    const from = resolveCommit(root, opts.fromCommit ?? "");
    const to = resolveCommit(root, opts.toCommit ?? "HEAD");
    if (!to) return { error: `cannot resolve --to commit: ${opts.toCommit}`, code: "missing_head_commit" };
    if (!from) return { error: `cannot resolve --from commit: ${opts.fromCommit}`, code: "missing_base_commit" };
    raw = parseNameStatus(gitRequired(root, ["diff", "--name-status", "-z", "-M", from, to]));
    previousCommit = from;
    currentCommit = to;
    source = "commit-range";
  } else if (opts.mode === "staged") {
    raw = parseNameStatus(gitRequired(root, ["diff", "--name-status", "-z", "-M", "--cached"]));
    previousCommit = head;
    source = "staged";
  } else {
    // working-tree / since: base commit .. current tree (tracked diff + untracked adds)
    const base = resolveCommit(root, opts.baseCommit ?? "HEAD");
    if (!base) return { error: `cannot resolve base commit: ${opts.baseCommit}`, code: "missing_base_commit" };
    raw = parseNameStatus(gitRequired(root, ["diff", "--name-status", "-z", "-M", base]));
    raw = raw.concat(untracked(root));
    previousCommit = base;
    source = opts.mode === "since" ? "since" : "working-tree";
  }

  return {
    changeSet: buildChangeSet({
      repositoryId: opts.repositoryId,
      repositoryIdentity: opts.repositoryIdentity,
      source,
      previousCommit,
      currentCommit,
      dirty,
      changes: raw,
    }),
  };
}
