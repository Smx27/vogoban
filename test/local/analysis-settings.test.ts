import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultWorkspaceConfig, initializeWorkspace, workspaceConfigPath } from "../../src/local/workspace.ts";
import { createLogger } from "../../src/log.ts";
import { analyzeRepository } from "../../src/pipeline/analyze.ts";
import { loadConfig } from "../../src/pipeline/config.ts";
import { discoverFiles } from "../../src/pipeline/discovery.ts";
import { ANALYZER_GROUPS, defaultPlugins, selectAnalyzerPlugins } from "../../src/plugins/registry.ts";
import type { AnalysisPlugin } from "../../src/plugins/types.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";
import { configFingerprint, syncRepository } from "../../src/incremental/sync.ts";
import { syncStatus } from "../../src/incremental/status.ts";
import type { ChangeSet } from "../../src/incremental/changeset.ts";

const log = createLogger({ level: "error" });
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".capy", "work", "dotnet", "dotnet"), join(process.env.HOME ?? "", ".dotnet", "dotnet")].find((path) => path && existsSync(path));
const fixtures: { root: string; store: SqliteGraphStore }[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vogoban-analysis-settings-"));
  const store = new SqliteGraphStore(":memory:");
  const result = { root, store };
  fixtures.push(result);
  return result;
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function settings(root: string, analysis: Partial<ReturnType<typeof defaultWorkspaceConfig>["analysis"]> & { semantic?: boolean }) {
  const config = defaultWorkspaceConfig(root);
  config.analysis = { ...config.analysis, analyzers: ["ownership"], exclusions: [], ...analysis };
  initializeWorkspace(root, config);
  writeFileSync(workspaceConfigPath(root), JSON.stringify(config));
}

function probe(id: string): AnalysisPlugin {
  return {
    id, version: "settings-test", category: "framework",
    async run(ctx) {
      ctx.graph.entity({ key: `settings-test|${ctx.repository.id}|${id}`, kind: "Application", layer: "application", name: id, repositoryId: ctx.repository.id, metadata: { semantic: ctx.options.semantic }, provenance: ctx.provenance({ plugin: id, extractor: "settings-test", mechanism: "fixture", version: "settings-test" }) });
    },
  };
}

function adapterBaseline(store: SqliteGraphStore, repositoryId: string): ChangeSet {
  const catalog = store.getCatalog(repositoryId)!;
  store.upsertCatalog({ ...catalog, analyzedCommit: "adapter-v1", analyzedDirty: false });
  return { repositoryId, repositoryIdentity: catalog.identity, source: "manual", previousCommit: "adapter-v1", currentCommit: "adapter-v1", dirty: false, changes: [] };
}

afterEach(() => {
  for (const { root, store } of fixtures.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("analysis settings consumption", () => {
  test("all groups cover the exact default registry, unknown groups fail, and custom plugins survive", () => {
    const plugins = defaultPlugins();
    const all = selectAnalyzerPlugins(plugins, ANALYZER_GROUPS.map((group) => group.id));
    expect(all.map((plugin) => plugin.id)).toEqual(plugins.map((plugin) => plugin.id));
    expect(selectAnalyzerPlugins(plugins).map((plugin) => plugin.id)).toEqual(plugins.map((plugin) => plugin.id));
    const custom = probe("custom.settings-test");
    expect(selectAnalyzerPlugins([...plugins, custom], [])).toEqual([custom]);
    expect(() => selectAnalyzerPlugins([], ["typo"])).toThrow("unknown analyzer group");
    const azure = selectAnalyzerPlugins(plugins, ["azure"]);
    expect(azure.some((plugin) => plugin.category === "language")).toBe(false);
    expect(azure.some((plugin) => plugin.id.startsWith("frontend."))).toBe(false);
  });

  test("each workspace group controls executed plugin versions and entity output for passed plugins", async () => {
    const { root, store } = fixture();
    const plugins = defaultPlugins().map((plugin) => probe(plugin.id));
    plugins.push(probe("custom.settings-test"));
    for (const group of ANALYZER_GROUPS) {
      settings(root, { analyzers: [group.id], snapshots: false });
      const result = await analyzeRepository(root, store, plugins, {}, log);
      const expected = selectAnalyzerPlugins(plugins, [group.id]).map((plugin) => plugin.id).sort();
      expect(Object.keys(result.run.pluginVersions).sort()).toEqual(expected);
      expect(store.findEntities({ repositoryId: result.repositoryId, kinds: ["Application"] }).map((entity) => entity.name).sort()).toEqual(expected);
    }
  });

  test("real ownership and contract output follows workspace selection and explicit overrides", async () => {
    const { root, store } = fixture();
    write(root, "CODEOWNERS", "* @fixture/team\n");
    write(root, "openapi.json", JSON.stringify({ openapi: "3.0.0", info: { title: "Fixture", version: "1" }, paths: {} }));
    settings(root, { analyzers: ["ownership"], snapshots: false, semantic: false });
    const first = await analyzeRepository(root, store, defaultPlugins(), {}, log);
    expect(first.run.pluginVersions).toEqual({ "ownership.codeowners": "1" });
    expect(store.getCatalog(first.repositoryId)?.semantic).toBe(false);
    expect(store.findEntities({ kinds: ["OwnershipRule"] })).toHaveLength(1);
    expect(store.findEntities({ kinds: ["ContractDocument"] })).toHaveLength(0);
    expect(store.listGraphSnapshots({})).toHaveLength(0);
    const second = await analyzeRepository(root, store, defaultPlugins(), { analyzers: ["contracts"], snapshots: true, semantic: true }, log);
    expect(Object.keys(second.run.pluginVersions).sort()).toEqual(selectAnalyzerPlugins(defaultPlugins(), ["contracts"]).map((plugin) => plugin.id).sort());
    expect(store.findEntities({ kinds: ["OwnershipRule"] })).toHaveLength(0);
    expect(store.findEntities({ kinds: ["ContractDocument"] })).toHaveLength(1);
    expect(store.getCatalog(second.repositoryId)?.semantic).toBe(true);
    expect(store.listGraphSnapshots({})).toHaveLength(1);
  });

  test("directory and root-relative glob exclusions happen before reads and suppress File nodes", async () => {
    const { root, store } = fixture();
    write(root, "keep.ts", "export const keep = 1;");
    write(root, "nested/generated/secret.ts", "export const secret = 1;");
    write(root, "hidden/a.cs", "class Hidden {}");
    write(root, "src/a.ignore.cs", "class Ignore {}");
    settings(root, { analyzers: [], exclusions: ["generated", "hidden/**", "src/*.ignore.cs"], snapshots: false });
    const original = Bun.file;
    const readPaths: string[] = [];
    Bun.file = ((path: Parameters<typeof Bun.file>[0], ...args: unknown[]) => {
      readPaths.push(String(path));
      return (original as (...values: unknown[]) => ReturnType<typeof Bun.file>)(path, ...args);
    }) as typeof Bun.file;
    try {
      const discovered = await discoverFiles(root, log, [], [], [], undefined, ["generated", "hidden/**", "src/*.ignore.cs"]);
      expect(discovered.files.map((file) => file.path)).toEqual(["keep.ts"]);
      expect(readPaths.some((path) => /secret|a\.cs|ignore/.test(path))).toBe(false);
    } finally { Bun.file = original; }
    const result = await analyzeRepository(root, store, [], {}, log);
    expect(store.findEntities({ repositoryId: result.repositoryId, kinds: ["File"] }).map((entity) => entity.qualifiedName)).toEqual(["keep.ts"]);
    const override = await analyzeRepository(root, store, [], { exclusions: [] }, log);
    expect(override.run.stats.files).toBe(4);
  });

  test("absent workspace preserves legacy execution, snapshots, and config fingerprint", async () => {
    const { root, store } = fixture();
    const plugins = [probe("dotnet.msbuild"), probe("frontend.workspace"), probe("custom.settings-test")];
    const result = await analyzeRepository(root, store, plugins, { semantic: false }, log);
    expect(Object.keys(result.run.pluginVersions)).toHaveLength(3);
    expect(store.listGraphSnapshots({})).toHaveLength(1);
    const { errors, ...config } = loadConfig(root);
    expect(configFingerprint(loadConfig(root))).toBe(createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16));
    const changeSet = adapterBaseline(store, result.repositoryId);
    const synced = await syncRepository(root, store, plugins, { semantic: false, changeSet }, log);
    expect(synced.status).toBe("NO_OP");
  });

  test("frontend semantic compiler cannot read an excluded imported source", async () => {
    const { root, store } = fixture();
    write(root, "package.json", JSON.stringify({ name: "settings-fixture" }));
    write(root, "main.ts", 'import { Hidden } from "./private/hidden"; export function visible() { return new Hidden(); }');
    write(root, "private/hidden.ts", "export class Hidden {}");
    settings(root, { analyzers: ["frontend"], exclusions: ["private"], snapshots: false, semantic: true });
    const original = Bun.file;
    const readPaths: string[] = [];
    Bun.file = ((path: Parameters<typeof Bun.file>[0], ...args: unknown[]) => {
      readPaths.push(String(path));
      return (original as (...values: unknown[]) => ReturnType<typeof Bun.file>)(path, ...args);
    }) as typeof Bun.file;
    try {
      const result = await analyzeRepository(root, store, defaultPlugins(), {}, log);
      expect(result.run.pluginVersions["typescript.semantic"]).toBeDefined();
      expect(store.findDiagnostics({ repositoryId: result.repositoryId }).filter((diagnostic) => diagnostic.code === "plugin-failed")).toHaveLength(0);
      expect(store.findEntities({ repositoryId: result.repositoryId, file: "private/hidden.ts" })).toHaveLength(0);
      expect(readPaths.some((path) => path.endsWith("private/hidden.ts"))).toBe(false);
    } finally { Bun.file = original; }
  });

  test.skipIf(!dotnet)("Roslyn evaluation retains Compile resolution but excludes imported sources and invalidates cached facts", async () => {
    const { root, store } = fixture();
    write(root, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Program.cs" /></ItemGroup><Import Project="compile.props" /></Project>');
    write(root, "compile.props", '<Project><PropertyGroup><EvaluatedSource>generated/Hidden.cs</EvaluatedSource></PropertyGroup><ItemGroup><Compile Include="$(EvaluatedSource)" /></ItemGroup></Project>');
    write(root, "Program.cs", "namespace Fixture; public class Visible {}");
    write(root, "generated/Hidden.cs", "namespace Fixture; public class EvaluatedHidden {}");
    settings(root, { analyzers: ["dotnet"], exclusions: [], snapshots: false, semantic: true });
    const events: { event: string; fields?: Record<string, unknown> }[] = [];
    const recording = { ...log, info: (event: string, fields?: Record<string, unknown>) => { events.push({ event, fields }); }, child: () => recording };
    const previousDotnet = process.env.VOGOBAN_DOTNET;
    const previousEvaluation = process.env.VOGOBAN_MSBUILD_EVALUATION;
    process.env.VOGOBAN_DOTNET = dotnet;
    delete process.env.VOGOBAN_MSBUILD_EVALUATION;
    try {
      const first = await analyzeRepository(root, store, defaultPlugins(), {}, recording);
      expect(store.findEntities({ repositoryId: first.repositoryId, kinds: ["Type"] }).some((entity) => entity.qualifiedName === "Fixture.EvaluatedHidden")).toBe(true);
      expect(events.some(({ event, fields }) => event === "roslyn.project-loaded" && fields?.evaluation === "msbuild")).toBe(true);
      events.length = 0;
      settings(root, { analyzers: ["dotnet"], exclusions: ["generated"], snapshots: false, semantic: true });
      const second = await analyzeRepository(root, store, defaultPlugins(), {}, recording);
      expect(events.some(({ event, fields }) => event === "roslyn.project-loaded" && fields?.evaluation === "msbuild")).toBe(true);
      expect(store.findEntities({ repositoryId: second.repositoryId, kinds: ["Type"] }).some((entity) => entity.qualifiedName === "Fixture.Visible")).toBe(true);
      expect(store.findEntities({ repositoryId: second.repositoryId, file: "generated/Hidden.cs" })).toHaveLength(0);
      expect(store.findEntities({ repositoryId: second.repositoryId }).some((entity) => entity.qualifiedName === "Fixture.EvaluatedHidden")).toBe(false);
      expect(store.findDiagnostics({ repositoryId: second.repositoryId }).some((diagnostic) => diagnostic.code === "semantic-unavailable" || diagnostic.code === "semantic-project-failed")).toBe(false);
    } finally {
      if (previousDotnet === undefined) delete process.env.VOGOBAN_DOTNET; else process.env.VOGOBAN_DOTNET = previousDotnet;
      if (previousEvaluation === undefined) delete process.env.VOGOBAN_MSBUILD_EVALUATION; else process.env.VOGOBAN_MSBUILD_EVALUATION = previousEvaluation;
    }
  });

  test("a failed settings rebuild cannot make the retry a NO_OP", async () => {
    const { root, store } = fixture();
    settings(root, { snapshots: true });
    const first = await syncRepository(root, store, [], {}, log);
    const changeSet = adapterBaseline(store, first.repositoryId);
    settings(root, { snapshots: false });
    const save = store.saveRepositoryGraph;
    store.saveRepositoryGraph = () => { throw new Error("fixture storage failure"); };
    try {
      expect((await syncRepository(root, store, [], { changeSet }, log)).status).toBe("FAILED");
    } finally { store.saveRepositoryGraph = save; }
    expect(syncStatus(root, store, []).state).toBe("FULL_REBUILD_REQUIRED");
    expect((await syncRepository(root, store, [], { changeSet }, log)).status).toBe("SUCCESS");
  });

  test("settings edits and overrides invalidate sync NO_OP and status even without file changes", async () => {
    const { root, store } = fixture();
    write(root, "CODEOWNERS", "* @fixture/team\n");
    settings(root, { snapshots: false });
    const first = await syncRepository(root, store, defaultPlugins(), {}, log);
    expect(first.status).toBe("SUCCESS");
    for (const key of ["entitiesCreated", "entitiesUpdated", "entitiesDeleted", "relationshipsCreated", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(first.metrics[key]).toBeNull();
    let changeSet = adapterBaseline(store, first.repositoryId);
    const unchanged = await syncRepository(root, store, defaultPlugins(), { changeSet }, log);
    expect(unchanged.status).toBe("NO_OP");
    for (const key of ["entitiesCreated", "entitiesUpdated", "entitiesDeleted", "relationshipsCreated", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(unchanged.metrics[key]).toBe(0);
    expect(syncStatus(root, store, defaultPlugins()).state).toBe("UP_TO_DATE");
    settings(root, { snapshots: true });
    expect(syncStatus(root, store, defaultPlugins()).state).toBe("FULL_REBUILD_REQUIRED");
    const snapshots = await syncRepository(root, store, defaultPlugins(), { changeSet }, log);
    expect(snapshots.status).toBe("SUCCESS");
    expect(snapshots.fallbackCode).toBe("configuration_changed");
    expect(snapshots.diffSnapshotTo).not.toBeNull();
    for (const key of ["entitiesCreated", "entitiesUpdated", "entitiesDeleted", "relationshipsCreated", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(snapshots.metrics[key]).toBeNull();
    changeSet = adapterBaseline(store, first.repositoryId);
    const snapshotCount = store.listGraphSnapshots({}).length;
    settings(root, { snapshots: false, exclusions: ["CODEOWNERS"] });
    expect(syncStatus(root, store, defaultPlugins()).upToDate).toBe(false);
    const excluded = await syncRepository(root, store, defaultPlugins(), { changeSet }, log);
    expect(excluded.status).toBe("SUCCESS");
    expect(excluded.diffSnapshotFrom).toBeNull();
    expect(excluded.diffSnapshotTo).toBeNull();
    for (const key of ["entitiesCreated", "entitiesUpdated", "entitiesDeleted", "relationshipsCreated", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(excluded.metrics[key]).toBeNull();
    expect(store.findEntities({ kinds: ["File", "OwnershipRule"] })).toHaveLength(0);
    expect(store.listGraphSnapshots({})).toHaveLength(snapshotCount);
    changeSet = adapterBaseline(store, first.repositoryId);
    expect(syncStatus(root, store, defaultPlugins(), { exclusions: [] }).state).toBe("FULL_REBUILD_REQUIRED");
    const overridden = await syncRepository(root, store, defaultPlugins(), { changeSet, exclusions: [] }, log);
    expect(overridden.status).toBe("SUCCESS");
    expect(store.findEntities({ kinds: ["OwnershipRule"] })).toHaveLength(1);
  });

  test("snapshot counters remain measured on first publication and subsequent captured rebuilds", async () => {
    const { root, store } = fixture();
    write(root, "CODEOWNERS", "* @fixture/team\n");
    settings(root, { snapshots: true });
    const first = await syncRepository(root, store, defaultPlugins(), {}, log);
    expect(first.status).toBe("SUCCESS");
    expect(first.metrics.entitiesCreated).toBeGreaterThan(0);
    expect(first.metrics.relationshipsCreated).toBeGreaterThan(0);
    for (const key of ["entitiesUpdated", "entitiesDeleted", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(first.metrics[key]).toBe(0);
    const changeSet = adapterBaseline(store, first.repositoryId);
    write(root, "CODEOWNERS", "* @fixture/team\n*.ts @fixture/frontend\n");
    const rebuilt = await syncRepository(root, store, defaultPlugins(), { changeSet, forceFull: true }, log);
    expect(rebuilt.status).toBe("SUCCESS");
    expect(rebuilt.metrics.entitiesCreated).toBe(1);
    expect(rebuilt.metrics.entitiesUpdated).toBeGreaterThan(0);
    for (const key of ["entitiesCreated", "entitiesUpdated", "entitiesDeleted", "relationshipsCreated", "relationshipsUpdated", "relationshipsDeleted"] as const) expect(typeof rebuilt.metrics[key]).toBe("number");
  });

  test("incremental false forces sync rebuilds while analyze is always a full analysis", async () => {
    const { root, store } = fixture();
    settings(root, { incremental: false, snapshots: false });
    const analyzed = await analyzeRepository(root, store, [probe("custom.settings-test")], {}, log);
    expect(analyzed.run.stats.entities).toBe(2);
    const changeSet = adapterBaseline(store, analyzed.repositoryId);
    const sync = await syncRepository(root, store, [probe("custom.settings-test")], { changeSet }, log);
    expect(sync.mode).toBe("full");
    expect(sync.status).toBe("SUCCESS");
    expect(syncStatus(root, store, [probe("custom.settings-test")]).fullRebuildRequired).toBe(true);
    adapterBaseline(store, analyzed.repositoryId);
    const override = await syncRepository(root, store, [probe("custom.settings-test")], { changeSet, incremental: true }, log);
    expect(override.status).toBe("SUCCESS");
    adapterBaseline(store, analyzed.repositoryId);
    expect((await syncRepository(root, store, [probe("custom.settings-test")], { changeSet, incremental: true }, log)).status).toBe("NO_OP");
  });
});
