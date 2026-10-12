import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import {
  KUBERNETES_INPUT,
  PIPELINE_FACTS,
  configuredEnvironment,
  environmentEntity,
  escapeRegExp,
  infraDiagnostic,
  infraEntity,
  infraProvenance,
  infraRelate,
  isObject,
  lineOf,
  list,
  parseYamlDocuments,
  str,
  type HelmReleaseRecord,
  type Json,
  type KubernetesInput,
  type ManifestDocument,
} from "./common.ts";
import { HELM_TEMPLATE_ENGINE_VERSION, HelmRenderer, Unresolved, collectDefines, deepMerge, parseTemplate } from "./helm-template.ts";

const ID = "infrastructure.helm";
const VERSION = HELM_TEMPLATE_ENGINE_VERSION;

interface Profile {
  key: string;
  label: string;
  valueFiles: string[];
  releaseName: string | null;
  namespace: string | null;
  environment: string | null;
  environmentBasis: string | null;
  declaredBy: { pipelineId: string; jobId: string; taskId: string; file: string; line: number } | null;
}

export const helmPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const input: KubernetesInput = { documents: [], releases: [], charts: [] };
    ctx.artifacts.set(KUBERNETES_INPUT, input);
    const repoId = ctx.repository.id;
    const deploys = ctx.artifacts.get(PIPELINE_FACTS)?.deploys.filter((d) => d.tool === "helm") ?? [];
    const filesByPath = new Map(ctx.files.map((f) => [f.path, f]));
    const readYaml = async (path: string): Promise<Json | null> => {
      try {
        const text = filesByPath.has(path) ? await ctx.readText(path) : await Bun.file(`${ctx.repository.rootPath}/${path}`).text();
        const { documents, errors } = parseYamlDocuments(text);
        for (const e of errors) infraDiagnostic(ctx, ID, path, "helm-values-invalid", `${e.message} (line ${e.line})`);
        return documents[0]?.value ?? {};
      } catch {
        return null;
      }
    };
    const sharedValues: Json[] = [];
    for (const path of ctx.config.infrastructure.helmValues) {
      const v = await readYaml(path);
      if (v === null) infraDiagnostic(ctx, ID, "vogoban.json", "helm-values-missing", `configured Helm values file not found: ${path}`);
      else sharedValues.push(v);
    }

    for (const chartFile of ctx.files.filter((f) => /(^|\/)Chart\.yaml$/.test(f.path))) {
      const dir = chartFile.path.slice(0, -"Chart.yaml".length);
      const chartProv = infraProvenance(ctx, ID, VERSION, "HELM_CHART", "helm-static", chartFile.path, 1);
      const chart = await readYaml(chartFile.path);
      if (!isObject(chart) || !str(chart.name)) {
        infraDiagnostic(ctx, ID, chartFile.path, "helm-chart-invalid", "Chart.yaml has no name");
        continue;
      }
      const chartName = str(chart.name)!;
      const templates = ctx.files.filter((f) => f.path.startsWith(`${dir}templates/`) && !f.path.slice(dir.length).includes("/charts/"));
      const valueFiles = ctx.files.filter((f) => f.path.startsWith(dir) && /^values[\w.-]*\.ya?ml$/i.test(f.path.slice(dir.length))).map((f) => f.path);
      const chartId = infraEntity(ctx, {
        key: `helm-chart|${repoId}|${dir}`,
        kind: "HelmChart",
        name: chartName,
        qualifiedName: `${dir}${chartName}`,
        file: chartFile.path,
        metadata: {
          version: str(chart.version),
          appVersion: str(chart.appVersion),
          apiVersion: str(chart.apiVersion),
          chartType: str(chart.type) ?? "application",
          description: str(chart.description),
          dependencies: list(chart.dependencies).filter(isObject).map((d) => `${str(d.name)}@${str(d.version) ?? "*"}${str(d.repository) ? ` (${str(d.repository)})` : ""}`),
          templates: templates.map((t) => t.path.slice(dir.length)),
          valuesFiles: valueFiles.map((v) => v.slice(dir.length)),
          sourceHash: chartFile.hash,
          parserVersion: VERSION,
        },
      }, chartProv);
      input.charts.push({ entityId: chartId, dir, name: chartName });
      const fileId = ctx.fileEntityId(chartFile.path);
      if (fileId) infraRelate(ctx, "DECLARES", fileId, chartId, chartProv, {}, "EXACT");
      if (str(chart.type) === "library") continue;

      const parsedTemplates: { path: string; nodes: ReturnType<typeof parseTemplate>; lines: string[] }[] = [];
      const defines = new Map<string, ReturnType<typeof parseTemplate>>();
      for (const t of templates) {
        try {
          const text = await ctx.readText(t.path);
          const nodes = parseTemplate(text);
          collectDefines(nodes, defines);
          parsedTemplates.push({ path: t.path, nodes, lines: text.split(/\r?\n/) });
        } catch (error) {
          infraDiagnostic(ctx, ID, t.path, "helm-template-unsupported", error instanceof Error ? error.message : String(error));
        }
      }
      const defaultValuesPath = valueFiles.find((v) => /^values\.ya?ml$/i.test(v.slice(dir.length)));
      const profiles: Profile[] = [{ key: "default", label: "default", valueFiles: defaultValuesPath ? [defaultValuesPath] : [], releaseName: null, namespace: null, environment: configuredEnvironment(ctx, dir), environmentBasis: configuredEnvironment(ctx, dir) ? "configured" : null, declaredBy: null }];
      for (const overlay of valueFiles.filter((v) => v !== defaultValuesPath)) {
        const env = configuredEnvironment(ctx, overlay);
        profiles.push({ key: overlay, label: overlay.slice(dir.length), valueFiles: [...(defaultValuesPath ? [defaultValuesPath] : []), overlay], releaseName: null, namespace: null, environment: env, environmentBasis: env ? "configured" : null, declaredBy: null });
      }
      for (const d of deploys) {
        const chartPath = d.chart?.replace(/\/+$/, "") ?? "";
        const chartDir = dir.replace(/\/+$/, "");
        if (!chartPath || (chartPath !== chartDir && !chartPath.endsWith(`/${chartDir}`))) continue;
        const files = [...(defaultValuesPath ? [defaultValuesPath] : []), ...d.valueFiles];
        profiles.push({
          key: `pipeline|${d.file}|${d.line}|${d.release ?? ""}`, label: `${d.release ?? chartName} via ${d.file}`, valueFiles: files, releaseName: d.release, namespace: d.namespace,
          environment: d.environment, environmentBasis: d.environment ? "pipeline-deployment-environment" : null, declaredBy: { pipelineId: d.pipelineId, jobId: d.jobId, taskId: d.taskId, file: d.file, line: d.line },
        });
      }

      for (const profile of profiles) {
        let values: Json = {};
        const loaded: string[] = [];
        if (profile.valueFiles[0] === defaultValuesPath && defaultValuesPath) {
          values = (await readYaml(defaultValuesPath)) ?? {};
          loaded.push(defaultValuesPath);
        }
        for (const shared of sharedValues) values = deepMerge(values, shared) as Json;
        for (const f of profile.valueFiles.filter((f) => f !== defaultValuesPath)) {
          const v = await readYaml(f);
          if (v === null) infraDiagnostic(ctx, ID, profile.declaredBy?.file ?? null, "helm-values-missing", `values file not found: ${f}`);
          else {
            values = deepMerge(values, v) as Json;
            loaded.push(f);
          }
        }
        const prov = infraProvenance(ctx, ID, VERSION, "HELM_RELEASE", "helm-static-render", profile.declaredBy?.file ?? chartFile.path, profile.declaredBy?.line ?? 1);
        const root = {
          Values: values,
          Chart: { Name: chartName, Version: str(chart.version), AppVersion: str(chart.appVersion), ...(isObject(chart) ? chart : {}) },
          Release: { Name: profile.releaseName ?? new Unresolved(".Release.Name", false), Namespace: profile.namespace ?? new Unresolved(".Release.Namespace", false), Service: "Helm", IsInstall: true, IsUpgrade: false, Revision: 1 },
          Capabilities: new Unresolved(".Capabilities", false),
          Files: new Unresolved(".Files", false),
          Template: { BasePath: `${chartName}/templates`, Name: "" },
        };
        const image = isObject(values) && isObject(values.image) ? values.image : null;
        const releaseId = infraEntity(ctx, {
          key: `helm-release|${repoId}|${dir}|${profile.key}`,
          kind: "HelmRelease",
          name: profile.releaseName ?? `${chartName} (${profile.label})`,
          qualifiedName: `${dir}${chartName}#${profile.label}`,
          file: profile.declaredBy?.file ?? chartFile.path,
          line: profile.declaredBy?.line ?? 1,
          metadata: {
            chart: chartName,
            profile: profile.label,
            valueFiles: loaded,
            sharedValueFiles: ctx.config.infrastructure.helmValues,
            releaseName: profile.releaseName,
            namespace: profile.namespace,
            environment: profile.environment,
            declaredByPipeline: profile.declaredBy !== null,
            imageRepository: image ? str(image.repository) : null,
            imageTag: image ? str(image.tag) : null,
            replicaCount: isObject(values) && typeof values.replicaCount === "number" ? values.replicaCount : null,
            servicePort: isObject(values) && isObject(values.service) ? str(values.service.port) : null,
            ingressEnabled: isObject(values) && isObject(values.ingress) ? values.ingress.enabled === true : null,
          },
        }, prov);
        infraRelate(ctx, "CONTAINS", chartId, releaseId, prov, { profile: profile.label });
        if (profile.environment) infraRelate(ctx, "IN_ENVIRONMENT", releaseId, environmentEntity(ctx, profile.environment, prov, profile.environmentBasis ?? "configured"), prov, { basis: profile.environmentBasis });
        if (profile.declaredBy) {
          infraRelate(ctx, "DEPLOYS", profile.declaredBy.pipelineId, releaseId, prov, { job: profile.declaredBy.jobId, task: profile.declaredBy.taskId, tool: "helm" });
          infraRelate(ctx, "DEPLOYS", profile.declaredBy.jobId, releaseId, prov, { tool: "helm" });
        }
        const record: HelmReleaseRecord = { entityId: releaseId, chartId, chartDir: dir, chartName, valueFiles: loaded, releaseName: profile.releaseName, environment: profile.environment };
        input.releases.push(record);
        for (const t of parsedTemplates) {
          const name = t.path.split("/").pop()!;
          if (name.startsWith("_") || !/\.(ya?ml|json)$/i.test(name)) continue;
          const state = { defines, root: { ...root, Template: { ...root.Template, Name: t.path.slice(dir.length) } }, conditional: false, depth: 0 };
          let rendered: string;
          try {
            rendered = new HelmRenderer(state).render(t.nodes);
          } catch (error) {
            infraDiagnostic(ctx, ID, t.path, "helm-template-unsupported", error instanceof Error ? error.message : String(error));
            continue;
          }
          const { documents, errors } = parseYamlDocuments(rendered);
          for (const e of errors) infraDiagnostic(ctx, ID, t.path, "helm-rendered-yaml-invalid", `${profile.label}: ${e.message.split("\n")[0]}`);
          for (const doc of documents) {
            if (!isObject(doc.value) || !str(doc.value.kind)) continue;
            const kind = str(doc.value.kind)!;
            input.documents.push({
              value: doc.value,
              file: t.path,
              line: lineOf(t.lines, new RegExp(`^\\s*kind:\\s*['"]?${escapeRegExp(kind)}`)),
              scope: `helm:${releaseId}`,
              scopeKind: "helm-release",
              releaseId,
              releaseLabel: profile.releaseName ?? `${chartName} (${profile.label})`,
              environment: profile.environment,
              conditional: state.conditional,
            } satisfies ManifestDocument);
          }
        }
      }
    }
    ctx.log.info("helm.rendered", { charts: input.charts.length, releases: input.releases.length, documents: input.documents.length });
  },
};
