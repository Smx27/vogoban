import { GraphBuilder } from "../graph/builder.ts";
import { ids, keys } from "../graph/identity.ts";
import { GRAPH_SCHEMA_VERSION, type AnalysisRun, type FileRecord, type Provenance } from "../graph/model.ts";
import type { Logger } from "../log.ts";
import {
  ArtifactStore,
  PLUGIN_CATEGORIES,
  type AnalysisContext,
  type AnalysisOptions,
  type LanguagePlugin,
  type ParseResult,
  type Plugin,
} from "../plugins/types.ts";
import type { GraphStore } from "../store/store.ts";
import { createHash } from "node:crypto";
import { captureRepositorySnapshot } from "../analysis/diff.ts";
import type { CatalogEntry } from "../graph/model.ts";
import { loadConfig, type VogobanConfig } from "./config.ts";
import { discoverFiles, discoverRepository, fileExclusionMatcher, repositoryRoot, type DiscoveredRepository } from "./discovery.ts";
import { loadWorkspaceConfig } from "../local/workspace.ts";
import { selectAnalyzerPlugins } from "../plugins/registry.ts";

export const ANALYZER_VERSION = "0.1.0";
const CORE = "vogoban.core";

export function repositoryAnalysisSettings(root: string, overrides: AnalysisOptions & { incremental?: boolean }) {
  const workspace = loadWorkspaceConfig(root)?.analysis;
  const explicit = Object.fromEntries(["semantic", "analyzers", "exclusions", "snapshots", "incremental"].filter((key) => overrides[key as keyof typeof overrides] !== undefined).map((key) => [key, overrides[key as keyof typeof overrides]]));
  const hasOverrides = overrides.analyzers !== undefined || overrides.exclusions !== undefined || overrides.snapshots !== undefined || overrides.incremental !== undefined;
  return {
    options: {
      semantic: overrides.semantic ?? workspace?.semantic ?? true,
      analyzers: overrides.analyzers ?? workspace?.analyzers,
      exclusions: overrides.exclusions ?? workspace?.exclusions,
      snapshots: overrides.snapshots ?? workspace?.snapshots ?? true,
      incremental: overrides.incremental ?? workspace?.incremental ?? true,
    },
    fingerprint: workspace || hasOverrides ? createHash("sha256").update(JSON.stringify({ workspace: workspace ?? null, overrides: explicit })).digest("hex").slice(0, 16) : undefined,
  };
}

export class AnalysisError extends Error {
  constructor(readonly category: "repository" | "storage", message: string) {
    super(message);
  }
}

export interface AnalyzeResult {
  run: AnalysisRun;
  repositoryId: string;
}

function isLanguagePlugin(plugin: Plugin): plugin is LanguagePlugin<unknown> {
  return plugin.category === "language";
}

export async function analyzeRepository(
  path: string,
  store: GraphStore,
  plugins: readonly Plugin[],
  options: AnalysisOptions,
  rootLog: Logger,
): Promise<AnalyzeResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let repo: DiscoveredRepository;
  let config: VogobanConfig;
  let settings: ReturnType<typeof repositoryAnalysisSettings>;
  try {
    const root = repositoryRoot(path);
    config = loadConfig(root);
    settings = repositoryAnalysisSettings(root, options);
    options = settings.options;
    plugins = selectAnalyzerPlugins(plugins, options.analyzers);
    repo = discoverRepository(path, config.repository);
  } catch (error) {
    throw new AnalysisError("repository", `repository cannot be accessed: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  const log = rootLog.child({ repo: repo.name });
  log.info("discovery.repository", { id: repo.id, root: repo.rootPath, commit: repo.commit, branch: repo.branch, dirty: repo.dirty });
  const previous = store.getCatalog(repo.id);
  if (!previous && repo.identity.startsWith("local:")) {
    const registered = store.listCatalog().find((e) => e.localPath === repo.rootPath && e.identity !== repo.identity);
    if (registered)
      throw new AnalysisError("repository", `${repo.rootPath} is registered as ${registered.identity} but Git no longer reports a repository there (identity would become ${repo.identity}); the Git checkout is missing or unusable. Restore it and retry; the previous graph is preserved.`);
  }
  const catalog: CatalogEntry = {
    repositoryId: repo.id, identity: repo.identity, name: repo.name, url: repo.remoteUrl, provider: repo.provider, organization: repo.organization,
    defaultBranch: repo.defaultBranch, localPath: repo.rootPath, status: "ANALYZING", registeredAt: previous?.registeredAt ?? startedAt,
    analyzedCommit: previous?.analyzedCommit ?? null, analyzedDirty: previous?.analyzedDirty ?? false, analyzedRun: previous?.analyzedRun ?? null, analyzedAt: previous?.analyzedAt ?? null,
    graphVersion: previous?.graphVersion ?? null, analyzerVersion: previous?.analyzerVersion ?? null, semantic: settings.options.semantic, lastError: null,
  };
  store.upsertCatalog(catalog);
  try {
    let snapshot: ReturnType<typeof captureRepositorySnapshot> | null = null;
    const result = await analyzeDiscovered(repo, config, store, plugins, options, log, startedAt, started, (run, graphVersion) => {
      store.upsertCatalog({ ...catalog, status: "READY", analyzedCommit: repo.commit, analyzedDirty: repo.dirty, analyzedRun: run.id, analyzedAt: run.finishedAt, graphVersion, analyzerVersion: ANALYZER_VERSION });
      store.saveBaseline(`evaluation:${repo.id}`, process.env.VOGOBAN_MSBUILD_EVALUATION === "0" ? "off" : "on");
      store.saveBaseline(`analysis-settings:${repo.id}`, settings.fingerprint ?? null);
      if (options.snapshots !== false) snapshot = captureRepositorySnapshot(store, repo.id, repo.commit, graphVersion);
    });
    const captured = snapshot as ReturnType<typeof captureRepositorySnapshot> | null;
    if (captured) log.info("graph.snapshot", { id: captured.id, entities: captured.entities, relationships: captured.relationships });
    return result;
  } catch (error) {
    store.upsertCatalog({ ...catalog, status: "FAILED", lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function analyzeDiscovered(
  repo: DiscoveredRepository,
  config: VogobanConfig,
  store: GraphStore,
  plugins: readonly Plugin[],
  options: AnalysisOptions,
  log: Logger,
  startedAt: string,
  started: number,
  publish: (run: AnalysisRun, graphVersion: string) => void,
): Promise<AnalyzeResult & { graphVersion: string }> {
  const { files, skipped } = await discoverFiles(repo.rootPath, log, config.openapi, config.infrastructure.pipelines, config.infrastructure.helmValues, config.frontend, options.exclusions);
  const graph = new GraphBuilder();
  const provenance = (input: { plugin: string; extractor: string; mechanism: string; resolver?: string | null; location?: Provenance["location"]; version: string }): Provenance => ({
    repositoryId: repo.id,
    commit: repo.commit,
    location: input.location ?? null,
    plugin: input.plugin,
    extractor: input.extractor,
    resolver: input.resolver ?? null,
    mechanism: input.mechanism,
    analysisVersion: `${ANALYZER_VERSION}/${input.version}`,
  });

  const repositoryEntityId = graph.entity({
    key: keys.repository(repo.identity),
    kind: "Repository",
    layer: "repository",
    name: repo.name,
    qualifiedName: repo.identity,
    repositoryId: repo.id,
    metadata: { remoteUrl: repo.remoteUrl, branch: repo.branch, commit: repo.commit, dirty: repo.dirty },
    provenance: provenance({ plugin: CORE, extractor: "repository-discovery", mechanism: "git", version: ANALYZER_VERSION }),
  });

  const fileIds = new Map<string, string>();
  for (const file of files) {
    const id = graph.entity({
      key: keys.file(repo.id, file.path),
      kind: "File",
      layer: "source",
      name: file.path.split("/").pop() ?? file.path,
      qualifiedName: file.path,
      repositoryId: repo.id,
      language: file.language,
      location: { file: file.path, startLine: 1, startColumn: 1 },
      metadata: { hash: file.hash, size: file.size, category: file.category, generated: file.generated },
      provenance: provenance({ plugin: CORE, extractor: "file-discovery", mechanism: "filesystem", version: ANALYZER_VERSION }),
    });
    fileIds.set(file.path, id);
    graph.relate({
      type: "CONTAINS",
      sourceId: repositoryEntityId,
      targetId: id,
      repositoryId: repo.id,
      evidence: "EXACT",
      provenance: provenance({ plugin: CORE, extractor: "file-discovery", mechanism: "filesystem", version: ANALYZER_VERSION }),
    });
  }
  for (const error of config.errors) {
    graph.diagnostic({ repositoryId: repo.id, category: "discovery", plugin: CORE, file: "vogoban.json", severity: "error", recoverable: true, code: "config-invalid", message: error });
  }
  for (const s of skipped) {
    graph.diagnostic({ repositoryId: repo.id, category: "discovery", plugin: CORE, file: s.path, severity: "warning", recoverable: true, code: "file-skipped", message: s.reason });
  }

  const excluded = fileExclusionMatcher(options.exclusions ?? []);
  const ctx: AnalysisContext = {
    repository: repo,
    repositoryEntityId,
    files,
    skippedFiles: skipped,
    graph,
    artifacts: new ArtifactStore(),
    cache: { get: (scope, key) => store.getCachedFacts(scope, key), put: (scope, key, payload) => store.putCachedFacts(scope, key, payload) },
    log,
    options,
    config,
    provenance,
    readText: (p) => excluded(p) ? Promise.reject(new Error(`file excluded by analysis settings: ${p}`)) : Bun.file(`${repo.rootPath}/${p}`).text(),
    fileEntityId: (p) => fileIds.get(p),
  };

  const ordered = [...plugins].sort((a, b) => PLUGIN_CATEGORIES.indexOf(a.category) - PLUGIN_CATEGORIES.indexOf(b.category));
  const pluginVersions: Record<string, string> = {};
  const timings: Record<string, number> = {};
  for (const plugin of ordered) {
    pluginVersions[plugin.id] = plugin.version;
    const t0 = performance.now();
    const plog = log.child({ plugin: plugin.id });
    try {
      if (isLanguagePlugin(plugin)) await runLanguagePlugin(plugin, ctx, plog);
      else await plugin.run({ ...ctx, log: plog });
    } catch (error) {
      plog.error("plugin.failed", { error: String(error) });
      graph.diagnostic({
        repositoryId: repo.id,
        category: plugin.category === "semantic" ? "semantic" : plugin.category === "language" ? "parser" : plugin.category === "workspace" ? "project" : plugin.category === "resolver" ? "resolver" : "framework",
        plugin: plugin.id,
        file: null,
        severity: "error",
        recoverable: true,
        code: "plugin-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    timings[plugin.id] = Math.round(performance.now() - t0);
    plog.info("plugin.completed", { ms: timings[plugin.id] });
  }

  const batch = graph.finalize();
  const fileRecords: FileRecord[] = files.map((f) => ({ repositoryId: repo.id, path: f.path, hash: f.hash, size: f.size, category: f.category, language: f.language }));
  const run: AnalysisRun = {
    id: ids.run(repo.id, startedAt),
    repositoryId: repo.id,
    commit: repo.commit,
    startedAt,
    finishedAt: new Date().toISOString(),
    schemaVersion: GRAPH_SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    pluginVersions,
    stats: {
      files: files.length,
      entities: batch.entities.length,
      relationships: batch.relationships.length,
      unresolved: batch.unresolved.length,
      diagnostics: batch.diagnostics.length,
      conflicts: batch.conflicts.length,
      durationMs: Math.round(performance.now() - started),
      ...Object.fromEntries(Object.entries(timings).map(([k, v]) => [`ms:${k}`, v])),
    },
  };
  const version = createHash("sha256");
  version.update(`${GRAPH_SCHEMA_VERSION}|${ANALYZER_VERSION}|${JSON.stringify(pluginVersions)}\n`);
  for (const e of batch.entities) version.update(`${e.id}|${JSON.stringify(e.metadata)}\n`);
  for (const r of batch.relationships) version.update(`${r.id}|${r.evidence}|${JSON.stringify(r.metadata)}\n`);
  for (const u of batch.unresolved) version.update(`${u.id}\n`);
  for (const c of batch.conflicts) version.update(`${c.id}\n`);
  const graphVersion = version.digest("hex").slice(0, 32);
  const t0 = performance.now();
  try {
    store.transaction(() => {
      store.saveRepositoryGraph(repo, run, fileRecords, batch);
      publish(run, graphVersion);
    });
  } catch (error) {
    throw new AnalysisError("storage", `graph persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  log.info("graph.persisted", { entities: batch.entities.length, relationships: batch.relationships.length, ms: Math.round(performance.now() - t0) });
  return { run, repositoryId: repo.id, graphVersion };
}

async function runLanguagePlugin(plugin: LanguagePlugin<unknown>, ctx: AnalysisContext, log: Logger): Promise<void> {
  await plugin.init();
  const syntax = new Map<string, unknown>();
  let parsed = 0;
  let cached = 0;
  for (const file of ctx.files) {
    if (!plugin.extensions.some((ext) => file.path.toLowerCase().endsWith(ext))) continue;
    const scope = `syntax|${plugin.id}|${ctx.repository.id}|${file.path}`;
    const cacheKey = `${plugin.version}|${file.hash}`;
    let result: ParseResult<unknown>;
    const hit = ctx.cache.get(scope, cacheKey);
    if (hit) {
      result = JSON.parse(hit) as ParseResult<unknown>;
      cached++;
    } else {
      try {
        result = plugin.parse(file.path, await ctx.readText(file.path));
      } catch (error) {
        ctx.graph.diagnostic({
          repositoryId: ctx.repository.id, category: "parser", plugin: plugin.id, file: file.path, severity: "error", recoverable: true,
          code: "parse-failed", message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      ctx.cache.put(scope, cacheKey, JSON.stringify(result));
      parsed++;
    }
    for (const err of result.errors.slice(0, 5)) {
      ctx.graph.diagnostic({
        repositoryId: ctx.repository.id, category: "parser", plugin: plugin.id, file: file.path, severity: "warning", recoverable: true,
        code: "syntax-error", message: `${err.message} at ${err.line}:${err.column}`,
      });
    }
    syntax.set(file.path, result.facts);
  }
  ctx.artifacts.set(plugin.syntaxArtifact, syntax);
  log.info("parser.files", { parsed, cached });
}
