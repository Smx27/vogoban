import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * B-13: when Git state cannot be determined, `graph sync` must fail visibly and leave the previous graph untouched
 * (same graph version, same repository identity, no phantom `local:` repository, same relationships), and record the
 * failure in history. "Could not determine whether changes exist" is never reported as "no changes".
 */
const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "main.ts");
const BUN = process.execPath;

let work: string;
let repo: string;
let db: string;
let baseline: Snapshot;

interface Snapshot {
  catalog: Array<{ repository_id: string; identity: string; graph_version: string | null }>;
  repositories: number;
  relationships: number;
  entities: number;
}

function vogoban(args: string[], env: Record<string, string | undefined> = {}): { code: number; json: Record<string, unknown> | null; stderr: string; stdout: string } {
  const r = Bun.spawnSync([BUN, CLI, ...args, "--no-semantic", "--db", db, "--json"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_OFFLINE: "1", ...env } });
  const stdout = r.stdout.toString();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code: r.exitCode, json, stderr: r.stderr.toString(), stdout };
}

function snapshot(file = db): Snapshot {
  const d = new Database(file, { readonly: true });
  try {
    return {
      catalog: d.query("select repository_id, identity, graph_version from catalog order by repository_id").all() as Snapshot["catalog"],
      repositories: (d.query("select count(*) as c from repositories").get() as { c: number }).c,
      relationships: (d.query("select count(*) as c from relationships").get() as { c: number }).c,
      entities: (d.query("select count(*) as c from entities").get() as { c: number }).c,
    };
  } finally {
    d.close();
  }
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=CANARY-user", "-c", "user.email=canary@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, "App"), { recursive: true });
  writeFileSync(join(dir, "App", "App.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n`);
  writeFileSync(join(dir, "App", "Program.cs"), `namespace App { public class Greeter { public string Hello() => "hi"; } public class Caller { public string Go() => new Greeter().Hello(); } }\n`);
}

/** Runs sync under a broken Git state and asserts explicit failure with the graph untouched; `restore` always runs. */
function expectRefused(label: string, brk: () => void, restore: () => void, env: Record<string, string | undefined> = {}): Record<string, unknown> {
  brk();
  let result: ReturnType<typeof vogoban>;
  try {
    result = vogoban(["graph", "sync", repo], env);
  } finally {
    restore();
  }
  expect(result.code, `${label}: exit code (stderr: ${result.stderr})`).not.toBe(0);
  expect(result.json, `${label}: structured output`).not.toBeNull();
  const json = result.json!;
  if (json.status !== undefined) {
    expect(json.status).toBe("FAILED");
    expect(json.actualMode).not.toBe("noop");
    expect(typeof json.error).toBe("string");
    expect(json.repositoryId).toBe(baseline.catalog[0]!.repository_id);
    expect(json.graphVersion).toBe(baseline.catalog[0]!.graph_version);
  } else {
    expect(typeof json.error).toBe("string");
  }
  expect(snapshot(), `${label}: graph untouched`).toEqual(baseline);
  return json;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "vogoban-git-failure-"));
  repo = join(work, "repo");
  db = join(work, "store", "graph.db");
  mkdirSync(repo);
  mkdirSync(join(work, "store"));
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", "https://example.invalid/CANARY-org/CANARY-repo.git");
  writeFixture(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");

  const analyzed = vogoban(["analyze", repo]);
  expect(analyzed.code, analyzed.stderr).toBe(0);
  baseline = snapshot();
  expect(baseline.catalog).toHaveLength(1);
  expect(baseline.catalog[0]!.identity).toBe("example.invalid/canary-org/canary-repo");
  expect(baseline.catalog[0]!.graph_version).toBeTruthy();
  expect(baseline.repositories).toBe(1);
  expect(baseline.relationships).toBeGreaterThan(0);
});

afterAll(() => {
  for (const p of [join(repo, ".git"), join(repo, ".git", "objects"), join(repo, ".git", "index")]) if (existsSync(p)) chmodSync(p, 0o755);
  rmSync(work, { recursive: true, force: true });
});

describe("graph sync with unusable Git state", () => {
  test("healthy repository is a no-op baseline", () => {
    const r = vogoban(["graph", "sync", repo]);
    expect(r.code).toBe(0);
    expect(r.json?.status).toBe("NO_OP");
    expect(snapshot()).toEqual(baseline);
  });

  test(".git renamed away: no phantom local: repository", () => {
    const json = expectRefused(".git missing", () => renameSync(join(repo, ".git"), join(work, "git-away")), () => renameSync(join(work, "git-away"), join(repo, ".git")));
    expect(String(json.error)).toContain("local:");
    expect(String(json.error)).toContain("example.invalid/canary-org/canary-repo");
  });

  test(".git unreadable (chmod 000)", () => {
    const json = expectRefused(".git unreadable", () => chmodSync(join(repo, ".git"), 0o000), () => chmodSync(join(repo, ".git"), 0o755));
    expect(String(json.error)).toContain("cannot be determined");
  });

  test(".git/objects unreadable", () => {
    expectRefused("objects unreadable", () => chmodSync(join(repo, ".git", "objects"), 0o000), () => chmodSync(join(repo, ".git", "objects"), 0o755));
  });

  test(".git/index unreadable is not 'no changes'", () => {
    const json = expectRefused("index unreadable", () => chmodSync(join(repo, ".git", "index"), 0o000), () => chmodSync(join(repo, ".git", "index"), 0o644));
    expect(String(json.error)).toContain("index");
  });

  test("git command absent from PATH", () => {
    const json = expectRefused("no git", () => {}, () => {}, { PATH: join(work, "empty-path") });
    expect(String(json.error)).toContain("cannot be determined");
  });

  test("GIT_DIR pointing at garbage", () => {
    expectRefused("GIT_DIR garbage", () => {}, () => {}, { GIT_DIR: join(work, "nonexistent-git-dir") });
  });

  test("invalid HEAD content", () => {
    const head = join(repo, ".git", "HEAD");
    const backup = join(work, "HEAD.bak");
    expectRefused("invalid HEAD", () => { copyFileSync(head, backup); writeFileSync(head, "CANARY-garbage\n"); }, () => copyFileSync(backup, head));
  });

  test("invalid repository state: HEAD points at a missing ref", () => {
    const head = join(repo, ".git", "HEAD");
    const backup = join(work, "HEAD.bak2");
    const json = expectRefused("HEAD missing ref", () => { copyFileSync(head, backup); writeFileSync(head, "ref: refs/heads/CANARY-missing\n"); }, () => copyFileSync(backup, head));
    expect(String(json.error)).toContain("does not resolve to a commit");
  });

  test("permission failure on .git/config", () => {
    expectRefused("config unreadable", () => chmodSync(join(repo, ".git", "config"), 0o000), () => chmodSync(join(repo, ".git", "config"), 0o644));
  });

  test("failures are recorded in history as FAILED, never as no-op", () => {
    const h = vogoban(["graph", "history", repo]);
    expect(h.code).toBe(0);
    const entries = h.json as unknown as Array<{ status: string; mode: string; graphVersion: string | null }>;
    const failed = entries.filter((e) => e.status === "FAILED");
    expect(failed.length).toBeGreaterThanOrEqual(9);
    for (const e of failed) {
      expect(e.mode).not.toBe("noop");
      expect(e.graphVersion).toBe(baseline.catalog[0]!.graph_version);
    }
  });

  test("temporary failure then restore: sync recovers and picks up a real change", () => {
    expectRefused("temporary", () => chmodSync(join(repo, ".git"), 0o000), () => chmodSync(join(repo, ".git"), 0o755));
    const noop = vogoban(["graph", "sync", repo]);
    expect(noop.code, noop.stderr).toBe(0);
    expect(noop.json?.status).toBe("NO_OP");
    expect(snapshot()).toEqual(baseline);

    writeFileSync(join(repo, "App", "Extra.cs"), `namespace App { public class Extra { public string Use() => new Greeter().Hello(); } }\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "extra");
    const synced = vogoban(["graph", "sync", repo]);
    expect(synced.code, synced.stderr).toBe(0);
    expect(synced.json?.status).toBe("SUCCESS");
    expect(synced.json?.currentCommit).toBe(git(repo, "rev-parse", "HEAD"));
    const after = snapshot();
    expect(after.catalog).toHaveLength(1);
    expect(after.catalog[0]!.identity).toBe(baseline.catalog[0]!.identity);
    expect(after.catalog[0]!.repository_id).toBe(baseline.catalog[0]!.repository_id);
    expect(after.catalog[0]!.graph_version).not.toBe(baseline.catalog[0]!.graph_version);
    expect(after.repositories).toBe(1);
    expect(after.entities).toBeGreaterThan(baseline.entities);
  });
});

describe("re-analyze of a registered repository", () => {
  test("analyze with .git renamed away refuses to re-register the checkout under a local: identity", () => {
    const before = snapshot();
    renameSync(join(repo, ".git"), join(work, "git-away"));
    let r: ReturnType<typeof vogoban>;
    try {
      r = vogoban(["analyze", repo]);
    } finally {
      renameSync(join(work, "git-away"), join(repo, ".git"));
    }
    expect(r.code).toBe(2);
    expect(String(r.json?.error)).toContain("registered as example.invalid/canary-org/canary-repo");
    expect(snapshot()).toEqual(before);
  });
});

describe("first-time analyze", () => {
  test("a repository whose .git is unreadable fails instead of producing a local: identity", () => {
    const freshDb = join(work, "fresh", "graph.db");
    mkdirSync(join(work, "fresh"));
    chmodSync(join(repo, ".git"), 0o000);
    let r: ReturnType<typeof vogoban>;
    const saved = db;
    try {
      db = freshDb;
      r = vogoban(["analyze", repo]);
    } finally {
      db = saved;
      chmodSync(join(repo, ".git"), 0o755);
    }
    expect(r.code).toBe(2);
    expect(String(r.json?.error)).toContain("cannot be determined");
    expect(r.json?.category).toBe("repository");
    if (existsSync(freshDb)) {
      const s = snapshot(freshDb);
      expect(s.catalog).toHaveLength(0);
      expect(s.repositories).toBe(0);
    }
  });

  test("a plain directory without .git is still a legitimate non-git repository", () => {
    const plain = join(work, "plain");
    const plainDb = join(work, "plain-store", "graph.db");
    mkdirSync(join(work, "plain-store"));
    writeFixture(plain);
    const saved = db;
    let analyzed: ReturnType<typeof vogoban>;
    let synced: ReturnType<typeof vogoban>;
    try {
      db = plainDb;
      analyzed = vogoban(["analyze", plain]);
      synced = vogoban(["graph", "sync", plain]);
    } finally {
      db = saved;
    }
    expect(analyzed.code, analyzed.stderr).toBe(0);
    expect(synced.code, synced.stderr).toBe(0);
    expect(synced.json?.status).toBe("SUCCESS");
    const s = snapshot(plainDb);
    expect(s.catalog).toHaveLength(1);
    expect(s.catalog[0]!.identity).toBe(`local:${plain}`);
  });
});
