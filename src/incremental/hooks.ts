import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../pipeline/discovery.ts";

/**
 * Git hooks are an optional adapter over the same incremental engine used by the
 * CLI and CI. Installation is explicit, never touches the user's Git config, and
 * defaults to the cheapest behaviour so ordinary commits stay fast.
 */
export type HookMode = "notify" | "background" | "sync";
export type HookName = "post-commit" | "post-merge" | "post-checkout";

const SENTINEL = "# vogoban-incremental-sync-hook";
const HOOKS: HookName[] = ["post-commit", "post-merge"];

function gitDir(root: string): string {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-path", "hooks"], { stdout: "pipe", stderr: "ignore" });
  const rel = r.exitCode === 0 ? r.stdout.toString().trim() : ".git/hooks";
  return rel.startsWith("/") ? rel : join(root, rel);
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function hookBody(command: string, mode: HookMode, db: string | null): string {
  const bin = shellQuote(command);
  const invoke = `${bin} graph sync --quiet${db ? ` --db ${shellQuote(db)}` : ""}`;
  const action =
    mode === "notify"
      ? `echo "vogoban: repository changed - run '${command.replace(/["$`\\]/g, "")} graph sync' to update the architecture graph."`
      : mode === "background"
        ? `(${invoke} >/dev/null 2>&1 &)`
        : invoke;
  return [
    "#!/bin/sh",
    SENTINEL,
    `# mode: ${mode}`,
    ...(db ? [`# graph store: ${db}`] : []),
    "# Remove with: vogoban hooks uninstall",
    "# Never blocks or fails a commit: absent binary, recursion, and sync errors are ignored.",
    '[ -n "$VOGOBAN_HOOK_RUNNING" ] && exit 0',
    `command -v ${bin} >/dev/null 2>&1 || exit 0`,
    "unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX",
    "export VOGOBAN_HOOK_RUNNING=1",
    `${action} || true`,
    "exit 0",
    "",
  ].join("\n");
}

export interface HookActionResult {
  hook: HookName;
  action: "installed" | "removed" | "skipped";
  reason?: string;
}

/** `db` (the `--db` given at install time, made absolute) is baked into the hook so background syncs update that store rather than the default one. */
export function installHooks(path: string, command: string, mode: HookMode, force = false, db: string | null = null): HookActionResult[] {
  const root = repositoryRoot(path);
  const dir = gitDir(root);
  mkdirSync(dir, { recursive: true });
  const results: HookActionResult[] = [];
  for (const hook of HOOKS) {
    const file = join(dir, hook);
    if (existsSync(file) && !force) {
      const content = readFileSync(file, "utf8");
      if (!content.includes(SENTINEL)) {
        results.push({ hook, action: "skipped", reason: "a non-vogoban hook already exists; pass --force to overwrite" });
        continue;
      }
    }
    if (existsSync(file) && !readFileSync(file, "utf8").includes(SENTINEL)) copyFileSync(file, `${file}.vogoban-backup`);
    writeFileSync(file, hookBody(command, mode, db));
    chmodSync(file, 0o755);
    results.push({ hook, action: "installed" });
  }
  return results;
}

export function uninstallHooks(path: string): HookActionResult[] {
  const root = repositoryRoot(path);
  const dir = gitDir(root);
  const results: HookActionResult[] = [];
  for (const hook of HOOKS) {
    const file = join(dir, hook);
    if (!existsSync(file)) {
      results.push({ hook, action: "skipped", reason: "not installed" });
      continue;
    }
    if (!readFileSync(file, "utf8").includes(SENTINEL)) {
      results.push({ hook, action: "skipped", reason: "not a vogoban hook" });
      continue;
    }
    rmSync(file, { force: true });
    if (existsSync(`${file}.vogoban-backup`)) renameSync(`${file}.vogoban-backup`, file);
    results.push({ hook, action: "removed", ...(existsSync(file) ? { reason: "previous hook restored" } : {}) });
  }
  return results;
}

export function hookStatus(path: string): { hook: HookName; installed: boolean; mode: HookMode | null }[] {
  const root = repositoryRoot(path);
  const dir = gitDir(root);
  return HOOKS.map((hook) => {
    const file = join(dir, hook);
    if (!existsSync(file)) return { hook, installed: false, mode: null };
    const content = readFileSync(file, "utf8");
    if (!content.includes(SENTINEL)) return { hook, installed: false, mode: null };
    const m = /# mode: (\w+)/.exec(content);
    return { hook, installed: true, mode: (m?.[1] as HookMode) ?? null };
  });
}
