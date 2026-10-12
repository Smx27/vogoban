import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import {
  DOCKER_FACTS,
  dirOf,
  imageEntity,
  infraDiagnostic,
  infraEntity,
  infraProvenance,
  infraRelate,
  isObject,
  joinPath,
  lineOf,
  escapeRegExp,
  parseImageReference,
  parseYamlDocuments,
  redactCommandLine,
  safeValueMetadata,
  str,
  type ComposeServiceRecord,
  type DockerFacts,
} from "./common.ts";
import { DOCKERFILE_PARSER_VERSION, parseDockerfile, stageDependencies, type DockerfileFacts } from "./dockerfile.ts";

const ID = "infrastructure.docker";
const VERSION = DOCKERFILE_PARSER_VERSION;

export function resolveComposeDefaults(value: string): string {
  return value.replace(/\$\{(\w+)(:?-)([^}]*)\}/g, (_m, _name: string, _op: string, def: string) => def);
}

export const dockerPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const facts: DockerFacts = { dockerfiles: [], compose: [] };
    ctx.artifacts.set(DOCKER_FACTS, facts);
    const repoId = ctx.repository.id;
    for (const file of ctx.files.filter((f) => f.language === "docker")) {
      const name = file.path.split("/").pop()!.toLowerCase();
      const isCompose = /\.ya?ml$/.test(name);
      let text: string;
      try {
        text = await ctx.readText(file.path);
      } catch (error) {
        infraDiagnostic(ctx, ID, file.path, "infrastructure-file-unreadable", String(error), "error");
        continue;
      }
      if (isCompose) {
        parseCompose(ctx, file.path, text, facts.compose);
        continue;
      }
      const parsed: DockerfileFacts = parseDockerfile(text);
      for (const e of parsed.errors.slice(0, 10)) infraDiagnostic(ctx, ID, file.path, "dockerfile-syntax", `${e.message} (line ${e.line})`);
      if (!parsed.stages.length) continue;
      const prov = (line: number, extractor: string) => infraProvenance(ctx, ID, VERSION, extractor, "dockerfile-static", file.path, line);
      const final = parsed.stages[parsed.stages.length - 1]!;
      const finalChain: typeof parsed.stages = [];
      for (let s: (typeof parsed.stages)[number] | undefined = final; s; s = s.baseStage ? parsed.stages.find((x) => x.name === s!.baseStage && x.index < s!.index) : undefined) finalChain.unshift(s);
      const dockerfileId = infraEntity(ctx, {
        key: `dockerfile|${repoId}|${file.path}`,
        kind: "Dockerfile",
        name: file.path,
        qualifiedName: file.path,
        file: file.path,
        metadata: {
          stages: parsed.stages.map((s) => s.name ?? String(s.index)),
          finalStage: final.name ?? String(final.index),
          baseImages: [...new Set(parsed.stages.filter((s) => !s.baseStage).map((s) => s.baseResolved))],
          exposedPorts: [...new Set(finalChain.flatMap((s) => s.expose.map((e) => e.port)))],
          entrypoint: redactCommandLine(final.entrypoint ?? []),
          cmd: redactCommandLine(final.cmd ?? []),
          user: final.user,
          workdir: final.finalWorkdir,
          buildArgs: parsed.globalArgs.map((a) => a.name),
          labels: Object.entries(final.labels).map(([k, v]) => `${k}=${v}`),
          sourceHash: file.hash,
          parserVersion: VERSION,
        },
      }, prov(1, "DOCKERFILE"));
      const fileId = ctx.fileEntityId(file.path);
      if (fileId) infraRelate(ctx, "DECLARES", fileId, dockerfileId, prov(1, "DOCKERFILE"), {}, "EXACT");
      const stageIds: string[] = [];
      for (const stage of parsed.stages) {
        const p = prov(stage.line, "DOCKER_STAGE");
        const stageId = infraEntity(ctx, {
          key: `docker-stage|${repoId}|${file.path}|${stage.index}`,
          kind: "DockerStage",
          name: stage.name ?? `stage-${stage.index}`,
          qualifiedName: `${file.path}#${stage.name ?? stage.index}`,
          file: file.path,
          line: stage.line,
          metadata: {
            index: stage.index,
            base: stage.base,
            platform: stage.platform,
            workdir: stage.finalWorkdir,
            user: stage.user,
            final: stage === final,
            exposedPorts: stage.expose.map((e) => e.port),
            environmentVariables: stage.env.map((e) => e.name),
            dotnetCommands: stage.runs.flatMap((r) => r.dotnet.map((d) => `dotnet ${d.command}${d.target ? ` ${d.target}` : ""}${d.output ? ` -o ${d.output}` : ""}`)),
            copiesFrom: [...new Set(stage.copies.filter((c) => c.from).map((c) => c.from!))],
          },
        }, p);
        stageIds.push(stageId);
        infraRelate(ctx, "CONTAINS", dockerfileId, stageId, p, { order: stage.index });
        if (!stage.baseStage && stage.baseResolved.toLowerCase() !== "scratch") {
          const image = parseImageReference(stage.baseResolved);
          if (image) {
            const imageId = imageEntity(ctx, image, p, file.path, stage.line, "base");
            infraRelate(ctx, "BASED_ON", stageId, imageId, p, { tag: image.tag, digest: image.digest, raw: stage.base, parameters: image.parameters });
          }
        }
      }
      for (const stage of parsed.stages) {
        for (const dep of stageDependencies(parsed, stage)) {
          const target = parsed.stages.find((s) => (s.name ?? String(s.index)) === dep.stage);
          if (target) infraRelate(ctx, "DEPENDS_ON_STAGE", stageIds[stage.index]!, stageIds[target.index]!, prov(dep.line, "DOCKER_STAGE_DEPENDENCY"), { via: dep.via });
        }
      }
      for (const stage of finalChain) {
        for (const env of stage.env) {
          const p = prov(env.line, "DOCKER_ENV");
          const envId = infraEntity(ctx, {
            key: `env-var|${repoId}|dockerfile:${file.path}|${env.name}`,
            kind: "EnvironmentVariable",
            name: env.name,
            qualifiedName: `${file.path}:ENV ${env.name}`,
            file: file.path,
            line: env.line,
            metadata: { source: "dockerfile-env", ...safeValueMetadata(env.name, env.value) },
          }, p);
          infraRelate(ctx, "DECLARES", dockerfileId, envId, p);
        }
      }
      facts.dockerfiles.push({ entityId: dockerfileId, path: file.path, facts: parsed, stageIds });
    }
    ctx.log.info("docker.parsed", { dockerfiles: facts.dockerfiles.length, composeServices: facts.compose.length });
  },
};

function parseCompose(ctx: AnalysisContext, path: string, text: string, out: ComposeServiceRecord[]) {
  const { documents, errors } = parseYamlDocuments(text);
  for (const e of errors) infraDiagnostic(ctx, ID, path, "compose-yaml-invalid", `${e.message} (line ${e.line})`);
  const doc = documents[0]?.value;
  if (!isObject(doc) || !isObject(doc.services)) return;
  const lines = text.split(/\r?\n/);
  for (const [service, def] of Object.entries(doc.services).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isObject(def)) continue;
    const line = lineOf(lines, new RegExp(`^\\s+${escapeRegExp(service)}:\\s*$`));
    const build = isObject(def.build) ? def.build : str(def.build) ? { context: str(def.build) } : null;
    const rawImage = str(def.image);
    const image = rawImage ? parseImageReference(resolveComposeDefaults(rawImage)) : null;
    if (image) image.parameters = [...rawImage!.matchAll(/\$\{[^}]+\}/g)].map((m) => m[0]);
    const context = build && str(build.context) !== null ? joinPath(dirOf(path), resolveComposeDefaults(str(build.context)!)) : null;
    const dockerfile = build ? joinPath(context ?? dirOf(path), resolveComposeDefaults(str(build.dockerfile) ?? "Dockerfile")) : null;
    const existing = out.find((r) => r.service === service && r.dockerfile === dockerfile && r.image?.name === image?.name);
    if (existing || !build) continue;
    out.push({ file: path, service, dockerfile, context, target: build ? str(build.target) : null, image, imageId: null, line });
  }
}
