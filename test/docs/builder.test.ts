import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildDocumentation } from "../../src/docs/builder";

describe("documentation builder", () => {
  it("builds docs into html files with search index and sidebar", () => {
    const testOutDir = join(process.cwd(), "dist/test-docs");
    rmSync(testOutDir, { recursive: true, force: true });

    buildDocumentation({ baseHref: "/vogoban/", outDir: "dist/test-docs" });

    expect(existsSync(join(testOutDir, "index.html"))).toBe(true);
    expect(existsSync(join(testOutDir, "concepts.html"))).toBe(true);
    expect(existsSync(join(testOutDir, "cli/overview.html"))).toBe(true);
    expect(existsSync(join(testOutDir, "docs.js"))).toBe(true);

    const indexHtml = readFileSync(join(testOutDir, "index.html"), "utf-8");
    expect(indexHtml).toContain("Vogoban");
    expect(indexHtml).toContain("searchIndex");
    expect(indexHtml).toContain("sidebar-section");
    expect(indexHtml).toContain('<script src="/vogoban/docs.js" defer></script>');
    expect(indexHtml).not.toContain("<script>\\n    // Folder tree");

    rmSync(testOutDir, { recursive: true, force: true });
  });
});
