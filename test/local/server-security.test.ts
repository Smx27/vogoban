import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_SECURITY_HEADERS, serveLocalGraph } from "../../src/local/server.ts";

test("local graph server sends security headers on pages, assets and API responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "vogoban-security-"));
  const server = serveLocalGraph({ root, db: join(root, "graph.db") });
  try {
    for (const path of ["/", "/app.js", "/app.css", "/api/graph", "/api/status", "/missing"]) {
      const response = await fetch(`${server.url}${path}`);
      for (const [name, value] of Object.entries(LOCAL_SECURITY_HEADERS)) expect(response.headers.get(name), `${path} ${name}`).toBe(value);
      await response.arrayBuffer();
    }
    const csp = LOCAL_SECURITY_HEADERS["content-security-policy"]!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local graph server rejects requests whose Host is not loopback (DNS rebinding)", async () => {
  const root = mkdtempSync(join(tmpdir(), "vogoban-rebind-"));
  const server = serveLocalGraph({ root, db: join(root, "graph.db") });
  const port = new URL(server.url).port;
  try {
    for (const host of ["attacker.example", `attacker.example:${port}`, `127.0.0.1.attacker.example:${port}`]) {
      const response = await fetch(`${server.url}/api/graph`, { headers: { host } });
      expect(response.status, host).toBe(403);
      expect(await response.text()).not.toContain("entities");
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const response = await fetch(`${server.url}/api/graph`, { headers: { host } });
      expect(response.status, host).toBe(200);
      await response.arrayBuffer();
    }
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
