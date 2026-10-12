import type { EvidenceLevel } from "../../graph/model.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../../plugins/types.ts";
import type { DotnetProject } from "../artifacts.ts";
import type { FactLocation } from "../semantic-facts.ts";
import { functionDeclaration } from "../../azure/function-attributes.ts";
import { entityIdOf, frameworkFailure, frameworkProvenance, locationKey, relate, semanticIndex, type SemanticIndex } from "./shared.ts";

const ID = "dotnet.applications";
const VERSION = "2";

export type ApplicationKind = "aspnetcore" | "generic-host" | "blazor-webassembly" | "azure-functions";

export interface ApplicationModel {
  entityId: string;
  project: DotnetProject;
  kind: ApplicationKind;
  entryPoints: string[];
  reachable: Set<string>;
  signals: string[];
}

export interface ApplicationIndex {
  applications: ApplicationModel[];
  byProject: Map<string, ApplicationModel>;
  owners(callerKey: string, project: DotnetProject): { app: ApplicationModel; evidence: EvidenceLevel; attribution: string }[];
}

export const APPLICATIONS = artifactKey<ApplicationIndex>("dotnet.applications");

interface BuilderSignal {
  owner: string;
  methods: RegExp;
  kind: ApplicationKind;
  label: string;
}

const BUILDER_SIGNALS: BuilderSignal[] = [
  { owner: "Microsoft.AspNetCore.Builder.WebApplication", methods: /^(CreateBuilder|CreateSlimBuilder|CreateEmptyBuilder|Create)$/, kind: "aspnetcore", label: "WebApplication builder" },
  { owner: "Microsoft.AspNetCore.WebHost", methods: /^(CreateDefaultBuilder|CreateSlimBuilder|Start)$/, kind: "aspnetcore", label: "WebHost builder" },
  { owner: "Microsoft.Extensions.Hosting.GenericHostBuilderExtensions", methods: /^ConfigureWebHostDefaults$/, kind: "aspnetcore", label: "ConfigureWebHostDefaults" },
  { owner: "Microsoft.Extensions.Hosting.GenericHostWebHostBuilderExtensions", methods: /^ConfigureWebHost$/, kind: "aspnetcore", label: "ConfigureWebHost" },
  { owner: "Microsoft.AspNetCore.Components.WebAssembly.Hosting.WebAssemblyHostBuilder", methods: /^CreateDefault$/, kind: "blazor-webassembly", label: "WebAssemblyHostBuilder" },
  { owner: "Microsoft.Azure.Functions.Worker.Builder.FunctionsApplication", methods: /^CreateBuilder$/, kind: "azure-functions", label: "Functions application builder" },
  { owner: "Microsoft.Extensions.Hosting.WorkerHostBuilderExtensions", methods: /^(ConfigureFunctionsWorkerDefaults|ConfigureFunctionsWebApplication)$/, kind: "azure-functions", label: "Functions worker host" },
  { owner: "Microsoft.Azure.Functions.Worker.Builder.FunctionsApplicationBuilderAspNetCoreExtensions", methods: /^ConfigureFunctionsWebApplication$/, kind: "azure-functions", label: "Functions ASP.NET Core integration" },
  { owner: "Microsoft.Extensions.Hosting.FunctionsHostBuilderExtensions", methods: /^ConfigureFunctionsWebApplication$/, kind: "azure-functions", label: "Functions ASP.NET Core integration" },
  { owner: "Microsoft.Extensions.Hosting.Host", methods: /^(CreateApplicationBuilder|CreateDefaultBuilder|CreateEmptyApplicationBuilder)$/, kind: "generic-host", label: "Host builder" },
];

const KIND_RANK: Record<ApplicationKind, number> = { "azure-functions": -1, aspnetcore: 0, "blazor-webassembly": 1, "generic-host": 2 };

const TEST_PACKAGES = /^(Microsoft\.NET\.Test\.Sdk|xunit(\..*)?|MSTest(\..*)?|NUnit(\..*)?|Microsoft\.Testing\.Platform.*|TUnit.*)$/i;

function isTestProject(project: DotnetProject): boolean {
  return /test/i.test(project.sdk ?? "") || project.packages.some((p) => TEST_PACKAGES.test(p.name));
}

function reachableFrom(index: SemanticIndex, entryPoints: string[]): Set<string> {
  const seen = new Set(entryPoints);
  const queue = [...entryPoints];
  while (queue.length) {
    const next = queue.pop()!;
    for (const target of index.calls.get(next) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

function referencesTransitively(projects: Map<string, DotnetProject>, from: DotnetProject, to: DotnetProject): boolean {
  const seen = new Set<string>();
  const stack = [...from.projectReferences];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to.entityId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(projects.get(id)?.projectReferences ?? []));
  }
  return false;
}

export const applicationsPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    const empty: ApplicationIndex = { applications: [], byProject: new Map(), owners: () => [] };
    if (!index) {
      ctx.artifacts.set(APPLICATIONS, empty);
      return;
    }
    try {
      const candidates = new Map<string, { project: DotnetProject; kinds: Set<ApplicationKind>; entryPoints: Set<string>; signals: Set<string>; locations: FactLocation[] }>();
      const candidate = (project: DotnetProject) => {
        const existing = candidates.get(project.entityId);
        if (existing) return existing;
        const created = { project, kinds: new Set<ApplicationKind>(), entryPoints: new Set<string>(), signals: new Set<string>(), locations: [] as FactLocation[] };
        candidates.set(project.entityId, created);
        return created;
      };
      for (const { invocation, project, owner, method } of index.invocations) {
        const signal = BUILDER_SIGNALS.find((s) => s.owner === owner && s.methods.test(method));
        if (signal) {
          const c = candidate(project);
          c.kinds.add(signal.kind);
          c.entryPoints.add(invocation.caller);
          c.signals.add(`${signal.label} (${owner}.${method})`);
          c.locations.push(invocation.location);
          continue;
        }
        if (method === "UseStartup") {
          const startup = invocation.typeArguments[0] ?? invocation.arguments.find((a) => a.kind === "type")?.type;
          if (!startup) continue;
          const c = candidate(project);
          c.signals.add(`UseStartup<${startup.qualifiedName}>`);
          for (const m of index.members.get(startup.key) ?? []) {
            if (m.kind === "Method" && /^(ConfigureServices|Configure)(\w*)$/.test(m.name)) c.entryPoints.add(m.key);
          }
        }
      }

      for (const f of index.facts) {
        const project = index.projects.get(f.projectId);
        if (!project) continue;
        for (const s of f.symbols) {
          const declared = functionDeclaration(s);
          const startup = s.kind === "Method" && s.name === "Configure" && s.containerKey && index.symbols.get(s.containerKey)?.symbol.baseTypeChain.includes("Microsoft.Azure.Functions.Extensions.DependencyInjection.FunctionsStartup");
          if (!declared && !startup) continue;
          const c = candidate(project);
          c.kinds.add("azure-functions");
          c.entryPoints.add(s.key);
          c.signals.add(declared ? `Azure Functions ${declared.model === "in-process" ? "[FunctionName]" : "[Function]"} methods` : "FunctionsStartup.Configure");
          if (s.location) c.locations.push(s.location);
        }
      }

      const applications: ApplicationModel[] = [];
      for (const c of [...candidates.values()].sort((a, b) => a.project.path.localeCompare(b.project.path))) {
        if (c.kinds.size === 0) continue;
        if (isTestProject(c.project)) {
          ctx.log.info("applications.skipped-test-project", { project: c.project.name, signals: [...c.signals] });
          continue;
        }
        const kind = [...c.kinds].sort((a, b) => KIND_RANK[a] - KIND_RANK[b])[0]!;
        if (c.project.isWeb) c.signals.add(`SDK ${c.project.sdk ?? "Microsoft.AspNetCore.App framework reference"}`);
        if (c.project.outputType.toLowerCase().endsWith("exe")) c.signals.add(`OutputType ${c.project.outputType}`);
        const entryPoints = [...c.entryPoints].sort();
        const evidence: EvidenceLevel = kind === "aspnetcore" && !c.project.isWeb ? "STRUCTURALLY_RESOLVED" : "COMPILER_RESOLVED";
        const location = c.locations.sort((a, b) => locationKey(a).localeCompare(locationKey(b)))[0];
        const prov = frameworkProvenance(ctx, ID, kind === "generic-host" ? "GENERIC_HOST_BUILDER" : kind === "azure-functions" ? "AZURE_FUNCTIONS_HOST" : "ASPNETCORE_HOST_BUILDER", VERSION, location);
        const entityId = ctx.graph.entity({
          key: `application|${ctx.repository.id}|${c.project.path}`,
          kind: "Application",
          layer: "application",
          name: c.project.name,
          qualifiedName: `${c.project.name} (${kind})`,
          repositoryId: ctx.repository.id,
          projectId: c.project.entityId,
          assembly: c.project.assemblyName,
          language: "csharp",
          location: location ? { file: location.file, startLine: location.line, startColumn: location.column } : null,
          metadata: { applicationKind: kind, signals: [...c.signals].sort(), entryPoints },
          provenance: prov,
        });
        relate(ctx, "DEFINES_APPLICATION", c.project.entityId, entityId, evidence, prov, { signals: [...c.signals].sort() });
        for (const entry of entryPoints) {
          if (index.symbols.has(entry)) relate(ctx, "IMPLEMENTED_BY", entityId, entityIdOf(ctx, entry), "COMPILER_RESOLVED", prov, { role: "entry-point" });
        }
        applications.push({ entityId, project: c.project, kind, entryPoints, reachable: reachableFrom(index, entryPoints), signals: [...c.signals].sort() });
      }

      const byProject = new Map(applications.map((a) => [a.project.entityId, a]));
      const ownerCache = new Map<string, ReturnType<ApplicationIndex["owners"]>>();
      const owners: ApplicationIndex["owners"] = (callerKey, project) => {
        const cacheKey = `${callerKey}|${project.entityId}`;
        const cached = ownerCache.get(cacheKey);
        if (cached) return cached;
        let result: ReturnType<ApplicationIndex["owners"]> = applications
          .filter((a) => a.reachable.has(callerKey))
          .map((app) => ({ app, evidence: "STRUCTURALLY_RESOLVED" as EvidenceLevel, attribution: "reachable-from-entry-point" }));
        if (!result.length && byProject.has(project.entityId)) {
          result = [{ app: byProject.get(project.entityId)!, evidence: "INFERRED", attribution: "same-project" }];
        }
        if (!result.length) {
          result = applications
            .filter((a) => referencesTransitively(index.projects, a.project, project))
            .map((app) => ({ app, evidence: "INFERRED" as EvidenceLevel, attribution: "referenced-project" }));
        }
        ownerCache.set(cacheKey, result);
        return result;
      };
      ctx.artifacts.set(APPLICATIONS, { applications, byProject, owners });
      ctx.log.info("applications.detected", { applications: applications.length, kinds: applications.map((a) => `${a.project.name}:${a.kind}`) });
    } catch (error) {
      frameworkFailure(ctx, ID, "framework-detection-failed", error);
      ctx.artifacts.set(APPLICATIONS, empty);
    }
  },
};
