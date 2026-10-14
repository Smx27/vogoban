import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashOf } from "../graph/identity.ts";
import { isSecretName, redactSecretText } from "../infrastructure/common.ts";
import { fileExclusionMatcher, maxSourceFileBytes } from "../pipeline/discovery.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { DOTNET_PROJECTS, DOTNET_SEMANTIC, type DotnetProject } from "./artifacts.ts";
import type { SemanticProjectFacts } from "./semantic-facts.ts";
import { emitSemanticGraph } from "./semantic-graph.ts";
import { emitSyntaxGraph } from "./syntax-graph.ts";

const ID = "dotnet.roslyn";
const VERSION = "1";
const TOOL_DIR = join(import.meta.dir, "..", "..", "semantic", "Vogoban.Roslyn");
const TOOL_DLL = join(TOOL_DIR, "bin", "Release", "net8.0", "Vogoban.Roslyn.dll");

export interface SemanticBackend {
  readonly id: string;
  readonly version: string;
  available(ctx: AnalysisContext): Promise<string | null>;
  analyze(ctx: AnalysisContext, projects: DotnetProject[]): Promise<SemanticProjectFacts[]>;
}

function findDotnet(): string | null {
  const candidates = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(homedir(), ".dotnet", "dotnet")];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

function toolSourceHash(): string {
  const sources = readdirSync(TOOL_DIR).filter((f) => f.endsWith(".cs") || f.endsWith(".csproj")).sort();
  return hashOf(...sources.map((f) => readFileSync(join(TOOL_DIR, f), "utf8"))).slice(0, 16);
}

export const roslynBackend: SemanticBackend = {
  id: "roslyn-process",
  version: toolSourceHash(),
  async available(ctx) {
    const dotnet = findDotnet();
    if (!dotnet) return "dotnet SDK not found (set VOGOBAN_DOTNET or add dotnet to PATH)";
    const stamp = join(TOOL_DIR, "bin", ".source-hash");
    if (existsSync(TOOL_DLL) && existsSync(stamp) && readFileSync(stamp, "utf8") === this.version) return null;
    ctx.log.info("semantic.build-analyzer", { dir: TOOL_DIR });
    const build = Bun.spawnSync([dotnet, "build", TOOL_DIR, "-c", "Release", "--nologo", "-v", "q"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
    });
    if (build.exitCode !== 0) return `Roslyn analyzer build failed: ${build.stdout.toString().split("\n").filter((l) => l.includes("error")).slice(0, 3).join(" | ")}`;
    await Bun.write(stamp, this.version);
    return null;
  },
  async analyze(ctx, projects) {
    const dotnet = findDotnet()!;
    const request = {
      repositoryRoot: ctx.repository.rootPath,
      maxSourceFileBytes: maxSourceFileBytes(),
      excludedSourcePatterns: fileExclusionMatcher(ctx.options.exclusions ?? []).patterns,
      projects: projects.map((p) => ({
        id: p.entityId,
        name: p.name,
        projectPath: p.path,
        assemblyName: p.assemblyName,
        directory: p.dir,
        files: p.sourceFiles,
        projectReferences: p.projectReferences,
        frameworks: p.frameworks.map((f) => ({ targetFramework: f.targetFramework, referencePaths: f.referencePaths })),
        frameworkReferences: p.frameworkReferences,
        globalUsings: p.globalUsings,
        defineConstants: p.defineConstants,
        nullable: p.nullable,
        outputType: p.outputType,
        generatedSources: aspireProjectMetadata(p, projects),
      })),
    };
    const proc = Bun.spawn([dotnet, TOOL_DLL], {
      stdin: new Blob([JSON.stringify(request)]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_gcServer: "0" },
    });
    const stderr = (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of proc.stderr) {
        buffered += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          try {
            const { event, ...fields } = JSON.parse(line) as { event: string };
            ctx.log.info(event, fields);
          } catch {
            ctx.log.warn("semantic.stderr", { line: line.slice(0, 300) });
          }
        }
      }
    })();
    const text = await new Response(proc.stdout).text();
    await stderr;
    const code = await proc.exited;
    const results = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SemanticProjectFacts);
    if (code !== 0 && results.length < projects.length) throw new Error(`Roslyn analyzer exited with code ${code}`);
    return results;
  },
};

function projectCacheKeys(ctx: AnalysisContext, projects: DotnetProject[], backendVersion: string): Map<string, string> {
  const fileHash = new Map(ctx.files.map((f) => [f.path, f.hash]));
  const skippedUnder = (dir: string) => ctx.skippedFiles.filter((s) => s.path === dir || s.path.startsWith(`${dir}/`)).map((s) => `skipped:${s.path}:${s.reason}`).sort();
  const byId = new Map(projects.map((p) => [p.entityId, p]));
  const keysById = new Map<string, string>();
  const visiting = new Set<string>();
  const compute = (p: DotnetProject): string => {
    const known = keysById.get(p.entityId);
    if (known) return known;
    if (visiting.has(p.entityId)) return "cycle";
    visiting.add(p.entityId);
    const deps = p.projectReferences.map((id) => byId.get(id)).filter((d): d is DotnetProject => !!d).map(compute);
    const key = hashOf(
      VERSION,
      backendVersion,
      `msbuild-evaluation=${process.env.VOGOBAN_MSBUILD_EVALUATION === "0" ? "off" : "on"}`,
      `max-source-file-bytes=${maxSourceFileBytes()}`,
      JSON.stringify(ctx.options.exclusions ?? []),
      JSON.stringify({ ...p, sourceFiles: undefined }),
      JSON.stringify(aspireProjectMetadata(p, projects) ?? null),
      ...p.sourceFiles.map((f) => `${f}:${fileHash.get(f)}`),
      ...skippedUnder(p.dir),
      ...p.frameworks.flatMap((f) => [f.targetFramework, ...f.referencePaths]),
      ...deps,
    );
    keysById.set(p.entityId, key);
    return key;
  };
  for (const p of projects) compute(p);
  return keysById;
}

/** Parameters of SDK/credential constructors whose argument is always secret material, whatever its shape. */
const SECRET_PARAMETER = /^(authKey\w*|accountKey|sharedAccessKey|sharedAccessSignature|signature|sas\w*|clientSecret|secret\w*|password|pwd|token|accessToken|apiKey|certificatePassword)$/i;
/** Generic names are secret only as arguments of cloud SDK / credential constructors (elsewhere they are configuration, dictionary or partition keys). */
const CLOUD_SDK_SECRET_PARAMETER = /^(key|credential|keyValue|primaryKey|secondaryKey|namedKey)$/i;
const CLOUD_SDK_TYPE = /^(Azure\.|Microsoft\.Azure\.|Microsoft\.Extensions\.Azure\.|Microsoft\.Data\.SqlClient)/;
const cloudSdkTarget = (ref: unknown): boolean => {
  const r = ref as { qualifiedName?: string; containingType?: { qualifiedName?: string } } | undefined;
  return !!r && CLOUD_SDK_TYPE.test(r.containingType?.qualifiedName ?? r.qualifiedName ?? "");
};

/**
 * Aspire AppHost projects compile against `Projects.<Name>` metadata types that the Aspire SDK generates from the
 * AppHost's ProjectReferences at build time. Vogoban does not run builds, so it supplies the same deterministic
 * declarations (name, project path) to the compilation.
 */
export function aspireProjectMetadata(p: DotnetProject, all: DotnetProject[]): string[] | undefined {
  if (!/Aspire\.AppHost\.Sdk/i.test(p.sdk ?? "") && !p.packages.some((x) => /^Aspire\.Hosting\.AppHost$/i.test(x.name))) return undefined;
  const byId = new Map(all.map((x) => [x.entityId, x]));
  const refs = p.projectReferences.map((id) => byId.get(id)).filter((x): x is DotnetProject => !!x).sort((a, b) => a.name.localeCompare(b.name));
  if (!refs.length) return undefined;
  const classes = refs.map((r) => `  public class ${r.name.replace(/[^A-Za-z0-9_]/g, "_")} : global::Aspire.Hosting.IProjectMetadata { public string ProjectPath => @"${r.path.replace(/"/g, '""')}"; }`);
  return [`namespace Projects\n{\n${classes.join("\n")}\n}`];
}

export function redactSecretValues(facts: unknown): boolean {
  let changed = false;
  const walk = (node: unknown, cloudSdk = false) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, cloudSdk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.target || o.invocationTarget) cloudSdk = cloudSdkTarget(o.target ?? o.invocationTarget);
    if (typeof o.kind === "string" && (o.symbol || (o.kind === "new" && o.type))) cloudSdk = cloudSdkTarget(o.symbol ?? o.type);
    if ((o.kind === "string" || o.kind === "template") && typeof o.value === "string") {
      const parameter = String(o.parameter ?? o.name ?? "");
      if (o.kind === "string" && (isSecretName(parameter) || SECRET_PARAMETER.test(parameter) || (cloudSdk && CLOUD_SDK_SECRET_PARAMETER.test(parameter)) || redactSecretText(o.value) === "[redacted]")) {
        delete o.value;
        o.redacted = true;
        changed = true;
      } else {
        const safe = redactSecretText(o.value);
        if (safe !== o.value) {
          o.value = safe;
          o.redacted = true;
          changed = true;
        }
      }
    }
    if (typeof o.expression === "string" && o.expression !== (o.expression = redactSecretText(o.expression))) changed = true;
    if (typeof o.message === "string" && o.message !== (o.message = redactSecretText(o.message))) changed = true;
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, cloudSdk);
  };
  walk(facts);
  return changed;
}

export function createRoslynPlugin(backend: SemanticBackend = roslynBackend): AnalysisPlugin {
  return {
    id: ID,
    version: `${VERSION}+${backend.version}`,
    category: "semantic",
    async run(ctx: AnalysisContext) {
      const projects = (ctx.artifacts.get(DOTNET_PROJECTS) ?? []).filter((p) => p.path.endsWith(".csproj"));
      if (projects.length === 0) return;
      const unavailable = ctx.options.semantic ? await backend.available(ctx) : "semantic analysis disabled by option";
      const results = new Map<string, SemanticProjectFacts>();

      if (!unavailable) {
        const cacheKeys = projectCacheKeys(ctx, projects, backend.version);
        const scope = (p: DotnetProject) => `semantic|${ctx.repository.id}|${p.entityId}`;
        const misses = new Set<string>();
        for (const p of projects) {
          const hit = ctx.cache.get(scope(p), cacheKeys.get(p.entityId)!);
          if (hit) {
            const facts = JSON.parse(hit) as SemanticProjectFacts;
            if (redactSecretValues(facts)) ctx.cache.put(scope(p), cacheKeys.get(p.entityId)!, JSON.stringify(facts));
            results.set(p.entityId, facts);
          }
          else misses.add(p.entityId);
        }
        ctx.log.info("semantic.cache", { hits: results.size, misses: misses.size });
        if (misses.size) {
          const byId = new Map(projects.map((p) => [p.entityId, p]));
          const needed = new Set<string>();
          const include = (id: string) => {
            if (needed.has(id) || !byId.has(id)) return;
            needed.add(id);
            byId.get(id)!.projectReferences.forEach(include);
          };
          misses.forEach(include);
          const analyzed = await backend.analyze(ctx, projects.filter((p) => needed.has(p.entityId)));
          for (const facts of analyzed) {
            redactSecretValues(facts);
            results.set(facts.projectId, facts);
            const project = byId.get(facts.projectId);
            if (project && facts.success) ctx.cache.put(scope(project), cacheKeys.get(project.entityId)!, JSON.stringify(facts));
          }
        }
      } else {
        ctx.graph.diagnostic({
          repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: null, severity: "warning", recoverable: true,
          code: "semantic-unavailable", message: `${unavailable}; falling back to syntax-only declarations`,
        });
      }

      const semantic: SemanticProjectFacts[] = [];
      for (const project of projects) {
        const facts = results.get(project.entityId);
        for (const s of facts?.skippedSources ?? []) {
          ctx.graph.diagnostic({
            repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: s.file, severity: "warning", recoverable: true,
            code: s.code === "FILE_SKIPPED_RESOURCE_LIMIT" ? "FILE_SKIPPED_RESOURCE_LIMIT" : "source-rejected", message: `${s.code}: ${s.reason}; the file was not read`,
          });
        }
        if (facts?.success) {
          semantic.push(facts);
          emitSemanticGraph(ctx, project, facts, `${VERSION}+${backend.version}`);
          continue;
        }
        if (facts?.error) {
          ctx.graph.diagnostic({
            repositoryId: ctx.repository.id, category: "semantic", plugin: ID, file: project.path, severity: "error", recoverable: true,
            code: "semantic-project-failed", message: facts.error,
          });
        }
        emitSyntaxGraph(ctx, project);
      }
      ctx.artifacts.set(DOTNET_SEMANTIC, semantic);
    },
  };
}
