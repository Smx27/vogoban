import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffSnapshots, snapshotFor } from "../analysis/diff.ts";
import type { Logger } from "../log.ts";
import type { CatalogEntry } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import type { AnalysisOptions, Plugin } from "../plugins/types.ts";
import { selectAnalyzerPlugins } from "../plugins/registry.ts";
import { analyzeRepository, ANALYZER_VERSION, AnalysisError, repositoryAnalysisSettings } from "../pipeline/analyze.ts";
import { GRAPH_SCHEMA_VERSION } from "../graph/model.ts";
import { loadConfig } from "../pipeline/config.ts";
import { discoverRepository, GitStateError, repositoryRoot } from "../pipeline/discovery.ts";
import { changeSetFromGit, isGitRepository, resolveCommit } from "./git.ts";
import { changeSetFingerprint, summarizeChangeSet, type ChangeSet } from "./changeset.ts";
import { planIncremental, type Fingerprints, type FullRebuildCode, type IncrementalPlan, type SyncMode } from "./planner.ts";

export interface SyncOptions extends AnalysisOptions {
  incremental?: boolean;
  /** working-tree (default), since <commit>, commit-range <from>..<to>, or staged. */
  mode?: "working-tree" | "since" | "commit-range" | "staged";
  sinceCommit?: string | null;
  fromCommit?: string | null;
  toCommit?: string | null;
  forceFull?: boolean;
  semantic?: boolean;
  /** Directory for the per-repository sync lock (the graph store directory). Omit to skip cross-process locking. */
  lockDir?: string;
  lockWaitMs?: number;
  /** A change set from a non-Git adapter; when provided, Git is not consulted. */
  changeSet?: ChangeSet;
}

export interface SyncMetrics {
  changedFiles: number;
  filesAnalyzed: number;
  affectedProjects: number;
  entitiesCreated: number | null;
  entitiesUpdated: number | null;
  entitiesDeleted: number | null;
  relationshipsCreated: number | null;
  relationshipsUpdated: number | null;
  relationshipsDeleted: number | null;
  durationMs: number;
  /** Baseline full-analysis duration for this repository, when a prior run exists. */
  baselineDurationMs: number | null;
}

export interface SyncResult {
  repositoryId: string;
  repository: string;
  /** What the caller asked for: "full" only with --full, otherwise "incremental". */
  requestedMode: "incremental" | "full";
  /** What actually ran (same value as `mode`, named explicitly for CI consumers). */
  actualMode: SyncMode;
  mode: SyncMode;
  status: "SUCCESS" | "NO_OP" | "FAILED";
  reason: string;
  /** Set whenever an incremental request on an existing graph ran as a full rebuild. */
  fallbackReason: string | null;
  /** Stable machine-readable form of fallbackReason (e.g. missing_base_commit). */
  fallbackCode: FullRebuildCode | null;
  previousCommit: string | null;
  currentCommit: string | null;
  previousGraphVersion: string | null;
  graphVersion: string | null;
  changeSource: ChangeSet["source"];
  plan: IncrementalPlan;
  metrics: SyncMetrics;
  diffSnapshotFrom: string | null;
  diffSnapshotTo: string | null;
  /** Plugins that crashed during this analysis; the published graph is degraded for their domain. */
  degradedPlugins: string[];
  error: string | null;
  timestamp: string;
}

interface SyncHistoryEntry {
  timestamp: string;
  requestedMode?: SyncResult["requestedMode"];
  mode: SyncMode;
  status: SyncResult["status"];
  reason: string;
  fallbackReason: string | null;
  fallbackCode?: FullRebuildCode | null;
  currentCommit: string | null;
  graphVersion: string | null;
  configFingerprint: string;
  changeSetFingerprint: string;
  metrics: SyncMetrics;
}

const HISTORY_LIMIT = 50;

export function configFingerprint(config: ReturnType<typeof loadConfig>, settingsFingerprint?: string): string {
  const { errors: _errors, ...stable } = config;
  return createHash("sha256").update(JSON.stringify(settingsFingerprint === undefined ? stable : { config: stable, analysisSettings: settingsFingerprint })).digest("hex").slice(0, 16);
}

export function currentFingerprints(config: ReturnType<typeof loadConfig>, plugins: readonly Plugin[], settingsFingerprint?: string): Fingerprints {
  return {
    analyzerVersion: ANALYZER_VERSION,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    pluginVersions: Object.fromEntries(plugins.map((p) => [p.id, p.version])),
    configFingerprint: configFingerprint(config, settingsFingerprint),
  };
}

function historyKey(repositoryId: string): string {
  return `sync-history:${repositoryId}`;
}

export function syncHistory(store: GraphStore, repositoryId: string): SyncHistoryEntry[] {
  const baseline = store.getBaseline(historyKey(repositoryId));
  return baseline ? (baseline.data as SyncHistoryEntry[]) : [];
}

export function lastSync(store: GraphStore, repositoryId: string): SyncHistoryEntry | null {
  const history = syncHistory(store, repositoryId);
  return history.length ? history[history.length - 1]! : null;
}

function recordSync(store: GraphStore, repositoryId: string, entry: SyncHistoryEntry): void {
  const history = syncHistory(store, repositoryId);
  history.push(entry);
  store.saveBaseline(historyKey(repositoryId), history.slice(-HISTORY_LIMIT));
}

/** The catalog entry registered for a checkout, found by path when Git cannot say which repository the path belongs to. */
function catalogByPath(store: GraphStore, path: string): CatalogEntry | null {
  let dir: string;
  try {
    dir = realpathSync(path);
  } catch {
    return null;
  }
  const entries = store.listCatalog().filter((e) => e.localPath);
  for (; ; dir = dirname(dir)) {
    const entry = entries.find((e) => e.localPath === dir);
    if (entry) return entry;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * A synchronization refused before any analysis ran: the previous graph version, identity and relationships are untouched,
 * and the failure is recorded in the repository's history so it is visible, never mistaken for "no changes".
 */
function refuseSync(store: GraphStore, entry: Pick<CatalogEntry, "repositoryId" | "identity" | "name" | "analyzedCommit" | "graphVersion">, options: SyncOptions, fingerprints: Fingerprints, reason: string, error: string): SyncResult {
  const changeSet: ChangeSet = { repositoryId: entry.repositoryId, repositoryIdentity: entry.identity, source: "manual", previousCommit: entry.analyzedCommit, currentCommit: null, dirty: false, changes: [] };
  const result: SyncResult = {
    repositoryId: entry.repositoryId, repository: entry.name, requestedMode: options.forceFull ? "full" : "incremental", actualMode: "incremental", mode: "incremental", status: "FAILED", reason, fallbackReason: null, fallbackCode: null,
    previousCommit: entry.analyzedCommit, currentCommit: null, previousGraphVersion: entry.graphVersion, graphVersion: entry.graphVersion,
    changeSource: "manual", plan: { mode: "incremental", reason, safe: true, affected: { files: [], projects: [], domains: [], entityCount: 0 }, widened: false },
    metrics: { changedFiles: 0, filesAnalyzed: 0, affectedProjects: 0, entitiesCreated: 0, entitiesUpdated: 0, entitiesDeleted: 0, relationshipsCreated: 0, relationshipsUpdated: 0, relationshipsDeleted: 0, durationMs: 0, baselineDurationMs: null },
    diffSnapshotFrom: null, diffSnapshotTo: null, degradedPlugins: [], error, timestamp: new Date().toISOString(),
  };
  recordSync(store, entry.repositoryId, historyEntry(result, fingerprints, changeSet));
  return result;
}

/**
 * The incremental synchronization pipeline:
 *   Change Source -> Change Set -> Planner -> (Invalidation) -> Analysis ->
 *   Reconciliation -> New Graph Version -> Metrics.
 *
 * Analysis and reconciliation are delegated to the existing deterministic
 * analyzer, which reuses the per-file syntax cache and the per-project Roslyn
 * semantic cache (keyed by content hashes and the project-reference closure) and
 * reconciles the store by upsert plus stale deletion. That makes an incremental
 * result equivalent to a clean full rebuild by construction, preserving semantic
 * identity, provenance, and history while removing stale state. This function
 * adds the Git-independent orchestration, the deterministic plan and fallback
 * decision, graph versioning metadata, and the efficiency metrics around it.
 */
export class SyncUsageError extends Error {}

async function syncUnlocked(
  path: string,
  store: GraphStore,
  plugins: readonly Plugin[],
  options: SyncOptions,
  log: Logger,
): Promise<SyncResult> {
  for (const ref of [options.sinceCommit, options.fromCommit, options.toCommit])
    if (ref && !/^\w[\w./@{}^~+-]*$/.test(ref)) throw new SyncUsageError(`invalid commit reference '${ref.slice(0, 80)}'`);
  const root = repositoryRoot(path);
  const config = loadConfig(root);
  const settings = repositoryAnalysisSettings(root, options);
  plugins = selectAnalyzerPlugins(plugins, settings.options.analyzers);
  const repo = discoverRepository(path, config.repository);
  const catalog = store.getCatalog(repo.id);
  const fingerprints = currentFingerprints(config, plugins, settings.fingerprint);
  const previous = lastSync(store, repo.id);
  const published = syncHistory(store, repo.id).findLast((entry) => entry.status !== "FAILED");
  const baselineSettings = store.getBaseline(`analysis-settings:${repo.id}`)?.data;
  const timestamp = new Date().toISOString();

  // Git identity integrity: a checkout registered under a remote-derived identity must never be re-registered under a
  // path-derived one (that would publish a phantom repository), and a graph built from a commit cannot be synced
  // against a checkout whose HEAD no longer resolves to one.
  if (!catalog && repo.identity.startsWith("local:")) {
    const registered = catalogByPath(store, root);
    if (registered && registered.identity !== repo.identity)
      return refuseSync(store, registered, options, fingerprints, "repository identity could not be confirmed",
        `${root} is registered as ${registered.identity} but Git no longer reports a repository there (identity would become ${repo.identity}); the Git checkout is missing or unusable. Restore it and retry; the previous graph is preserved.`);
  }
  if (!options.changeSet && catalog?.analyzedCommit && !repo.commit && isGitRepository(root))
    return refuseSync(store, catalog, options, fingerprints, "checked-out commit could not be determined",
      `HEAD of ${root} does not resolve to a commit although the graph was built from ${catalog.analyzedCommit.slice(0, 12)}; the Git checkout is in an invalid state. Restore it and retry; the previous graph is preserved.`);

  // A commit range describes what CI checked out. The head must resolve and be the checked-out commit, whether or not
  // the base can be resolved; otherwise the request cannot be honoured as stated (usage error, exit 2).
  if (!options.changeSet && options.mode === "commit-range") {
    if (!isGitRepository(root)) throw new SyncUsageError("a commit-range synchronization needs a Git checkout of the head commit (not a Git repository)");
    const head = resolveCommit(root, options.toCommit ?? "HEAD");
    if (!head) throw new SyncUsageError(`cannot resolve --head/--to commit: ${options.toCommit}`);
    if (head !== repo.commit) throw new SyncUsageError(`--head/--to ${head.slice(0, 12)} is not the checked-out commit (${repo.commit?.slice(0, 12) ?? "none"}); synchronization analyzes the checked-out tree, so check out the head commit first`);
  }

  // 1. Change Set (Git adapter, or caller-supplied adapter output).
  let changeSet: ChangeSet;
  let changeSetError: { error: string; code: FullRebuildCode } | null = null;
  if (options.changeSet) {
    changeSet = options.changeSet;
  } else {
    const base = options.mode === "since" ? options.sinceCommit : (catalog?.analyzedCommit ?? null);
    const built = changeSetFromGit({
      repositoryId: repo.id,
      repositoryIdentity: repo.identity,
      root,
      mode: options.mode ?? "working-tree",
      baseCommit: base ?? "HEAD",
      fromCommit: options.fromCommit,
      toCommit: options.toCommit,
    });
    if ("error" in built && built.code === "git_state_unreadable")
      return refuseSync(store, catalog ?? { repositoryId: repo.id, identity: repo.identity, name: repo.name, analyzedCommit: null, graphVersion: null }, options, fingerprints, "Git state could not be read", built.error);
    if ("error" in built) {
      // No reliable change source: fall back to a full rebuild rather than guessing.
      changeSet = {
        repositoryId: repo.id, repositoryIdentity: repo.identity, source: "manual",
        previousCommit: catalog?.analyzedCommit ?? null, currentCommit: repo.commit, dirty: repo.dirty, changes: [],
      };
      changeSetError = { error: built.error, code: built.code === "not_a_git_repository" ? "not_a_git_repository" : "missing_base_commit" };
      log.warn("sync.changeset.unavailable", { reason: built.error, code: built.code });
    } else {
      changeSet = built.changeSet;
    }
  }

  // 2. Plan (deterministic; decides noop / incremental / full with explicit reason).
  const plan = planIncremental(store, catalog, changeSet, fingerprints, {
    forceFull: options.forceFull || !settings.options.incremental,
    semantic: settings.options.semantic,
    forceReason: changeSetError ? `change set unavailable (${changeSetError.error}); full rebuild is the only safe option` : null,
    forceCode: changeSetError?.code,
    previousConfigFingerprint: published?.configFingerprint ?? configFingerprint(config, typeof baselineSettings === "string" ? baselineSettings : undefined),
  });
  const fallbackReason = plan.mode === "full" && !options.forceFull && catalog?.graphVersion ? plan.reason : null;
  const fallbackCode = fallbackReason ? (plan.code ?? null) : null;
  const requestedMode = options.forceFull ? "full" : "incremental";
  const previousGraphVersion = catalog?.graphVersion ?? null;

  const emptyMetrics: SyncMetrics = {
    changedFiles: summarizeChangeSet(changeSet).total, filesAnalyzed: 0, affectedProjects: plan.affected.projects.length,
    entitiesCreated: 0, entitiesUpdated: 0, entitiesDeleted: 0, relationshipsCreated: 0, relationshipsUpdated: 0, relationshipsDeleted: 0,
    durationMs: 0, baselineDurationMs: store.listRuns(repo.id)[0]?.stats.durationMs ?? null,
  };

  // 3. No-op: no new graph version for an unchanged repository.
  if (plan.mode === "noop") {
    const result: SyncResult = {
      repositoryId: repo.id, repository: repo.name, requestedMode, actualMode: "noop", mode: "noop", status: "NO_OP", reason: plan.reason, fallbackReason: null, fallbackCode: null,
      previousCommit: changeSet.previousCommit, currentCommit: changeSet.currentCommit, previousGraphVersion, graphVersion: previousGraphVersion,
      changeSource: changeSet.source, plan, metrics: emptyMetrics, diffSnapshotFrom: null, diffSnapshotTo: null, degradedPlugins: [], error: null, timestamp,
    };
    recordSync(store, repo.id, historyEntry(result, fingerprints, changeSet));
    return result;
  }

  // Capture the "before" snapshot for reconciliation metrics and before/after diff.
  const beforeSnapshot = settings.options.snapshots && previousGraphVersion ? snapshotFor(store, previousGraphVersion, "repository", repo.id) : null;

  // 4-7. Invalidate + Analyze + Reconcile + Version (delegated to the deterministic engine).
  try {
    const { run, repositoryId } = await analyzeRepository(path, store, plugins, settings.options, log);
    store.saveBaseline(`analysis-settings:${repositoryId}`, settings.fingerprint ?? null);
    const newCatalog = store.getCatalog(repositoryId);
    const graphVersion = newCatalog?.graphVersion ?? null;
    const afterSnapshot = settings.options.snapshots && graphVersion ? snapshotFor(store, graphVersion, "repository", repo.id) : null;
    const measured = afterSnapshot !== null && (beforeSnapshot !== null || previousGraphVersion === null);

    let entitiesCreated = 0, entitiesUpdated = 0, entitiesDeleted = 0, relsCreated = 0, relsUpdated = 0, relsDeleted = 0;
    if (beforeSnapshot && afterSnapshot && beforeSnapshot.id !== afterSnapshot.id) {
      const d = diffSnapshots(store, beforeSnapshot.id, afterSnapshot.id);
      entitiesCreated = d.entities.added.length; entitiesUpdated = d.entities.changed.length; entitiesDeleted = d.entities.removed.length;
      relsCreated = d.relationships.added.length; relsUpdated = d.relationships.changed.length; relsDeleted = d.relationships.removed.length;
    } else if (!previousGraphVersion && afterSnapshot) {
      entitiesCreated = afterSnapshot.entities; relsCreated = afterSnapshot.relationships;
    }

    const metrics: SyncMetrics = {
      changedFiles: summarizeChangeSet(changeSet).total, filesAnalyzed: run.stats.files ?? 0, affectedProjects: plan.affected.projects.length,
      entitiesCreated: measured ? entitiesCreated : null,
      entitiesUpdated: measured ? entitiesUpdated : null,
      entitiesDeleted: measured ? entitiesDeleted : null,
      relationshipsCreated: measured ? relsCreated : null,
      relationshipsUpdated: measured ? relsUpdated : null,
      relationshipsDeleted: measured ? relsDeleted : null,
      durationMs: run.stats.durationMs ?? 0, baselineDurationMs: previous?.metrics.baselineDurationMs ?? emptyMetrics.baselineDurationMs,
    };
    const result: SyncResult = {
      repositoryId: repo.id, repository: repo.name, requestedMode, actualMode: plan.mode, mode: plan.mode, status: "SUCCESS", reason: plan.reason, fallbackReason, fallbackCode,
      previousCommit: changeSet.previousCommit, currentCommit: run.commit, previousGraphVersion, graphVersion,
      changeSource: changeSet.source, plan, metrics, diffSnapshotFrom: beforeSnapshot?.id ?? null, diffSnapshotTo: afterSnapshot?.id ?? null,
      degradedPlugins: [...new Set(store.findDiagnostics({ repositoryId, limit: 100000 }).filter((d) => d.code === "plugin-failed").map((d) => d.plugin))].sort(), error: null, timestamp,
    };
    recordSync(store, repo.id, historyEntry(result, fingerprints, changeSet));
    return result;
  } catch (error) {
    // Failure-safe: analyzeRepository persists atomically, so the previous valid
    // graph version is untouched when analysis fails.
    const message = error instanceof AnalysisError ? `${error.category}: ${error.message}` : error instanceof Error ? error.message : String(error);
    const result: SyncResult = {
      repositoryId: repo.id, repository: repo.name, requestedMode, actualMode: plan.mode, mode: plan.mode, status: "FAILED", reason: plan.reason, fallbackReason, fallbackCode,
      previousCommit: changeSet.previousCommit, currentCommit: changeSet.currentCommit, previousGraphVersion, graphVersion: previousGraphVersion,
      changeSource: changeSet.source, plan, metrics: emptyMetrics, diffSnapshotFrom: null, diffSnapshotTo: null, degradedPlugins: [], error: message, timestamp,
    };
    recordSync(store, repo.id, historyEntry(result, fingerprints, changeSet));
    return result;
  }
}

function historyEntry(result: SyncResult, fingerprints: Fingerprints, changeSet: ChangeSet): SyncHistoryEntry {
  return {
    timestamp: result.timestamp, requestedMode: result.requestedMode, mode: result.mode, status: result.status, reason: result.reason, fallbackReason: result.fallbackReason, fallbackCode: result.fallbackCode,
    currentCommit: result.currentCommit, graphVersion: result.graphVersion, configFingerprint: fingerprints.configFingerprint,
    changeSetFingerprint: changeSetFingerprint(changeSet), metrics: result.metrics,
  };
}


function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process exclusive lock using atomic mkdir; a lock owned by a dead process is recovered. */
async function withSyncLock<T>(dir: string, repositoryId: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, `sync-${repositoryId}.lock`);
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, "owner"), String(process.pid));
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(join(lock, "owner"), "utf8"));
      } catch {
        /* owner file not yet written: treat as live */
        owner = -1;
      }
      const ownerless = !(owner > 0) && Date.now() - statSync(lock).mtimeMs > 30_000;
      if (ownerless || (owner > 0 && !alive(owner))) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("another synchronization of this repository is in progress");
      await Bun.sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function syncRepository(path: string, store: GraphStore, plugins: readonly Plugin[], options: SyncOptions, log: Logger): Promise<SyncResult> {
  let config: ReturnType<typeof loadConfig>;
  let repo: ReturnType<typeof discoverRepository>;
  try {
    config = loadConfig(repositoryRoot(path));
    repo = discoverRepository(path, config.repository);
  } catch (error) {
    // Git exists but is unusable: refuse explicitly. When the checkout is a registered repository, record the refusal
    // in its history; otherwise the error surfaces as is (exit 1), never as a path-derived identity.
    if (!(error instanceof GitStateError)) throw error;
    const registered = catalogByPath(store, path);
    if (!registered) throw error;
    log.error("sync.git.unreadable", { path, error: error.message });
    return refuseSync(store, registered, options, currentFingerprints(loadConfig(registered.localPath ?? path), plugins), "Git state could not be read", error.message);
  }
  const run = () => syncUnlocked(path, store, plugins, options, log);
  if (!options.lockDir) return run();
  try {
    return await withSyncLock(options.lockDir, repo.id, options.lockWaitMs ?? 120_000, run);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("another synchronization")) throw error;
    const catalog = store.getCatalog(repo.id);
    const timestamp = new Date().toISOString();
    return {
      repositoryId: repo.id, repository: repo.name, requestedMode: options.forceFull ? "full" : "incremental", actualMode: "incremental", mode: "incremental", status: "FAILED", reason: "synchronization lock not acquired", fallbackReason: null, fallbackCode: null,
      previousCommit: catalog?.analyzedCommit ?? null, currentCommit: repo.commit, previousGraphVersion: catalog?.graphVersion ?? null, graphVersion: catalog?.graphVersion ?? null,
      changeSource: "manual", plan: { mode: "incremental", reason: "lock not acquired", safe: true, affected: { files: [], projects: [], domains: [], entityCount: 0 }, widened: false },
      metrics: { changedFiles: 0, filesAnalyzed: 0, affectedProjects: 0, entitiesCreated: 0, entitiesUpdated: 0, entitiesDeleted: 0, relationshipsCreated: 0, relationshipsUpdated: 0, relationshipsDeleted: 0, durationMs: 0, baselineDurationMs: null },
      diffSnapshotFrom: null, diffSnapshotTo: null, degradedPlugins: [], error: error.message, timestamp,
    };
  }
}
