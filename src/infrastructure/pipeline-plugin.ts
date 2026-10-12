import type { Metadata } from "../graph/model.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { AZURE_PIPELINES_PARSER_VERSION, AzurePipelineParser, looksLikeAzurePipeline, type ParsedPipeline, type PipelineStep } from "./azure-pipelines.ts";
import {
  PIPELINE_FACTS,
  environmentEntity,
  infraDiagnostic,
  infraEntity,
  infraProvenance,
  infraRelate,
  infraUnresolved,
  isObject,
  isSecretName,
  joinPath,
  parseImageReference,
  parseYaml,
  imageEntity,
  placeholders,
  safeValueMetadata,
  secretValueState,
  type Json,
  type PipelineFacts,
} from "./common.ts";
import { recognizeStep } from "./pipeline-tasks.ts";

const ID = "infrastructure.azure-pipelines";
const VERSION = AZURE_PIPELINES_PARSER_VERSION;

const PREDEFINED_PATHS: Record<string, string> = {
  "build.sourcesdirectory": "",
  "system.defaultworkingdirectory": "",
  "build.repository.localpath": "",
  "build.artifactstagingdirectory": "<staging>",
  "build.stagingdirectory": "<staging>",
  "pipeline.workspace": "<workspace>",
  "agent.builddirectory": "<workspace>",
  "build.binariesdirectory": "<binaries>",
};

export function expandVariables(value: string, vars: Map<string, string>): string {
  return value
    .replace(/\$\((\w[\w.]*)\)|\$\{\{\s*variables\.([\w.]+)\s*\}\}|\$\[\s*variables\.([\w.]+)\s*\]/g, (m, a?: string, b?: string, c?: string) => {
      const name = (a ?? b ?? c)!;
      const predefined = PREDEFINED_PATHS[name.toLowerCase()];
      if (predefined !== undefined) return predefined === "" ? "/" : predefined;
      return vars.get(name) ?? m;
    });
}

export function pipelinePath(value: string | null, vars: Map<string, string>): string | null {
  if (value === null) return null;
  const expanded = expandVariables(value.trim(), vars).replace(/\\/g, "/");
  if (expanded.startsWith("<")) return expanded.replace(/\/+$/, "");
  return joinPath("", expanded.replace(/^\/+/, ""));
}

function triggerSummary(p: ParsedPipeline): string[] {
  return p.triggers.map((t) => {
    const parts = [`${t.kind}:${t.mode}`];
    if (t.name) parts.push(`name=${t.name}`);
    if (t.cron) parts.push(`cron=${t.cron}`);
    if (t.branchesInclude.length) parts.push(`branches=${t.branchesInclude.join(",")}`);
    if (t.branchesExclude.length) parts.push(`!branches=${t.branchesExclude.join(",")}`);
    if (t.pathsInclude.length) parts.push(`paths=${t.pathsInclude.join(",")}`);
    if (t.pathsExclude.length) parts.push(`!paths=${t.pathsExclude.join(",")}`);
    return parts.join(" ");
  });
}

export const azurePipelinesPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const facts: PipelineFacts = { dockerBuilds: [], dotnet: [], publishes: [], deploys: [], copies: [], downloads: [] };
    ctx.artifacts.set(PIPELINE_FACTS, facts);
    const known = new Set(ctx.files.map((f) => f.path));
    const read = async (path: string) => {
      if (known.has(path)) return ctx.readText(path).catch(() => null);
      const file = Bun.file(`${ctx.repository.rootPath}/${path}`);
      return (await file.exists()) ? file.text() : null;
    };
    const candidates: { path: string; hash: string; doc: Record<string, Json> }[] = [];
    for (const file of ctx.files.filter((f) => f.category === "pipeline" && /\.ya?ml$/i.test(f.path) && !f.path.startsWith(".github/"))) {
      let doc: Json;
      try {
        doc = parseYaml(await ctx.readText(file.path)) as Json;
      } catch (error) {
        infraDiagnostic(ctx, ID, file.path, "pipeline-yaml-invalid", error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!looksLikeAzurePipeline(doc) || !isObject(doc)) {
        ctx.log.debug("pipelines.not-azure", { file: file.path });
        continue;
      }
      candidates.push({ path: file.path, hash: file.hash, doc });
    }
    const parser = new AzurePipelineParser(read);
    const parsed: { parsed: ParsedPipeline; hash: string }[] = [];
    for (const c of candidates) {
      try {
        parsed.push({ parsed: await parser.parse(c.path, c.doc), hash: c.hash });
      } catch (error) {
        infraDiagnostic(ctx, ID, c.path, "pipeline-parse-failed", error instanceof Error ? error.message : String(error), "error");
      }
    }
    const templateFiles = new Set(parsed.flatMap((p) => p.parsed.templates));
    for (const { parsed: p, hash } of parsed) {
      if (templateFiles.has(p.file)) continue;
      try {
        emitPipeline(ctx, p, hash, facts);
      } catch (error) {
        infraDiagnostic(ctx, ID, p.file, "pipeline-emit-failed", error instanceof Error ? error.message : String(error), "error");
      }
    }
    ctx.log.info("pipelines.parsed", { pipelines: parsed.length - [...templateFiles].filter((t) => parsed.some((p) => p.parsed.file === t)).length, templates: templateFiles.size });
  },
};

function emitPipeline(ctx: AnalysisContext, p: ParsedPipeline, hash: string, facts: PipelineFacts) {
  const repoId = ctx.repository.id;
  const prov = (file: string, line: number, extractor: string) => infraProvenance(ctx, ID, VERSION, extractor, "azure-pipelines-yaml", file, line);
  const ci = p.triggers.find((t) => t.kind === "ci");
  const pr = p.triggers.find((t) => t.kind === "pr");
  const pipelineId = infraEntity(ctx, {
    key: `pipeline|${repoId}|${p.file}`,
    kind: "Pipeline",
    name: p.name && !p.name.includes("$(") ? p.name : p.file,
    qualifiedName: p.file,
    file: p.file,
    metadata: {
      platform: "azure-pipelines",
      triggers: triggerSummary(p),
      ciTrigger: ci?.mode ?? "default",
      prTrigger: pr?.mode ?? "default",
      ciBranches: ci?.branchesInclude ?? [],
      ciPaths: ci?.pathsInclude ?? [],
      schedules: p.triggers.filter((t) => t.kind === "schedule").map((t) => t.cron ?? ""),
      manualOnly: ci?.mode === "none" && pr?.mode === "none" && !p.triggers.some((t) => t.kind === "schedule" || t.kind === "pipeline-resource"),
      variables: p.variables.filter((v) => v.name).map((v) => v.name!),
      variableGroups: p.variables.filter((v) => v.group).map((v) => v.group!),
      templates: p.templates,
      parameters: p.parameters,
      pool: p.pool,
      sourceHash: hash,
      parserVersion: VERSION,
    },
  }, prov(p.file, 1, "AZURE_PIPELINE"));
  const fileId = ctx.fileEntityId(p.file);
  if (fileId) infraRelate(ctx, "DECLARES", fileId, pipelineId, prov(p.file, 1, "AZURE_PIPELINE"), {}, "EXACT");
  for (const t of p.templates) {
    const templateFileId = ctx.fileEntityId(t);
    if (templateFileId) infraRelate(ctx, "REFERENCES", pipelineId, templateFileId, prov(p.file, 1, "PIPELINE_TEMPLATE"), { role: "template" }, "EXACT");
  }
  for (const u of p.unresolvedTemplates) {
    infraUnresolved(ctx, ID, { type: "REFERENCES", sourceId: pipelineId, display: u.reference, reason: u.reason, category: "pipeline-template-unresolved", provenance: prov(u.source.file, u.source.line, "PIPELINE_TEMPLATE") });
  }

  const vars = new Map<string, string>();
  for (const v of p.variables) {
    if (v.group) {
      const pv = prov(v.source.file, v.source.line, "PIPELINE_VARIABLE_GROUP");
      const groupId = infraEntity(ctx, { key: `config|${repoId}|variable-group|${v.group}`, kind: "Configuration", name: v.group, qualifiedName: `variable-group:${v.group}`, file: v.source.file, line: v.source.line, metadata: { source: "pipeline-variable-group", valueKind: "external" } }, pv);
      infraRelate(ctx, "REFERENCES_CONFIG", pipelineId, groupId, pv, { via: "variable-group" });
      continue;
    }
    if (!v.name) continue;
    const pv = prov(v.source.file, v.source.line, "PIPELINE_VARIABLE");
    if (isSecretName(v.name)) {
      const secretId = infraEntity(ctx, { key: `secret-ref|${repoId}|pipeline-variable|${p.file}|${v.name}`, kind: "SecretReference", name: v.name, qualifiedName: `pipeline:${p.file}:${v.name}`, file: v.source.file, line: v.source.line, metadata: { source: "pipeline-variable", valueStored: false, valueState: secretValueState(v.value, v.name) } }, pv);
      infraRelate(ctx, "USES_SECRET", pipelineId, secretId, pv, { via: "variable" });
      continue;
    }
    const meta = safeValueMetadata(v.name, v.value);
    if (meta.valueKind === "literal" || meta.valueKind === "url" || meta.valueKind === "parameterized") vars.set(v.name, String(meta.value));
    const configId = infraEntity(ctx, { key: `config|${repoId}|pipeline:${p.file}|${v.name}`, kind: "Configuration", name: v.name, qualifiedName: `pipeline:${p.file}:${v.name}`, file: v.source.file, line: v.source.line, metadata: { source: "pipeline-variable", ...meta } }, pv);
    infraRelate(ctx, "DECLARES", pipelineId, configId, pv);
  }

  const stageIds = new Map<string, string>();
  p.stages.forEach((stage, stageIndex) => {
    let containerId = pipelineId;
    if (!stage.implicit) {
      const ps = prov(stage.source.file, stage.source.line, "PIPELINE_STAGE");
      const stageId = infraEntity(ctx, {
        key: `pipeline-stage|${repoId}|${p.file}|${stage.name}`,
        kind: "PipelineStage",
        name: stage.name,
        qualifiedName: `${p.file}#${stage.name}`,
        file: stage.source.file,
        line: stage.source.line,
        metadata: { displayName: stage.displayName, dependsOn: stage.dependsOn, condition: stage.condition, conditional: stage.conditional, order: stageIndex, jobs: stage.jobs.map((j) => j.name) },
      }, ps);
      stageIds.set(stage.name, stageId);
      infraRelate(ctx, "CONTAINS", pipelineId, stageId, ps, { order: stageIndex });
      containerId = stageId;
    }
    const jobIds = new Map<string, string>();
    stage.jobs.forEach((job, jobIndex) => {
      const pj = prov(job.source.file, job.source.line, job.deployment ? "PIPELINE_DEPLOYMENT_JOB" : "PIPELINE_JOB");
      const jobId = infraEntity(ctx, {
        key: `pipeline-job|${repoId}|${p.file}|${stage.name}|${job.name}`,
        kind: "PipelineJob",
        name: job.name,
        qualifiedName: `${p.file}#${stage.implicit ? "" : `${stage.name}/`}${job.name}`,
        file: job.source.file,
        line: job.source.line,
        metadata: { displayName: job.displayName, deploymentJob: job.deployment, environment: job.environment, strategy: job.strategy, pool: job.pool, dependsOn: job.dependsOn, condition: job.condition, conditional: job.conditional, order: jobIndex, stage: stage.implicit ? null : stage.name },
      }, pj);
      jobIds.set(job.name, jobId);
      infraRelate(ctx, "CONTAINS", containerId, jobId, pj, { order: jobIndex });
      if (job.environment) {
        const envId = environmentEntity(ctx, job.environment, pj, "pipeline-deployment-environment");
        infraRelate(ctx, "IN_ENVIRONMENT", jobId, envId, pj, { basis: "deployment job environment" });
      }
      let hasExplicitDownload = false;
      job.steps.forEach((step, stepIndex) => {
        const recognized = recognizeStep(step);
        const pt = prov(step.source.file, step.source.line, "PIPELINE_TASK");
        const taskId = infraEntity(ctx, {
          key: `pipeline-task|${repoId}|${p.file}|${stage.name}|${job.name}|${stepIndex}`,
          kind: "PipelineTask",
          name: step.displayName ?? step.task ?? step.kind,
          qualifiedName: `${p.file}#${stage.implicit ? "" : `${stage.name}/`}${job.name}/${stepIndex}`,
          file: step.source.file,
          line: step.source.line,
          metadata: taskMetadata(step, recognized.kinds, stepIndex),
        }, pt);
        infraRelate(ctx, "CONTAINS", jobId, taskId, pt, { order: stepIndex });
        for (const d of recognized.dotnet) {
          facts.dotnet.push({ taskId, pipelineId, command: d.command, projects: d.projects.map((x) => pipelinePath(x, vars)!).filter(Boolean), output: pipelinePath(d.output, vars), file: step.source.file, line: step.source.line });
        }
        for (const d of recognized.docker) {
          const images = d.images.map((raw) => {
            const expanded = expandVariables(raw, vars);
            const qualified = d.registryConnection && !/^[^/]*[.:][^/]*\//.test(expanded) ? `$(serviceConnection:${d.registryConnection})/${expanded}` : expanded;
            return parseImageReference(qualified);
          }).filter((x) => x !== null);
          facts.dockerBuilds.push({
            taskId, pipelineId, command: d.command, dockerfile: pipelinePath(d.dockerfile, vars), context: pipelinePath(d.context, vars), images,
            composeFile: pipelinePath(d.composeFile, vars), composeServices: d.composeServices, line: step.source.line, file: step.source.file,
          });
          for (const image of images) {
            const imageId = imageEntity(ctx, image, pt, step.source.file, step.source.line, "declared");
            if (d.command === "push" || d.command === "buildAndPush") {
              const artifactId = infraEntity(ctx, { key: `artifact|${repoId}|${p.file}|image:${image.name}`, kind: "Artifact", name: image.name, qualifiedName: `${p.file}:image:${image.name}`, file: step.source.file, line: step.source.line, metadata: { artifactType: "container-image", reference: image.raw, tag: image.tag, parameters: image.parameters } }, pt);
              infraRelate(ctx, "PRODUCES_ARTIFACT", pipelineId, artifactId, pt, { job: job.name, stage: stage.implicit ? null : stage.name, taskIndex: stepIndex, command: d.command });
              infraRelate(ctx, "PACKAGED_AS", artifactId, imageId, pt, { tag: image.tag });
            }
            if (d.command !== "push") infraRelate(ctx, "BUILDS", pipelineId, imageId, pt, { tag: image.tag, parameters: image.parameters, job: job.name, taskIndex: stepIndex, command: d.command });
          }
        }
        for (const pub of recognized.publish) {
          const name = expandVariables(pub.artifact, vars);
          const path = pipelinePath(pub.path, vars);
          const artifactId = infraEntity(ctx, { key: `artifact|${repoId}|${p.file}|${name}`, kind: "Artifact", name, qualifiedName: `${p.file}:${name}`, file: step.source.file, line: step.source.line, metadata: { artifactType: pub.artifactType, path, parameters: placeholders(name) } }, pt);
          infraRelate(ctx, "PRODUCES_ARTIFACT", pipelineId, artifactId, pt, { job: job.name, stage: stage.implicit ? null : stage.name, taskIndex: stepIndex });
          facts.publishes.push({ taskId, pipelineId, artifactId, artifact: name, path });
        }
        for (const dl of recognized.download) {
          hasExplicitDownload = true;
          facts.downloads.push({ jobId, pipelineId, artifact: expandVariables(dl.artifact, vars) });
        }
        if (recognized.kinds.includes("artifact-download-none")) hasExplicitDownload = true;
        for (const c of recognized.copy) facts.copies.push({ pipelineId, from: pipelinePath(c.from, vars) ?? "", to: pipelinePath(c.to, vars) ?? "" });
        for (const d of recognized.deploy) {
          const images = (d.images ?? []).map((raw) => parseImageReference(expandVariables(raw, vars))).filter((x) => x !== null);
          for (const image of images) infraRelate(ctx, "DEPLOYS", jobId, imageEntity(ctx, image, pt, step.source.file, step.source.line, "declared"), pt, { via: "deployment task container override", tag: image.tag, parameters: image.parameters });
          facts.deploys.push({
            images,
            taskId, jobId, pipelineId, tool: d.tool, chart: pipelinePath(d.chart, vars), release: d.release ? expandVariables(d.release, vars) : null, namespace: d.namespace ? expandVariables(d.namespace, vars) : null,
            valueFiles: d.valueFiles.map((v) => pipelinePath(v, vars)!).filter(Boolean), manifests: d.manifests.map((m) => pipelinePath(m, vars)!).filter(Boolean), environment: job.environment, file: step.source.file, line: step.source.line,
          });
        }
      });
      if (job.deployment && !hasExplicitDownload) facts.downloads.push({ jobId, pipelineId, artifact: "*implicit" });
    });
    stage.jobs.forEach((job) => {
      for (const dep of job.dependsOn) {
        const target = jobIds.get(dep);
        if (target) infraRelate(ctx, "DEPENDS_ON_STAGE", jobIds.get(job.name)!, target, prov(job.source.file, job.source.line, "PIPELINE_JOB_DEPENDENCY"), { level: "job" });
      }
    });
  });
  const published = facts.publishes.filter((x) => x.pipelineId === pipelineId && x.path);
  const fromArtifact = (path: string) => {
    const m = /^<workspace>\/([^/]+)(?:\/(.*))?$/.exec(path);
    const source = m ? published.find((x) => x.artifact === m[1]) : undefined;
    return source ? joinPath(source.path!, m![2] ?? "") : path;
  };
  for (const d of facts.deploys.filter((x) => x.pipelineId === pipelineId)) {
    d.manifests = d.manifests.map(fromArtifact);
    d.valueFiles = d.valueFiles.map(fromArtifact);
    if (d.chart) d.chart = fromArtifact(d.chart);
  }
  p.stages.forEach((stage, i) => {
    if (stage.implicit) return;
    const sourceId = stageIds.get(stage.name)!;
    const ps = prov(stage.source.file, stage.source.line, "PIPELINE_STAGE_DEPENDENCY");
    const deps = stage.dependsOnDeclared ? stage.dependsOn : i > 0 ? [p.stages[i - 1]!.name] : [];
    for (const dep of deps) {
      const target = stageIds.get(dep);
      if (target) infraRelate(ctx, "DEPENDS_ON_STAGE", sourceId, target, ps, { level: "stage", implicit: !stage.dependsOnDeclared });
      else infraUnresolved(ctx, ID, { type: "DEPENDS_ON_STAGE", sourceId, display: dep, reason: "stage dependency not declared in this pipeline", category: "pipeline-dependency-unresolved", provenance: ps });
    }
  });
}

function taskMetadata(step: PipelineStep, kinds: string[], index: number): Metadata {
  const safeInputs = Object.entries(step.inputs)
    .filter(([k]) => /^(command|projects|arguments|repository|dockerfile|buildContext|tags|containerRegistry|artifactName|artifact|PathtoPublish|targetPath|path|chartType|chartPath|chartName|releaseName|namespace|valueFile|manifests|action|dockerComposeFile|dockerComposeCommand|imageName|sourceFolder|targetFolder|configuration|source)$/i.test(k))
    .map(([k, v]) => {
      const meta = safeValueMetadata(k, v);
      return `${k}=${meta.value ?? `<${meta.valueKind}>`}`;
    });
  return {
    order: index,
    stepType: step.kind,
    task: step.task,
    taskKinds: kinds,
    displayName: step.displayName,
    condition: step.condition,
    conditional: step.conditional,
    hook: step.hook,
    inputs: safeInputs,
    environmentVariables: Object.keys(step.env),
    scriptLines: step.script ? step.script.split(/\r?\n/).filter((l) => l.trim()).length : 0,
  };
}
