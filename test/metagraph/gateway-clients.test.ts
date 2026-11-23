import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".dotnet/dotnet"), join(process.env.HOME ?? "", ".capy/work/dotnet/dotnet")].find((p) => p && existsSync(p));

test.skipIf(!dotnet)("typed HttpClient calls without a known base address are not resolved to the calling gateway's own operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "vogoban-gateway-"));
  try {
    cpSync(join(ROOT, "example/vogoban-enterprise-landscape/platform-gateway"), join(dir, "platform-gateway"), { recursive: true });
    const r = Bun.spawnSync(["bun", CLI, "analyze", join(dir, "platform-gateway"), "--db", join(dir, "graph.db"), "--log-level", "error"], { env: { ...process.env, VOGOBAN_OFFLINE: "1", VOGOBAN_DOTNET: dotnet! }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const db = new Database(join(dir, "graph.db"), { readonly: true });
    const resolved = db.query("SELECT COUNT(*) AS n FROM relationships WHERE type = 'CALLS_ENDPOINT' AND file LIKE 'src/PlatformGateway.Api/Clients/%'").get() as { n: number };
    const unresolved = db.query("SELECT COUNT(*) AS n FROM unresolved WHERE type = 'CALLS_ENDPOINT' AND target_display LIKE '%/api/orders%'").get() as { n: number };
    db.close();
    expect(resolved.n).toBe(0);
    expect(unresolved.n).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
