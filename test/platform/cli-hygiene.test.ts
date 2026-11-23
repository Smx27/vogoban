import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, ROOT } from "./helpers.ts";

const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_DEBUG: "0" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const expectNoStackTrace = (text: string) => {
  expect(text).not.toMatch(/^\s+at /m);
  expect(text).not.toMatch(/TypeError|RangeError|ReferenceError|ERR_PARSE_ARGS/);
  expect(text).not.toMatch(/main\.ts:\d+/);
};

describe("CLI hygiene (C-07/C-08)", () => {
  test("--version prints the package.json version cleanly", () => {
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const r = run("--version");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${version}\n`);
    expect(r.err).toBe("");
  });

  test("unknown option: one-line error + usage, exit 2, no stack trace", () => {
    for (const args of [["--bogus"], ["repos", "--bogus"], ["--db"], ["--limit"], ["-x"]]) {
      const r = run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toBe("");
      const lines = r.err.trimEnd().split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toMatch(/^error: /);
      expect(lines[1]).toMatch(/^usage: vogoban/);
      expectNoStackTrace(r.err);
    }
  });

  test("unknown command: error + help, exit 2", () => {
    const r = run("frobnicate");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unknown command 'frobnicate'/);
    expect(r.err).toContain("Usage: vogoban <command>");
    expectNoStackTrace(r.err);
  });

  test("no command prints help and exits 1; --help exits 0", () => {
    const none = run();
    expect(none.code).toBe(1);
    expect(none.out).toContain("Usage: vogoban <command>");
    const help = run("--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("--version");
  });

  test("missing store for a read command is a clean error", () => {
    const r = run("repos", "--db", "/nonexistent-dir/CANARY/graph.db");
    expect(r.code).not.toBe(0);
    expectNoStackTrace(r.err);
  });

  test("hooks status with --db reports hook state and never installs anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "vogoban-hooks-"));
    try {
      const r = run("hooks", "status", ROOT, "--db", join(dir, "graph.db"), "--json");
      expect(r.code).toBe(0);
      expectNoStackTrace(r.err);
      const status = JSON.parse(r.out) as { hook: string; installed: boolean; mode: string | null }[];
      expect(status.map((h) => h.hook).sort()).toEqual(["post-commit", "post-merge"]);
      for (const h of status) expect(h.installed).toBe(false);
      expect(existsSync(join(dir, "graph.db"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unwritable --db location is a clean one-line error", () => {
    const r = run("hooks", "status", ROOT, "--db", "/nonexistent-dir/CANARY/graph.db");
    expect(r.code).toBe(1);
    expect(r.err.trimEnd().split("\n").length).toBe(1);
    expectNoStackTrace(r.err);
  });
});

test("hooks install --db bakes the absolute store path into the hook (C-08)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vogoban-hooks-db-"));
  try {
    Bun.spawnSync(["git", "init", "-q", dir]);
    const r = run("hooks", "install", dir, "--db", join(dir, "store", "graph.db"), "--hook-mode", "background", "--json");
    expect(r.code).toBe(0);
    const hook = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(hook).toContain(`graph sync --quiet --db '${join(dir, "store", "graph.db")}'`);
    expect(run("hooks", "uninstall", dir, "--db", join(dir, "store", "graph.db"), "--json").code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
