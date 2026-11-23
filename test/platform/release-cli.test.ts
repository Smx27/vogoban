import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./helpers.ts";

let dir = "";
const run = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd, env: { ...process.env, VOGOBAN_OFFLINE: "1", VOGOBAN_DEBUG: "0", VOGOBAN_POLICIES: "" }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const write = (path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vogoban-release-cli-"));
  write("both/.github/CODEOWNERS", "* @acme/platform\n");
  write("both/catalog-info.yaml", "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: both\nspec:\n  owner: team-x\n");
  write("both/a.js", "export const a = 1;\n");
  write("backstage-only/catalog-info.yaml", "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: backstage-only\nspec:\n  owner: group:default/team-y\n");
  write("backstage-only/a.js", "export const b = 2;\n");
  write("no-owner/catalog-info.yaml", "apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: no-owner\nspec:\n  type: service\n");
  write("no-owner/a.txt", "x\n");
  mkdirSync(join(dir, "work"));
  for (const repo of ["both", "backstage-only", "no-owner"]) expect(run(dir, "analyze", repo, "--no-semantic", "--db", "graph.db", "--log-level", "error").code).toBe(0);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("store selection", () => {
  test("read commands refuse a missing store instead of creating an empty one", () => {
    for (const args of [["stats"], ["metagraph", "stats"], ["repos"], ["find", "x"]]) {
      const r = run(dir, ...args, "--db", "missing.db");
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("no graph store at missing.db");
      expect(r.err).not.toMatch(/^\s+at /m);
      expect(existsSync(join(dir, "missing.db"))).toBe(false);
    }
  });

  test("analysis commands still create the store", () => {
    expect(existsSync(join(dir, "graph.db"))).toBe(true);
    expect(run(dir, "stats", "--db", "graph.db").code).toBe(0);
  });
});

describe("governance without a policy folder", () => {
  test("governance and policy listings succeed and explain how to add policies", () => {
    const db = join(dir, "graph.db");
    const governance = run(join(dir, "work"), "governance", "--db", db);
    expect(governance.code).toBe(0);
    expect(governance.out).toContain("No policies configured");
    for (const command of ["policies", "rules", "violations", "exceptions"]) expect(run(join(dir, "work"), command, "--db", db).code, command).toBe(0);
  });

  test("an explicit policy path that does not exist is still an error", () => {
    const r = run(join(dir, "work"), "governance", "--db", join(dir, "graph.db"), "--policy", "nope");
    expect(r.code).not.toBe(0);
  });
});

describe("Backstage ownership", () => {
  test("CODEOWNERS wins over catalog-info.yaml, Backstage owners fill the gap, and a descriptor without owner is unowned", () => {
    const { teams } = JSON.parse(run(dir, "teams", "--db", "graph.db", "--json").out) as { teams: { team: { id: string }; owns: Record<string, number> }[] };
    const owns = Object.fromEntries(teams.map((t) => [t.team.id, t.owns.REPOSITORY ?? 0]));
    expect(owns).toEqual({ "principal:@acme/platform": 1, "principal:team-y": 1 });
    const unowned = run(dir, "unowned", "--db", "graph.db");
    expect(unowned.out).toContain("no-owner");
    expect(unowned.out).not.toContain("backstage-only");
  });
});

describe("QA regressions", () => {
  test("restore refuses to restore a backup onto itself and keeps the backup", () => {
    const backup = join(dir, "self-backup.db");
    expect(run(dir, "backup", "--out", backup, "--db", "graph.db").code).toBe(0);
    const r = run(dir, "restore", "--from", backup, "--db", backup);
    expect(r.code).toBe(2);
    expect(r.err).toContain("backup and target are the same file");
    expect(existsSync(backup)).toBe(true);
    const restored = run(dir, "restore", "--from", backup, "--db", join(dir, "restored.db"));
    expect(restored.code).toBe(0);
    expect(run(dir, "stats", "--db", join(dir, "restored.db")).code).toBe(0);
  });

  test("help is a command", () => {
    const r = run(dir, "help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: vogoban <command>");
  });

  test("register refuses a file and a second checkout of an already registered repository", () => {
    const file = run(dir, "register", "both/a.js", "--db", "graph.db");
    expect(file.code).toBe(2);
    expect(file.err).toContain("not a directory");
    for (const copy of ["remote-a", "remote-b"]) {
      write(`${copy}/x.txt`, "x\n");
      Bun.spawnSync(["git", "-C", join(dir, copy), "init", "-q"]);
      Bun.spawnSync(["git", "-C", join(dir, copy), "remote", "add", "origin", "https://example.invalid/acme/shared.git"]);
    }
    expect(run(dir, "register", "remote-a", "--db", "remotes.db").code).toBe(0);
    const second = run(dir, "register", "remote-b", "--db", "remotes.db");
    expect(second.code).toBe(2);
    expect(second.err).toContain("already registered from");
    expect(run(dir, "register", "remote-b", "--db", "remotes.db", "--force").code).toBe(0);
  });

  test("analyze-all exits 1 when a repository fails", () => {
    const db = join(dir, "readonly.db");
    expect(run(dir, "register", "backstage-only", "--db", db).code).toBe(0);
    chmodSync(db, 0o444);
    try {
      const r = run(dir, "analyze-all", "--db", db, "--no-semantic");
      expect(r.out).toContain("FAILED");
      expect(r.code).toBe(1);
    } finally {
      chmodSync(db, 0o644);
    }
  });

  test("export names a missing output directory instead of a temporary file", () => {
    const r = run(dir, "export", "--format", "json", "--out", join(dir, "missing-dir", "x.json"), "--db", "graph.db");
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing-dir");
    expect(r.err).not.toContain("partial");
  });

  test("graph status of a tree without Git history requires a full rebuild instead of claiming it is current", () => {
    const r = run(dir, "graph", "status", "no-owner", "--db", "graph.db", "--json");
    expect(JSON.parse(r.out).state).toBe("FULL_REBUILD_REQUIRED");
  });
});

