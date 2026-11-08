import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsServer } from "../../src/docs/server";

describe("documentation server security", () => {
  let tempDir: string;
  let outDir: string;
  let secretFile: string;
  let server: ReturnType<typeof createDocsServer>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vogoban-docs-sec-"));
    outDir = join(tempDir, "docs");
    mkdirSync(outDir, { recursive: true });

    // Place a legitimate file in docs
    writeFileSync(join(outDir, "index.html"), "<html><body>Home</body></html>");
    mkdirSync(join(outDir, "guide"), { recursive: true });
    writeFileSync(join(outDir, "guide", "index.html"), "<html><body>Guide</body></html>");

    // Place a sensitive file outside docs
    secretFile = join(tempDir, "secret.txt");
    writeFileSync(secretFile, "SUPER_SECRET_TOKEN_DO_NOT_EXPOSE");

    server = createDocsServer({
      port: 0,
      outDir,
      rebuild: false,
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds to loopback address 127.0.0.1", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  it("serves valid documentation files", async () => {
    const resRoot = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(resRoot.status).toBe(200);
    expect(await resRoot.text()).toContain("Home");

    const resGuide = await fetch(`http://127.0.0.1:${server.port}/guide`);
    expect(resGuide.status).toBe(200);
    expect(await resGuide.text()).toContain("Guide");
  });

  it("prevents path traversal attempts to access files outside outDir", async () => {
    // Relative path traversal attempts
    const pathsToTest = [
      "/../secret.txt",
      "/../../secret.txt",
      "/../../../secret.txt",
      "/guide/../../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/etc/passwd",
      "/../../../etc/passwd",
    ];

    for (const testPath of pathsToTest) {
      const res = await fetch(`http://127.0.0.1:${server.port}${testPath}`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("SUPER_SECRET_TOKEN_DO_NOT_EXPOSE");
      expect(text).not.toContain("root:");
    }
  });
});
