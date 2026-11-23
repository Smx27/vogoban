import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphAccess, readOnlyStore } from "../../src/ai/access.ts";
import { DEFAULT_LIMITS } from "../../src/ai/model.ts";
import { runTool } from "../../src/ai/tools.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
let dir = "";
let store: SqliteGraphStore;

const settings = (name: string) => JSON.stringify({ Cosmos: { AccountEndpoint: "https://shared-cosmos.documents.azure.com:443/" }, Services: { Name: name } });
const access = (repositories: string[] | null, graph: "all" | "repository" = "all") =>
  new GraphAccess(readOnlyStore(store), { graph, repositories, environment: null, snapshots: { repositories: {}, meta: null } }, DEFAULT_LIMITS, { policyPaths: null, enterprisePath: null, aliases: {} });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vogoban-ai-scope-"));
  for (const repo of ["alpha", "beta"]) {
    mkdirSync(join(dir, "repos", repo, "src"), { recursive: true });
    writeFileSync(join(dir, "repos", repo, "catalog-info.yaml"), `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${repo}\nspec:\n  owner: team-${repo}\n`);
    writeFileSync(join(dir, "repos", repo, "src", "appsettings.json"), settings(repo));
  }
  const r = Bun.spawnSync(["bun", CLI, "discover", join(dir, "repos"), "--db", join(dir, "graph.db"), "--no-semantic"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_OFFLINE: "1" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString() + r.stdout.toString());
  store = new SqliteGraphStore(join(dir, "graph.db"));
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const repoId = (name: string) => store.listCatalog().find((e) => e.name === name)!.repositoryId;

test("get_external_systems never returns repositories outside the permitted scope", async () => {
  const all = JSON.stringify(await runTool(access(null), "get_external_systems", {}));
  expect(all).toContain("beta");
  const scoped = JSON.stringify(await runTool(access([repoId("alpha")]), "get_external_systems", {}));
  expect(scoped).toContain("alpha");
  expect(scoped).not.toContain("beta");
});

test("repository graph scope does not serve MetaGraph facts", async () => {
  const deps = await runTool(access(null, "repository"), "get_repository_dependencies", { repository: "alpha" });
  expect(deps.status).not.toBe("OK");
  expect(JSON.stringify(deps)).toContain("graph=repository");
  const snapshots = await runTool(access(null, "repository"), "list_snapshots", { meta: true });
  expect(snapshots.status).not.toBe("OK");
  expect((await runTool(access(null, "all"), "list_snapshots", { meta: true })).status).toBe("OK");
});
