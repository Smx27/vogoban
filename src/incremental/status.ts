import type { GraphStore } from "../store/store.ts";
import type { Plugin } from "../plugins/types.ts";
import { loadConfig } from "../pipeline/config.ts";
import { discoverRepository, repositoryRoot } from "../pipeline/discovery.ts";
import { changeSetFromGit, headCommit, isDirty, isGitRepository } from "./git.ts";
import { summarizeChangeSet, type ChangeSet } from "./changeset.ts";
import { currentFingerprints, lastSync } from "./sync.ts";

export type SyncState = "NEVER_ANALYZED" | "UP_TO_DATE" | "CHANGES_DETECTED" | "FULL_REBUILD_REQUIRED" | "FAILED";

export interface SyncStatus {
  repository: string;
  repositoryId: string;
  state: SyncState;
  analyzedCommit: string | null;
  workingCommit: string | null;
  dirty: boolean;
  upToDate: boolean;
  lastSyncAt: string | null;
  lastSyncMode: string | null;
  lastSyncStatus: string | null;
  fallbackReason: string | null;
  fullRebuildRequired: boolean;
  fullRebuildReason: string | null;
  changedFiles: number;
  changeSet: ChangeSet | null;
}

/** Report whether the graph is current with the working tree, and why not. */
export function syncStatus(path: string, store: GraphStore, plugins: readonly Plugin[]): SyncStatus {
  const root = repositoryRoot(path);
  const config = loadConfig(root);
  const repo = discoverRepository(path, config.repository);
  const catalog = store.getCatalog(repo.id);
  const last = lastSync(store, repo.id);
  const workingCommit = isGitRepository(root) ? headCommit(root) : null;
  const dirty = isGitRepository(root) ? isDirty(root) : false;

  const base: Omit<SyncStatus, "state" | "upToDate" | "changedFiles" | "changeSet" | "fullRebuildRequired" | "fullRebuildReason"> = {
    repository: repo.name, repositoryId: repo.id, analyzedCommit: catalog?.analyzedCommit ?? null, workingCommit, dirty,
    lastSyncAt: last?.timestamp ?? null, lastSyncMode: last?.mode ?? null, lastSyncStatus: last?.status ?? null, fallbackReason: last?.fallbackReason ?? null,
  };

  if (!catalog || catalog.status === "FAILED" && !catalog.graphVersion)
    return { ...base, state: "NEVER_ANALYZED", upToDate: false, changedFiles: 0, changeSet: null, fullRebuildRequired: true, fullRebuildReason: "repository has not been analyzed", };

  // Fingerprint incompatibility forces a full rebuild regardless of file changes.
  const current = currentFingerprints(config, plugins);
  const run = store.listRuns(repo.id)[0] ?? null;
  let fullReason: string | null = null;
  if (run && run.schemaVersion !== current.schemaVersion) fullReason = "graph schema version changed";
  else if (run && run.analyzerVersion !== current.analyzerVersion) fullReason = "analyzer version changed";
  else if (last && last.configFingerprint !== current.configFingerprint) fullReason = "configuration changed since last sync";

  let changeSet: ChangeSet | null = null;
  let changedFiles = 0;
  if (isGitRepository(root) && catalog.analyzedCommit) {
    const built = changeSetFromGit({ repositoryId: repo.id, repositoryIdentity: repo.identity, root, mode: "working-tree", baseCommit: catalog.analyzedCommit });
    if (!("error" in built)) {
      changeSet = built.changeSet;
      changedFiles = summarizeChangeSet(changeSet).total;
    }
  }

  if (fullReason) return { ...base, state: "FULL_REBUILD_REQUIRED", upToDate: false, changedFiles, changeSet, fullRebuildRequired: true, fullRebuildReason: fullReason };

  const upToDate = changedFiles === 0 && !dirty && (workingCommit === null || workingCommit === catalog.analyzedCommit);
  return {
    ...base,
    state: last?.status === "FAILED" ? "FAILED" : upToDate ? "UP_TO_DATE" : "CHANGES_DETECTED",
    upToDate, changedFiles, changeSet, fullRebuildRequired: false, fullRebuildReason: null,
  };
}
