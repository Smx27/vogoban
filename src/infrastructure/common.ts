import { LineCounter, parseAllDocuments } from "yaml";
import { globToRegExp } from "../dotnet/msbuild.ts";
import type { EntityKind, EvidenceLevel, Metadata, Provenance, RelationshipType } from "../graph/model.ts";
import { artifactKey, type AnalysisContext } from "../plugins/types.ts";
import type { DockerfileFacts } from "./dockerfile.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null);
export const list = (v: unknown): Json[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v as Json]);

export interface YamlDocument {
  value: Json;
  startLine: number;
  endLine: number;
}

export function parseYamlDocuments(text: string): { documents: YamlDocument[]; errors: { line: number; message: string }[] } {
  const counter = new LineCounter();
  const documents: YamlDocument[] = [];
  const errors: { line: number; message: string }[] = [];
  for (const doc of parseAllDocuments(text, { lineCounter: counter, uniqueKeys: false, merge: true, prettyErrors: false })) {
    const range = doc.range ?? [0, 0, 0];
    const startLine = counter.linePos(doc.contents?.range?.[0] ?? range[0]).line;
    if (doc.errors.length) {
      const e = doc.errors[0]!;
      errors.push({ line: counter.linePos(e.pos[0]).line, message: e.message.split("\n")[0]! });
      continue;
    }
    const value = doc.toJS({ maxAliasCount: 1000 }) as Json;
    if (value !== null && value !== undefined) documents.push({ value, startLine, endLine: counter.linePos(range[2]).line });
  }
  return { documents, errors };
}

export function parseYaml(text: string): Json {
  const { documents, errors } = parseYamlDocuments(text);
  if (errors.length) throw new Error(`${errors[0]!.message} (line ${errors[0]!.line})`);
  return documents[0]?.value ?? null;
}

export function lineOf(lines: string[], pattern: RegExp, from = 1, to = lines.length): number {
  for (let i = Math.max(0, from - 1); i < Math.min(lines.length, to); i++) if (pattern.test(lines[i]!)) return i + 1;
  return from;
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECRET_NAME = /(password|passwd|pwd|secret|token|apikey|api[_-]?key|credential|privatekey|private[_-]?key|accesskey|access[_-]?key|sas|signature|instrumentationkey|clientsecret|cert(ificate)?[_-]?(key|password))/i;
const CONNECTION_STRING = /(^|;)\s*(server|host|data ?source|endpoint|accountname|address|addr|user ?id|uid|username|password|pwd|initial catalog|database|sharedaccesskey|accountkey|filename|trusted_connection|integrated security)\s*=/i;
const PLACEHOLDER = /\$\{[^}]+\}|\$\([^)]+\)|\$\{\{[^}]+\}\}|\{\{[^}]+\}\}|^\$[A-Za-z_]\w*$/;

const SECRET_SETTING_SUFFIX = /(lifetime\w*|expir\w*|timeout|ttl|url|uri|endpoint|path|file(name)?|type|length|count|minutes|hours|days|seconds|enabled|header(name)?|issuer|audience|validation\w*|name)$/i;

const SECRET_FLAG = /^--?[\w.-]*(pass(word)?|pwd|secret|token|api-?key|access-?key|credential)[\w.-]*$/i;

export function redactCommandLine(parts: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const part of parts) {
    if (redactNext && !part.startsWith("-")) {
      out.push("<redacted>");
      redactNext = false;
      continue;
    }
    redactNext = false;
    const tokens = part.split(/(\s+)/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const eq = /^(--?[\w.-]+)=(.*)$/.exec(t);
      if (eq && SECRET_FLAG.test(eq[1]!) && eq[2]) tokens[i] = `${eq[1]}=<redacted>`;
      else if (SECRET_FLAG.test(t)) {
        const next = tokens.findIndex((x, j) => j > i && x.trim());
        if (next > 0) tokens[next] = "<redacted>";
        else redactNext = true;
      }
    }
    out.push(tokens.join(""));
  }
  return out;
}

/**
 * Fact-cache generation. Bump it whenever the redaction rules change: every graph store purges its fact_cache on open when the
 * stored generation differs, so facts persisted by an earlier release with weaker redaction never survive an upgrade.
 */
export const FACT_CACHE_GENERATION = "2";

const CONNECTION_PAIR = /(^|;)(\s*)([^;=]+?)(\s*=\s*)([^;]*)/g;
const SECRET_PAIR_KEY = /(password|passwd|pwd|secret|token|signature|sig|key|credential|sas)$/i;
const SECRET_QUERY_KEY = /(key|token|sig|signature|password|passwd|pwd|secret|code|sas|credential|auth|authorization|access_token|id_token|refresh_token)/i;
const CREDENTIAL_SHAPE = /^(eyJ[\w-]+\.[\w-]+\.|-----BEGIN |AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_|xox[baprs]-|sk-[A-Za-z0-9]{20,}|SharedAccessSignature |Bearer [A-Za-z0-9._~+/=-]{16,}$)/;
const OPAQUE_BLOB = /^[A-Za-z0-9+/=_-]{32,}$/;
const LETTERS_ONLY = /^[A-Za-z_-]+$/;
const AZURE_CLIENT_SECRET = /^(?=.*~)[A-Za-z0-9._~-]{34,48}$/;
const QUERY_STRING_SHAPE = /^(?:[\w.%-]+=[^&\s]*)(?:&[\w.%-]+=[^&\s]*)+$/;

/** Opaque base64/hex-like material of credential length; letters-only blobs below 64 characters are identifiers (D-10, documented). */
function opaqueSecret(value: string): boolean {
  return (OPAQUE_BLOB.test(value) && (!LETTERS_ONLY.test(value) || value.length >= 64)) || AZURE_CLIENT_SECRET.test(value) || (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value) && /[0-9+/]/.test(value)) || /^[0-9a-f]{40,}$/i.test(value);
}

function redactQuery(query: string): string {
  return query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    const name = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
    return SECRET_QUERY_KEY.test(name) && pair.length > eq + 1 ? `${pair.slice(0, eq)}=[redacted]` : pair;
  }).join("&");
}

/**
 * The authoritative value-level secret filter for persistent analysis state. Every string an analyzer extracts from
 * repository code or configuration passes through it before it reaches a fact cache, a graph entity, a diagnostic or an
 * export. Connection strings keep their non-secret pairs (Endpoint, AccountName, EntityPath) and lose every secret pair;
 * URLs and bare query strings lose user information and secret query parameters; known credential shapes (JWT, PEM,
 * cloud API keys, Azure client secrets, SAS tokens, opaque key material) are replaced entirely. Returns the value unchanged
 * when it carries no secret material.
 */
export function redactSecretText(value: string): string {
  if (!value) return value;
  if (CREDENTIAL_SHAPE.test(value) || opaqueSecret(value)) return "[redacted]";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/[;\s]/.test(value)) {
    const noUser = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[redacted]@");
    const q = noUser.indexOf("?");
    if (q < 0) return noUser;
    const hash = noUser.indexOf("#", q);
    const query = hash < 0 ? noUser.slice(q + 1) : noUser.slice(q + 1, hash);
    return `${noUser.slice(0, q + 1)}${redactQuery(query)}${hash < 0 ? "" : noUser.slice(hash)}`;
  }
  if (value.includes("=") && (value.includes(";") || CONNECTION_STRING.test(value))) {
    return value.replace(CONNECTION_PAIR, (_m, sep: string, lead: string, key: string, eq: string, raw: string) => {
      const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
      if (!raw || /name$/.test(normalized) || !SECRET_PAIR_KEY.test(normalized)) return `${sep}${lead}${key}${eq}${raw}`;
      return `${sep}${lead}${key}${eq}[redacted]`;
    });
  }
  if (QUERY_STRING_SHAPE.test(value) && /(^|&)(sig|signature|token|key|secret|code|sas)=/i.test(value)) return redactQuery(value);
  return value;
}

export function isSecretName(name: string): boolean {
  const last = name.split(/[:.]|__/).filter((s) => !/^\d*$/.test(s)).pop() ?? name;
  return SECRET_NAME.test(last) && !SECRET_SETTING_SUFFIX.test(last);
}

export function placeholders(value: string): string[] {
  return [...value.matchAll(/\$\{\{[^}]+\}\}|\$\{[^}]+\}|\$\([^)]+\)|^\$[A-Za-z_]\w*$/g)].map((m) => m[0]);
}

export interface SafeValue {
  valueKind: "url" | "connection-string" | "literal" | "parameterized" | "redacted" | "empty";
  value: string | null;
  hosts: string[];
  credential?: "literal" | "parameterized" | "placeholder";
}

const PLACEHOLDER_TEXT = /^(your[-_ ]|<[^>]*>$|\[[^\]]*\]$|\{[^}]*\}$|x{3,}$|\*{3,}$|(change|replace)[-_ ]?me|todo$|tbd$|placeholder|dummy|sample[-_ ]|example[-_ ])/i;

export function secretValueState(raw: string | null | undefined, name?: string): "literal" | "parameterized" | "placeholder" | "reference" | "empty" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "empty";
  const value = String(raw).trim();
  if (PLACEHOLDER.test(value)) return "parameterized";
  if (name && /secret(name)?$/i.test(name) && /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(value) && !PLACEHOLDER_TEXT.test(value)) return "reference";
  return PLACEHOLDER_TEXT.test(value) ? "placeholder" : "literal";
}

function sanitizeUrl(raw: string): { value: string; host: string | null } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?([^/?#\s]*)([^?#\s]*)/i.exec(raw.trim());
  if (!m) return null;
  return { value: `${m[1]!.toLowerCase()}://${m[2]}${m[3]}`, host: m[2] || null };
}

export function safeValue(name: string, raw: string | null | undefined): SafeValue {
  if (raw === null || raw === undefined || raw === "") return { valueKind: "empty", value: null, hosts: [] };
  const value = String(raw);
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(value) || /^eyJ[\w-]+\.[\w-]+\./.test(value)) return { valueKind: "redacted", value: null, hosts: [] };
  if (CONNECTION_STRING.test(value) && value.includes("=")) {
    const hosts = [...value.matchAll(/(?:^|;)\s*(?:server|host|data ?source|endpoint|address|addr)\s*=\s*([^;]+)/gi)]
      .map((m) => m[1]!.trim().replace(/^tcp:/i, "").replace(/^[a-z]+:\/\//i, "").replace(/[/,].*$/, ""))
      .filter((h) => h && !/[@]/.test(h));
    const secrets = [...value.matchAll(/(?:^|;)\s*(?:password|pwd|accountkey|sharedaccesskey)\s*=\s*([^;]*)/gi)].map((m) => secretValueState(m[1]!.trim())).filter((s) => s !== "empty");
    const credential = secrets.includes("literal") ? "literal" : secrets.includes("parameterized") ? "parameterized" : secrets.length ? "placeholder" : undefined;
    return { valueKind: "connection-string", value: null, hosts: [...new Set(hosts)].sort(), ...(credential ? { credential } : {}) };
  }
  if (isSecretName(name)) return { valueKind: "redacted", value: null, hosts: [] };
  const url = sanitizeUrl(value);
  if (url) return { valueKind: "url", value: url.value, hosts: url.host ? [url.host] : [] };
  if (PLACEHOLDER.test(value) && value.length <= 256) return { valueKind: "parameterized", value, hosts: [] };
  const highEntropy = value.length >= 24 && !/\s/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
  if (value.length > 128 || highEntropy || /[+/]{1}[A-Za-z0-9+/]{30,}={0,2}$/.test(value)) return { valueKind: "redacted", value: null, hosts: [] };
  return { valueKind: "literal", value, hosts: [] };
}

const DATABASE_NAME = /(^|[_:.])(connectionstrings?(__|:|_)|database_?url|db_?(host|server|name|connection|url)|connection_?string)|connectionstring$/i;

export function configRole(name: string, valueKind: SafeValue["valueKind"]): string | null {
  if (valueKind === "connection-string" || DATABASE_NAME.test(name)) return "database";
  if (valueKind === "url") return "service-url";
  return null;
}

export function safeValueMetadata(name: string, raw: string | null | undefined): Metadata {
  const v = safeValue(name, raw);
  return { valueKind: v.valueKind, value: v.value, role: configRole(name, v.valueKind), ...(v.hosts.length ? { hosts: v.hosts } : {}), ...(v.credential ? { embeddedCredential: v.credential } : {}), ...(v.valueKind === "parameterized" && v.value ? { parameters: placeholders(v.value) } : {}) };
}

export interface ImageReference {
  raw: string;
  name: string;
  registry: string | null;
  repository: string;
  tag: string | null;
  digest: string | null;
  parameters: string[];
}

export function parseImageReference(raw: string): ImageReference | null {
  let ref = raw.trim().replace(/^["']|["']$/g, "");
  if (!ref || /\s/.test(ref.replace(/\$\{\{[^}]*\}\}|\$\([^)]*\)|\$\{[^}]*\}/g, ""))) return null;
  let digest: string | null = null;
  const at = ref.indexOf("@sha256:");
  if (at >= 0) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }
  let tag: string | null = null;
  const masked = ref.replace(/\$\{\{[^}]*\}\}|\$\([^)]*\)|\$\{[^}]*\}/g, (m) => "x".repeat(m.length));
  const lastSlash = masked.lastIndexOf("/");
  const colon = masked.indexOf(":", lastSlash + 1);
  if (colon >= 0) {
    tag = ref.slice(colon + 1) || null;
    ref = ref.slice(0, colon);
  }
  let name = ref.replace(/^(index\.)?docker\.io\//i, "");
  if (/^library\/[^/]+$/.test(name)) name = name.slice("library/".length);
  if (!name) return null;
  const first = name.split("/")[0]!;
  const registry = name.includes("/") && (/[.:]/.test(first) || first === "localhost" || /^\$/.test(first)) ? first : null;
  const repository = registry ? name.slice(first.length + 1) : name;
  const lower = (s: string) => s.split(/(\$\{\{[^}]*\}\}|\$\([^)]*\)|\$\{[^}]*\})/).map((part, i) => (i % 2 ? part : part.toLowerCase())).join("");
  return { raw: raw.trim(), name: lower(name), repository: lower(repository), registry: registry ? lower(registry) : null, tag, digest, parameters: placeholders(raw) };
}

export interface InfraEntityInput {
  key: string;
  kind: EntityKind;
  name: string;
  qualifiedName?: string | null;
  file?: string | null;
  line?: number;
  metadata?: Metadata;
  projectId?: string | null;
  external?: boolean;
  repositoryScoped?: boolean;
}

export function infraEntity(ctx: AnalysisContext, input: InfraEntityInput, provenance: Provenance): string {
  return ctx.graph.entity({
    key: input.key,
    kind: input.kind,
    layer: "infrastructure",
    name: input.name,
    qualifiedName: input.qualifiedName ?? null,
    repositoryId: input.repositoryScoped === false ? null : ctx.repository.id,
    projectId: input.projectId ?? null,
    location: input.file ? { file: input.file, startLine: input.line ?? 1, startColumn: 1 } : null,
    external: input.external ?? false,
    metadata: { declaredState: "DECLARED", ...input.metadata },
    provenance,
  });
}

export function infraRelate(
  ctx: AnalysisContext,
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  provenance: Provenance,
  metadata: Metadata = {},
  evidence: EvidenceLevel = "DECLARED",
  confidence = 1,
): string {
  return ctx.graph.relate({ type, sourceId, targetId, repositoryId: ctx.repository.id, evidence, confidence, metadata, provenance });
}

export function infraProvenance(ctx: AnalysisContext, plugin: string, version: string, extractor: string, mechanism: string, file: string | null, line = 1, resolver: string | null = null): Provenance {
  return ctx.provenance({ plugin, extractor, mechanism, version, resolver, location: file ? { file, startLine: line, startColumn: 1 } : null });
}

export function infraUnresolved(
  ctx: AnalysisContext,
  plugin: string,
  input: { type: RelationshipType; sourceId: string; display: string; reason: string; category: string; provenance: Provenance; metadata?: Metadata },
) {
  ctx.graph.unresolved({
    type: input.type,
    sourceId: input.sourceId,
    repositoryId: ctx.repository.id,
    targetDisplay: input.display,
    resolver: plugin,
    reason: input.reason,
    metadata: { category: input.category, ...input.metadata },
    provenance: input.provenance,
  });
}

export function infraDiagnostic(ctx: AnalysisContext, plugin: string, file: string | null, code: string, message: string, severity: "info" | "warning" | "error" = "warning") {
  ctx.graph.diagnostic({ repositoryId: ctx.repository.id, category: "parser", plugin, file, severity, recoverable: true, code, message });
}

export function imageEntity(ctx: AnalysisContext, image: ImageReference, provenance: Provenance, file: string | null, line: number, role: "base" | "declared"): string {
  const external = role === "base";
  return infraEntity(
    ctx,
    {
      key: external ? `container-image|external|${image.name}` : `container-image|${ctx.repository.id}|${image.name}`,
      kind: "ContainerImage",
      name: image.repository,
      qualifiedName: image.name,
      file: external ? null : file,
      line,
      external,
      repositoryScoped: !external,
      metadata: { registry: image.registry, repository: image.repository, parameterizedName: placeholders(image.name).length > 0 },
    },
    provenance,
  );
}

export function environmentEntity(ctx: AnalysisContext, name: string, provenance: Provenance, basis: string): string {
  return infraEntity(ctx, { key: `environment|${ctx.repository.id}|${name.toLowerCase()}`, kind: "Environment", name, qualifiedName: `environment:${name}`, metadata: { basis: [basis] } }, provenance);
}

export function configuredEnvironment(ctx: AnalysisContext, path: string): string | null {
  for (const [name, globs] of Object.entries(ctx.config.infrastructure.environments).sort(([a], [b]) => a.localeCompare(b))) {
    if (globs.some((g) => globToRegExp(g).test(path) || path.startsWith(g.endsWith("/") ? g : `${g}/`))) return name;
  }
  return null;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(base: string, rel: string): string {
  const parts = (rel.startsWith("/") ? [] : base.split("/").filter(Boolean)).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export interface DockerfileRecord {
  entityId: string;
  path: string;
  facts: DockerfileFacts;
  stageIds: string[];
}

export interface ComposeServiceRecord {
  file: string;
  service: string;
  dockerfile: string | null;
  context: string | null;
  target: string | null;
  imageId: string | null;
  image: ImageReference | null;
  line: number;
}

export interface DockerFacts {
  dockerfiles: DockerfileRecord[];
  compose: ComposeServiceRecord[];
}

export const DOCKER_FACTS = artifactKey<DockerFacts>("infrastructure.docker");

export interface PipelineDockerBuild {
  taskId: string;
  pipelineId: string;
  command: string;
  dockerfile: string | null;
  context: string | null;
  images: ImageReference[];
  composeFile: string | null;
  composeServices: string[] | null;
  line: number;
  file: string;
}

export interface PipelineDotnet {
  taskId: string;
  pipelineId: string;
  command: string;
  projects: string[];
  output: string | null;
  file: string;
  line: number;
}

export interface PipelineArtifactPublish {
  taskId: string;
  pipelineId: string;
  artifactId: string;
  artifact: string;
  path: string | null;
}

export interface PipelineDeploy {
  taskId: string;
  jobId: string;
  pipelineId: string;
  tool: "helm" | "kubectl";
  chart: string | null;
  release: string | null;
  namespace: string | null;
  valueFiles: string[];
  manifests: string[];
  images: ImageReference[];
  environment: string | null;
  file: string;
  line: number;
}

export interface PipelineFacts {
  dockerBuilds: PipelineDockerBuild[];
  dotnet: PipelineDotnet[];
  publishes: PipelineArtifactPublish[];
  deploys: PipelineDeploy[];
  copies: { pipelineId: string; from: string; to: string }[];
  downloads: { jobId: string; pipelineId: string; artifact: string }[];
}

export const PIPELINE_FACTS = artifactKey<PipelineFacts>("infrastructure.pipelines");

export interface ManifestDocument {
  value: JsonObject;
  file: string;
  line: number;
  scope: string;
  scopeKind: "manifest" | "helm-release";
  releaseId: string | null;
  releaseLabel: string | null;
  environment: string | null;
  conditional: boolean;
}

export interface HelmReleaseRecord {
  entityId: string;
  chartId: string;
  chartDir: string;
  chartName: string;
  valueFiles: string[];
  releaseName: string | null;
  environment: string | null;
}

export interface KubernetesInput {
  documents: ManifestDocument[];
  releases: HelmReleaseRecord[];
  charts: { entityId: string; dir: string; name: string }[];
}

export const KUBERNETES_INPUT = artifactKey<KubernetesInput>("infrastructure.kubernetes.input");

export interface WorkloadRecord {
  entityId: string;
  kind: string;
  name: string;
  namespace: string | null;
  bucket: string;
  podLabels: Record<string, string>;
  containers: { entityId: string; name: string; image: ImageReference | null; imageId: string | null; command: string[]; ports: { name: string | null; port: string }[] }[];
  serviceAccount: string | null;
  configMaps: { name: string; sourceId: string; via: string; line: number }[];
  secrets: { name: string; sourceId: string; via: string; line: number }[];
  environment: string | null;
  releaseId: string | null;
  file: string;
  line: number;
}

export interface ServiceRecord {
  entityId: string;
  name: string;
  namespace: string | null;
  bucket: string;
  selector: Record<string, string> | null;
  ports: { port: string; targetPort: string | null; name: string | null }[];
  file: string;
  line: number;
}

export interface IngressRecord {
  entityId: string;
  name: string;
  namespace: string | null;
  bucket: string;
  backends: { service: string; port: string | null; host: string | null; path: string | null }[];
  tlsSecrets: string[];
  file: string;
  line: number;
}

export interface NamedResourceRecord {
  entityId: string;
  kind: "ConfigMap" | "Secret" | "ServiceAccount" | "HorizontalPodAutoscaler";
  name: string;
  namespace: string | null;
  bucket: string;
  target: string | null;
  keyIds: Record<string, string>;
  file: string;
  line: number;
}

export interface KubernetesFacts {
  workloads: WorkloadRecord[];
  services: ServiceRecord[];
  ingresses: IngressRecord[];
  named: NamedResourceRecord[];
  environmentVariables: { entityId: string; name: string; containerId: string; workloadId: string }[];
}

export const KUBERNETES_FACTS = artifactKey<KubernetesFacts>("infrastructure.kubernetes");

export const bucketKey = (namespace: string | null, scope: string) => `${scope}|${namespace ?? "<unspecified>"}`;
