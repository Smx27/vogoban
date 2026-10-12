import type { PipelineStep } from "./azure-pipelines.ts";

export interface RecognizedDocker {
  command: "build" | "push" | "buildAndPush" | "compose-build" | "compose-push";
  images: string[];
  dockerfile: string | null;
  context: string | null;
  registryConnection: string | null;
  composeFile: string | null;
  composeServices: string[] | null;
}

export interface RecognizedTask {
  kinds: string[];
  dotnet: { command: string; projects: string[]; output: string | null }[];
  docker: RecognizedDocker[];
  publish: { artifact: string; path: string | null; artifactType: string }[];
  download: { artifact: string }[];
  deploy: { tool: "helm" | "kubectl"; chart: string | null; release: string | null; namespace: string | null; valueFiles: string[]; manifests: string[]; images?: string[] }[];
  copy: { from: string; to: string }[];
}

type Recognizer = (step: PipelineStep, input: (name: string) => string | null) => Partial<RecognizedTask> | null;

const lines = (v: string | null) => (v ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);

function shellWords(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

function flag(ws: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    for (const n of names) {
      if (w === n && ws[i + 1] !== undefined) out.push(ws[i + 1]!);
      else if (w.startsWith(`${n}=`)) out.push(w.slice(n.length + 1));
    }
  }
  return out;
}

function positional(ws: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (w.startsWith("-")) {
      if (valueFlags.has(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

const DOTNET_VALUE_FLAGS = new Set(["-c", "--configuration", "-o", "--output", "-r", "--runtime", "-f", "--framework", "-p", "--property", "-s", "--source", "-v", "--verbosity", "--logger", "-l", "--results-directory", "--collect", "--settings", "--version-suffix", "-a", "--arch", "--os"]);
const DOCKER_VALUE_FLAGS = new Set(["-t", "--tag", "-f", "--file", "--build-arg", "--target", "--platform", "--label", "--network", "--cache-from", "-o", "--output", "--secret", "--progress", "--registry", "-r", "--image", "--name", "-n", "--namespace", "--values", "--set", "--set-string", "--version", "--kube-context", "--timeout", "--context", "-l", "--selector", "--resource-group", "-g"]);

function scriptCommands(script: string): Partial<RecognizedTask> {
  const result: Partial<RecognizedTask> = { kinds: [], dotnet: [], docker: [], deploy: [] };
  const joined = script.replace(/\\\r?\n/g, " ").replace(/`\r?\n/g, " ");
  for (const raw of joined.split(/\r?\n|&&|;/)) {
    const ws = shellWords(raw.trim());
    const i = ws.findIndex((w) => /^(dotnet|docker|helm|kubectl|az|docker-compose)$/.test(w));
    if (i < 0) continue;
    const tool = ws[i]!;
    const args = ws.slice(i + 1);
    if (tool === "dotnet" && /^(build|test|publish|pack|restore)$/.test(args[0] ?? "")) {
      result.kinds!.push(`dotnet-${args[0]}`);
      result.dotnet!.push({ command: args[0]!, projects: positional(args.slice(1), DOTNET_VALUE_FLAGS).slice(0, 1), output: flag(args, ["-o", "--output"])[0] ?? null });
    } else if (tool === "docker" && (args[0] === "build" || (args[0] === "buildx" && args[1] === "build"))) {
      const rest = args[0] === "buildx" ? args.slice(2) : args.slice(1);
      result.kinds!.push("docker-build");
      result.docker!.push({ command: rest.includes("--push") ? "buildAndPush" : "build", images: flag(rest, ["-t", "--tag"]), dockerfile: flag(rest, ["-f", "--file"])[0] ?? null, context: positional(rest, DOCKER_VALUE_FLAGS)[0] ?? null, registryConnection: null, composeFile: null, composeServices: null });
    } else if (tool === "docker" && args[0] === "push") {
      result.kinds!.push("docker-push");
      result.docker!.push({ command: "push", images: positional(args.slice(1), DOCKER_VALUE_FLAGS).slice(0, 1), dockerfile: null, context: null, registryConnection: null, composeFile: null, composeServices: null });
    } else if ((tool === "docker-compose" || (tool === "docker" && args[0] === "compose"))) {
      const rest = tool === "docker" ? args.slice(1) : args;
      const verb = positional(rest, new Set(["-f", "--file", "-p", "--project-name", "--env-file"]))[0];
      if (verb !== "build" && verb !== "push") continue;
      result.kinds!.push(`docker-compose-${verb}`);
      const services = positional(rest.slice(rest.indexOf(verb) + 1), new Set());
      result.docker!.push({ command: verb === "build" ? "compose-build" : "compose-push", images: [], dockerfile: null, context: null, registryConnection: null, composeFile: flag(rest, ["-f", "--file"])[0] ?? null, composeServices: services.length ? services : null });
    } else if (tool === "az" && args[0] === "acr" && args[1] === "build") {
      result.kinds!.push("docker-build");
      result.docker!.push({ command: "buildAndPush", images: flag(args, ["-t", "--image", "--tag"]), dockerfile: flag(args, ["-f", "--file"])[0] ?? null, context: positional(args.slice(2), DOCKER_VALUE_FLAGS)[0] ?? null, registryConnection: flag(args, ["-r", "--registry"])[0] ?? null, composeFile: null, composeServices: null });
    } else if (tool === "helm" && /^(upgrade|install)$/.test(args[0] ?? "")) {
      const pos = positional(args.slice(1), new Set([...DOCKER_VALUE_FLAGS, "-f"]));
      result.kinds!.push("helm-deploy");
      result.deploy!.push({ tool: "helm", release: pos[0] ?? null, chart: pos[1] ?? null, namespace: flag(args, ["-n", "--namespace"])[0] ?? null, valueFiles: flag(args, ["-f", "--values"]), manifests: [] });
    } else if (tool === "kubectl" && /^(apply|create|replace)$/.test(args[0] ?? "")) {
      result.kinds!.push("kubectl-apply");
      result.deploy!.push({ tool: "kubectl", release: null, chart: null, namespace: flag(args, ["-n", "--namespace"])[0] ?? null, valueFiles: [], manifests: [...flag(args, ["-f", "--filename"]), ...flag(args, ["-k", "--kustomize"])] });
    }
  }
  return result;
}

function registryFrom(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { loginServer?: string };
    if (parsed.loginServer) return parsed.loginServer;
  } catch {}
  return /^[\w.-]+\.[a-z]{2,}$/i.test(value) ? value : null;
}

const RECOGNIZERS: Record<string, Recognizer> = {
  DotNetCoreCLI: (_s, input) => {
    const command = (input("command") ?? "build").toLowerCase();
    const args = shellWords(input("arguments") ?? "");
    const kinds = [`dotnet-${command}`];
    const projects = lines(input("projects") ?? input("searchPatternPack") ?? input("packagesToPack"));
    const result: Partial<RecognizedTask> = { kinds, dotnet: [{ command, projects, output: flag(args, ["-o", "--output"])[0] ?? input("outputDir") ?? null }] };
    if (command === "push") result.publish = [{ artifact: `nuget:${input("packagesToPush") ?? "$(Build.ArtifactStagingDirectory)/*.nupkg"}`, path: input("packagesToPush"), artifactType: "nuget-package" }];
    return result;
  },
  NuGetCommand: (_s, input) => {
    const command = (input("command") ?? "restore").toLowerCase();
    if (command === "push") return { kinds: ["nuget-push"], publish: [{ artifact: `nuget:${input("packagesToPush") ?? "*.nupkg"}`, path: input("packagesToPush"), artifactType: "nuget-package" }] };
    return { kinds: [`nuget-${command}`] };
  },
  Docker: (s, input) => {
    const major = Number((s.task ?? "").split("@")[1] ?? "2");
    if (major >= 2) {
      const command = (input("command") ?? "buildAndPush") as string;
      if (!/^(build|push|buildAndPush)$/.test(command)) return { kinds: [`docker-${command.toLowerCase()}`] };
      const repository = input("repository");
      const tags = lines(input("tags") ?? "$(Build.BuildId)");
      const images = repository ? tags.map((t) => `${repository}:${t}`) : [];
      return {
        kinds: command === "buildAndPush" ? ["docker-build", "docker-push"] : [`docker-${command}`],
        docker: [{ command: command as RecognizedDocker["command"], images, dockerfile: input("Dockerfile") ?? input("dockerfile") ?? "**/Dockerfile", context: input("buildContext"), registryConnection: input("containerRegistry"), composeFile: null, composeServices: null }],
      };
    }
    const action = (input("action") ?? input("command") ?? "Build an image").toLowerCase();
    const command = action.includes("push") ? "push" : action.includes("build") ? "build" : null;
    if (!command) return { kinds: ["docker-other"] };
    const registry = registryFrom(input("azureContainerRegistry"));
    const image = input("imageName") ?? "$(Build.Repository.Name):$(Build.BuildId)";
    const qualify = (input("qualifyImageName") ?? "true") !== "false" && registry;
    return { kinds: [`docker-${command}`], docker: [{ command, images: [qualify ? `${registry}/${image}` : image], dockerfile: input("dockerFile") ?? "**/Dockerfile", context: input("buildContext"), registryConnection: input("dockerRegistryEndpoint") ?? input("dockerRegistryConnection"), composeFile: null, composeServices: null }] };
  },
  DockerCompose: (_s, input) => {
    const command = (input("dockerComposeCommand") ?? input("action") ?? "").trim();
    const verb = /push/i.test(command) ? "push" : /build/i.test(command) ? "build" : null;
    if (!verb) return { kinds: ["docker-compose-other"] };
    const services = /^(build|push)\s+(.+)$/i.exec(command)?.[2]?.split(/\s+/).filter((w) => !w.startsWith("-")) ?? lines(input("serviceName"));
    return { kinds: [`docker-compose-${verb}`], docker: [{ command: verb === "build" ? "compose-build" : "compose-push", images: [], dockerfile: null, context: null, registryConnection: input("dockerRegistryEndpoint") ?? registryFrom(input("azureContainerRegistry")), composeFile: input("dockerComposeFile") ?? "**/docker-compose.yml", composeServices: services.length ? services : null }] };
  },
  PublishBuildArtifacts: (_s, input) => ({ kinds: ["artifact-publish"], publish: [{ artifact: input("ArtifactName") ?? input("artifactName") ?? "drop", path: input("PathtoPublish") ?? input("pathToPublish") ?? input("pathtoPublish") ?? "$(Build.ArtifactStagingDirectory)", artifactType: "build-artifact" }] }),
  PublishPipelineArtifact: (_s, input) => ({ kinds: ["artifact-publish"], publish: [{ artifact: input("artifactName") ?? input("artifact") ?? "$(System.JobAttempt)", path: input("targetPath") ?? input("path") ?? "$(Pipeline.Workspace)", artifactType: "pipeline-artifact" }] }),
  DownloadBuildArtifacts: (_s, input) => ({ kinds: ["artifact-download"], download: [{ artifact: input("artifactName") ?? "*" }] }),
  DownloadPipelineArtifact: (_s, input) => ({ kinds: ["artifact-download"], download: [{ artifact: input("artifactName") ?? input("artifact") ?? "*" }] }),
  CopyFiles: (_s, input) => ({ kinds: ["copy-files"], copy: [{ from: input("SourceFolder") ?? input("sourceFolder") ?? "$(Build.SourcesDirectory)", to: input("TargetFolder") ?? input("targetFolder") ?? "" }] }),
  ArchiveFiles: (_s, input) => ({ kinds: ["archive"], copy: [{ from: input("rootFolderOrFile") ?? "", to: input("archiveFile") ?? "" }] }),
  HelmDeploy: (_s, input) => {
    const command = (input("command") ?? "ls").toLowerCase();
    if (!/^(install|upgrade)$/.test(command)) return { kinds: [`helm-${command}`] };
    const chartType = (input("chartType") ?? "Name").toLowerCase();
    return { kinds: ["helm-deploy"], deploy: [{ tool: "helm", chart: chartType === "filepath" ? input("chartPath") : input("chartName"), release: input("releaseName"), namespace: input("namespace"), valueFiles: lines(input("valueFile")), manifests: [] }] };
  },
  HelmInstaller: () => ({ kinds: ["helm-install-tool"] }),
  KubernetesManifest: (_s, input) => {
    const action = (input("action") ?? "deploy").toLowerCase();
    if (action !== "deploy") return { kinds: [`kubernetes-${action}`] };
    return { kinds: ["kubernetes-deploy"], deploy: [{ tool: "kubectl", chart: null, release: null, namespace: input("namespace"), valueFiles: [], manifests: lines(input("manifests")), images: (input("containers") ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }] };
  },
  Kubernetes: (_s, input) => {
    const command = (input("command") ?? "").toLowerCase();
    if (!/^(apply|create|replace)$/.test(command)) return { kinds: [`kubernetes-${command || "command"}`] };
    const args = shellWords(input("arguments") ?? "");
    const manifests = [...flag(args, ["-f", "--filename"]), ...(input("useConfigurationFile") === "true" && input("configuration") ? [input("configuration")!] : [])];
    return { kinds: ["kubernetes-deploy"], deploy: [{ tool: "kubectl", chart: null, release: null, namespace: input("namespace"), valueFiles: [], manifests }] };
  },
  AzureWebApp: () => ({ kinds: ["azure-webapp-deploy"] }),
  AzureRmWebAppDeployment: () => ({ kinds: ["azure-webapp-deploy"] }),
  AzureFunctionApp: () => ({ kinds: ["azure-functionapp-deploy"] }),
  VSTest: () => ({ kinds: ["dotnet-test"] }),
  VSBuild: (_s, input) => ({ kinds: ["msbuild"], dotnet: [{ command: "build", projects: lines(input("solution")), output: null }] }),
  UseDotNet: () => ({ kinds: ["dotnet-sdk-install"] }),
  AzureCLI: (_s, input) => scriptCommands(input("inlineScript") ?? ""),
  PowerShell: (_s, input) => scriptCommands(input("script") ?? ""),
  Bash: (_s, input) => scriptCommands(input("script") ?? ""),
  CmdLine: (_s, input) => scriptCommands(input("script") ?? ""),
};

export function recognizeStep(step: PipelineStep): RecognizedTask {
  const result: RecognizedTask = { kinds: [], dotnet: [], docker: [], publish: [], download: [], deploy: [], copy: [] };
  const lowerInputs = new Map(Object.entries(step.inputs).map(([k, v]) => [k.toLowerCase(), v]));
  const input = (name: string) => lowerInputs.get(name.toLowerCase()) ?? null;
  let partial: Partial<RecognizedTask> | null = null;
  if (step.task) {
    const name = step.task.split("@")[0]!;
    const recognizer = RECOGNIZERS[name];
    partial = recognizer ? recognizer(step, input) : { kinds: [`task:${name}`] };
    if (!partial?.kinds?.length) partial = { ...partial, kinds: [`task:${name}`] };
  } else if (step.script) {
    partial = scriptCommands(step.script);
    if (!partial.kinds?.length) partial.kinds = ["script"];
  } else if (step.kind === "publish") {
    partial = { kinds: ["artifact-publish"], publish: [{ artifact: input("artifact") ?? "$(System.JobAttempt)", path: input("path"), artifactType: "pipeline-artifact" }] };
  } else if (step.kind === "download") {
    partial = input("source") === "none" ? { kinds: ["artifact-download-none"] } : { kinds: ["artifact-download"], download: [{ artifact: input("artifact") ?? "*" }] };
  } else {
    partial = { kinds: [step.kind] };
  }
  for (const key of Object.keys(result) as (keyof RecognizedTask)[]) (result[key] as unknown[]).push(...((partial?.[key] as unknown[] | undefined) ?? []));
  return result;
}
