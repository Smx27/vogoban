import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
const FILES: Record<string, string> = {"svc-a/README.md": "# svc-a\n", "svc-a/catalog-info.yaml": "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: svc-a\nspec:\n  type: service\n  owner: group:team-a\n  system: shop\n  lifecycle: production\n", "svc-a/tools/catalog-info.yaml": "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: svc-a-tools\nspec:\n  type: library\n  owner: team-b\n", "svc-a/deploy/app.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: worker\n  namespace: jobs\nspec:\n  selector:\n    matchLabels: { app: worker }\n  template:\n    metadata:\n      labels: { app: worker }\n    spec:\n      containers:\n        - name: worker\n          image: example.azurecr.io/worker:1.0.0\n---\napiVersion: keda.sh/v1alpha1\nkind: TriggerAuthentication\nmetadata:\n  name: sb-auth\n  namespace: jobs\nspec:\n  podIdentity:\n    provider: azure-workload\n---\napiVersion: keda.sh/v1alpha1\nkind: ScaledObject\nmetadata:\n  name: worker-scaler\n  namespace: jobs\nspec:\n  scaleTargetRef:\n    name: worker\n  minReplicaCount: 0\n  maxReplicaCount: 7\n  triggers:\n    - type: azure-servicebus\n      metadata:\n        namespace: sb-shop\n        queueName: jobs\n      authenticationRef:\n        name: sb-auth\n---\napiVersion: keda.sh/v1alpha1\nkind: ScaledObject\nmetadata:\n  name: ghost-scaler\n  namespace: jobs\nspec:\n  scaleTargetRef:\n    name: ghost\n  triggers:\n    - type: cron\n      metadata:\n        timezone: UTC\n        start: 0 8 * * *\n        end: 0 18 * * *\n        desiredReplicas: \"2\"\n      authenticationRef:\n        name: missing-auth\n", "svc-b/catalog-info.yaml": "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: svc-b\nspec:\n  type: website\n  owner: group:default/team-c\n", "svc-b/index.js": "export const x = 1;\n"};

let dir = "";
let db = "";
const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...args, "--db", db], { cwd: dir, env: { ...process.env, VOGOBAN_OFFLINE: "1", VOGOBAN_DEBUG: "0" }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const json = <T>(...args: string[]): T => {
  const r = run(...args, "--json");
  if (r.code !== 0) throw new Error(`${args.join(" ")} exited ${r.code}: ${r.err}`);
  return JSON.parse(r.out) as T;
};
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });

interface DiscoverResult {
  repositories: { path: string; marker: string; repository: string | null; action: string; detail: string }[];
  stale: { name: string; localPath: string }[];
  metagraph: { snapshot: string } | null;
}
const actions = (r: DiscoverResult) => Object.fromEntries(r.repositories.map((x) => [x.path.split("/").pop(), x.action]));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vogoban-discover-"));
  db = join(dir, "graph.db");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const extra: Record<string, string> = {
    "svc-a/lib/Lib.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
    "svc-a/lib/Contract.cs": "namespace Lib;\npublic record OrderPlaced(string Id);\n",
    "svc-a/js/package.json": '{ "name": "@fx/lib", "version": "1.0.0", "private": true }\n',
    "svc-a/js/index.js": "export const lib = 1;\n",
    "svc-b/app/App.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <ProjectReference Include="../../svc-a/lib/Lib.csproj" />\n  </ItemGroup>\n</Project>\n',
    "svc-b/package.json": '{ "name": "svc-b-web", "version": "1.0.0", "dependencies": { "@fx/lib": "file:../svc-a/js" } }\n',
  };
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  mkdirSync(join(dir, "node_modules/pkg/.git"), { recursive: true });
  mkdirSync(join(dir, "deep/a/b/c/d"), { recursive: true });
  writeFileSync(join(dir, "deep/a/b/c/d/vogoban.json"), "{}\n");
  git(join(dir, "svc-a"), "init", "-q");
  git(join(dir, "svc-a"), "add", "-A");
  git(join(dir, "svc-a"), "commit", "-q", "-m", "fixture");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vogoban discover", () => {
  test("dry run lists repositories by marker, skips dependency folders and respects --depth", () => {
    const dry = json<DiscoverResult>("discover", dir, "--dry-run");
    expect(dry.repositories.map((r) => [r.path.slice(dir.length + 1), r.marker, r.action])).toEqual([
      ["svc-a", ".git", "NEW"],
      ["svc-b", "catalog-info.yaml", "NEW"],
    ]);
    expect(dry.metagraph).toBeNull();
    const deeper = json<DiscoverResult>("discover", dir, "--dry-run", "--depth", "6");
    expect(deeper.repositories.map((r) => r.path.slice(dir.length + 1))).toContain("deep/a/b/c/d");
    expect(deeper.repositories.some((r) => r.path.includes("node_modules"))).toBe(false);
  });

  test("registers, analyzes and builds the MetaGraph, then skips unchanged git checkouts", () => {
    const first = json<DiscoverResult>("discover", dir, "--no-semantic");
    expect(actions(first)).toEqual({ "svc-a": "ANALYZED", "svc-b": "ANALYZED" });
    expect(first.metagraph?.snapshot).toMatch(/^snap_/);
    const repos = json<{ entry: { name: string } }[]>("repositories");
    expect(repos.map((r) => r.entry.name).sort()).toEqual(["svc-a", "svc-b"]);
    const second = json<DiscoverResult>("discover", dir, "--no-semantic");
    expect(actions(second)).toEqual({ "svc-a": "UNCHANGED", "svc-b": "ANALYZED" });
    writeFileSync(join(dir, "svc-a/README.md"), "# svc-a changed\n");
    git(join(dir, "svc-a"), "commit", "-qam", "change");
    expect(actions(json<DiscoverResult>("discover", dir, "--no-semantic"))).toEqual({ "svc-a": "ANALYZED", "svc-b": "ANALYZED" });
  });

  test("cross-repository ProjectReference paths and npm file: dependencies link the consuming repository to its provider", () => {
    const r = run("metagraph-topology", "svc-a", "--reverse", "--depth", "1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("svc-b depends on svc-a (DEPENDS_ON_REPOSITORY)  DECLARED 0.95 [file-dependency-path, project-reference-path]");
    const packages = run("shared-packages", "--package", "@fx/lib");
    expect(packages.out).toMatch(/@fx\/lib .*internal-library-dependency\s+svc-a:@fx\/lib/);
  });

  test("KEDA ScaledObjects annotate their target workload and record what they cannot resolve", () => {
    const store = new Database(db, { readonly: true });
    try {
      const worker = store.query("SELECT metadata FROM entities WHERE kind = 'Deployment' AND name = 'worker'").get() as { metadata: string };
      expect(JSON.parse(worker.metadata)).toMatchObject({ autoscaler: "worker-scaler", autoscalerKind: "KEDA ScaledObject", minReplicas: "0", maxReplicas: "7", scaleTriggers: ["azure-servicebus:sb-shop/jobs"], triggerAuthentications: ["sb-auth"] });
      const categories = (store.query("SELECT metadata FROM unresolved WHERE type = 'REFERENCES'").all() as { metadata: string }[]).map((u) => JSON.parse(u.metadata).category).sort();
      expect(categories).toEqual(["keda-authentication-unresolved", "keda-target-unresolved"]);
      const diagnostics = (store.query("SELECT message FROM diagnostics").all() as { message: string }[]).map((d) => d.message).join("\n");
      expect(diagnostics).not.toMatch(/not modelled|unsupported kind/i);
    } finally {
      store.close();
    }
  });

  test("Backstage catalog-info.yaml owners become repository ownership", () => {
    const { teams } = json<{ teams: { team: { id: string }; owns: Record<string, number> }[] }>("teams");
    const owns = Object.fromEntries(teams.map((t) => [t.team.id, t.owns.REPOSITORY ?? 0]));
    expect(owns).toMatchObject({ "principal:team-a": 1, "principal:team-c": 1 });
  });

  test("reports catalog entries whose checkout disappeared", () => {
    rmSync(join(dir, "svc-b"), { recursive: true, force: true });
    const result = json<DiscoverResult>("discover", dir, "--no-semantic");
    expect(actions(result)).toEqual({ "svc-a": "UNCHANGED" });
    expect(result.stale.map((s) => s.name)).toEqual(["svc-b"]);
  });

  test("missing and empty directories", () => {
    const missing = run("discover", join(dir, "nope"));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("directory not found");
    mkdirSync(join(dir, "empty"));
    const empty = json<DiscoverResult>("discover", join(dir, "empty"));
    expect(empty.repositories).toEqual([]);
    expect(empty.metagraph).toBeNull();
  });

  test("descriptor-only folders inside another git repository are skipped with a reason", () => {
    const parent = mkdtempSync(join(tmpdir(), "vogoban-nested-"));
    try {
      mkdirSync(join(parent, "services/api"), { recursive: true });
      writeFileSync(join(parent, "services/api/catalog-info.yaml"), FILES["svc-b/catalog-info.yaml"]!);
      git(parent, "init", "-q");
      const result = json<DiscoverResult>("discover", join(parent, "services"), "--dry-run");
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]!.action).toBe("SKIPPED");
      expect(result.repositories[0]!.detail).toContain("inside the git repository");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
