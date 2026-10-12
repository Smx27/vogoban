import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * D-06 (symlink / repository boundary escape through MSBuild Compile items), D-05 (secret persistence in fact_cache) and
 * D-11 (pathological source file resource bounds) regression suite. Runs the real CLI with the real Roslyn analyzer
 * (MSBuild evaluation on), which is exactly the path the audit used to bypass discovery.
 */

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "main.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "boundary-secrets");
const HOST_CANARY = "HOSTCANARY_D06_7781";
const REPO_LINK_CANARY = "REPOLINKCANARY_D06_4412";
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".capy", "work", "dotnet", "dotnet"), join(process.env.HOME ?? "", ".dotnet", "dotnet")].find((c) => c && existsSync(c));
const ENV = { ...process.env, PATH: `${dotnet ? join(dotnet, "..") : ""}:${process.env.PATH}`, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };

/** Every canary that must never reach persistent analysis state. */
const SECRET_CANARIES = [
  "CANARYSBKEY", "CANARYSTORAGEKEY", "CANARYCOSMOSKEY", "CANARYSIGNATURE", "CANARYFUNCTIONKEY", "CANARYSASTOKEN", "CANARYAPPCONFIGSECRET",
  "CANARYNAMEDKEYLETTERS", "CANARYKEYSHORT", "CANARYCLIENTSECRET", "CANARYSASCREDENTIAL", "CANARYINLINEKEY", "CANARYCOSMOSAUTHKEY",
  HOST_CANARY, REPO_LINK_CANARY,
];

interface Run { code: number; stdout: string; stderr: string }

function vogoban(args: string[], cwd: string, env: Record<string, string | undefined> = {}): Run {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd, env: { ...ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function dump(db: string): string {
  const d = new Database(db, { readonly: true });
  const tables = (d.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  const out: string[] = [];
  for (const t of tables) for (const row of d.query(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) out.push(`${t}\t${JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v))}`);
  d.close();
  return out.join("\n");
}

function persistentState(repo: string, db: string): { all: string; cache: string; diagnostics: string; exportJson: string; exportJsonl: string } {
  const d = new Database(db, { readonly: true });
  const cache = (d.query("SELECT payload FROM fact_cache").all() as { payload: string }[]).map((r) => r.payload).join("\n");
  const diagnostics = (d.query("SELECT * FROM diagnostics").all() as Record<string, unknown>[]).map((r) => JSON.stringify(r)).join("\n");
  d.close();
  const outJson = join(repo, "..", "export.json");
  const outJsonl = join(repo, "..", "export.jsonl");
  expect(vogoban(["export", "--format", "json", "--out", outJson, "--db", db], repo).code).toBe(0);
  expect(vogoban(["export", "--format", "jsonl", "--out", outJsonl, "--db", db], repo).code).toBe(0);
  return { all: dump(db), cache, diagnostics, exportJson: readFileSync(outJson, "utf8"), exportJsonl: readFileSync(outJsonl, "utf8") };
}

/** Restores the fixture from the local NuGet cache (offline); SDK types then resolve and credential constructor arguments are recorded. */
function restore(repo: string): boolean {
  const p = Bun.spawnSync([dotnet!, "restore", join(repo, "src", "App", "App.csproj")], { env: ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) console.warn(`dotnet restore failed (${p.stderr.toString().slice(0, 200)}): credential-argument assertions run without SDK types`);
  return p.exitCode === 0;
}

function prepare(name: string): { work: string; repo: string; db: string } {
  const work = mkdtempSync(join(tmpdir(), `vogoban-${name}-`));
  const repo = join(work, "repo");
  cpSync(FIXTURE, repo, { recursive: true, filter: (src) => !/[\/](bin|obj)([\/]|$)/.test(src) });
  const outside = join(work, "outside");
  mkdirSync(join(outside, "nested"), { recursive: true });
  writeFileSync(join(work, "host-secret.cs"), `namespace Host { public static class Leak { public const string Value = "${HOST_CANARY}"; } }\n`);
  writeFileSync(join(outside, "nested", "escape.cs"), `namespace Host { public static class Nested { public const string Value = "${HOST_CANARY}-nested"; } }\n`);
  writeFileSync(join(repo, "src", "App", "Nested", "Internal.cs"), `namespace App.Nested { public static class Internal { public const string Marker = "${REPO_LINK_CANARY}"; } }\n`);
  symlinkSync(join(work, "host-secret.cs"), join(repo, "src", "App", "LinkHost.cs"));
  symlinkSync("Nested/Internal.cs", join(repo, "src", "App", "LinkRepo.cs"));
  symlinkSync("../../../../outside/nested/escape.cs", join(repo, "src", "App", "Nested", "DeepEscape.cs"));
  symlinkSync(outside, join(repo, "src", "App", "LinkedDir"));
  return { work, repo, db: join(work, "graph.db") };
}

const skip = !dotnet;

describe.skipIf(skip)("D-06 repository boundary for MSBuild Compile items", () => {
  const modes: [string, string[], Record<string, string | undefined>][] = [
    ["default", [], {}],
    ["trusted (--trust-repository)", ["--trust-repository"], {}],
    ["untrusted (--untrusted)", ["--untrusted"], {}],
  ];
  for (const [label, flags, env] of modes) {
    test(`${label}: normal files analyzed, every symlink rejected, canaries absent`, () => {
      const { work, repo, db } = prepare("d06");
      try {
        const run = vogoban(["analyze", repo, "--db", db, ...flags], repo, env);
        expect(run.code).toBe(0);
        const d = new Database(db, { readonly: true });
        const files = (d.query("SELECT path FROM files").all() as { path: string }[]).map((r) => r.path);
        const classes = (d.query("SELECT qualified_name FROM entities WHERE kind IN ('Class','Static Class','Type') OR qualified_name LIKE 'App.%' OR qualified_name LIKE 'Host.%'").all() as { qualified_name: string }[]).map((r) => r.qualified_name);
        const diagnostics = d.query("SELECT code, file, message FROM diagnostics").all() as { code: string; file: string | null; message: string }[];
        d.close();
        expect(files).toContain("src/App/Program.cs");
        expect(files).toContain("src/App/Nested/Settings.cs");
        expect(classes).toContain("App.Program");
        expect(classes).toContain("App.Nested.Settings");
        expect(classes.some((q) => q.startsWith("Host."))).toBe(false);
        expect(files.some((f) => /LinkHost|LinkRepo|DeepEscape|LinkedDir/.test(f))).toBe(false);
        const rejected = diagnostics.filter((x) => /LinkHost|LinkRepo|DeepEscape|LinkedDir/.test(x.file ?? ""));
        for (const r of rejected) expect(r.message).toMatch(/symbolic link|outside the repository/i);
        const state = persistentState(repo, db);
        for (const text of [state.all, state.cache, state.diagnostics, state.exportJson, state.exportJsonl]) {
          expect(text).not.toContain(HOST_CANARY);
          expect(text).not.toContain(REPO_LINK_CANARY);
        }
        if (!flags.includes("--untrusted")) {
          const semanticSkips = diagnostics.filter((x) => x.code === "source-rejected");
          expect(semanticSkips.map((x) => x.file).sort()).toEqual(["src/App/LinkHost.cs", "src/App/LinkRepo.cs", "src/App/LinkedDir/nested/escape.cs", "src/App/Nested/DeepEscape.cs"]);
        } else {
          expect(rejected).toEqual([]);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  test("CI commit-range sync (--trust-repository) rejects symlink escapes added in the range", () => {
    const { work, repo, db } = prepare("d06ci");
    try {
      const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" });
      for (const link of ["src/App/LinkHost.cs", "src/App/LinkRepo.cs", "src/App/Nested/DeepEscape.cs", "src/App/LinkedDir"]) rmSync(join(repo, link));
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").stdout.toString().trim();
      expect(vogoban(["analyze", repo, "--db", db], repo).code).toBe(0);
      symlinkSync(join(work, "host-secret.cs"), join(repo, "src", "App", "LinkHost.cs"));
      symlinkSync("../../../../outside/nested/escape.cs", join(repo, "src", "App", "Nested", "DeepEscape.cs"));
      writeFileSync(join(repo, "src", "App", "Touched.cs"), "namespace App { public static class Touched { } }\n");
      git("add", "-A");
      git("commit", "-qm", "head");
      const head = git("rev-parse", "HEAD").stdout.toString().trim();
      const run = vogoban(["sync", repo, "--db", db, "--base", base, "--head", head, "--trust-repository", "--json"], repo);
      expect(run.code).toBe(0);
      const state = persistentState(repo, db);
      for (const text of [state.all, state.exportJson, state.exportJsonl]) expect(text).not.toContain(HOST_CANARY);
      expect(state.all).toContain("App.Touched");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skip)("D-05 secrets never enter persistent analysis state", () => {
  test("connection strings, SAS/query secrets and credential constructor arguments are redacted before persistence", () => {
    const { work, repo, db } = prepare("d05");
    try {
      const restored = restore(repo);
      expect(vogoban(["analyze", repo, "--db", db], repo).code).toBe(0);
      const state = persistentState(repo, db);
      expect(state.cache.length).toBeGreaterThan(0);
      for (const canary of SECRET_CANARIES) {
        for (const [label, text] of Object.entries(state)) expect(text, `${canary} in ${label}`).not.toContain(canary);
      }
      const d = new Database(db, { readonly: true });
      const cached = (d.query("SELECT payload FROM fact_cache WHERE scope LIKE 'semantic|%'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload));
      d.close();
      expect(cached.length).toBeGreaterThan(0);
      const text = JSON.stringify(cached);
      if (restored) {
        const creations = cached.flatMap((c: { creations?: { target: { display: string }; arguments: { parameter?: string; kind: string; value?: string; redacted?: boolean }[] }[] }) => c.creations ?? []);
        const argument = (ctor: RegExp, parameter: string) => creations.find((c) => ctor.test(c.target.display))?.arguments.find((a) => a.parameter === parameter);
        expect(argument(/AzureNamedKeyCredential/, "key")?.redacted).toBe(true);
        expect(argument(/AzureNamedKeyCredential/, "name")?.value).toBe("orders-policy");
        expect(argument(/AzureKeyCredential/, "key")?.redacted).toBe(true);
        expect(argument(/ClientSecretCredential/, "clientSecret")?.redacted).toBe(true);
        expect(argument(/ClientSecretCredential/, "tenantId")?.value).toBe("tenant-id");
        expect(argument(/AzureSasCredential/, "signature")?.redacted).toBe(true);
        expect(argument(/CosmosClient/, "authKeyOrResourceToken")?.redacted).toBe(true);
        expect(argument(/CosmosClient/, "accountEndpoint")?.value).toBe("https://contoso.documents.azure.com:443/");
        const connections = creations.filter((c) => /ServiceBusClient/.test(c.target.display)).map((c) => c.arguments[0]?.value);
        expect(connections).toContain("Endpoint=sb://contoso-orders.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=[redacted]");
        expect(connections).toContain("Endpoint=sb://contoso-inline.servicebus.windows.net/;SharedAccessKeyName=send;SharedAccessKey=[redacted]");
      }
      expect(text).toContain("[redacted]");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a fact cache written by an earlier generation is purged on open (upgrade cleanup)", () => {
    const work = mkdtempSync(join(tmpdir(), "vogoban-d05gen-"));
    try {
      const db = join(work, "graph.db");
      expect(vogoban(["analyze", FIXTURE, "--db", db, "--no-semantic"], FIXTURE).code).toBe(0);
      const d = new Database(db);
      d.query("INSERT INTO fact_cache (scope, cache_key, payload) VALUES ('semantic|legacy', 'k', ?)").run('{"value":"Endpoint=sb://x/;SharedAccessKey=LEGACYCANARYKEY"}');
      d.query("UPDATE meta SET value = '1' WHERE key = 'fact_cache_generation'").run();
      d.close();
      const { SqliteGraphStore } = require(join(ROOT, "src", "store", "sqlite.ts")) as typeof import("../../src/store/sqlite.ts");
      const store = new SqliteGraphStore(db);
      expect(store.getCachedFacts("semantic|legacy", "k")).toBeNull();
      store.close();
      expect(dump(db)).not.toContain("LEGACYCANARYKEY");
      const reopened = new Database(db, { readonly: true });
      expect((reopened.query("SELECT value FROM meta WHERE key='fact_cache_generation'").get() as { value: string }).value).not.toBe("1");
      reopened.close();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skip)("D-11 pathological source files are bounded", () => {
  const big = (bytes: number, name: string) => {
    const header = `namespace App.Generated { public static class ${name} { public static readonly string[] Values = new[] {\n`;
    const footer = "\"end\" }; } }\n";
    const line = `"${"x".repeat(60)}",\n`;
    const lines = Math.max(0, Math.ceil((bytes - header.length - footer.length) / line.length));
    return header + line.repeat(lines) + footer;
  };

  test("near-limit file analyzed; over-limit, multiple oversized and oversized generated files skipped with FILE_SKIPPED_RESOURCE_LIMIT; other files still analyzed", () => {
    const { work, repo, db } = prepare("d11");
    try {
      const limit = 512 * 1024;
      writeFileSync(join(repo, "src", "App", "NearLimit.cs"), big(limit - 4096, "NearLimit"));
      writeFileSync(join(repo, "src", "App", "Over.cs"), big(limit * 3, "Over"));
      writeFileSync(join(repo, "src", "App", "Over2.cs"), big(limit * 2, "Over2"));
      writeFileSync(join(repo, "src", "App", "Huge.g.cs"), `// <auto-generated/>\n${big(limit * 4, "Huge")}`);
      const run = vogoban(["analyze", repo, "--db", db], repo, { VOGOBAN_MAX_SOURCE_FILE_BYTES: String(limit) });
      expect(run.code).toBe(0);
      const d = new Database(db, { readonly: true });
      const classes = (d.query("SELECT qualified_name FROM entities").all() as { qualified_name: string }[]).map((r) => r.qualified_name);
      const diagnostics = d.query("SELECT code, file, message FROM diagnostics").all() as { code: string; file: string | null; message: string }[];
      d.close();
      expect(classes).toContain("App.Generated.NearLimit");
      expect(classes).toContain("App.Program");
      expect(classes).toContain("App.Nested.Settings");
      for (const name of ["Over", "Over2", "Huge"]) expect(classes).not.toContain(`App.Generated.${name}`);
      const skipped = diagnostics.filter((x) => /FILE_SKIPPED_RESOURCE_LIMIT/.test(x.message) || x.code === "FILE_SKIPPED_RESOURCE_LIMIT");
      expect(new Set(skipped.map((x) => x.file))).toEqual(new Set(["src/App/Over.cs", "src/App/Over2.cs", "src/App/Huge.g.cs"]));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a 50 MB C# file reachable only through MSBuild evaluation is skipped by the Roslyn analyzer, not read", () => {
    const { work, repo, db } = prepare("d11msbuild");
    try {
      mkdirSync(join(repo, "gen"), { recursive: true });
      writeFileSync(join(repo, "gen", "Giant.cs"), big(50 * 1024 * 1024, "Giant"));
      writeFileSync(join(repo, "src", "App", "App.csproj"), readFileSync(join(repo, "src", "App", "App.csproj"), "utf8").replace("</Project>", '  <ItemGroup><Compile Include="../../gen/Giant.cs" /></ItemGroup>\n</Project>'));
      const run = vogoban(["analyze", repo, "--db", db], repo);
      expect(run.code).toBe(0);
      const d = new Database(db, { readonly: true });
      const classes = (d.query("SELECT qualified_name FROM entities").all() as { qualified_name: string }[]).map((r) => r.qualified_name);
      const diagnostics = d.query("SELECT code, file, message FROM diagnostics").all() as { code: string; file: string | null; message: string }[];
      d.close();
      expect(classes).toContain("App.Program");
      expect(classes).not.toContain("App.Generated.Giant");
      expect(diagnostics.filter((x) => x.file === "gen/Giant.cs" && x.code === "FILE_SKIPPED_RESOURCE_LIMIT").length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

test("D-06/D-05/D-11 suite requires the dotnet SDK", () => {
  if (skip) console.warn("dotnet SDK not found: D-06/D-05/D-11 regression tests were skipped");
  expect(true).toBe(true);
});
