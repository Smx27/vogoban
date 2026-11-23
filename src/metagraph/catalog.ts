import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CatalogEntry, RepositoryStatus } from "../graph/model.ts";
import { loadConfig } from "../pipeline/config.ts";
import { currentCommit, discoverRepository, repositoryRoot } from "../pipeline/discovery.ts";
import type { GraphStore } from "../store/store.ts";

export interface CatalogStatus {
  entry: CatalogEntry;
  status: RepositoryStatus;
  currentCommit: string | null;
  reason: string | null;
}

export function registerRepository(store: GraphStore, path: string, semantic: boolean): CatalogEntry {
  const root = repositoryRoot(path);
  const repo = discoverRepository(root, loadConfig(root).repository);
  const existing = store.getCatalog(repo.id);
  const entry: CatalogEntry = existing
    ? { ...existing, localPath: repo.rootPath, url: repo.remoteUrl, provider: repo.provider, organization: repo.organization, defaultBranch: repo.defaultBranch ?? existing.defaultBranch, semantic }
    : {
        repositoryId: repo.id, identity: repo.identity, name: repo.name, url: repo.remoteUrl, provider: repo.provider, organization: repo.organization,
        defaultBranch: repo.defaultBranch, localPath: repo.rootPath, status: "REGISTERED", registeredAt: new Date().toISOString(), analyzedCommit: null,
        analyzedDirty: false, analyzedRun: null, analyzedAt: null, graphVersion: null, analyzerVersion: null, semantic, lastError: null,
      };
  store.upsertCatalog(entry);
  return entry;
}

export function catalogStatus(entry: CatalogEntry): CatalogStatus {
  if (entry.status !== "READY") return { entry, status: entry.status, currentCommit: null, reason: entry.lastError };
  if (!entry.localPath || !existsSync(entry.localPath)) return { entry, status: "UNAVAILABLE", currentCommit: null, reason: "local checkout is not available; the stored graph is still usable" };
  const current = currentCommit(entry.localPath);
  if (current.commit !== entry.analyzedCommit) return { entry, status: "STALE", currentCommit: current.commit, reason: `analyzed ${entry.analyzedCommit?.slice(0, 12) ?? "(no commit)"}, checkout is at ${current.commit?.slice(0, 12) ?? "(no commit)"}` };
  if (current.dirty && !entry.analyzedDirty) return { entry, status: "STALE", currentCommit: current.commit, reason: "checkout has uncommitted changes since analysis" };
  return { entry, status: "READY", currentCommit: current.commit, reason: null };
}

export const usableForMetaGraph = (s: CatalogStatus) => s.entry.graphVersion !== null;

export function discoverRepositories(baseDir: string, maxDepth = 3): string[] {
  const resolvedBase = resolve(baseDir);
  if (!existsSync(resolvedBase)) return [];

  const foundRoots: string[] = [];

  function isGitRoot(dir: string): boolean {
    const gitPath = join(dir, ".git");
    return existsSync(gitPath);
  }

  function walk(currentDir: string, currentDepth: number) {
    if (isGitRoot(currentDir)) {
      foundRoots.push(currentDir);
      return;
    }
    if (currentDepth >= maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "bin" || entry === "obj" || entry.startsWith(".")) {
        continue;
      }
      const fullPath = join(currentDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, currentDepth + 1);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  walk(resolvedBase, 0);
  return foundRoots.sort();
}
