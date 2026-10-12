import { ids, keys } from "../graph/identity.ts";
import type { CatalogEntry } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import { summarizeChangeSet, type ChangeSet } from "./changeset.ts";

/**
 * Compatibility fingerprints. Incremental reuse of existing analysis artifacts
 * is valid only when every one of these matches the state the graph was built
 * with; otherwise the planner demands a full rebuild and reports why.
 */
export interface Fingerprints {
  analyzerVersion: string;
  schemaVersion: number;
  pluginVersions: Record<string, string>;
  configFingerprint: string;
}

export type SyncMode = "noop" | "incremental" | "full";

export type FullRebuildCode =
  | "missing_base_commit"
  | "not_a_git_repository"
  | "full_requested"
  | "no_existing_graph"
  | "no_prior_run"
  | "semantic_mode_changed"
  | "evaluation_mode_changed"
  | "schema_version_changed"
  | "analyzer_version_changed"
  | "plugin_versions_changed"
  | "configuration_changed";

export interface IncrementalPlan {
  mode: SyncMode;
  /** Human-readable reason, always populated for noop and full. */
  reason: string;
  /** Stable machine-readable reason for a full rebuild (for CI); absent for noop and incremental plans. */
  code?: FullRebuildCode;
  /** True when a safe incremental dependency boundary was established. */
  safe: boolean;
  affected: {
    files: string[];
    projects: string[];
    /** Downstream intelligence domains that may need recomputation. */
    domains: string[];
    /** Entities whose provenance points at a changed file (reconciliation candidates). */
    entityCount: number;
  };
  /** When true, invalidation was widened because a structural/config change was detected. */
  widened: boolean;
}

const pluginKey = (v: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));

const DOMAIN_BY_CATEGORY: Record<string, string[]> = {
  source: ["code", "application", "api", "messaging"],
  project: ["code", "application", "api", "messaging"],
  solution: ["code", "application"],
  contract: ["api", "messaging"],
  infrastructure: ["infrastructure", "deployment"],
  pipeline: ["infrastructure", "deployment"],
  config: ["configuration", "security"],
};

/**
 * Deterministic incremental planner. Given the same repository state and change
 * set it always produces the same plan. It never silently underestimates
 * invalidation: when a safe boundary cannot be established it widens scope, and
 * on any incompatibility it falls back to a full rebuild with an explicit reason.
 */
export function planIncremental(
  store: GraphStore,
  catalog: CatalogEntry | null,
  changeSet: ChangeSet,
  current: Fingerprints,
  options: { forceFull?: boolean; forceReason?: string | null; forceCode?: FullRebuildCode; previousConfigFingerprint?: string | null; semantic?: boolean } = {},
): IncrementalPlan {
  const summary = summarizeChangeSet(changeSet);
  const empty = { files: [], projects: [], domains: [], entityCount: 0 };

  if (options.forceReason) return { mode: "full", reason: options.forceReason, code: options.forceCode ?? "missing_base_commit", safe: true, affected: empty, widened: false };
  if (options.forceFull) return { mode: "full", reason: "full rebuild requested", code: "full_requested", safe: true, affected: empty, widened: false };
  if (!catalog || !catalog.graphVersion || !catalog.analyzedCommit) return { mode: "full", reason: "no existing graph for this repository", code: "no_existing_graph", safe: true, affected: empty, widened: false };

  if (options.semantic !== undefined && catalog.semantic !== options.semantic)
    return { mode: "full", reason: `semantic analysis mode changed (${catalog.semantic ? "enabled" : "disabled"} -> ${options.semantic ? "enabled" : "disabled"}); the analysis model differs`, code: "semantic_mode_changed", safe: true, affected: empty, widened: false };
  const evaluation = process.env.VOGOBAN_MSBUILD_EVALUATION === "0" ? "off" : "on";
  const builtWith = store.getBaseline(`evaluation:${catalog.repositoryId}`)?.data;
  if (builtWith !== undefined && builtWith !== evaluation)
    return { mode: "full", reason: `repository build evaluation mode changed (${builtWith} -> ${evaluation}); the analysis trust model differs`, code: "evaluation_mode_changed", safe: true, affected: empty, widened: false };
  const lastRun = store.listRuns(catalog.repositoryId)[0] ?? null;
  if (!lastRun) return { mode: "full", reason: "no prior analysis run recorded", code: "no_prior_run", safe: true, affected: empty, widened: false };
  if (lastRun.schemaVersion !== current.schemaVersion) return { mode: "full", reason: `graph schema version changed (${lastRun.schemaVersion} -> ${current.schemaVersion})`, code: "schema_version_changed", safe: true, affected: empty, widened: false };
  if (lastRun.analyzerVersion !== current.analyzerVersion) return { mode: "full", reason: `analyzer version changed (${lastRun.analyzerVersion} -> ${current.analyzerVersion})`, code: "analyzer_version_changed", safe: true, affected: empty, widened: false };
  if (pluginKey(lastRun.pluginVersions) !== pluginKey(current.pluginVersions)) return { mode: "full", reason: "plugin versions changed", code: "plugin_versions_changed", safe: true, affected: empty, widened: false };
  if (options.previousConfigFingerprint && options.previousConfigFingerprint !== current.configFingerprint)
    return { mode: "full", reason: "configuration changed since last sync", code: "configuration_changed", safe: true, affected: empty, widened: false };
  if (changeSet.changes.some((c) => c.path === "vogoban.json" || c.previousPath === "vogoban.json"))
    return { mode: "full", reason: "vogoban.json configuration changed", code: "configuration_changed", safe: true, affected: empty, widened: false };

  const sameCommit = changeSet.currentCommit === catalog.analyzedCommit;
  // A graph built from a dirty tree reflects uncommitted content that no commit diff can describe; it must be re-derived.
  if (catalog.analyzedDirty && summary.total === 0)
    return { mode: "incremental", reason: "graph was built from a dirty working tree; re-deriving against current state", safe: true, affected: { ...empty, domains: ["code", "application", "api", "messaging", "infrastructure", "deployment", "configuration", "security", "metagraph"] }, widened: true };
  if (sameCommit && !changeSet.dirty && !catalog.analyzedDirty)
    return { mode: "noop", reason: "graph already reflects the checked-out commit", safe: true, affected: empty, widened: false };
  if (summary.total === 0 && sameCommit && !changeSet.dirty)
    return { mode: "noop", reason: "repository unchanged since last analyzed commit", safe: true, affected: empty, widened: false };
  if (summary.total === 0 && sameCommit && changeSet.dirty)
    return { mode: "noop", reason: "no file changes detected relative to the analyzed commit", safe: true, affected: empty, widened: false };

  // Incremental: compute the affected scope from the change set and existing graph relationships.
  const repoId = catalog.repositoryId;
  const files = new Set<string>();
  const domains = new Set<string>(["metagraph"]);
  for (const c of changeSet.changes) {
    files.add(c.path);
    if (c.previousPath) files.add(c.previousPath);
    for (const d of DOMAIN_BY_CATEGORY[c.category] ?? ["code"]) domains.add(d);
  }

  let affectedProjects = resolveAffectedProjects(store, repoId, [...files]);
  // Shared build/SDK/analyzer configuration can change compilation of any project: report (and plan for) all of them.
  const SHARED = /(^|\/)(Directory\.[\w.]+\.(props|targets)|global\.json|nuget\.config|\.editorconfig|[\w.-]+\.(props|targets)|[\w.-]+\.(sln|slnx|slnf))$/i;
  const widenedFiles = [...files].filter((f) => SHARED.test(f));
  if (widenedFiles.length) {
    affectedProjects = store.findEntities({ repositoryId: repoId, kinds: ["Project"], limit: 1_000_000 }).map((e) => e.qualifiedName ?? e.name);
    for (const d of ["code", "application", "api", "messaging"]) domains.add(d);
  }
  // Frontend: package manifests and tsconfig chains shape module resolution and compiler options of every npm project
  // (workspace names, `extends`, `paths`), so a change to any of them re-derives all of them.
  const FRONTEND_SHARED = /(^|\/)(package\.json|(tsconfig|jsconfig)[\w.-]*\.json|angular\.json|pnpm-workspace\.yaml|nx\.json|lerna\.json)$/i;
  const frontendShared = [...files].filter((f) => FRONTEND_SHARED.test(f));
  if (frontendShared.length) {
    const npm = store.findEntities({ repositoryId: repoId, kinds: ["Project"], limit: 1_000_000 }).filter((e) => e.metadata.ecosystem === "npm").map((e) => e.qualifiedName ?? e.name);
    affectedProjects = [...new Set([...affectedProjects, ...npm])];
    widenedFiles.push(...frontendShared);
  }
  if ([...files].some((f) => /\.(m|c)?(t|j)sx?$|\.html$/i.test(f) || FRONTEND_SHARED.test(f))) domains.add("frontend");
  // Azure: IaC, Functions configuration and azd manifests are Azure inputs; a module file used by other IaC files widens the
  // plan to every file (transitively) instantiating it, and code changes re-derive the Azure facts of repositories that have them.
  const AZURE_INPUT = /\.(bicep|bicepparam|tf|tfvars)$|\.tfvars\.json$|(^|\/)(host|function|local\.settings[\w.-]*)\.json$|(^|\/)azure\.ya?ml$/i;
  const azureFiles = [...files].filter((f) => AZURE_INPUT.test(f) || store.getEntity(ids.entity(keys.file(repoId, f)))?.language === "arm" || store.getEntity(ids.entity(keys.file(repoId, f)))?.language === "bicep-content");
  const hasAzure = store.findEntities({ repositoryId: repoId, kinds: ["AzureFunction", "AzureResource"], limit: 1 }).length > 0;
  if (azureFiles.length || (hasAzure && [...files].some((f) => /\.(cs|csproj|props|targets)$/i.test(f)))) domains.add("azure");
  if (azureFiles.length) {
    const queue = azureFiles.map((f) => ids.entity(keys.file(repoId, f)));
    const seen = new Set(queue);
    while (queue.length) {
      const batch = queue.splice(0, 400);
      for (const rel of store.findRelationships({ targetIds: batch, types: ["USES_MODULE"], repositoryId: repoId })) {
        if (seen.has(rel.sourceId)) continue;
        seen.add(rel.sourceId);
        queue.push(rel.sourceId);
        const consumer = store.getEntity(rel.sourceId)?.qualifiedName;
        if (consumer) {
          files.add(consumer);
          widenedFiles.push(consumer);
        }
      }
    }
  }
  let entityCount = 0;
  for (const path of files) {
    const fileEntityId = ids.entity(keys.file(repoId, path));
    if (store.getEntity(fileEntityId)) entityCount++;
  }

  return {
    mode: "incremental",
    reason: `${summary.total} file change(s): +${summary.added} ~${summary.modified} -${summary.deleted} renamed ${summary.renamed}`,
    safe: true,
    affected: {
      files: [...files].sort(),
      projects: affectedProjects.sort(),
      domains: [...domains].sort(),
      entityCount,
    },
    widened: summary.structural || widenedFiles.length > 0,
  };
}

/**
 * Map changed files to the projects that must be re-derived: the owning project
 * of each file plus every project that transitively references it. This mirrors
 * the compiler cache's invalidation closure, so the reported scope matches what
 * the analyzer will actually recompute.
 */
function resolveAffectedProjects(store: GraphStore, repoId: string, files: string[]): string[] {
  const direct = new Set<string>();
  for (const path of files) {
    const fileEntityId = ids.entity(keys.file(repoId, path));
    // Project -> file (PROJECT_CONTAINS) and project-file -> project (DECLARES).
    for (const rel of store.findRelationships({ targetIds: [fileEntityId], types: ["PROJECT_CONTAINS", "DECLARES"], repositoryId: repoId })) {
      const src = store.getEntity(rel.sourceId);
      if (src?.kind === "Project") direct.add(src.id);
      else if (src) {
        // DECLARES may go project-file -> project; follow forward too.
        for (const r2 of store.findRelationships({ sourceIds: [fileEntityId], types: ["DECLARES"], repositoryId: repoId })) {
          const t = store.getEntity(r2.targetId);
          if (t?.kind === "Project") direct.add(t.id);
        }
      }
    }
    for (const rel of store.findRelationships({ sourceIds: [fileEntityId], types: ["DECLARES"], repositoryId: repoId })) {
      const t = store.getEntity(rel.targetId);
      if (t?.kind === "Project") direct.add(t.id);
    }
  }

  // TS/JS: a project's analysis reads every module its files import (also across package boundaries via relative
  // paths or tsconfig `paths`), so the owner of any file that transitively imports a changed module is affected too.
  const IMPORT_TYPES = ["IMPORTS", "TYPE_IMPORTS", "DYNAMIC_IMPORTS", "REQUIRES", "REFERENCES_MODULE", "RE_EXPORTS"] as const;
  const moduleQueue = files.filter((f) => /\.(m|c)?(t|j)sx?$/i.test(f)).map((f) => ids.entity(keys.file(repoId, f)));
  const seenModules = new Set(moduleQueue);
  while (moduleQueue.length) {
    const batch = moduleQueue.splice(0, 400);
    for (const rel of store.findRelationships({ targetIds: batch, types: [...IMPORT_TYPES], repositoryId: repoId })) {
      if (seenModules.has(rel.sourceId)) continue;
      seenModules.add(rel.sourceId);
      moduleQueue.push(rel.sourceId);
    }
  }
  const modules = [...seenModules];
  for (let i = 0; i < modules.length; i += 400) {
    for (const rel of store.findRelationships({ targetIds: modules.slice(i, i + 400), types: ["PROJECT_CONTAINS"], repositoryId: repoId })) {
      if (store.getEntity(rel.sourceId)?.kind === "Project") direct.add(rel.sourceId);
    }
  }

  // Transitive reverse closure over PROJECT_REFERENCES (a dependent must recompile).
  const affected = new Set(direct);
  const queue = [...direct];
  while (queue.length) {
    const id = queue.pop()!;
    for (const rel of store.findRelationships({ targetIds: [id], types: ["PROJECT_REFERENCES"], repositoryId: repoId })) {
      if (!affected.has(rel.sourceId)) {
        affected.add(rel.sourceId);
        queue.push(rel.sourceId);
      }
    }
  }
  return [...affected].map((id) => store.getEntity(id)?.qualifiedName ?? store.getEntity(id)?.name ?? id);
}
