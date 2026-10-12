import { DOTNET_PROJECTS, type DotnetProject } from "../dotnet/artifacts.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { globToRegExp } from "../dotnet/msbuild.ts";
import { ids } from "../graph/identity.ts";
import type { EvidenceLevel, Metadata, Provenance } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import {
  DOCKER_FACTS,
  KUBERNETES_FACTS,
  KUBERNETES_INPUT,
  PIPELINE_FACTS,
  dirOf,
  environmentEntity,
  imageEntity,
  infraEntity,
  infraProvenance,
  infraRelate,
  infraUnresolved,
  joinPath,
  type DockerfileRecord,
  type KubernetesFacts,
  type ImageReference,
  type ServiceRecord,
  type WorkloadRecord,
} from "./common.ts";
import { assembliesFromCommand, containerPath, type DockerStageFacts } from "./dockerfile.ts";
import { configurationReferenceIndex, referencesForVariable } from "./resolver-shared.ts";

const ID = "infrastructure.resolver";
const VERSION = "1";

interface ImageLink {
  projects: Set<string>;
  applications: Set<string>;
  dockerfiles: Set<string>;
}

export const infrastructureResolverPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "resolver",
  async run(ctx: AnalysisContext) {
    const docker = ctx.artifacts.get(DOCKER_FACTS) ?? { dockerfiles: [], compose: [] };
    const pipelines = ctx.artifacts.get(PIPELINE_FACTS) ?? { dockerBuilds: [], dotnet: [], publishes: [], deploys: [], copies: [], downloads: [] };
    const kube = ctx.artifacts.get(KUBERNETES_FACTS) ?? { workloads: [], services: [], ingresses: [], named: [], environmentVariables: [] };
    const charts = ctx.artifacts.get(KUBERNETES_INPUT)?.charts ?? [];
    const projects = ctx.artifacts.get(DOTNET_PROJECTS) ?? [];
    const apps = ctx.artifacts.get(APPLICATIONS);
    const repoId = ctx.repository.id;
    const prov = (extractor: string, file: string | null, line = 1) => infraProvenance(ctx, ID, VERSION, extractor, "infrastructure-resolution", file, line, ID);
    const relate = (type: Parameters<typeof infraRelate>[1], s: string, t: string, p: Provenance, metadata: Metadata = {}, evidence: EvidenceLevel = "STRUCTURALLY_RESOLVED", confidence = 1) => infraRelate(ctx, type, s, t, p, metadata, evidence, confidence);

    const projectByPath = new Map(projects.map((p) => [p.path.toLowerCase(), p]));
    const projectsByDir = new Map<string, DotnetProject[]>();
    const projectsByAssembly = new Map<string, DotnetProject[]>();
    for (const p of projects) {
      projectsByDir.set(p.dir.toLowerCase(), [...(projectsByDir.get(p.dir.toLowerCase()) ?? []), p]);
      projectsByAssembly.set(p.assemblyName.toLowerCase(), [...(projectsByAssembly.get(p.assemblyName.toLowerCase()) ?? []), p]);
    }
    const appOf = (p: DotnetProject) => apps?.byProject.get(p.entityId)?.entityId ?? null;
    const solutionProjects = new Map<string, string[]>();
    for (const r of ctx.graph.allRelationships()) {
      if (r.type !== "CONTAINS") continue;
      const source = ctx.graph.get(r.sourceId);
      if (source?.kind !== "Solution") continue;
      solutionProjects.set(source.qualifiedName!, [...(solutionProjects.get(source.qualifiedName!) ?? []), r.targetId]);
    }
    const projectById = new Map(projects.map((p) => [p.entityId, p]));
    const knownFiles = new Set(ctx.files.map((f) => f.path.toLowerCase()));

    const dockerfileByPath = new Map(docker.dockerfiles.map((d) => [d.path, d]));
    const contexts = new Map<string, { context: string; basis: string }[]>();
    const builtImages = new Map<string, { imageId: string; image: ImageReference | null }[]>();
    const addContext = (path: string, context: string | null, basis: string) => {
      if (context === null || context.startsWith("<")) return;
      const list = contexts.get(path) ?? [];
      if (!list.some((c) => c.context === context)) list.push({ context, basis });
      contexts.set(path, list);
    };
    const addBuilt = (path: string, imageId: string, image: ImageReference | null) => {
      const list = builtImages.get(path) ?? [];
      if (!list.some((i) => i.imageId === imageId)) list.push({ imageId, image });
      builtImages.set(path, list);
    };

    for (const rec of docker.compose) {
      const p = infraProvenance(ctx, ID, VERSION, "COMPOSE_SERVICE_BUILD", "compose-yaml", rec.file, rec.line, ID);
      const dockerfile = rec.dockerfile ? dockerfileByPath.get(rec.dockerfile) : undefined;
      if (rec.image) rec.imageId = imageEntity(ctx, rec.image, p, rec.file, rec.line, "declared");
      if (!dockerfile) {
        if (rec.dockerfile) infraUnresolved(ctx, ID, { type: "BUILDS", sourceId: ctx.fileEntityId(rec.file) ?? ctx.repositoryEntityId, display: rec.dockerfile, reason: `compose service '${rec.service}' references a Dockerfile that is not in the repository`, category: "dockerfile-unresolved", provenance: p });
        continue;
      }
      addContext(dockerfile.path, rec.context, `compose:${rec.file}#${rec.service}`);
      if (rec.imageId) {
        addBuilt(dockerfile.path, rec.imageId, rec.image);
        relate("BUILDS", dockerfile.entityId, rec.imageId, p, { via: "compose", composeFile: rec.file, service: rec.service, tag: rec.image!.tag, parameters: rec.image!.parameters, resolvedFromDefaults: rec.image!.parameters.length > 0, target: rec.target }, "DECLARED");
      }
    }

    for (const b of pipelines.dockerBuilds) {
      const p = infraProvenance(ctx, ID, VERSION, "PIPELINE_DOCKER_BUILD", "azure-pipelines-yaml", b.file, b.line, ID);
      if (b.composeFile) {
        const re = globToRegExp(b.composeFile);
        const services = docker.compose.filter((c) => (c.file === b.composeFile || re.test(c.file)) && (!b.composeServices || b.composeServices.includes(c.service)));
        if (!services.length) {
          infraUnresolved(ctx, ID, { type: "BUILDS", sourceId: b.pipelineId, display: `${b.composeFile}${b.composeServices ? ` [${b.composeServices.join(" ")}]` : ""}`, reason: "compose file or services not found in the repository", category: "compose-unresolved", provenance: p });
          continue;
        }
        for (const s of services) {
          if (!s.imageId) continue;
          if (b.command === "compose-build") relate("BUILDS", b.pipelineId, s.imageId, p, { via: "docker-compose", composeFile: s.file, service: s.service, tag: s.image!.tag }, "DECLARED");
          else {
            const artifactId = infraEntity(ctx, { key: `artifact|${repoId}|${b.file}|image:${s.image!.name}`, kind: "Artifact", name: s.image!.name, qualifiedName: `${b.file}:image:${s.image!.name}`, file: b.file, line: b.line, metadata: { artifactType: "container-image", reference: s.image!.raw, tag: s.image!.tag, via: "docker-compose" } }, p);
            relate("PRODUCES_ARTIFACT", b.pipelineId, artifactId, p, { via: "docker-compose push", service: s.service }, "DECLARED");
            relate("PACKAGED_AS", artifactId, s.imageId, p, { tag: s.image!.tag }, "DECLARED");
          }
        }
        continue;
      }
      if (b.command === "push" || !b.dockerfile) continue;
      const re = globToRegExp(b.dockerfile);
      const matches = dockerfileByPath.has(b.dockerfile) ? [dockerfileByPath.get(b.dockerfile)!] : docker.dockerfiles.filter((d) => re.test(d.path));
      if (matches.length !== 1) {
        infraUnresolved(ctx, ID, { type: "BUILDS", sourceId: b.pipelineId, display: b.dockerfile, reason: matches.length ? `Dockerfile pattern matches ${matches.length} files` : "Dockerfile not found in the repository", category: matches.length ? "dockerfile-ambiguous" : "dockerfile-unresolved", provenance: p });
        continue;
      }
      const df = matches[0]!;
      addContext(df.path, b.context ?? dirOf(df.path), `pipeline:${b.file}:${b.line}`);
      for (const image of b.images) {
        const imageId = imageEntity(ctx, image, p, b.file, b.line, "declared");
        addBuilt(df.path, imageId, image);
        relate("BUILDS", df.entityId, imageId, p, { via: "pipeline", tag: image.tag, parameters: image.parameters }, "DECLARED");
      }
    }

    const imageLinks = new Map<string, ImageLink>();
    const imageLink = (imageId: string) => {
      let l = imageLinks.get(imageId);
      if (!l) imageLinks.set(imageId, (l = { projects: new Set(), applications: new Set(), dockerfiles: new Set() }));
      return l;
    };
    for (const df of docker.dockerfiles) {
      if (!builtImages.has(df.path)) {
        const p = prov("DOCKERFILE_IMAGE", df.path);
        const imageId = infraEntity(ctx, { key: `container-image|${repoId}|dockerfile:${df.path}`, kind: "ContainerImage", name: `${df.path} (unnamed)`, qualifiedName: `dockerfile:${df.path}`, file: df.path, metadata: { unnamed: true, reason: "no image name is declared for this Dockerfile in compose files or pipelines" } }, p);
        relate("BUILDS", df.entityId, imageId, p, { via: "dockerfile" }, "DECLARED");
        addBuilt(df.path, imageId, null);
      }
      const resolved = resolveDockerProjects(df, [...(contexts.get(df.path) ?? []), ...inferredContexts(df, knownFiles), { context: dirOf(df.path), basis: "dockerfile-directory" }, { context: "", basis: "repository-root" }], projectByPath, projectsByDir);
      const final = df.facts.stages[df.facts.stages.length - 1]!;
      for (const assembly of assembliesFromCommand(final.entrypoint).concat(assembliesFromCommand(final.cmd))) {
        const candidates = projectsByAssembly.get(assembly.toLowerCase()) ?? [];
        if (candidates.length !== 1) continue;
        const existing = resolved.get(candidates[0]!.path);
        if (existing) existing.basis.push(`entrypoint assembly ${assembly}.dll`);
        else resolved.set(candidates[0]!.path, { project: candidates[0]!, basis: [`entrypoint assembly ${assembly}.dll`], context: null, line: final.line });
      }
      const publishCommands = df.facts.stages.flatMap((s) => s.runs.flatMap((r) => r.dotnet.filter((d) => d.command === "publish" || d.command === "build").map((d) => ({ d, line: r.line }))));
      if (!resolved.size && (publishCommands.length || assembliesFromCommand(final.entrypoint).length)) {
        const first = publishCommands[0];
        infraUnresolved(ctx, ID, { type: "PACKAGES", sourceId: df.entityId, display: first ? `dotnet ${first.d.command} ${first.d.target ?? "(working directory)"}` : (final.entrypoint ?? []).join(" "), reason: "the packaged project could not be mapped through COPY instructions and known build contexts", category: "dockerfile-project-unresolved", provenance: prov("DOCKERFILE_PROJECT", df.path, first?.line ?? final.line) });
      }
      for (const { project, basis, context, line } of resolved.values()) {
        const p = prov("DOCKERFILE_PROJECT", df.path, line);
        relate("PACKAGES", df.entityId, project.entityId, p, { basis, context }, "STRUCTURALLY_RESOLVED", basis.length > 1 ? 1 : 0.9);
        const appId = appOf(project);
        for (const built of builtImages.get(df.path) ?? []) {
          const link = imageLink(built.imageId);
          link.projects.add(project.entityId);
          link.dockerfiles.add(df.path);
          relate("PACKAGED_AS", project.entityId, built.imageId, p, { dockerfile: df.path, basis }, "STRUCTURALLY_RESOLVED", basis.length > 1 ? 1 : 0.9);
          if (appId) {
            link.applications.add(appId);
            relate("PACKAGED_AS", appId, built.imageId, p, { dockerfile: df.path, basis }, "STRUCTURALLY_RESOLVED", basis.length > 1 ? 1 : 0.9);
          }
        }
      }
      for (const built of builtImages.get(df.path) ?? []) imageLink(built.imageId).dockerfiles.add(df.path);
    }

    const artifactPaths = pipelines.publishes.filter((pub) => pub.path);
    const artifactsCovering = (pipelineId: string, path: string) => artifactPaths.filter((a) => a.pipelineId === pipelineId && (path === a.path || path.startsWith(`${a.path}/`)));
    for (const d of pipelines.dotnet) {
      const p = infraProvenance(ctx, ID, VERSION, "PIPELINE_DOTNET_TASK", "azure-pipelines-yaml", d.file, d.line, ID);
      if (!/^(build|publish|test|pack)$/.test(d.command)) continue;
      const targets = new Map<string, string>();
      for (const pattern of d.projects) {
        if (/\.(sln|slnx)$/i.test(pattern) && solutionProjects.has(pattern)) for (const id of solutionProjects.get(pattern)!) targets.set(id, `solution ${pattern}`);
        else if (projectByPath.has(pattern.toLowerCase())) targets.set(projectByPath.get(pattern.toLowerCase())!.entityId, pattern);
        else if (/[*?]/.test(pattern)) {
          const re = globToRegExp(pattern);
          for (const proj of projects) if (re.test(proj.path)) targets.set(proj.entityId, `glob ${pattern}`);
        } else if ((projectsByDir.get(pattern.toLowerCase()) ?? []).length === 1) targets.set(projectsByDir.get(pattern.toLowerCase())![0]!.entityId, pattern);
      }
      if (!targets.size) {
        infraUnresolved(ctx, ID, { type: "BUILDS", sourceId: d.pipelineId, display: `dotnet ${d.command} ${d.projects.join(" ") || "(working directory)"}`, reason: d.projects.length ? "project pattern matches no project in the repository" : "no project argument; target depends on the agent working directory", category: "pipeline-project-unresolved", provenance: p });
        continue;
      }
      for (const [projectId, basis] of targets) {
        const project = projectById.get(projectId);
        if (d.command === "test") continue;
        relate("BUILDS", d.pipelineId, projectId, p, { command: d.command, basis, task: d.taskId }, "DECLARED");
        const appId = project ? appOf(project) : null;
        if (appId) relate("BUILDS", d.pipelineId, appId, p, { command: d.command, basis, task: d.taskId }, "DECLARED");
        if (d.command === "publish" && d.output) {
          for (const a of artifactsCovering(d.pipelineId, d.output)) {
            relate("PACKAGED_AS", projectId, a.artifactId, p, { output: d.output }, "STRUCTURALLY_RESOLVED");
            if (appId) relate("PACKAGED_AS", appId, a.artifactId, p, { output: d.output }, "STRUCTURALLY_RESOLVED");
          }
          for (const b of pipelines.dockerBuilds.filter((x) => x.pipelineId === d.pipelineId && x.context && (x.context === d.output || d.output!.startsWith(`${x.context}/`)))) {
            for (const image of b.images) {
              const imageId = ids.entity(`container-image|${repoId}|${image.name}`);
              if (!ctx.graph.has(imageId)) continue;
              relate("PACKAGED_AS", projectId, imageId, p, { via: "publish output used as docker build context", output: d.output }, "STRUCTURALLY_RESOLVED", 0.9);
              const link = imageLink(imageId);
              link.projects.add(projectId);
              if (appId) {
                link.applications.add(appId);
                relate("PACKAGED_AS", appId, imageId, p, { via: "publish output used as docker build context", output: d.output }, "STRUCTURALLY_RESOLVED", 0.9);
              }
              for (const a of artifactsCovering(d.pipelineId, d.output)) relate("PACKAGED_AS", a.artifactId, imageId, p, { via: "docker build context" }, "STRUCTURALLY_RESOLVED", 0.9);
            }
          }
        }
      }
    }

    for (const c of pipelines.copies) {
      if (!c.from || c.from.startsWith("<")) continue;
      for (const a of artifactsCovering(c.pipelineId, c.to)) {
        const p = prov("PIPELINE_ARTIFACT_CONTENT", ctx.graph.get(a.artifactId)?.location?.file ?? null, ctx.graph.get(a.artifactId)?.location?.startLine ?? 1);
        for (const chart of charts) {
          const dir = chart.dir.replace(/\/$/, "");
          if (dir === c.from || dir.startsWith(`${c.from}/`)) relate("PACKAGES", a.artifactId, chart.entityId, p, { copiedFrom: c.from }, "STRUCTURALLY_RESOLVED");
        }
        ctx.graph.annotate(a.artifactId, { contents: [c.from], artifactType: charts.some((ch) => ch.dir.startsWith(`${c.from}/`) || ch.dir.replace(/\/$/, "") === c.from) ? "deployment-package" : String(ctx.graph.get(a.artifactId)?.metadata.artifactType ?? "build-artifact") }, p);
      }
    }

    for (const dl of pipelines.downloads) {
      const p = prov("PIPELINE_ARTIFACT_DOWNLOAD", ctx.graph.get(dl.jobId)?.location?.file ?? null, ctx.graph.get(dl.jobId)?.location?.startLine ?? 1);
      const produced = pipelines.publishes.filter((x) => x.pipelineId === dl.pipelineId);
      const targets = dl.artifact === "*" || dl.artifact === "*implicit" ? produced : produced.filter((x) => ctx.graph.get(x.artifactId)?.name === dl.artifact);
      for (const t of targets) relate("CONSUMES_ARTIFACT", dl.jobId, t.artifactId, p, { implicit: dl.artifact === "*implicit" }, dl.artifact === "*implicit" ? "STRUCTURALLY_RESOLVED" : "DECLARED");
    }

    resolveKubernetes(ctx, kube, relate, prov, imageLinks, projectsByAssembly, appOf);

    const refIndex = configurationReferenceIndex(ctx);
    const appWorkloads = new Set<string>();
    for (const r of ctx.graph.allRelationships()) if (r.type === "RUNS") appWorkloads.add(r.sourceId);
    for (const ev of kube.environmentVariables) {
      if (!appWorkloads.has(ev.workloadId)) continue;
      for (const refId of referencesForVariable(refIndex, ev.name)) relate("SUPPLIES_CONFIG", ev.entityId, refId, prov("ENVIRONMENT_VARIABLE_CONFIG_KEY", ctx.graph.get(ev.entityId)?.location?.file ?? null, ctx.graph.get(ev.entityId)?.location?.startLine ?? 1), { key: ev.name });
    }
    for (const w of kube.workloads.filter((x) => appWorkloads.has(x.entityId))) {
      for (const cm of w.configMaps.filter((c) => c.via === "envFrom")) {
        const target = kube.named.find((n) => n.kind === "ConfigMap" && n.bucket === w.bucket && n.name === cm.name);
        for (const [key, keyId] of Object.entries(target?.keyIds ?? {})) {
          for (const refId of referencesForVariable(refIndex, key)) relate("SUPPLIES_CONFIG", keyId, refId, prov("CONFIGMAP_ENVFROM_CONFIG_KEY", target!.file, target!.line), { key, via: "envFrom" });
        }
      }
    }
    for (const df of docker.dockerfiles) {
      const linked = (builtImages.get(df.path) ?? []).some((b) => (imageLinks.get(b.imageId)?.applications.size ?? 0) > 0);
      if (!linked) continue;
      for (const stage of df.facts.stages) {
        for (const env of stage.env) {
          const envId = ids.entity(`env-var|${repoId}|dockerfile:${df.path}|${env.name}`);
          if (!ctx.graph.has(envId)) continue;
          for (const refId of referencesForVariable(refIndex, env.name)) relate("SUPPLIES_CONFIG", envId, refId, prov("DOCKER_ENV_CONFIG_KEY", df.path, env.line), { key: env.name });
        }
      }
    }
    ctx.log.info("infrastructure.resolved", { images: imageLinks.size, workloads: kube.workloads.length });
  },
};

function inferredContexts(df: DockerfileRecord, known: Set<string>): { context: string; basis: string }[] {
  const sources = df.facts.stages.flatMap((s) => s.copies.filter((c) => !c.from).flatMap((c) => c.sources)).filter((src) => /\.(csproj|fsproj|vbproj|sln|slnx|props|targets)$/i.test(src) && !/[*?$]/.test(src));
  if (!sources.length) return [];
  const out: { context: string; basis: string }[] = [];
  for (let dir = dirOf(df.path); ; dir = dirOf(dir)) {
    if (sources.every((src) => known.has(joinPath(dir, src).toLowerCase()))) out.push({ context: dir, basis: `COPY sources exist relative to ${dir || "repository root"}` });
    if (!dir) break;
  }
  return out;
}

function resolveDockerProjects(
  df: DockerfileRecord,
  contexts: { context: string; basis: string }[],
  projectByPath: Map<string, DotnetProject>,
  projectsByDir: Map<string, DotnetProject[]>,
): Map<string, { project: DotnetProject; basis: string[]; context: string | null; line: number }> {
  const stages = df.facts.stages;
  const chainOf = (stage: DockerStageFacts) => {
    const out: DockerStageFacts[] = [];
    for (let s: DockerStageFacts | undefined = stage; s; s = s.baseStage ? stages.find((x) => x.name === s!.baseStage && x.index < s!.index) : undefined) out.push(s);
    return out;
  };
  const mapToContext = (chain: DockerStageFacts[], cpath: string): string[] => {
    const out: string[] = [];
    for (const stage of chain) {
      for (const copy of [...stage.copies].reverse()) {
        if (copy.from) continue;
        const dest = copy.dest.replace(/\/$/, "") || "/";
        const destIsDir = copy.dest.endsWith("/") || copy.sources.length > 1;
        for (const src of copy.sources) {
          if (/^https?:\/\//.test(src) || /[*?]/.test(src)) continue;
          const srcPath = joinPath("", src);
          const base = srcPath.split("/").pop() ?? "";
          const prefix = dest === "/" ? "" : dest;
          if (cpath === dest || cpath.startsWith(`${prefix}/`)) out.push(joinPath(srcPath, cpath.slice(prefix.length).replace(/^\//, "")));
          if (destIsDir && base) {
            const d2 = `${prefix}/${base}`;
            if (cpath === d2) out.push(srcPath);
            else if (cpath.startsWith(`${d2}/`)) out.push(joinPath(srcPath, cpath.slice(d2.length + 1)));
          }
        }
      }
    }
    return [...new Set(out)];
  };
  const commands = stages.flatMap((s) => s.runs.flatMap((r) => r.dotnet.filter((d) => d.command === "publish" || d.command === "build").map((d) => ({ stage: s, run: r, d }))));
  const preferred = commands.some((c) => c.d.command === "publish") ? commands.filter((c) => c.d.command === "publish") : commands;
  for (const ctxCandidate of contexts) {
    const found = new Map<string, { project: DotnetProject; basis: string[]; context: string | null; line: number }>();
    for (const { stage, run, d } of preferred) {
      if (d.target && /\.(sln|slnx|slnf)$/i.test(d.target)) continue;
      const cpath = containerPath(run.workdir, d.target ?? ".");
      for (const rel of mapToContext(chainOf(stage), cpath)) {
        const repoPath = joinPath(ctxCandidate.context, rel).toLowerCase();
        const byPath = projectByPath.get(repoPath);
        const byDir = !byPath && (projectsByDir.get(repoPath) ?? []).length === 1 ? projectsByDir.get(repoPath)![0] : undefined;
        const project = byPath ?? byDir;
        if (!project) continue;
        found.set(project.path, { project, basis: [`dotnet ${d.command} ${d.target ?? `(WORKDIR ${run.workdir})`} via COPY mapping (${ctxCandidate.basis})`], context: ctxCandidate.context, line: run.line });
        break;
      }
    }
    if (found.size) return found;
  }
  return new Map();
}

function resolveKubernetes(
  ctx: AnalysisContext,
  kube: KubernetesFacts,
  relate: (type: Parameters<typeof infraRelate>[1], s: string, t: string, p: Provenance, metadata?: Metadata, evidence?: EvidenceLevel, confidence?: number) => string,
  prov: (extractor: string, file: string | null, line?: number) => Provenance,
  imageLinks: Map<string, ImageLink>,
  projectsByAssembly: Map<string, DotnetProject[]>,
  appOf: (p: DotnetProject) => string | null,
) {
  const repoId = ctx.repository.id;
  const labelIndex = new Map<string, Set<WorkloadRecord>>();
  const workloadsByName = new Map<string, WorkloadRecord>();
  for (const w of kube.workloads) {
    workloadsByName.set(`${w.bucket}|${w.kind}|${w.name}`, w);
    for (const [k, v] of Object.entries(w.podLabels)) {
      const key = `${w.bucket}|${k}=${v}`;
      const set = labelIndex.get(key) ?? new Set();
      set.add(w);
      labelIndex.set(key, set);
    }
  }
  const servicesByName = new Map<string, ServiceRecord>(kube.services.map((s) => [`${s.bucket}|${s.name}`, s]));
  const named = new Map(kube.named.filter((n) => n.entityId).map((n) => [`${n.kind}|${n.bucket}|${n.name}`, n]));

  for (const svc of kube.services) {
    const p = prov("SERVICE_SELECTOR", svc.file, svc.line);
    const entries = Object.entries(svc.selector ?? {});
    if (!entries.length) {
      const entity = ctx.graph.get(svc.entityId);
      if (entity?.metadata.serviceType !== "ExternalName") infraUnresolved(ctx, ID, { type: "ROUTES_TO", sourceId: svc.entityId, display: `Service/${svc.name}`, reason: "service has no selector; endpoints are managed outside the manifest", category: "service-without-selector", provenance: p });
      continue;
    }
    let candidates: WorkloadRecord[] = [...(labelIndex.get(`${svc.bucket}|${entries[0]![0]}=${entries[0]![1]}`) ?? [])];
    for (const [k, v] of entries.slice(1)) {
      const set = labelIndex.get(`${svc.bucket}|${k}=${v}`);
      candidates = set ? candidates.filter((w) => set.has(w)) : [];
    }
    if (!candidates.length) {
      infraUnresolved(ctx, ID, { type: "ROUTES_TO", sourceId: svc.entityId, display: entries.map(([k, v]) => `${k}=${v}`).join(","), reason: "no workload in the same namespace and deployment scope has matching pod labels", category: "selector-unmatched", provenance: p });
      continue;
    }
    for (const w of candidates.sort((a, b) => a.entityId.localeCompare(b.entityId))) {
      const containerPorts = w.containers.flatMap((c) => c.ports);
      const matchedPorts = svc.ports.filter((sp) => containerPorts.some((cp) => cp.port === (sp.targetPort ?? sp.port) || (cp.name !== null && cp.name === sp.targetPort))).map((sp) => `${sp.port}->${sp.targetPort ?? sp.port}`);
      relate("ROUTES_TO", svc.entityId, w.entityId, p, { basis: "label-selector", selector: entries.map(([k, v]) => `${k}=${v}`), matchedPorts });
      relate("EXPOSES_SERVICE", w.entityId, svc.entityId, p, { basis: "label-selector" });
    }
  }

  const routes = new Map<string, string[]>();
  for (const ing of kube.ingresses) {
    const byService = new Map<string, string[]>();
    for (const b of ing.backends) byService.set(b.service, [...(byService.get(b.service) ?? []), `${b.host ?? "*"}${b.path ?? ""} -> :${b.port ?? ""}`]);
    const p = prov("INGRESS_BACKEND", ing.file, ing.line);
    for (const [service, list] of byService) {
      const target = servicesByName.get(`${ing.bucket}|${service}`);
      if (target) relate("ROUTES_TO", ing.entityId, target.entityId, p, { basis: "ingress-backend-service-name", routes: list }, "DECLARED");
      else infraUnresolved(ctx, ID, { type: "ROUTES_TO", sourceId: ing.entityId, display: `Service/${service}`, reason: "backend service is not declared in the same namespace and deployment scope", category: "ingress-backend-unresolved", provenance: p });
    }
    for (const secret of ing.tlsSecrets) relate("USES_SECRET", ing.entityId, secretRef(ctx, named, ing.bucket, secret, ing.file, ing.line), p, { via: "tls" }, "DECLARED");
    const ingressMeta = ctx.graph.get(ing.entityId)?.metadata;
    const env = String(ingressMeta?.environment ?? "");
    if (ingressMeta?.helmRelease && !env) continue;
    for (const b of ing.backends) {
      if (!b.host && !b.path) continue;
      const key = `${env}|${b.host ?? "*"}|${b.path ?? ""}`;
      routes.set(key, [...new Set([...(routes.get(key) ?? []), ing.entityId])]);
    }
  }
  for (const [key, ingressIds] of routes) {
    if (ingressIds.length < 2) continue;
    ctx.graph.conflict({ repositoryId: repoId, kind: "conflicting-ingress-route", subject: key, factIds: ingressIds, severity: "warning", status: "unresolved", description: `route ${key.split("|").slice(1).join("")} is declared by ${ingressIds.length} ingresses${key.startsWith("|") ? "" : ` in environment ${key.split("|")[0]}`}`, provenance: ingressIds.map((id) => ctx.graph.get(id)!.provenance[0]!) });
  }

  for (const w of kube.workloads) {
    const p = prov("WORKLOAD_REFERENCES", w.file, w.line);
    for (const ref of w.configMaps) {
      const target = named.get(`ConfigMap|${w.bucket}|${ref.name}`);
      if (!target) {
        infraUnresolved(ctx, ID, { type: "REFERENCES_CONFIG", sourceId: ref.sourceId, display: `ConfigMap/${ref.name}`, reason: "ConfigMap is not declared in the same namespace and deployment scope", category: "configmap-unresolved", provenance: p, metadata: { via: ref.via } });
        continue;
      }
      relate("REFERENCES_CONFIG", ref.sourceId, target.entityId, p, { via: ref.via }, "DECLARED");
      if (ref.sourceId !== w.entityId) relate("REFERENCES_CONFIG", w.entityId, target.entityId, p, { via: ref.via }, "DECLARED");
      const key = /^env:[^:]+:(.+)$/.exec(ref.via)?.[1];
      if (key && target.keyIds[key]) relate("REFERENCES_CONFIG", ref.sourceId, target.keyIds[key]!, p, { via: "configMapKeyRef", key }, "DECLARED");
      else if (key) infraUnresolved(ctx, ID, { type: "REFERENCES_CONFIG", sourceId: ref.sourceId, display: `ConfigMap/${ref.name}:${key}`, reason: "key is not present in the declared ConfigMap", category: "configmap-key-unresolved", provenance: p });
    }
    for (const ref of w.secrets) {
      const secretId = secretRef(ctx, named, w.bucket, ref.name, w.file, w.line);
      relate("USES_SECRET", ref.sourceId, secretId, p, { via: ref.via }, "DECLARED");
      if (ref.sourceId !== w.entityId) relate("USES_SECRET", w.entityId, secretId, p, { via: ref.via }, "DECLARED");
    }
    if (w.serviceAccount && w.serviceAccount !== "default") {
      const sa = named.get(`ServiceAccount|${w.bucket}|${w.serviceAccount}`);
      if (sa) relate("USES_SERVICE_ACCOUNT", w.entityId, sa.entityId, p, {}, "DECLARED");
      else infraUnresolved(ctx, ID, { type: "USES_SERVICE_ACCOUNT", sourceId: w.entityId, display: `ServiceAccount/${w.serviceAccount}`, reason: "service account is not declared in the same namespace and deployment scope", category: "service-account-unresolved", provenance: p });
    }

    const runs = new Map<string, { basis: string[]; containers: string[] }>();
    for (const c of w.containers) {
      if (c.imageId) {
        for (const appId of imageLinks.get(c.imageId)?.applications ?? []) {
          const r = runs.get(appId) ?? { basis: [], containers: [] };
          r.basis.push(`image ${c.image?.name} packages the application`);
          r.containers.push(c.name);
          runs.set(appId, r);
        }
        const link = imageLinks.get(c.imageId);
        if (link && !link.applications.size && link.projects.size === 0 && link.dockerfiles.size) {
          infraUnresolved(ctx, ID, { type: "RUNS", sourceId: w.entityId, display: c.image?.name ?? c.name, reason: "image is built in this repository but its Dockerfile could not be linked to a project", category: "application-unresolved", provenance: p });
        }
      }
      for (const assembly of assembliesFromCommand(c.command)) {
        const candidates = projectsByAssembly.get(assembly.toLowerCase()) ?? [];
        const appId = candidates.length === 1 ? appOf(candidates[0]!) : null;
        if (!appId) continue;
        const r = runs.get(appId) ?? { basis: [], containers: [] };
        r.basis.push(`container command runs ${assembly}.dll`);
        r.containers.push(c.name);
        runs.set(appId, r);
      }
    }
    for (const [appId, r] of runs) relate("RUNS", w.entityId, appId, p, { basis: [...new Set(r.basis)], containers: [...new Set(r.containers)] }, "STRUCTURALLY_RESOLVED", r.basis.length > 1 ? 1 : 0.9);

    for (const ev of kube.environmentVariables.filter((e) => e.workloadId === w.entityId && /^(ASPNETCORE|DOTNET)_ENVIRONMENT$/.test(e.name))) {
      const value = ctx.graph.get(ev.entityId)?.metadata;
      if (value?.valueKind !== "literal" || typeof value.value !== "string") continue;
      const envProv = prov("HOSTING_ENVIRONMENT_VARIABLE", w.file, w.line);
      relate("IN_ENVIRONMENT", w.entityId, environmentEntity(ctx, value.value, envProv, "hosting-environment-variable"), envProv, { basis: ev.name, scope: "application-hosting-environment" }, "DECLARED");
    }
  }

  for (const hpa of kube.named.filter((n) => n.kind === "HorizontalPodAutoscaler")) {
    const [target, min, max] = (hpa.target ?? "").split("|");
    const [kind, name] = (target ?? "").split("/");
    const w = workloadsByName.get(`${hpa.bucket}|${kind}|${name}`);
    const p = prov("HORIZONTAL_POD_AUTOSCALER", hpa.file, hpa.line);
    if (w) ctx.graph.annotate(w.entityId, { autoscaler: hpa.name, minReplicas: min || null, maxReplicas: max || null }, p);
    else if (target) infraUnresolved(ctx, ID, { type: "REFERENCES", sourceId: ctx.fileEntityId(hpa.file) ?? ctx.repositoryEntityId, display: `HorizontalPodAutoscaler/${hpa.name} -> ${target}`, reason: "scale target is not declared in the same namespace and deployment scope", category: "hpa-target-unresolved", provenance: p });
  }

  const groups = new Map<string, WorkloadRecord[]>();
  for (const w of kube.workloads) {
    if (w.releaseId && !w.environment) continue;
    const key = `${w.environment ?? "(no environment)"}|${w.kind}|${w.namespace ?? ""}|${w.name}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const fingerprint = (w: WorkloadRecord) => [ctx.graph.get(w.entityId)?.metadata.replicas ?? "", ...w.containers.map((c) => `${c.name}=${c.image?.raw ?? ""}:${c.ports.map((p) => p.port).join(",")}`)].join("|");
    if (new Set(list.map(fingerprint)).size < 2) continue;
    ctx.graph.conflict({ repositoryId: repoId, kind: "conflicting-infrastructure-declaration", subject: key, factIds: list.map((w) => w.entityId), severity: "warning", status: "unresolved", description: `${key.split("|").slice(1).join("/")} is declared ${list.length} times with different images, ports or replicas (${list.map((w) => w.file).join(", ")})`, provenance: list.map((w) => ctx.graph.get(w.entityId)!.provenance[0]!) });
  }
  const tags = new Map<string, Map<string, string[]>>();
  for (const w of kube.workloads) {
    if (w.releaseId && !w.environment) continue;
    for (const c of w.containers) {
      if (!c.imageId || !c.image) continue;
      const key = `${c.imageId}|${w.environment ?? ""}`;
      const m = tags.get(key) ?? new Map<string, string[]>();
      m.set(c.image.tag ?? c.image.digest ?? "(none)", [...(m.get(c.image.tag ?? c.image.digest ?? "(none)") ?? []), c.entityId]);
      tags.set(key, m);
    }
  }
  for (const [key, m] of tags) {
    if (m.size < 2) continue;
    const [imageId, env] = key.split("|");
    const facts = [...m.values()].flat();
    ctx.graph.conflict({ repositoryId: repoId, kind: "conflicting-image-tag", subject: key, factIds: facts, severity: "info", status: "unresolved", description: `image ${ctx.graph.get(imageId!)?.qualifiedName} is declared with tags ${[...m.keys()].join(", ")}${env ? ` in environment ${env}` : ""}`, provenance: facts.map((id) => ctx.graph.get(id)!.provenance[0]!) });
  }
}

function secretRef(ctx: AnalysisContext, named: Map<string, { entityId: string }>, bucket: string, name: string, file: string, line: number): string {
  const declared = named.get(`Secret|${bucket}|${name}`);
  if (declared) return declared.entityId;
  return infraEntity(ctx, {
    key: `secret-ref|${ctx.repository.id}|k8s-ref|${bucket}|${name}`,
    kind: "SecretReference",
    name,
    qualifiedName: `Secret/${name}`,
    file,
    line,
    metadata: { source: "kubernetes-secret-reference", declaredInRepository: false, valueStored: false, scope: bucket },
  }, infraProvenance(ctx, ID, VERSION, "SECRET_REFERENCE", "infrastructure-resolution", file, line, ID));
}
