import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { FileCategory, RepositoryRecord } from "../graph/model.ts";
import { ids, keys } from "../graph/identity.ts";
import type { DiscoveredFile } from "../plugins/types.ts";
import type { Logger } from "../log.ts";
import { globToRegExp } from "../dotnet/msbuild.ts";

const IGNORED_DIRS = new Set([".git", "bin", "obj", "node_modules", ".vs", ".idea", ".vogoban", "packages", "TestResults"]);
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Largest source file any analyzer may read (discovery and the Roslyn analyzer share this bound); VOGOBAN_MAX_SOURCE_FILE_BYTES overrides the 8 MiB default. */
export function maxSourceFileBytes(): number {
  const configured = Number(process.env.VOGOBAN_MAX_SOURCE_FILE_BYTES);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_BYTES;
}

/** Git state exists on disk (or is pointed at by GIT_DIR) but cannot be read reliably; nothing may be guessed from it. */
export class GitStateError extends Error {}

function hasGitDir(root: string): boolean {
  if (process.env.GIT_DIR) return true;
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Runs git and returns its trimmed stdout. Exit 1 means "nothing to report" (a missing ref or config key) and yields null.
 * Any other failure yields null only when no Git directory exists at all (a plain directory); when `.git` is present but
 * git cannot answer, the repository's identity and state are unknowable and a GitStateError is thrown instead of guessing.
 * `optional` lookups (branch names, remote URL) yield null on every failure.
 */
function git(root: string, args: string[], optional = false): string | null {
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    exitCode = result.exitCode;
    stdout = result.stdout.toString();
    stderr = result.stderr.toString();
  } catch (error) {
    stderr = `git could not be executed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (exitCode === 0) return stdout.trim();
  if (/dubious ownership/i.test(stderr))
    throw new Error(`Git refuses to read ${root} because it is owned by a different user (dubious ownership). Run vogoban as the repository owner (for containers: docker run --user "$(id -u):$(id -g)"). Vogoban does not override this Git safety check.`);
  if (optional || exitCode === 1 || !hasGitDir(root)) return null;
  const detail = stderr.split("\n").find((line) => line.trim()) ?? `exit code ${exitCode ?? "unknown"}`;
  throw new GitStateError(`Git state of ${root} cannot be determined (git ${args.join(" ")}: ${detail.trim()}); a .git directory exists but is unusable, so the repository identity and its changes are unknown. Fix or restore the Git checkout and retry.`);
}

export function sanitizeRemote(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  let normalized = scp ? `${scp[1]}/${scp[2]}` : url;
  normalized = normalized.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  return normalized.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

export interface DiscoveredRepository extends RepositoryRecord {
  identity: string;
  provider: string | null;
  organization: string | null;
  defaultBranch: string | null;
}

export function repositoryRoot(path: string): string {
  const absolute = realpathSync(path);
  return git(absolute, ["rev-parse", "--show-toplevel"]) ?? absolute;
}

export function currentCommit(root: string): { commit: string | null; dirty: boolean } {
  return { commit: git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]), dirty: (git(root, ["status", "--porcelain"]) ?? "") !== "" };
}

export function discoverRepository(path: string, configured: { id: string | null; name: string | null } = { id: null, name: null }): DiscoveredRepository {
  const root = repositoryRoot(path);
  const remote = git(root, ["config", "--get", "remote.origin.url"], true);
  const remoteUrl = remote ? sanitizeRemote(remote) : null;
  const identity = configured.id ? `configured:${configured.id}` : (remoteUrl ?? `local:${root}`);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], true);
  const segments = remoteUrl?.split("/") ?? [];
  const defaultRef = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true);
  return {
    id: ids.entity(keys.repository(identity)),
    identity,
    provider: segments.length >= 3 ? segments[0]! : null,
    organization: segments.length >= 3 ? segments.slice(1, -1).join("/") : null,
    defaultBranch: defaultRef ? defaultRef.replace(/^origin\//, "") : null,
    name: configured.name ?? (remoteUrl ? (remoteUrl.split("/").pop() ?? basename(root)) : basename(root)),
    rootPath: root,
    remoteUrl,
    branch: branch && branch !== "HEAD" ? branch : null,
    commit: git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    dirty: (git(root, ["status", "--porcelain"]) ?? "") !== "",
  };
}

function listFiles(root: string): string[] {
  const tracked = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (tracked !== null) {
    return tracked
      .split("\0")
      .filter(Boolean)
      .filter((p) => !p.split("/").some((part) => IGNORED_DIRS.has(part)));
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return out;
}

export function classifyFile(path: string): { category: FileCategory; language: string | null } {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (name.endsWith(".cs")) return { category: "source", language: "csharp" };
  if (name.endsWith(".razor") || name.endsWith(".cshtml")) return { category: "source", language: "razor" };
  if (/\.(csproj|fsproj|vbproj|props|targets)$/.test(name)) return { category: "project", language: "msbuild" };
  if (/\.(ts|tsx|mts|cts)$/.test(name)) return { category: "source", language: "typescript" };
  if (/\.(js|jsx|mjs|cjs)$/.test(name)) return { category: "source", language: "javascript" };
  if (name === "package.json") return { category: "project", language: "npm" };
  if (/^(tsconfig|jsconfig)([\w.-]*)\.json$/.test(name)) return { category: "config", language: "tsconfig" };
  if (name === "angular.json" || name === "pnpm-workspace.yaml" || name === "lerna.json" || name === "nx.json") return { category: "config", language: name.endsWith(".yaml") ? "yaml" : "json" };
  if (/^\.env(\.[\w-]+)?$/.test(name)) return { category: "config", language: "dotenv" };
  if (/\.(sln|slnx|slnf)$/.test(name)) return { category: "solution", language: null };
  if (/^appsettings(\.[\w-]+)?\.json$/.test(name) || /^(web|app)\.config$/.test(name) || name === "launchsettings.json")
    return { category: "config", language: "json" };
  if (/^(azure-pipelines.*|\.azure-pipelines.*)\.ya?ml$/.test(name) || lower.startsWith(".github/workflows/") || lower.includes("/pipelines/"))
    return { category: "pipeline", language: "yaml" };
  if (/(openapi|swagger)[\w.-]*\.(json|ya?ml)$/.test(name) || /asyncapi[\w.-]*\.(json|ya?ml)$/.test(name))
    return { category: "contract", language: name.endsWith(".json") ? "json" : "yaml" };
  if (/^dockerfile([.-][\w.-]+)?$/.test(name) || name.endsWith(".dockerfile") || /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(name)) return { category: "infrastructure", language: "docker" };
  if (name === "chart.yaml" || name.startsWith("values") && name.endsWith(".yaml") || /(^|\/)(charts|helm|k8s|kubernetes|manifests|deploy)\//.test(lower))
    return { category: "infrastructure", language: "yaml" };
  if (/\.(tf|bicep)$/.test(name)) return { category: "infrastructure", language: name.split(".").pop() ?? null };
  if (name.endsWith(".bicepparam")) return { category: "infrastructure", language: "bicepparam" };
  if (/\.tfvars(\.json)?$/.test(name)) return { category: "infrastructure", language: "tfvars" };
  if (name === "host.json" || name === "function.json" || /^local\.settings(\.[\w-]+)?\.json$/.test(name)) return { category: "config", language: "azure-functions" };
  if (name === "azure.yaml" || name === "azure.yml") return { category: "config", language: "azd" };
  return { category: "other", language: null };
}

const FRONTEND_OUTPUT_DIRS = new Set(["dist", "build", "out", "coverage", ".angular", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".vite", "storybook-static", "bower_components", "jspm_packages", ".yarn", "vendor", ".docusaurus"]);
const FRONTEND_BUNDLE = /\.(min|bundle|chunk)\.(js|mjs|cjs)$|\.(js|mjs)\.map$/i;

/** Build output, vendored libraries and caches are never analyzed as frontend source unless vogoban.json frontend.include names them. */
export function frontendExclusion(path: string, include: RegExp[] = []): string | null {
  if (include.some((re) => re.test(path))) return null;
  const parts = path.split("/");
  const dir = parts.slice(0, -1).findIndex((p) => FRONTEND_OUTPUT_DIRS.has(p.toLowerCase()));
  if (dir >= 0) return parts.slice(0, dir + 1).join("/");
  const lib = parts.findIndex((p, i) => p.toLowerCase() === "wwwroot" && parts[i + 1]?.toLowerCase() === "lib");
  if (lib >= 0) return parts.slice(0, lib + 2).join("/");
  if (FRONTEND_BUNDLE.test(path)) return path;
  return null;
}

const OPENAPI_MARKER = /("openapi"\s*:\s*"\d|^openapi\s*:\s*['"]?\d|"swagger"\s*:\s*"2|^swagger\s*:\s*['"]?2)/m;

const GENERATED_FRONTEND = /<auto-generated|@generated|Generated using the NSwag toolchain|generated by (openapi-generator|swagger-codegen|orval|graphql-codegen)|do not edit|do not modify this file/i;

const GENERATED_PATH = /(\.g|\.g\.i|\.designer|\.generated|\.assemblyinfo|\.assemblyattributes)\.cs$/i;

const KUBERNETES_MARKER = /^apiVersion:\s*\S+[\s\S]*?^kind:\s*\w+|^kind:\s*\w+[\s\S]*?^apiVersion:\s*\S+/m;
const ARM_MARKER = /"\$schema"\s*:\s*"https?:\/\/schema\.management\.azure\.com\/schemas\/[^"]*(deploymentTemplate|deploymentParameters)\.json/i;
const PIPELINE_MARKER = /^(stages|jobs|steps|extends):/m;

export async function discoverFiles(
  root: string,
  log: Logger,
  explicitContracts: string[] = [],
  explicitPipelines: string[] = [],
  explicitInfrastructure: string[] = [],
  frontend: { include: string[]; exclude: string[] } = { include: [], exclude: [] },
): Promise<{ files: DiscoveredFile[]; skipped: { path: string; reason: string }[] }> {
  const files: DiscoveredFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const all = listFiles(root).sort();
  const gitlinks = (git(root, ["ls-files", "--stage", "-z"]) ?? "").split("\0").filter((e) => e.startsWith("160000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
  for (const path of gitlinks) skipped.push({ path, reason: "git submodule not analyzed: its contents are external to this repository's graph (register it as its own repository)" });
  const chartDirs = all.filter((p) => /(^|\/)Chart\.yaml$/.test(p)).map((p) => p.slice(0, -"Chart.yaml".length));
  const pipelineGlobs = explicitPipelines.map(globToRegExp);
  const frontendInclude = frontend.include.map(globToRegExp);
  const frontendExclude = frontend.exclude.map(globToRegExp);
  const excludedFrontend = new Map<string, number>();
  const siblings = new Set(all.filter((p) => /\.ts$/i.test(p)).map((p) => p.toLowerCase()));
  const bicepDirs = new Set(all.filter((p) => /\.bicep$/i.test(p)).map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")));
  for (const path of all) {
    const absolutePath = join(root, path);
    let entry;
    try {
      entry = lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (classifyFile(path).category !== "other") skipped.push({ path, reason: "symbolic links are not followed" });
      continue;
    }
    if (entry.isDirectory() && !gitlinks.includes(path)) skipped.push({ path, reason: "nested Git repository not analyzed: its contents are external to this repository's graph" });
    if (!entry.isFile()) continue;
    let { category, language } = classifyFile(path);
    const chartDir = chartDirs.find((dir) => path.startsWith(dir));
    if (chartDir !== undefined && (path.startsWith(`${chartDir}templates/`) || /^values[\w.-]*\.ya?ml$/i.test(path.slice(chartDir.length)))) {
      category = "infrastructure";
      language = path.endsWith(".tpl") ? "helm-template" : "yaml";
    }
    if (category === "other" && /\.(json|ya?ml)$/i.test(path) && !/(^|\/)(package(-lock)?|tsconfig|launchSettings|global|appsettings[\w.-]*)\.json$/i.test(path)) {
      const head = await Bun.file(absolutePath).slice(0, 4096).text().catch(() => "");
      if (/\.json$/i.test(path) && ARM_MARKER.test(head)) {
        category = "infrastructure";
        language = "arm";
      } else if (OPENAPI_MARKER.test(head)) {
        category = "contract";
        language = path.toLowerCase().endsWith(".json") ? "json" : "yaml";
      } else if (/\.ya?ml$/i.test(path) && KUBERNETES_MARKER.test(head)) {
        category = "infrastructure";
        language = "yaml";
      } else if (/\.ya?ml$/i.test(path) && PIPELINE_MARKER.test(head)) {
        category = "pipeline";
        language = "yaml";
      }
    }
    if (/\.ya?ml$/i.test(path) && pipelineGlobs.some((re) => re.test(path))) {
      category = "pipeline";
      language = "yaml";
    }
    if (explicitInfrastructure.includes(path)) {
      category = "infrastructure";
      language = "yaml";
    }
    if (category === "other" && /\.html$/i.test(path) && siblings.has(path.replace(/\.html$/i, ".ts").toLowerCase())) {
      category = "source";
      language = "html";
    }
    if (category === "other" && /\.(json|jsonc|ya?ml|txt|xml)$/i.test(path) && bicepDirs.has(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")) {
      category = "infrastructure";
      language = "bicep-content";
    }
    if (category === "other" && path === "vogoban.json") category = "config";
    if (category === "other" && /^(\.github\/|docs\/|\.gitlab\/)?CODEOWNERS$/.test(path)) category = "config";
    if (explicitContracts.includes(path)) {
      category = "contract";
      language = path.toLowerCase().endsWith(".json") ? "json" : "yaml";
    }
    if (category === "other") continue;
    if (language === "typescript" || language === "javascript" || language === "html") {
      const excluded = frontendExclude.some((re) => re.test(path)) ? "vogoban.json frontend.exclude" : frontendExclusion(path, frontendInclude);
      if (excluded) {
        excludedFrontend.set(excluded, (excludedFrontend.get(excluded) ?? 0) + 1);
        continue;
      }
    }
    let size: number;
    try {
      size = lstatSync(absolutePath).size;
    } catch {
      skipped.push({ path, reason: "unreadable" });
      continue;
    }
    if (size > maxSourceFileBytes()) {
      skipped.push({ path, reason: `FILE_SKIPPED_RESOURCE_LIMIT: file size ${size} bytes exceeds the source limit of ${maxSourceFileBytes()} bytes (VOGOBAN_MAX_SOURCE_FILE_BYTES)` });
      continue;
    }
    const bytes = await Bun.file(absolutePath).bytes();
    const head = new TextDecoder().decode(bytes.subarray(0, 1024));
    files.push({
      path,
      absolutePath,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size,
      category,
      language,
      generated: (language === "csharp" && (GENERATED_PATH.test(path) || /<auto-generated/i.test(head))) || ((language === "typescript" || language === "javascript") && GENERATED_FRONTEND.test(head)),
    });
  }
  for (const [scope, n] of [...excludedFrontend].sort(([a], [b]) => a.localeCompare(b)))
    skipped.push({ path: scope, reason: `frontend build output, bundle or vendored library not analyzed (${n} file${n === 1 ? "" : "s"}); list it in vogoban.json frontend.include to analyze it` });
  log.info("discovery.files", { files: files.length, skipped: skipped.length });
  return { files, skipped };
}
