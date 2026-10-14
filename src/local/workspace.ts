import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { repositoryRoot } from "../pipeline/discovery.ts";
import { ANALYZER_GROUPS } from "../plugins/registry.ts";

export const WORKSPACE_DIR = ".vogoban";
export const WORKSPACE_CONFIG = "config.json";

export interface RepositoryDetection {
  root: string;
  name: string;
  git: boolean;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  analyzers: string[];
}

export interface LocalWorkspaceConfig {
  version: 1;
  repository: { root: string; initializedAt: string };
  analysis: {
    analyzers: string[];
    exclusions: string[];
    semantic?: boolean;
    incremental: boolean;
    snapshots: boolean;
  };
  ui: { openAfterAnalysis: boolean };
}

export function workspacePath(root: string): string {
  return join(root, WORKSPACE_DIR);
}

export function workspaceConfigPath(root: string): string {
  return join(workspacePath(root), WORKSPACE_CONFIG);
}

export function defaultWorkspaceConfig(
  root: string,
  detection = detectRepository(root),
): LocalWorkspaceConfig {
  return {
    version: 1,
    repository: { root, initializedAt: new Date().toISOString() },
    analysis: {
      analyzers: detection.analyzers,
      exclusions: ["node_modules", "bin", "obj", "dist", "generated", "vendor"],
      semantic: true,
      incremental: true,
      snapshots: true,
    },
    ui: { openAfterAnalysis: false },
  };
}

export function loadWorkspaceConfig(root: string): LocalWorkspaceConfig | null {
  const path = workspaceConfigPath(root);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new WorkspaceConfigError(
      `Cannot read ${path}; check its permissions. The existing configuration was preserved.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkspaceConfigError(
      `Invalid JSON in ${path}; repair it before continuing. The existing configuration was preserved.`,
    );
  }
  validateWorkspaceConfig(parsed, path);
  return parsed;
}

export class WorkspaceConfigError extends Error {}

export function validateWorkspaceConfig(
  value: unknown,
  path = "workspace configuration",
): asserts value is LocalWorkspaceConfig {
  const fail = (field: string): never => {
    throw new WorkspaceConfigError(
      `Invalid ${field} in ${path}; repair it before continuing. The existing configuration was preserved.`,
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("configuration");
  const config = value as LocalWorkspaceConfig;
  if (config.version !== 1) fail("version (supported: 1)");
  if (
    !config.repository ||
    typeof config.repository.root !== "string" ||
    !config.repository.root ||
    typeof config.repository.initializedAt !== "string"
  )
    fail("repository");
  if (
    !config.analysis ||
    !Array.isArray(config.analysis.analyzers) ||
    !config.analysis.analyzers.every(
      (id) =>
        typeof id === "string" &&
        ANALYZER_GROUPS.some((group) => group.id === id),
    )
  )
    fail("analysis.analyzers");
  if (
    !Array.isArray(config.analysis.exclusions) ||
    !config.analysis.exclusions.every(
      (pattern) =>
        typeof pattern === "string" &&
        pattern.length > 0 &&
        !/[\x00-\x1f]/.test(pattern) &&
        !pattern.startsWith("/") &&
        !pattern.split("/").includes(".."),
    )
  )
    fail("analysis.exclusions (use repository-relative patterns)");
  for (const field of ["incremental", "snapshots"] as const)
    if (typeof config.analysis[field] !== "boolean") fail(`analysis.${field}`);
  if (
    config.analysis.semantic !== undefined &&
    typeof config.analysis.semantic !== "boolean"
  )
    fail("analysis.semantic");
  if (!config.ui || typeof config.ui.openAfterAnalysis !== "boolean")
    fail("ui.openAfterAnalysis");
}

export function configureWorkspace(
  rootPath: string,
  config: LocalWorkspaceConfig,
  expected: LocalWorkspaceConfig,
): { root: string; changed: boolean; config: LocalWorkspaceConfig } {
  const root = repositoryRoot(resolve(rootPath));
  const path = workspaceConfigPath(root);
  validateWorkspaceConfig(config, path);
  const current = loadWorkspaceConfig(root);
  if (!current)
    throw new WorkspaceConfigError(
      `No workspace configuration found; run vogoban init ${root} first.`,
    );
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new WorkspaceConfigError(
      "Configuration changed while you were editing it. Run configure again; no changes were written.",
    );
  if (JSON.stringify(current) === JSON.stringify(config))
    return { root, changed: false, config: current };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (JSON.stringify(loadWorkspaceConfig(root)) !== JSON.stringify(expected))
      throw new WorkspaceConfigError(
        "Configuration changed while you were editing it. Run configure again; no changes were written.",
      );
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { root, changed: true, config };
}

/** Creates only missing workspace files. Existing graph, snapshots, cache and config are never touched. */
export function initializeWorkspace(
  rootPath: string,
  config?: LocalWorkspaceConfig,
): { root: string; created: boolean; config: LocalWorkspaceConfig } {
  const root = repositoryRoot(resolve(rootPath));
  const existing = loadWorkspaceConfig(root);
  if (existing) return { root, created: false, config: existing };
  const workspace = workspacePath(root);
  mkdirSync(join(workspace, "cache"), { recursive: true });
  mkdirSync(join(workspace, "snapshots"), { recursive: true });
  mkdirSync(join(workspace, "metadata"), { recursive: true });
  const ignore = join(workspace, ".gitignore");
  if (!existsSync(ignore))
    writeFileSync(ignore, "*\n!.gitignore\n!config.json\n", {
      encoding: "utf8",
      flag: "wx",
    });
  const next = config ?? defaultWorkspaceConfig(root);
  validateWorkspaceConfig(next, workspaceConfigPath(root));
  writeFileSync(
    workspaceConfigPath(root),
    `${JSON.stringify(next, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { root, created: true, config: next };
}

export function detectRepository(rootPath: string): RepositoryDetection {
  const root = repositoryRoot(resolve(rootPath));
  const has = (...paths: string[]) =>
    paths.some((path) => existsSync(join(root, path)));
  const files = walk(root, 5);
  const any = (pattern: RegExp) => files.some((file) => pattern.test(file));
  const languages: string[] = [];
  const frameworks: string[] = [];
  const packageManagers: string[] = [];
  const analyzers: string[] = [];
  if (any(/\.(sln|slnx|slnf|csproj|fsproj|vbproj)$/i)) {
    languages.push(".NET");
    analyzers.push("dotnet");
  }
  if (any(/\.(ts|tsx|js|jsx)$/i) || has("package.json")) {
    languages.push("TypeScript / JavaScript");
    analyzers.push("frontend");
  }
  if (has("angular.json")) frameworks.push("Angular");
  if (
    has("next.config.js", "next.config.mjs", "next.config.ts") ||
    any(/(^|\/)react\.(tsx?|jsx?)$/i)
  )
    frameworks.push("React");
  if (any(/\.tf$/i)) {
    languages.push("Terraform");
    analyzers.push("infrastructure");
  }
  if (any(/\.bicep$/i) || any(/\.bicepparam$/i)) {
    languages.push("Bicep");
    analyzers.push("azure");
  }
  if (
    any(/(^|\/)(k8s|kubernetes|helm)\//i) ||
    any(/(^|\/)(Chart\.yaml|values\.ya?ml)$/i)
  ) {
    languages.push("Kubernetes");
    if (!analyzers.includes("infrastructure")) analyzers.push("infrastructure");
  }
  if (
    any(
      /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|azure-pipelines[^/]*\.ya?ml)$/i,
    ) ||
    any(/(^|\/)\.github\/workflows\//)
  ) {
    if (!analyzers.includes("infrastructure")) analyzers.push("infrastructure");
  }
  if (analyzers.includes("dotnet") || analyzers.includes("frontend")) {
    if (!analyzers.includes("azure")) analyzers.push("azure");
    analyzers.push("contracts");
  }
  if (
    any(/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i) &&
    !analyzers.includes("contracts")
  )
    analyzers.push("contracts");
  if (any(/(^|\/)CODEOWNERS$/)) analyzers.push("ownership");
  if (has("package-lock.json")) packageManagers.push("npm");
  if (has("pnpm-lock.yaml")) packageManagers.push("pnpm");
  if (has("yarn.lock")) packageManagers.push("yarn");
  if (has("bun.lock", "bun.lockb")) packageManagers.push("bun");
  if (has("global.json", "Directory.Packages.props"))
    packageManagers.push("NuGet");
  return {
    root,
    name: basename(root),
    git: has(".git"),
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
    packageManagers,
    analyzers: [...new Set(analyzers)],
  };
}

function walk(root: string, maxDepth: number): string[] {
  const files: string[] = [];
  const ignored = new Set([
    ".git",
    ".vogoban",
    "node_modules",
    "bin",
    "obj",
    "dist",
    "generated",
    "vendor",
  ]);
  const visit = (relative: string, depth: number) => {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && depth < maxDepth && !ignored.has(entry.name))
        visit(path, depth + 1);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit("", 1);
  return files;
}
