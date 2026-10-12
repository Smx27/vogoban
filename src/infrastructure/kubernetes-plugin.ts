import type { Metadata } from "../graph/model.ts";
import { globToRegExp } from "../dotnet/msbuild.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import {
  KUBERNETES_FACTS,
  KUBERNETES_INPUT,
  PIPELINE_FACTS,
  bucketKey,
  configuredEnvironment,
  dirOf,
  environmentEntity,
  imageEntity,
  infraDiagnostic,
  infraEntity,
  infraProvenance,
  infraRelate,
  infraUnresolved,
  isObject,
  list,
  lineOf,
  escapeRegExp,
  parseImageReference,
  parseYamlDocuments,
  safeValueMetadata,
  secretValueState,
  redactCommandLine,
  str,
  type JsonObject,
  type KubernetesFacts,
  type ManifestDocument,
  type PipelineDeploy,
  type WorkloadRecord,
} from "./common.ts";

const ID = "infrastructure.kubernetes";
const VERSION = "1";
const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const SUPPORTED = new Set([...WORKLOADS, "Namespace", "Service", "Ingress", "ConfigMap", "Secret", "ServiceAccount", "HorizontalPodAutoscaler", "List"]);

const labelsOf = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (str(x) !== null) out[k] = str(x)!;
  return out;
};
const kv = (m: Record<string, string>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
const isPlaceholderOnly = (s: string) => s.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\{\{[^}]*\}\}|[/:.-]/g, "").trim() === "";

function podSpecOf(kind: string, spec: JsonObject): JsonObject | null {
  if (kind === "Pod") return spec;
  if (kind === "CronJob") {
    const jobTemplate = isObject(spec.jobTemplate) ? spec.jobTemplate : null;
    const jobSpec = jobTemplate && isObject(jobTemplate.spec) ? jobTemplate.spec : null;
    const template = jobSpec && isObject(jobSpec.template) ? jobSpec.template : null;
    return template && isObject(template.spec) ? template.spec : null;
  }
  const template = isObject(spec.template) ? spec.template : null;
  return template && isObject(template.spec) ? template.spec : null;
}

function podLabelsOf(kind: string, spec: JsonObject): Record<string, string> {
  if (kind === "Pod") return {};
  const template = kind === "CronJob" ? (isObject(spec.jobTemplate) && isObject(spec.jobTemplate.spec) && isObject(spec.jobTemplate.spec.template) ? spec.jobTemplate.spec.template : null) : isObject(spec.template) ? spec.template : null;
  return template && isObject(template.metadata) ? labelsOf(template.metadata.labels) : {};
}

export const kubernetesPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const facts: KubernetesFacts = { workloads: [], services: [], ingresses: [], named: [], environmentVariables: [] };
    ctx.artifacts.set(KUBERNETES_FACTS, facts);
    const input = ctx.artifacts.get(KUBERNETES_INPUT) ?? { documents: [], releases: [], charts: [] };
    const chartDirs = input.charts.map((c) => c.dir);
    const kubectlDeploys = ctx.artifacts.get(PIPELINE_FACTS)?.deploys.filter((d) => d.tool === "kubectl") ?? [];
    const documents: ManifestDocument[] = [...input.documents];
    const deployedBy = new Map<string, PipelineDeploy[]>();
    const matchedManifests = new Set<string>();
    for (const file of ctx.files) {
      if (file.category !== "infrastructure" || file.language !== "yaml" || !/\.ya?ml$/i.test(file.path)) continue;
      if (chartDirs.some((d) => file.path.startsWith(d))) continue;
      let text: string;
      try {
        text = await ctx.readText(file.path);
      } catch {
        continue;
      }
      if (!/^\s*kind:/m.test(text)) continue;
      const { documents: docs, errors } = parseYamlDocuments(text);
      for (const e of errors) infraDiagnostic(ctx, ID, file.path, "kubernetes-yaml-invalid", `${e.message.split("\n")[0]} (document at line ${e.line})`);
      const deploys = kubectlDeploys.filter((d) =>
        d.manifests.filter((m) => m === file.path || file.path.startsWith(`${m.replace(/\/+$/, "")}/`) || globToRegExp(m).test(file.path)).map((m) => matchedManifests.add(`${d.taskId}|${m}`)).length > 0,
      );
      if (deploys.length) deployedBy.set(file.path, deploys);
      const env = deploys.find((d) => d.environment)?.environment ?? configuredEnvironment(ctx, file.path);
      const lines = text.split(/\r?\n/);
      for (const doc of docs) {
        if (!isObject(doc.value) || !str(doc.value.kind) || !str(doc.value.apiVersion)) continue;
        const items = str(doc.value.kind) === "List" ? list(doc.value.items).filter(isObject) : [doc.value];
        for (const item of items) {
          documents.push({
            value: item,
            file: file.path,
            line: lineOf(lines, new RegExp(`^\\s*kind:\\s*['"]?${escapeRegExp(str(item.kind) ?? "")}`), doc.startLine, doc.endLine),
            scope: `file:${file.path}`,
            scopeKind: "manifest",
            releaseId: null,
            releaseLabel: null,
            environment: env,
            conditional: false,
          });
        }
      }
    }
    for (const kubectl of kubectlDeploys) {
      for (const m of kubectl.manifests) {
        if (!matchedManifests.has(`${kubectl.taskId}|${m}`)) {
          infraUnresolved(ctx, ID, { type: "DEPLOYS", sourceId: kubectl.jobId, display: m, reason: "manifest path does not match a Kubernetes manifest in the repository", category: "deployment-target-unresolved", provenance: infraProvenance(ctx, ID, VERSION, "PIPELINE_KUBECTL_DEPLOY", "azure-pipelines-yaml", kubectl.file, kubectl.line) });
        }
      }
    }
    const unsupported = new Map<string, Set<string>>();
    for (const doc of documents) {
      const kind = str(doc.value.kind)!;
      if (!SUPPORTED.has(kind)) {
        const set = unsupported.get(doc.file) ?? new Set();
        set.add(kind);
        unsupported.set(doc.file, set);
        continue;
      }
      try {
        emitResource(ctx, doc, facts, deployedBy.get(doc.file) ?? []);
      } catch (error) {
        infraDiagnostic(ctx, ID, doc.file, "kubernetes-resource-failed", `${kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [file, kinds] of unsupported) infraDiagnostic(ctx, ID, file, "kubernetes-kind-unsupported", `not modelled: ${[...kinds].sort().join(", ")}`, "info");
    ctx.log.info("kubernetes.resources", { workloads: facts.workloads.length, services: facts.services.length, ingresses: facts.ingresses.length, other: facts.named.length });
  },
};

function emitResource(ctx: AnalysisContext, doc: ManifestDocument, facts: KubernetesFacts, deploys: PipelineDeploy[]) {
  const repoId = ctx.repository.id;
  const v = doc.value;
  const kind = str(v.kind)!;
  const meta = isObject(v.metadata) ? v.metadata : {};
  const name = str(meta.name) ?? str(meta.generateName) ?? "(unnamed)";
  const rawNamespace = kind === "Namespace" ? null : str(meta.namespace);
  const namespace = rawNamespace;
  const scope = doc.scopeKind === "helm-release" ? doc.scope : doc.environment ? `env:${doc.environment}` : `dir:${dirOf(doc.file)}`;
  const bucket = bucketKey(namespace, scope);
  const scopeLabel = doc.releaseLabel ? `${doc.releaseLabel}::` : "";
  const prov = infraProvenance(ctx, ID, VERSION, `KUBERNETES_${kind.toUpperCase()}`, doc.scopeKind === "helm-release" ? "helm-static-render" : "kubernetes-yaml", doc.file, doc.line);
  const baseKey = `k8s|${repoId}|${doc.scope}|${kind}|${namespace ?? ""}|${name}`;
  const common: Metadata = {
    resourceKind: kind,
    apiVersion: str(v.apiVersion),
    namespace,
    labels: kv(labelsOf(meta.labels)),
    sourceScope: doc.scopeKind,
    helmRelease: doc.releaseId,
    environment: doc.environment,
    conditionalRender: doc.conditional,
  };
  const link = (entityId: string) => {
    const fileId = ctx.fileEntityId(doc.file);
    if (fileId && doc.scopeKind === "manifest") infraRelate(ctx, "DECLARES", fileId, entityId, prov, {}, "EXACT");
    if (doc.releaseId) infraRelate(ctx, "CONTAINS_RESOURCE", doc.releaseId, entityId, prov, { template: doc.file });
    if (doc.environment) infraRelate(ctx, "IN_ENVIRONMENT", entityId, environmentEntity(ctx, doc.environment, prov, doc.scopeKind === "helm-release" ? "helm-release-environment" : deploys.length ? "pipeline-deployment-environment" : "configured"), prov);
    if (namespace && !/\$\{|\$\(/.test(namespace)) {
      const nsId = infraEntity(ctx, { key: `k8s-namespace|${repoId}|${doc.environment ?? ""}|${namespace}`, kind: "KubernetesNamespace", name: namespace, qualifiedName: `namespace:${namespace}${doc.environment ? `@${doc.environment}` : ""}`, metadata: { environment: doc.environment, declaredBy: "reference" } }, prov);
      infraRelate(ctx, "RUNS_IN", entityId, nsId, prov);
    }
    for (const d of deploys) {
      const dp = infraProvenance(ctx, ID, VERSION, "PIPELINE_KUBECTL_DEPLOY", "azure-pipelines-yaml", d.file, d.line);
      infraRelate(ctx, "DEPLOYS", d.pipelineId, entityId, dp, { tool: "kubectl", job: d.jobId, task: d.taskId });
      infraRelate(ctx, "DEPLOYS", d.jobId, entityId, dp, { tool: "kubectl" });
    }
  };

  if (kind === "Namespace") {
    const id = infraEntity(ctx, { key: `k8s-namespace|${repoId}|${doc.environment ?? ""}|${name}`, kind: "KubernetesNamespace", name, qualifiedName: `namespace:${name}${doc.environment ? `@${doc.environment}` : ""}`, file: doc.file, line: doc.line, metadata: { ...common, declaredBy: "manifest" } }, prov);
    link(id);
    return;
  }
  const spec = isObject(v.spec) ? v.spec : {};

  if (WORKLOADS.has(kind)) {
    const pod = podSpecOf(kind, spec) ?? {};
    const podLabels = podLabelsOf(kind, spec);
    const selector = isObject(spec.selector) ? labelsOf(spec.selector.matchLabels ?? (kind === "ReplicaSet" ? undefined : spec.selector)) : {};
    const volumes = list(pod.volumes).filter(isObject);
    const workloadId = infraEntity(ctx, {
      key: baseKey,
      kind: "Deployment",
      name,
      qualifiedName: `${scopeLabel}${kind}/${namespace ? `${namespace}/` : ""}${name}`,
      file: doc.file,
      line: doc.line,
      metadata: {
        ...common,
        replicas: typeof spec.replicas === "number" ? spec.replicas : str(spec.replicas),
        selector: kv(selector),
        podLabels: kv(podLabels),
        serviceAccount: str(pod.serviceAccountName) ?? str(pod.serviceAccount),
        schedule: kind === "CronJob" ? str(spec.schedule) : null,
        volumes: volumes.map((vol) => `${str(vol.name)}:${Object.keys(vol).filter((k) => k !== "name").join(",")}`),
        strategy: isObject(spec.strategy) ? str(spec.strategy.type) : null,
      },
    }, prov);
    link(workloadId);
    const record: WorkloadRecord = {
      entityId: workloadId, kind, name, namespace, bucket, podLabels, containers: [], serviceAccount: str(pod.serviceAccountName) ?? str(pod.serviceAccount),
      configMaps: [], secrets: [], environment: doc.environment, releaseId: doc.releaseId, file: doc.file, line: doc.line,
    };
    for (const vol of volumes) {
      if (isObject(vol.configMap) && str(vol.configMap.name)) record.configMaps.push({ name: str(vol.configMap.name)!, sourceId: workloadId, via: `volume:${str(vol.name)}`, line: doc.line });
      if (isObject(vol.secret) && str(vol.secret.secretName)) record.secrets.push({ name: str(vol.secret.secretName)!, sourceId: workloadId, via: `volume:${str(vol.name)}`, line: doc.line });
      if (isObject(vol.projected)) {
        for (const src of list(vol.projected.sources).filter(isObject)) {
          if (isObject(src.configMap) && str(src.configMap.name)) record.configMaps.push({ name: str(src.configMap.name)!, sourceId: workloadId, via: `projected:${str(vol.name)}`, line: doc.line });
          if (isObject(src.secret) && str(src.secret.name)) record.secrets.push({ name: str(src.secret.name)!, sourceId: workloadId, via: `projected:${str(vol.name)}`, line: doc.line });
        }
      }
    }
    for (const s of list(pod.imagePullSecrets).filter(isObject)) if (str(s.name)) record.secrets.push({ name: str(s.name)!, sourceId: workloadId, via: "imagePullSecrets", line: doc.line });
    const containers = [...list(pod.initContainers).filter(isObject).map((c) => ({ c, init: true })), ...list(pod.containers).filter(isObject).map((c) => ({ c, init: false }))];
    for (const { c, init } of containers) {
      const cname = str(c.name) ?? "(unnamed)";
      const ckey = `${baseKey}|container|${cname}`;
      const rawImage = str(c.image);
      const image = rawImage ? parseImageReference(rawImage) : null;
      const ports = list(c.ports).filter(isObject).map((p) => ({ name: str(p.name), port: str(p.containerPort) ?? "?", protocol: str(p.protocol) }));
      const resources = isObject(c.resources) ? c.resources : {};
      const command = [...list(c.command), ...list(c.args)].map((x) => str(x) ?? "").filter(Boolean);
      const containerId = infraEntity(ctx, {
        key: ckey,
        kind: "Container",
        name: cname,
        qualifiedName: `${scopeLabel}${kind}/${namespace ? `${namespace}/` : ""}${name}/${cname}`,
        file: doc.file,
        line: doc.line,
        metadata: {
          initContainer: init,
          image: rawImage,
          command: redactCommandLine(list(c.command).map((x) => str(x) ?? "")),
          args: redactCommandLine(list(c.args).map((x) => str(x) ?? "")),
          ports: ports.map((p) => `${p.name ? `${p.name}:` : ""}${p.port}${p.protocol ? `/${p.protocol}` : ""}`),
          resources: ["requests", "limits"].flatMap((k) => (isObject(resources[k]) ? Object.entries(resources[k] as JsonObject).map(([rk, rv]) => `${k}.${rk}=${str(rv)}`) : [])),
          volumeMounts: list(c.volumeMounts).filter(isObject).map((m) => `${str(m.name)}:${str(m.mountPath)}`),
          environment: doc.environment,
          helmRelease: doc.releaseId,
        },
      }, prov);
      infraRelate(ctx, "CONTAINS", workloadId, containerId, prov, { initContainer: init });
      let imageId: string | null = null;
      if (image && !isPlaceholderOnly(image.repository)) {
        imageId = imageEntity(ctx, image, prov, doc.file, doc.line, "declared");
        infraRelate(ctx, "RUNS_IMAGE", containerId, imageId, prov, { tag: image.tag, digest: image.digest, raw: image.raw, parameters: image.parameters, environment: doc.environment });
      } else if (rawImage) {
        infraUnresolved(ctx, ID, { type: "RUNS_IMAGE", sourceId: containerId, display: rawImage, reason: "image repository is parameterized and not statically determinable", category: "image-parameterized", provenance: prov, metadata: { parameters: image?.parameters ?? [] } });
      }
      record.containers.push({ entityId: containerId, name: cname, image, imageId, command, ports: ports.map((p) => ({ name: p.name, port: p.port })) });
      for (const from of list(c.envFrom).filter(isObject)) {
        if (isObject(from.configMapRef) && str(from.configMapRef.name)) record.configMaps.push({ name: str(from.configMapRef.name)!, sourceId: containerId, via: `envFrom${str(from.prefix) ? `:${str(from.prefix)}` : ""}`, line: doc.line });
        if (isObject(from.secretRef) && str(from.secretRef.name)) record.secrets.push({ name: str(from.secretRef.name)!, sourceId: containerId, via: "envFrom", line: doc.line });
      }
      for (const e of list(c.env).filter(isObject)) {
        const ename = str(e.name);
        if (!ename) continue;
        const valueFrom = isObject(e.valueFrom) ? e.valueFrom : null;
        let metadata: Metadata;
        if (valueFrom && isObject(valueFrom.configMapKeyRef)) metadata = { source: "configMapKeyRef", configMap: str(valueFrom.configMapKeyRef.name), configMapKey: str(valueFrom.configMapKeyRef.key), valueKind: "reference", value: null };
        else if (valueFrom && isObject(valueFrom.secretKeyRef)) metadata = { source: "secretKeyRef", secret: str(valueFrom.secretKeyRef.name), secretKey: str(valueFrom.secretKeyRef.key), valueKind: "secret-reference", value: null };
        else if (valueFrom && isObject(valueFrom.fieldRef)) metadata = { source: "fieldRef", fieldPath: str(valueFrom.fieldRef.fieldPath), valueKind: "reference", value: null };
        else if (valueFrom && isObject(valueFrom.resourceFieldRef)) metadata = { source: "resourceFieldRef", resource: str(valueFrom.resourceFieldRef.resource), valueKind: "reference", value: null };
        else metadata = { source: doc.scopeKind === "helm-release" ? "helm-rendered-literal" : "literal", ...safeValueMetadata(ename, str(e.value)) };
        const envId = infraEntity(ctx, {
          key: `${ckey}|env|${ename}`,
          kind: "EnvironmentVariable",
          name: ename,
          qualifiedName: `${kind}/${name}/${cname}:${ename}`,
          file: doc.file,
          line: doc.line,
          metadata: { ...metadata, environment: doc.environment },
        }, prov);
        infraRelate(ctx, "DECLARES", containerId, envId, prov);
        facts.environmentVariables.push({ entityId: envId, name: ename, containerId, workloadId });
        if (metadata.source === "configMapKeyRef" && metadata.configMap) record.configMaps.push({ name: String(metadata.configMap), sourceId: envId, via: `env:${ename}:${metadata.configMapKey ?? ""}`, line: doc.line });
        if (metadata.source === "secretKeyRef" && metadata.secret) record.secrets.push({ name: String(metadata.secret), sourceId: envId, via: `env:${ename}`, line: doc.line });
      }
    }
    facts.workloads.push(record);
    return;
  }

  if (kind === "Service") {
    const selector = isObject(spec.selector) ? labelsOf(spec.selector) : null;
    const ports = list(spec.ports).filter(isObject).map((p) => ({ port: str(p.port) ?? "?", targetPort: str(p.targetPort), name: str(p.name), protocol: str(p.protocol), nodePort: str(p.nodePort) }));
    const id = infraEntity(ctx, {
      key: baseKey,
      kind: "KubernetesService",
      name,
      qualifiedName: `${scopeLabel}Service/${namespace ? `${namespace}/` : ""}${name}`,
      file: doc.file,
      line: doc.line,
      metadata: { ...common, serviceType: str(spec.type) ?? "ClusterIP", selector: selector ? kv(selector) : [], ports: ports.map((p) => `${p.name ? `${p.name}:` : ""}${p.port}->${p.targetPort ?? p.port}${p.protocol ? `/${p.protocol}` : ""}${p.nodePort ? ` nodePort=${p.nodePort}` : ""}`), externalName: str(spec.externalName) },
    }, prov);
    link(id);
    facts.services.push({ entityId: id, name, namespace, bucket, selector, ports, file: doc.file, line: doc.line });
    return;
  }

  if (kind === "Ingress") {
    const backends: { service: string; port: string | null; host: string | null; path: string | null }[] = [];
    const backendOf = (b: unknown): { service: string; port: string | null } | null => {
      if (!isObject(b)) return null;
      if (isObject(b.service) && str(b.service.name)) return { service: str(b.service.name)!, port: isObject(b.service.port) ? (str(b.service.port.number) ?? str(b.service.port.name)) : null };
      if (str(b.serviceName)) return { service: str(b.serviceName)!, port: str(b.servicePort) };
      return null;
    };
    const def = backendOf(spec.defaultBackend ?? spec.backend);
    if (def) backends.push({ ...def, host: null, path: null });
    for (const rule of list(spec.rules).filter(isObject)) {
      const http = isObject(rule.http) ? rule.http : {};
      for (const p of list(http.paths).filter(isObject)) {
        const b = backendOf(p.backend);
        if (b) backends.push({ ...b, host: str(rule.host), path: str(p.path) ?? "/" });
      }
    }
    const tls = list(spec.tls).filter(isObject);
    const annotations = isObject(meta.annotations) ? meta.annotations : {};
    const id = infraEntity(ctx, {
      key: baseKey,
      kind: "KubernetesIngress",
      name,
      qualifiedName: `${scopeLabel}Ingress/${namespace ? `${namespace}/` : ""}${name}`,
      file: doc.file,
      line: doc.line,
      metadata: {
        ...common,
        ingressClass: str(spec.ingressClassName) ?? str(annotations["kubernetes.io/ingress.class"]),
        hosts: [...new Set(backends.map((b) => b.host).filter((h): h is string => h !== null))],
        routes: backends.map((b) => `${b.host ?? "*"}${b.path ?? ""} -> ${b.service}:${b.port ?? ""}`),
        tlsHosts: tls.flatMap((t) => list(t.hosts).map((h) => str(h) ?? "")),
        tlsSecrets: tls.map((t) => str(t.secretName)).filter((s): s is string => s !== null),
      },
    }, prov);
    link(id);
    facts.ingresses.push({ entityId: id, name, namespace, bucket, backends, tlsSecrets: tls.map((t) => str(t.secretName)).filter((s): s is string => s !== null), file: doc.file, line: doc.line });
    return;
  }

  if (kind === "ConfigMap") {
    const data = { ...(isObject(v.data) ? v.data : {}), ...(isObject(v.binaryData) ? Object.fromEntries(Object.keys(v.binaryData).map((k) => [k, null])) : {}) };
    const id = infraEntity(ctx, { key: baseKey, kind: "KubernetesConfigMap", name, qualifiedName: `${scopeLabel}ConfigMap/${namespace ? `${namespace}/` : ""}${name}`, file: doc.file, line: doc.line, metadata: { ...common, keys: Object.keys(data).sort() } }, prov);
    link(id);
    const keyIds: Record<string, string> = {};
    for (const [key, value] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
      const cfgId = keyIds[key] = infraEntity(ctx, { key: `${baseKey}|key|${key}`, kind: "Configuration", name: key, qualifiedName: `ConfigMap/${name}:${key}`, file: doc.file, line: doc.line, metadata: { source: "configmap", configMap: name, environment: doc.environment, ...safeValueMetadata(key, str(value)) } }, prov);
      infraRelate(ctx, "CONTAINS", id, cfgId, prov);
    }
    facts.named.push({ entityId: id, kind: "ConfigMap", name, namespace, bucket, target: null, keyIds, file: doc.file, line: doc.line });
    return;
  }

  if (kind === "Secret") {
    const secretManifestState = (doc: Record<string, unknown>) => {
      const states = [...Object.values(isObject(doc.data) ? doc.data : {}), ...Object.values(isObject(doc.stringData) ? doc.stringData : {})].map((x) => secretValueState(str(x)));
      return states.includes("literal") ? "literal" : states.includes("parameterized") ? "parameterized" : "empty";
    };
    const keys = [...Object.keys(isObject(v.data) ? v.data : {}), ...Object.keys(isObject(v.stringData) ? v.stringData : {})].sort();
    const id = infraEntity(ctx, { key: `secret-ref|${repoId}|k8s|${doc.scope}|${namespace ?? ""}|${name}`, kind: "SecretReference", name, qualifiedName: `Secret/${namespace ? `${namespace}/` : ""}${name}`, file: doc.file, line: doc.line, metadata: { ...common, source: "kubernetes-secret-manifest", secretType: str(v.type), keys, valueStored: false, valueState: secretManifestState(v) } }, prov);
    link(id);
    facts.named.push({ entityId: id, kind: "Secret", name, namespace, bucket, target: null, keyIds: {}, file: doc.file, line: doc.line });
    return;
  }

  if (kind === "ServiceAccount") {
    const id = infraEntity(ctx, { key: baseKey, kind: "ServiceAccount", name, qualifiedName: `${scopeLabel}ServiceAccount/${namespace ? `${namespace}/` : ""}${name}`, file: doc.file, line: doc.line, metadata: { ...common } }, prov);
    link(id);
    facts.named.push({ entityId: id, kind: "ServiceAccount", name, namespace, bucket, target: null, keyIds: {}, file: doc.file, line: doc.line });
    return;
  }

  if (kind === "HorizontalPodAutoscaler") {
    const ref = isObject(spec.scaleTargetRef) ? spec.scaleTargetRef : {};
    facts.named.push({ entityId: "", kind: "HorizontalPodAutoscaler", name, namespace, bucket, target: `${str(ref.kind) ?? ""}/${str(ref.name) ?? ""}|${str(spec.minReplicas) ?? ""}|${str(spec.maxReplicas) ?? ""}`, keyIds: {}, file: doc.file, line: doc.line });
  }
}
