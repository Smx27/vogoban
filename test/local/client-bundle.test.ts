import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveLocalGraph, LOCAL_SECURITY_HEADERS } from "../../src/local/server.ts";

test("local graph serves responses with defensive security headers", async () => {
  const root = mkdtempSync(join(tmpdir(), "vogoban-sec-headers-"));
  const server = serveLocalGraph({
    root,
    db: join(root, ".vogoban", "graph.db"),
  });
  try {
    expect(LOCAL_SECURITY_HEADERS["content-security-policy"]).toContain("script-src 'self'");
    expect(LOCAL_SECURITY_HEADERS["content-security-policy"]).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(LOCAL_SECURITY_HEADERS["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    for (const path of ["/", "/app.js", "/api/status", "/nonexistent"]) {
      const response = await fetch(`${server.url}${path}`);
      for (const [header, expectedValue] of Object.entries(LOCAL_SECURITY_HEADERS)) {
        expect(response.headers.get(header)).toBe(expectedValue);
      }
    }
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local graph serves an offline React Flow client and unchanged graph JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "vogoban-client-"));
  const server = serveLocalGraph({
    root,
    db: join(root, ".vogoban", "graph.db"),
  });
  try {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    for (const path of ["/", "/app.js", "/flow.css", "/app.css"]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    }
    const response = await fetch(`${server.url}/api/graph`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entities: [],
      relationships: [],
      categories: [],
    });
    const html = await (await fetch(server.url)).text();
    expect(html).not.toContain("https://");
    expect(html).toContain('src="/app.js"');
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
