import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveLocalGraph } from "../../src/local/server.ts";

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
