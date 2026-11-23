import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");

test("MCP stdio answers JSON-RPC batches and rejects empty batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vogoban-mcp-batch-"));
  try {
    writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
    expect(Bun.spawnSync(["bun", CLI, "analyze", dir, "--no-semantic", "--db", join(dir, "graph.db"), "--log-level", "error"], { env: { ...process.env, VOGOBAN_OFFLINE: "1" } }).exitCode).toBe(0);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      [{ jsonrpc: "2.0", id: 901, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 902, method: "ping" }],
      [],
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = Bun.spawnSync(["bun", CLI, "mcp", "--db", join(dir, "graph.db")], { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    const replies = r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
    const batch = replies.find((x) => Array.isArray(x)) as { id: number; result: unknown }[];
    expect(batch.map((x) => x.id).sort()).toEqual([901, 902]);
    expect(replies.some((x) => !Array.isArray(x) && x.id === null && x.error?.code === -32600)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
