import { dirname, join } from "node:path";
import { keys } from "../graph/identity.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { DOTNET_PROJECTS, type DotnetProject } from "./artifacts.ts";
import {
  findUpward,
  globToRegExp,
  isUnder,
  msbuildPath,
  parseCentralPackageVersions,
  parseProjectFile,
  parseSolution,
  normalizeTargetFramework,
  readProjectAssets,
  toRepoPath,
} from "./msbuild.ts";

const ID = "dotnet.msbuild";
const VERSION = "1";

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("$("));
}

const IMPLICIT_USINGS: Record<string, string[]> = {
  "Microsoft.NET.Sdk": ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks"],
  "Microsoft.NET.Sdk.Web": [
    "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing",
    "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging",
  ],
  "Microsoft.NET.Sdk.Worker": ["Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging"],
};

function globalUsings(props: Record<string, string>, sdk: string | null, items: { include: string; remove: boolean }[]): string[] {
  const set = new Set<string>();
  if (/^(enable|true)$/i.test(props.ImplicitUsings ?? "")) {
    for (const u of IMPLICIT_USINGS["Microsoft.NET.Sdk"]!) set.add(u);
    for (const u of IMPLICIT_USINGS[sdk ?? ""] ?? []) set.add(u);
  }
  for (const item of items) item.remove ? set.delete(item.include) : set.add(item.include);
  return [...set].sort();
}

export const msbuildPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "workspace",
  async run(ctx: AnalysisContext) {
    const { graph, repository } = ctx;
    const repoId = repository.id;
    const projectFiles = ctx.files.filter((f) => /\.(csproj|fsproj|vbproj)$/i.test(f.path));
    const sourceFiles = ctx.files.filter((f) => f.language === "csharp");
    const projectDirs = projectFiles.map((f) => dirname(f.path)).sort((a, b) => b.length - a.length);
    const prov = (extractor: string, file: string, line = 1) =>
      ctx.provenance({ plugin: ID, extractor, mechanism: "msbuild-static", version: VERSION, location: { file, startLine: line, startColumn: 1 } });

    const projectIdByPath = new Map<string, string>();
    for (const file of projectFiles) projectIdByPath.set(file.path.toLowerCase(), graph.entity({
      key: keys.project(repoId, file.path),
      kind: "Project",
      layer: "repository",
      name: file.path.split("/").pop()!.replace(/\.\w+proj$/i, ""),
      qualifiedName: file.path,
      repositoryId: repoId,
      language: file.path.endsWith(".csproj") ? "csharp" : file.path.endsWith(".fsproj") ? "fsharp" : "vb",
      location: { file: file.path, startLine: 1, startColumn: 1 },
      provenance: prov("project-discovery", file.path),
    }));

    const owningProjectDir = (path: string) => projectDirs.find((dir) => isUnder(dir, path));
    const projects: DotnetProject[] = [];

    for (const file of projectFiles) {
      const projectId = projectIdByPath.get(file.path.toLowerCase())!;
      const dir = dirname(file.path);
      let parsed;
      try {
        parsed = parseProjectFile(await ctx.readText(file.path));
      } catch (error) {
        graph.diagnostic({ repositoryId: repoId, category: "project", plugin: ID, file: file.path, severity: "error", recoverable: true, code: "project-parse-failed", message: String(error) });
        continue;
      }
      const centralPath = findUpward(dir, "Directory.Packages.props", repository.rootPath);
      const buildPropsPath = findUpward(dir, "Directory.Build.props", repository.rootPath);
      const inherited = buildPropsPath ? parseProjectFile(await ctx.readText(buildPropsPath).catch(() => "<Project/>")) : null;
      const centralProps = centralPath ? parseProjectFile(await ctx.readText(centralPath).catch(() => "<Project/>")).properties : {};
      const props: Record<string, string> = { ...centralProps, ...inherited?.properties, ...parsed.properties };
      props.OutputType ??= /Microsoft\.NET\.Sdk\.(Web|Worker|BlazorWebAssembly)$/i.test(parsed.sdk ?? "") ? "Exe" : "Library";
      parsed.packageReferences.push(...(inherited?.packageReferences ?? []));
      parsed.usings.unshift(...(inherited?.usings ?? []));
      const name = file.path.split("/").pop()!.replace(/\.\w+proj$/i, "");
      const assemblyName = props.AssemblyName && !props.AssemblyName.includes("$(") ? props.AssemblyName : name;
      const targetFrameworks = splitList(props.TargetFrameworks ?? props.TargetFramework ?? props.TargetFrameworkVersion).map(normalizeTargetFramework);
      const isWeb = /Microsoft\.NET\.Sdk\.(Web|Razor|BlazorWebAssembly)/i.test(parsed.sdk ?? "") || parsed.frameworkReferences.includes("Microsoft.AspNetCore.App");

      const central = centralPath ? parseCentralPackageVersions(await ctx.readText(centralPath).catch(() => "")) : new Map<string, string>();

      const removes = parsed.compileRemoves.map((g) => globToRegExp(toRepoPath(dir, g)));
      let files: string[];
      if (parsed.sdkStyle && props.EnableDefaultCompileItems !== "false") {
        files = sourceFiles.filter((f) => owningProjectDir(f.path) === dir).map((f) => f.path);
      } else {
        files = [];
      }
      for (const include of parsed.compileIncludes) {
        const pattern = globToRegExp(toRepoPath(dir, include));
        for (const f of sourceFiles) if (pattern.test(f.path)) files.push(f.path);
      }
      files = [...new Set(files)].filter((f) => !removes.some((r) => r.test(f))).sort();

      const assemblyEntityId = graph.entity({
        key: keys.assembly(repoId, assemblyName),
        kind: "Assembly",
        layer: "repository",
        name: assemblyName,
        qualifiedName: assemblyName,
        repositoryId: repoId,
        projectId,
        assembly: assemblyName,
        language: "dotnet",
        metadata: { outputType: props.OutputType },
        provenance: prov("assembly-identity", file.path),
      });
      graph.entity({
        key: keys.project(repoId, file.path),
        kind: "Project",
        layer: "repository",
        name,
        qualifiedName: file.path,
        repositoryId: repoId,
        projectId,
        assembly: assemblyName,
        language: "csharp",
        location: { file: file.path, startLine: 1, startColumn: 1 },
        metadata: {
          sdk: parsed.sdk,
          sdkStyle: parsed.sdkStyle,
          targetFrameworks,
          outputType: props.OutputType,
          assemblyName,
          rootNamespace: props.RootNamespace ?? assemblyName,
          isWeb,
          isTestProject: props.IsTestProject === "true",
          isPackable: props.IsPackable !== "false",
          packageId: props.PackageId ?? null,
          sourceFiles: files.length,
        },
        provenance: prov("project-properties", file.path),
      });
      graph.relate({ type: "PROJECT_CONTAINS", sourceId: ctx.repositoryEntityId, targetId: projectId, repositoryId: repoId, evidence: "EXACT", provenance: prov("project-discovery", file.path) });
      graph.relate({ type: "DEFINES_ASSEMBLY", sourceId: projectId, targetId: assemblyEntityId, repositoryId: repoId, evidence: "DECLARED", provenance: prov("assembly-identity", file.path) });
      const projectFileEntity = ctx.fileEntityId(file.path);
      if (projectFileEntity) graph.relate({ type: "DECLARES", sourceId: projectFileEntity, targetId: projectId, repositoryId: repoId, evidence: "EXACT", provenance: prov("project-discovery", file.path) });
      for (const f of files) {
        const fileId = ctx.fileEntityId(f);
        if (fileId) {
          graph.relate({ type: "PROJECT_CONTAINS", sourceId: projectId, targetId: fileId, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { rule: parsed.sdkStyle ? "sdk-default-compile-items" : "explicit-compile-items" }, provenance: prov("compile-items", file.path) });
          graph.relate({ type: "ASSEMBLY_CONTAINS", sourceId: assemblyEntityId, targetId: fileId, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", provenance: prov("compile-items", file.path) });
        }
      }

      const projectReferences: string[] = [];
      for (const ref of parsed.projectReferences) {
        const target = toRepoPath(dir, ref.include);
        const targetId = projectIdByPath.get(target.toLowerCase());
        if (targetId) {
          projectReferences.push(targetId);
          graph.relate({ type: "PROJECT_REFERENCES", sourceId: projectId, targetId, repositoryId: repoId, evidence: "DECLARED", metadata: { include: ref.include }, provenance: prov("project-reference", file.path, ref.line) });
        } else {
          graph.unresolved({
            type: "PROJECT_REFERENCES", sourceId: projectId, repositoryId: repoId, targetDisplay: target, resolver: ID,
            reason: "referenced project file is not part of this repository", metadata: { category: "missing-project" }, provenance: prov("project-reference", file.path, ref.line),
          });
        }
      }

      const absoluteDir = join(repository.rootPath, dir);
      const assetsByFramework = new Map((targetFrameworks.length ? targetFrameworks : [null]).map((tfm) => [tfm, readProjectAssets(absoluteDir, tfm)] as const));
      const assets = [...assetsByFramework.values()].find((a) => a) ?? null;
      const packages: DotnetProject["packages"] = [];
      for (const pkg of parsed.packageReferences) {
        const declared = pkg.version ?? central.get(pkg.name.toLowerCase()) ?? null;
        const version = declared && !declared.includes("$(") ? declared : null;
        packages.push({ name: pkg.name, version });
        const packageId = graph.entity({
          key: keys.package("nuget", pkg.name),
          kind: "Package",
          layer: "repository",
          name: pkg.name,
          qualifiedName: `nuget:${pkg.name}`,
          repositoryId: null,
          language: "dotnet",
          external: true,
          metadata: { ecosystem: "nuget" },
          provenance: prov("package-reference", file.path, pkg.line),
        });
        graph.relate({
          type: "PACKAGE_DEPENDS_ON", sourceId: projectId, targetId: packageId, repositoryId: repoId, evidence: "DECLARED",
          metadata: { version, direct: true, versionSource: pkg.version ? "project" : version ? "central" : "unspecified" },
          provenance: prov("package-reference", file.path, pkg.line),
        });
      }
      for (const pkg of assets?.packages ?? []) {
        if (pkg.direct) continue;
        const packageId = graph.entity({
          key: keys.package("nuget", pkg.name), kind: "Package", layer: "repository", name: pkg.name, qualifiedName: `nuget:${pkg.name}`,
          repositoryId: null, language: "dotnet", external: true, metadata: { ecosystem: "nuget" },
          provenance: ctx.provenance({ plugin: ID, extractor: "project-assets", mechanism: "nuget-restore-output", version: VERSION, location: { file: `${dir}/obj/project.assets.json`, startLine: 1, startColumn: 1 } }),
        });
        graph.relate({
          type: "PACKAGE_DEPENDS_ON", sourceId: projectId, targetId: packageId, repositoryId: repoId, evidence: "EXACT",
          metadata: { version: pkg.version, direct: false },
          provenance: ctx.provenance({ plugin: ID, extractor: "project-assets", mechanism: "nuget-restore-output", version: VERSION, location: { file: `${dir}/obj/project.assets.json`, startLine: 1, startColumn: 1 } }),
        });
      }

      const hintPaths: string[] = [];
      for (const ref of parsed.assemblyReferences) {
        const external = graph.entity({
          key: keys.assembly(null, ref.name), kind: "Assembly", layer: "repository", name: ref.name, qualifiedName: ref.name,
          repositoryId: null, assembly: ref.name, language: "dotnet", external: true, provenance: prov("assembly-reference", file.path, ref.line),
        });
        graph.relate({ type: "ASSEMBLY_REFERENCES", sourceId: projectId, targetId: external, repositoryId: repoId, evidence: "DECLARED", metadata: { hintPath: ref.hintPath }, provenance: prov("assembly-reference", file.path, ref.line) });
        if (ref.hintPath) hintPaths.push(join(absoluteDir, ref.hintPath));
      }

      projects.push({
        entityId: projectId,
        path: file.path,
        dir,
        name,
        assemblyName,
        assemblyEntityId,
        rootNamespace: props.RootNamespace ?? assemblyName,
        targetFrameworks,
        sdk: parsed.sdk,
        outputType: props.OutputType,
        isWeb,
        sourceFiles: files,
        razorComponents: ctx.files
          .filter((f) => f.language === "razor" && f.path.endsWith(".razor") && owningProjectDir(f.path) === dir)
          .map((f) => f.path.split("/").pop()!.replace(/\.razor$/, ""))
          .sort(),
        projectReferences,
        packages,
        frameworks: [...assetsByFramework].flatMap(([tfm, frameworkAssets]) =>
          tfm ? [{ targetFramework: tfm, referencePaths: [...(frameworkAssets?.compileReferences ?? []), ...hintPaths], restored: frameworkAssets !== null }] : [],
        ),
        frameworkReferences: [...new Set([...(isWeb ? ["Microsoft.AspNetCore.App"] : []), ...parsed.frameworkReferences])],
        defineConstants: splitList(props.DefineConstants),
        globalUsings: globalUsings(props, parsed.sdk, parsed.usings),
        langVersion: props.LangVersion ?? null,
        nullable: props.Nullable ?? null,
      });
    }

    const owned = new Set(projects.flatMap((p) => p.sourceFiles));
    const orphans = sourceFiles.filter((f) => !owned.has(f.path));
    if (orphans.length) {
      graph.diagnostic({
        repositoryId: repoId, category: "discovery", plugin: ID, file: null, severity: "info", recoverable: true, code: "orphan-sources",
        message: `${orphans.length} C# files are not owned by any project (e.g. ${orphans.slice(0, 3).map((f) => f.path).join(", ")})`,
      });
    }

    for (const sln of ctx.files.filter((f) => f.category === "solution" && !f.path.endsWith(".slnf"))) {
      const solutionId = graph.entity({
        key: `solution|${repoId}|${sln.path}`, kind: "Solution", layer: "repository", name: sln.path.split("/").pop()!, qualifiedName: sln.path,
        repositoryId: repoId, location: { file: sln.path, startLine: 1, startColumn: 1 }, provenance: prov("solution", sln.path),
      });
      graph.relate({ type: "CONTAINS", sourceId: ctx.repositoryEntityId, targetId: solutionId, repositoryId: repoId, evidence: "EXACT", provenance: prov("solution", sln.path) });
      for (const entry of parseSolution(await ctx.readText(sln.path), sln.path)) {
        const projectId = projectIdByPath.get(entry.path.toLowerCase());
        if (projectId) graph.relate({ type: "CONTAINS", sourceId: solutionId, targetId: projectId, repositoryId: repoId, evidence: "DECLARED", provenance: prov("solution", sln.path, entry.line) });
        else graph.unresolved({ type: "CONTAINS", sourceId: solutionId, repositoryId: repoId, targetDisplay: msbuildPath(entry.path), resolver: ID, reason: "solution entry not found in repository", metadata: { category: "missing-project" }, provenance: prov("solution", sln.path, entry.line) });
      }
    }

    projects.sort((a, b) => a.path.localeCompare(b.path));
    ctx.artifacts.set(DOTNET_PROJECTS, projects);
    ctx.log.info("dotnet.projects", { projects: projects.length, solutions: ctx.files.filter((f) => f.category === "solution").length });
  },
};
