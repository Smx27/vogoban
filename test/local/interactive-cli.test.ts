import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";

const cli = join(import.meta.dir, "../../src/cli/main.ts");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vogoban-interactive-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "cli-fixture", private: true }),
  );
  writeFileSync(join(root, "kept.ts"), "export class Kept {}\n");
  mkdirSync(join(root, "skip"));
  writeFileSync(
    join(root, "skip", "excluded.ts"),
    "export class Excluded {}\n",
  );
  return root;
}
async function run(...args: string[]) {
  const process = Bun.spawn(["bun", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, CI: "1", NO_COLOR: "1", VOGOBAN_DEBUG: "0" },
  });
  const [code, out, err] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    code,
    out,
    err,
    json: out.trim().startsWith("{") ? JSON.parse(out) : null,
  };
}
const path = (root: string) => join(root, ".vogoban", "config.json");

describe("interactive CLI automation contracts", () => {
  test("missing setup paths produce structured JSON errors", async () => {
    const root = fixture();
    try {
      for (const command of ["init", "configure"]) {
        const result = await run(command, join(root, "missing"), "--json");
        expect(result.code).toBe(2);
        expect(result.json.error).toContain("path not found");
        expect(result.json.category).toBe("cli");
        expect(result.err).toBe("");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("noninteractive init records explicit settings without ANSI, prompts, or a database", async () => {
    const root = fixture();
    try {
      const result = await run(
        "init",
        root,
        "--json",
        "--analyzers",
        "frontend",
        "--exclude",
        "skip,**/*.ignored.ts",
        "--no-semantic",
        "--no-incremental",
        "--no-snapshots",
        "--no-open",
      );
      expect(result.code).toBe(0);
      expect(result.json.initialized).toBe(true);
      expect(result.json.config.analysis).toEqual({
        analyzers: ["frontend"],
        exclusions: ["skip", "**/*.ignored.ts"],
        semantic: false,
        incremental: false,
        snapshots: false,
      });
      expect(result.out).not.toContain("\u001b[");
      expect(result.err).toBe("");
      expect(existsSync(join(root, ".vogoban", "graph.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configure changes only settings and preserves unknown fields and all local data", async () => {
    const root = fixture();
    try {
      expect((await run("init", root, "--json")).code).toBe(0);
      const config = JSON.parse(readFileSync(path(root), "utf8"));
      config.metadata = { owner: "fixture-team" };
      config.analysis.custom = "preserved";
      writeFileSync(path(root), JSON.stringify(config));
      const files = [
        join(root, ".vogoban", "graph.db"),
        join(root, ".vogoban", "cache", "keep"),
        join(root, ".vogoban", "snapshots", "keep"),
      ];
      for (const file of files) writeFileSync(file, "preserve these bytes");
      const result = await run(
        "configure",
        root,
        "--json",
        "--analyzers",
        "frontend,contracts",
        "--no-semantic",
        "--no-snapshots",
        "--exclude",
        "skip",
        "--open",
      );
      expect(result.code).toBe(0);
      expect(result.json.reconfigured).toBe(true);
      expect(result.json.config.metadata).toEqual(config.metadata);
      expect(result.json.config.analysis.custom).toBe("preserved");
      expect(result.json.config.repository.initializedAt).toBe(
        config.repository.initializedAt,
      );
      expect(result.json.config.ui.openAfterAnalysis).toBe(true);
      for (const file of files)
        expect(readFileSync(file, "utf8")).toBe("preserve these bytes");
      expect(
        readdirSync(join(root, ".vogoban")).some((name) =>
          name.endsWith(".tmp"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("init reruns cannot overwrite settings even when new flags are supplied", async () => {
    const root = fixture();
    try {
      await run("init", root, "--json");
      const before = readFileSync(path(root), "utf8");
      const unchanged = await run("init", root, "--json");
      expect(unchanged.json.initialized).toBe(false);
      expect(readFileSync(path(root), "utf8")).toBe(before);
      const rejected = await run("init", root, "--json", "--analyzers", "none");
      expect(rejected.code).toBe(2);
      expect(rejected.json.error).toContain("configure");
      expect(readFileSync(path(root), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid configuration is reported without replacement or database creation", async () => {
    const root = fixture();
    try {
      mkdirSync(join(root, ".vogoban"));
      writeFileSync(path(root), "{broken");
      for (const command of ["init", "configure", "analyze"]) {
        const result = await run(command, root, "--json");
        expect(result.code).toBe(2);
        expect(result.json.error).toContain("Invalid JSON");
        expect(readFileSync(path(root), "utf8")).toBe("{broken");
        expect(existsSync(join(root, ".vogoban", "graph.db"))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown analyzer groups and conflicting flags fail before creating a workspace", async () => {
    const root = fixture();
    try {
      for (const args of [
        ["--analyzers", "not-an-analyzer"],
        ["--semantic", "--no-semantic"],
        ["--snapshots", "--no-snapshots"],
        ["--exclude", "../outside"],
      ]) {
        expect((await run("init", root, "--json", ...args)).code).toBe(2);
        expect(existsSync(join(root, ".vogoban"))).toBe(false);
      }
      expect(
        (await run("configure", root, "--json", "--analyzers", "frontend"))
          .code,
      ).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("noninteractive configure refuses implicit edits", async () => {
    const root = fixture();
    try {
      await run("init", root, "--json");
      const before = readFileSync(path(root), "utf8");
      const result = await run("configure", root, "--json", "--yes");
      expect(result.code).toBe(2);
      expect(result.json.error).toContain("explicit setting flags");
      expect(readFileSync(path(root), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("analysis and graph sync honor local settings while one-run flags never rewrite configuration", async () => {
    const root = fixture();
    try {
      await run(
        "init",
        root,
        "--json",
        "--analyzers",
        "none",
        "--exclude",
        "skip",
        "--no-semantic",
        "--no-snapshots",
        "--no-incremental",
        "--open",
      );
      const before = readFileSync(path(root), "utf8");
      const first = await run("analyze", root, "--json");
      expect(first.code).toBe(0);
      expect(first.json.run.pluginVersions).toEqual({});
      const second = await run(
        "analyze",
        root,
        "--json",
        "--analyzers",
        "frontend",
        "--snapshots",
      );
      expect(second.code).toBe(0);
      expect(
        second.json.run.pluginVersions["typescript.tree-sitter"],
      ).toBeDefined();
      expect(readFileSync(path(root), "utf8")).toBe(before);
      const sync = await run("graph", "sync", root, "--json");
      expect(sync.code).toBe(0);
      expect(sync.json.actualMode).toBe("full");
      const store = new SqliteGraphStore(join(root, ".vogoban", "graph.db"));
      try {
        expect(
          store.listGraphSnapshots({
            scope: "repository",
            repositoryId: first.json.repository.id,
          }),
        ).toHaveLength(1);
        expect(
          store
            .findEntities({
              repositoryId: first.json.repository.id,
              kind: "File",
              limit: 100,
            })
            .some((entity) => entity.location?.file.startsWith("skip/")),
        ).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
