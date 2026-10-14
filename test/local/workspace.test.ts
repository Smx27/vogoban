import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkspaceConfig, detectRepository, initializeWorkspace, workspaceConfigPath, workspacePath } from "../../src/local/workspace.ts";

describe("repository-local Vogoban workspace", () => {
  test("detects supported repository signals and creates no graph database", () => {
    const root = mkdtempSync(join(tmpdir(), "vogoban-local-"));
    try {
      writeFileSync(join(root, "sample.sln"), "");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "angular.json"), "{}");
      writeFileSync(join(root, "main.tf"), "");
      writeFileSync(join(root, "app.bicep"), "");
      const detected = detectRepository(root);
      expect(detected.languages).toEqual(expect.arrayContaining([".NET", "TypeScript / JavaScript", "Terraform", "Bicep"]));
      expect(detected.frameworks).toContain("Angular");
      const created = initializeWorkspace(root, defaultWorkspaceConfig(root, detected));
      expect(created.created).toBe(true);
      expect(existsSync(workspaceConfigPath(root))).toBe(true);
      expect(readFileSync(join(workspacePath(root), ".gitignore"), "utf8")).toContain("*");
      expect(existsSync(join(workspacePath(root), "graph.db"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("is safe to re-run and preserves existing local configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "vogoban-local-"));
    try {
      const first = initializeWorkspace(root);
      writeFileSync(workspaceConfigPath(root), JSON.stringify({ ...first.config, ui: { openAfterAnalysis: true } }));
      const second = initializeWorkspace(root);
      expect(second.created).toBe(false);
      expect(second.config.ui.openAfterAnalysis).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
