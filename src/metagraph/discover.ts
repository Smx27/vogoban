import { readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CatalogEntry } from "../graph/model.ts";
import { repositoryRoot } from "../pipeline/discovery.ts";

export type RepositoryMarker = ".git" | "vogoban.json" | "catalog-info.yaml" | "catalog-info.yml";

export interface DiscoveredRepositoryCandidate {
  path: string;
  marker: RepositoryMarker;
  root: string;
  skipped: string | null;
}

export interface StaleCatalogEntry {
  name: string;
  repositoryId: string;
  localPath: string | null;
  reason: string;
}

const MARKERS: RepositoryMarker[] = [".git", "vogoban.json", "catalog-info.yaml", "catalog-info.yml"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "bin", "obj", "dist", "target", "vendor", "__pycache__"]);

export function discoverRepositoryCandidates(directory: string, maxDepth: number): DiscoveredRepositoryCandidate[] {
  const start = realpathSync(directory);
  const found: DiscoveredRepositoryCandidate[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = new Set(entries.map((e) => e.name));
    const marker = MARKERS.find((m) => names.has(m));
    if (marker) {
      const root = repositoryRoot(dir);
      const skipped = marker !== ".git" && root !== dir
        ? `inside the git repository ${root}; analyze that repository, or give this directory its own checkout`
        : null;
      found.push({ path: dir, marker, root, skipped });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(start, 0);
  const seen = new Set<string>();
  return found.filter((c) => {
    if (c.skipped) return true;
    if (seen.has(c.root)) return false;
    seen.add(c.root);
    return true;
  });
}

export function staleCatalogEntries(directory: string, catalog: CatalogEntry[], discoveredRoots: Set<string>): StaleCatalogEntry[] {
  const start = realpathSync(directory);
  const within = (path: string) => path === start || !relative(start, path).startsWith("..") && !relative(start, path).startsWith(sep);
  return catalog
    .filter((e) => e.localPath && within(e.localPath) && !discoveredRoots.has(e.localPath))
    .map((e) => ({ name: e.name, repositoryId: e.repositoryId, localPath: e.localPath, reason: "registered under this directory but no longer found there" }));
}
