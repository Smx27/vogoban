import { hashOf } from "../graph/identity.ts";
import type { EntityKind, RelationshipType } from "../graph/model.ts";
import { Evaluator, type EntitySummary, type PathStep } from "../governance/evaluate.ts";
import { GovernanceGraph, type GEntity, type GRel, type SnapshotSet } from "../governance/graph.ts";
import type { PolicySet, Selector } from "../governance/policy.ts";
import { isSecretName } from "../infrastructure/common.ts";
import type { GraphStore } from "../store/store.ts";
import { classificationRank, criticalityRank, type EnterpriseConfig, type OwnershipSource, type SecuritySeverity } from "./config.ts";

export type Exposure = "PUBLIC" | "INTERNAL" | "UNKNOWN";
export type Protection = "NO_OBSERVED_AUTH" | "EXPLICITLY_ANONYMOUS" | "AUTH_PRESENT_AUTHZ_UNKNOWN" | "AUTHZ_PRESENT" | "UNKNOWN";
export type Authentication = "AUTHENTICATED" | "EXPLICITLY_ANONYMOUS" | "UNKNOWN";
export type OwnershipState = "OWNED" | "CONFLICT" | "OWNER_UNKNOWN" | "UNOWNED";

export interface ExposureEvidence {
  exposure: "PUBLIC" | "INTERNAL";
  basis: string;
  detail: string;
  environment: string | null;
  path: PathStep[];
}

export interface ServiceExposure {
  service: EntitySummary;
  exposure: Exposure;
  byEnvironment: { environment: string | null; exposure: Exposure }[];
  workloads: number;
  evidence: ExposureEvidence[];
}

export interface EndpointSecurity {
  endpoint: EntitySummary;
  method: string | null;
  route: string | null;
  service: EntitySummary | null;
  exposure: Exposure;
  publicEnvironments: (string | null)[];
  protection: Protection;
  authentication: Authentication;
  authorization: { policies: string[]; roles: string[]; schemes: string[] };
  evidence: string[];
  serviceContext: string[];
  exposurePath: PathStep[];
}

export interface Consumer {
  entity: EntitySummary;
  services: EntitySummary[];
  path: PathStep[];
}

export type SecretState = "REFERENCE" | "LITERAL_VALUE_IN_SOURCE" | "PLACEHOLDER_VALUE" | "PARAMETERIZED" | "DECLARED";

export interface SecretRecord {
  secret: EntitySummary;
  name: string;
  provider: string;
  state: SecretState;
  detection: string;
  source: string | null;
  environments: string[];
  consumers: Consumer[];
  valueStored: false;
}

export interface ResourceRecord {
  resource: EntitySummary;
  resourceType: string;
  technology: string | null;
  identity: string;
  local: boolean;
  classification: string | null;
  classificationSources: string[];
  sensitive: boolean;
  accessors: Consumer[];
  backing: { workload: EntitySummary; image: string | null }[];
  environments: string[];
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: "PUBLIC_ENTRY" | "SERVICE_CALL" | "MESSAGE" | "DATA_ACCESS" | "EXTERNAL_CALL" | "TRANSPORT";
  basis: string;
  steps: GRel[];
  environments: string[];
}

export interface Crossing {
  id: string;
  dimension: "zone" | "environment";
  from: EntitySummary;
  to: EntitySummary;
  fromBoundary: string;
  toBoundary: string;
  flowKind: FlowEdge["kind"];
  approved: boolean | null;
  environments: string[];
  path: PathStep[];
}

export interface SecurityFlow {
  id: string;
  kind: string;
  entry: EntitySummary;
  target: EntitySummary;
  classification: string | null;
  services: EntitySummary[];
  entryProtection: Record<string, number>;
  crossings: string[];
  environments: string[];
  path: PathStep[];
}

export interface OwnerRef {
  id: string;
  kind: "team" | "principal";
  name: string;
  businessUnit: string | null;
  organization: string | null;
  externalOrganization: boolean;
}

export interface OwnershipClaim {
  owner: string;
  source: OwnershipSource;
  role: "owner" | "maintainer";
  inherited: boolean;
  definitive: boolean;
  rule: string;
  evidence: string;
}

export interface OwnershipRecord {
  component: EntitySummary;
  category: string;
  relationship: RelationshipType;
  state: OwnershipState;
  owners: OwnerRef[];
  maintainers: OwnerRef[];
  claims: OwnershipClaim[];
  resolution: string;
}

export interface SecurityFinding {
  id: string;
  category: string;
  severity: SecuritySeverity;
  state: "OBSERVED" | "UNKNOWN";
  message: string;
  source: EntitySummary;
  target: EntitySummary | null;
  repository: string | null;
  environment: string | null;
  snapshots: string[];
  owners: string[];
  ownership: OwnershipState;
  evidence: string[];
  path: PathStep[];
  remediation: string | null;
}

export interface EnterpriseModel {
  snapshots: SnapshotSet;
  config: { file: string | null; fingerprint: string };
  graph: GovernanceGraph;
  evaluator: Evaluator;
  services: ServiceExposure[];
  endpoints: EndpointSecurity[];
  secrets: SecretRecord[];
  resources: ResourceRecord[];
  flowEdges: FlowEdge[];
  crossings: Crossing[];
  flows: SecurityFlow[];
  ownership: OwnershipRecord[];
  teams: { team: OwnerRef; owns: Record<string, number>; maintains: number; components: string[] }[];
  criticality: Map<string, { level: string; rules: string[] }>;
  zones: Map<string, string>;
  findings: SecurityFinding[];
  warnings: string[];
}

export const PUBLIC_INTERNET = "tb_public-internet";
const SERVICE_KINDS: EntityKind[] = ["Application"];
const COMPONENT_RELATIONSHIP: Partial<Record<EntityKind, RelationshipType>> = {
  Repository: "OWNS_REPOSITORY", Project: "OWNS_REPOSITORY", Application: "OWNS_SERVICE", FrontendRoute: "OWNS_SERVICE", AzureFunction: "OWNS_SERVICE", Api: "OWNS_API", ApiOperation: "OWNS_API", Endpoint: "OWNS_API",
  Message: "OWNS_MESSAGE", Topic: "OWNS_MESSAGE", Queue: "OWNS_MESSAGE", SharedContract: "OWNS_CONTRACT", ContractDocument: "OWNS_CONTRACT", ApiSchema: "OWNS_CONTRACT",
  Deployment: "OWNS_INFRASTRUCTURE", KubernetesService: "OWNS_INFRASTRUCTURE", KubernetesIngress: "OWNS_INFRASTRUCTURE", HelmChart: "OWNS_INFRASTRUCTURE", Pipeline: "OWNS_INFRASTRUCTURE",
  ContainerImage: "OWNS_INFRASTRUCTURE", Dockerfile: "OWNS_INFRASTRUCTURE", DataStore: "OWNS_INFRASTRUCTURE", Database: "OWNS_INFRASTRUCTURE", ExternalSystem: "OWNS_INFRASTRUCTURE",
  SecretReference: "OWNS_INFRASTRUCTURE", Storage: "OWNS_INFRASTRUCTURE", AzureResource: "OWNS_INFRASTRUCTURE",
};
const CATEGORY: Record<string, string> = {
  OWNS_REPOSITORY: "REPOSITORY", OWNS_SERVICE: "SERVICE", OWNS_API: "API", OWNS_MESSAGE: "MESSAGE", OWNS_CONTRACT: "CONTRACT", OWNS_INFRASTRUCTURE: "INFRASTRUCTURE",
};
export const componentCategory = (kind: string) => (kind === "Project" ? "PROJECT" : kind === "DataStore" || kind === "Database" || kind === "Storage" ? "RESOURCE" : kind === "ExternalSystem" ? "EXTERNAL_INTEGRATION" : kind === "SecretReference" ? "SECRET" : CATEGORY[COMPONENT_RELATIONSHIP[kind as EntityKind] ?? ""] ?? "OTHER");
export const isComponentKind = (kind: string) => kind in COMPONENT_RELATIONSHIP;

const DATASTORE_IMAGES: [RegExp, string, string][] = [
  [/(mssql|sql-?server|azure-sql-edge)/i, "database", "sqlserver"],
  [/postgres/i, "database", "postgresql"],
  [/(mysql|mariadb)/i, "database", "mysql"],
  [/mongo/i, "database", "mongodb"],
  [/cosmos/i, "database", "cosmosdb"],
  [/redis/i, "cache", "redis"],
  [/rabbitmq/i, "message-broker", "rabbitmq"],
  [/(kafka|redpanda)/i, "message-broker", "kafka"],
  [/elasticsearch|opensearch/i, "database", "elasticsearch"],
  [/azurite|minio/i, "storage", "object-storage"],
];
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|\(localdb\).*|\.|host\.docker\.internal)$|\.(db|sqlite3?)$/i;
const SECRET_PROVIDER: Record<string, string> = {
  appsettings: "appsettings", "pipeline-variable": "azure-pipelines-variable", "kubernetes-secret-manifest": "kubernetes-secret", "kubernetes-secret-reference": "kubernetes-secret",
  "helm-rendered-literal": "helm-values", configMapKeyRef: "kubernetes-configmap", configmap: "kubernetes-configmap", "dockerfile-env": "dockerfile", "pipeline-variable-group": "azure-pipelines-variable-group",
};
const DEFAULT_SEVERITY: Record<string, { default: SecuritySeverity; production?: SecuritySeverity }> = {
  PUBLIC_ENDPOINT_WITHOUT_OBSERVED_AUTH: { default: "MEDIUM", production: "HIGH" },
  PUBLIC_ENDPOINT_EXPLICITLY_ANONYMOUS: { default: "INFO", production: "LOW" },
  PUBLIC_ENDPOINT_AUTHZ_UNKNOWN: { default: "INFO" },
  ENDPOINT_PROTECTION_UNKNOWN: { default: "INFO" },
  SERVICE_EXPOSURE_UNKNOWN: { default: "INFO" },
  INCONSISTENT_AUTHORIZATION: { default: "LOW" },
  SECRET_REFERENCE_EXPOSED_IN_UNSAFE_SOURCE: { default: "HIGH", production: "CRITICAL" },
  SECRET_FROM_UNAPPROVED_PROVIDER: { default: "MEDIUM" },
  SENSITIVE_RESOURCE_WITH_UNKNOWN_OWNER: { default: "MEDIUM", production: "HIGH" },
  UNCLASSIFIED_EXTERNAL_BOUNDARY: { default: "LOW" },
  UNPROTECTED_CROSS_BOUNDARY_FLOW: { default: "HIGH", production: "CRITICAL" },
  UNAPPROVED_TRUST_BOUNDARY_CROSSING: { default: "MEDIUM" },
  PRODUCTION_DEPENDS_ON_DEVELOPMENT_RESOURCE: { default: "HIGH" },
  CRITICAL_COMPONENT_WITHOUT_OWNER: { default: "HIGH" },
  DATA_RESOURCE_UNCLASSIFIED: { default: "INFO" },
  AZURE_FUNCTION_ANONYMOUS_HTTP: { default: "LOW", production: "MEDIUM" },
  AZURE_STORAGE_PUBLIC_BLOB_ACCESS: { default: "MEDIUM", production: "HIGH" },
  AZURE_DATA_SERVICE_PUBLIC_NETWORK: { default: "LOW", production: "MEDIUM" },
  AZURE_SHARED_KEY_ACCESS_ENABLED: { default: "LOW" },
  AZURE_WEAK_TLS: { default: "MEDIUM" },
  AZURE_HTTP_ALLOWED: { default: "MEDIUM" },
  AZURE_SQL_FIREWALL_OPEN_TO_INTERNET: { default: "HIGH", production: "CRITICAL" },
  AZURE_SQL_FIREWALL_ALLOWS_AZURE_SERVICES: { default: "LOW" },
  AZURE_CONTAINER_APP_EXTERNAL_INGRESS: { default: "INFO" },
  AZURE_HIGH_RISK_ROLE_ASSIGNMENT: { default: "MEDIUM", production: "HIGH" },
  AZURE_SECRET_BASED_CREDENTIAL: { default: "MEDIUM" },
  AZURE_KEY_BASED_CONNECTION_SETTING: { default: "LOW" },
};
export const FINDING_CATEGORIES = Object.keys(DEFAULT_SEVERITY);

const emptyPolicies = (): PolicySet => ({ policies: [], rules: [], overridden: [], layers: new Map(), exceptions: [], errors: [], warnings: [], fingerprint: "" });
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const sortStr = (xs: string[]) => uniq(xs).sort();
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function codeownersRegex(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\//, "");
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
    } else if (c === "*") body += "[^/]*";
    else if (c === "?") body += "[^/]";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dirOnly ? "/.*" : "(/.*)?"}$`);
}

export function buildEnterpriseModel(store: GraphStore, set: SnapshotSet, cfg: EnterpriseConfig, policies?: PolicySet, existing?: GovernanceGraph): EnterpriseModel {
  const graph = existing ?? new GovernanceGraph(store, set);
  const evaluator = new Evaluator(graph, policies ?? emptyPolicies());
  const warnings: string[] = [];
  const g = (id: string) => graph.entities.get(id);
  const S = (e: GEntity) => ({ ...evaluator.summary(e), location: e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : null });
  const step = (r: GRel): PathStep | null => {
    const s = g(r.sourceId);
    const t = g(r.targetId);
    return s && t ? { from: S(s), relationship: { id: r.id, type: r.type, evidence: r.evidence, scope: r.scope, location: r.location, snapshot: r.snapshot }, to: S(t) } : null;
  };
  const steps = (rels: GRel[]) => rels.map(step).filter((s): s is PathStep => !!s);
  const relText = (r: GRel) => `${r.type} ${r.id} [${r.evidence}, ${r.scope}]${r.location ? ` @ ${r.location}` : ""} (snapshot ${r.snapshot})`;
  const selectorsOk = (sel: Selector | null, where: string) => {
    for (const l of sel?.layer ?? []) if (!evaluator.policies.layers.has(l)) {
      warnings.push(`${where}: layer '${l}' is not defined by the loaded policies; selector ignored`);
      return false;
    }
    return true;
  };
  const select = (sel: Selector, where: string) => (selectorsOk(sel, where) ? evaluator.candidates(sel).filter((e) => evaluator.matches(e, sel)) : []);
  const derived = (type: RelationshipType, source: GEntity, target: GEntity, basis: string, location: string | null): GRel => ({
    id: `derived:${hashOf(type, source.id, target.id, basis).slice(0, 20)}`, type, sourceId: source.id, targetId: target.id, evidence: "STRUCTURALLY_RESOLVED", metadata: { derived: basis }, location, scope: "enterprise", snapshot: "derived",
  });
  const locOf = (e: GEntity) => (e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : null);
  const byKind = (k: EntityKind) => graph.byKind.get(k) ?? [];
  const repoSnapshot = new Map(set.repositories.map((r) => [r.repositoryId, r.snapshot]));

  const workloadsOf = (app: GEntity) => graph.incoming(app.id, ["RUNS"]).map((r) => ({ rel: r, w: g(r.sourceId)! })).filter((x) => x.w);
  const appEnvs = new Map<string, string[]>();
  const envsOf = (e: GEntity): string[] => {
    if (e.kind === "Application") {
      const cached = appEnvs.get(e.id);
      if (cached) return cached;
      const envs = sortStr(workloadsOf(e).flatMap((x) => graph.environments(x.w)));
      appEnvs.set(e.id, envs);
      return envs;
    }
    return graph.environments(e);
  };
  const stage = (env: string | null) => (env && cfg.environments.production.includes(env) ? "production" : env && cfg.environments.development.includes(env) ? "development" : null);

  // runtime consumers (who uses a configuration or secret, lifted to services)
  const consumersOf = (id: string, types: RelationshipType[] = ["USES_SECRET", "REFERENCES_CONFIG"]): Consumer[] => {
    const out: Consumer[] = [];
    for (const r of graph.incoming(id, types)) {
      const src = g(r.sourceId);
      if (!src) continue;
      const chain: GRel[] = [r];
      let services: { app: GEntity; via: GRel[] }[] = [];
      if (src.kind === "Application") services = [{ app: src, via: [] }];
      else if (src.kind === "Project") services = graph.outgoing(src.id, ["DEFINES_APPLICATION"]).map((d) => ({ app: g(d.targetId)!, via: [d] }));
      else if (src.kind === "EnvironmentVariable" || src.kind === "Container" || src.kind === "Deployment") {
        let deployments: { d: GEntity; via: GRel[] }[] = [];
        if (src.kind === "Deployment") deployments = [{ d: src, via: [] }];
        else {
          const containers = src.kind === "Container" ? [{ c: src, via: [] as GRel[] }] : graph.incoming(src.id, ["DECLARES"]).map((d) => ({ c: g(d.sourceId)!, via: [d] })).filter((x) => x.c?.kind === "Container");
          deployments = containers.flatMap((c) => graph.incoming(c.c.id, ["CONTAINS"]).map((d) => ({ d: g(d.sourceId)!, via: [d, ...c.via] })).filter((x) => x.d?.kind === "Deployment"));
        }
        services = deployments.flatMap((d) => graph.outgoing(d.d.id, ["RUNS"]).map((run) => ({ app: g(run.targetId)!, via: [run, ...d.via] })));
      } else if (src.kind === "Method" || src.kind === "Type") services = graph.applications(src).map((a) => ({ app: a, via: [] }));
      services = services.filter((s) => s.app?.kind === "Application");
      out.push({ entity: S(src), services: uniq(services.map((s) => s.app)).map(S), path: steps([...services.flatMap((s) => s.via), ...chain]) });
    }
    const self = g(id);
    const ownApps = self?.projectId ? new Set(graph.outgoing(self.projectId, ["DEFINES_APPLICATION"]).map((d) => d.targetId)) : null;
    for (const r of graph.outgoing(id, ["SUPPLIES_CONFIG"])) {
      for (const use of graph.incoming(r.targetId, ["REFERENCES_CONFIG"])) {
        const src = g(use.sourceId);
        if (!src) continue;
        const apps = graph.applications(src);
        if (ownApps && src.projectId !== self!.projectId && !apps.some((a) => ownApps.has(a.id))) continue;
        out.push({ entity: S(src), services: apps.map(S), path: steps([r, use]) });
      }
    }
    return out.sort((a, b) => a.entity.id.localeCompare(b.entity.id));
  };
  const servicesOf = (consumers: Consumer[]) => uniq(consumers.flatMap((c) => c.services.map((s) => s.id))).sort();

  // ---- exposure ----
  const services: ServiceExposure[] = [];
  const exposureOf = new Map<string, ServiceExposure>();
  for (const app of byKind("Application")) {
    const evidence: ExposureEvidence[] = [];
    const workloads = workloadsOf(app);
    for (const { rel: run, w } of workloads) {
      const envs = graph.environments(w);
      const envList: (string | null)[] = envs.length ? envs : [null];
      const svcs = graph.incoming(w.id, ["ROUTES_TO"]).map((r) => ({ r, s: g(r.sourceId)! })).filter((x) => x.s?.kind === "KubernetesService");
      for (const env of envList) {
        if (!svcs.length) evidence.push({ exposure: "INTERNAL", basis: "workload-without-service", detail: `workload ${w.qualifiedName ?? w.name} has no Kubernetes Service routing to it`, environment: env, path: steps([run]) });
        for (const { r: svcRel, s: svc } of svcs) {
          const type = str(svc.metadata.serviceType) ?? "ClusterIP";
          if (type === "LoadBalancer" || type === "NodePort") evidence.push({ exposure: "PUBLIC", basis: `service-type:${type}`, detail: `Service ${svc.qualifiedName ?? svc.name} is type ${type} (${strs(svc.metadata.ports).join(", ")})`, environment: env, path: steps([svcRel, run]) });
          const ingresses = graph.incoming(svc.id, ["ROUTES_TO"]).map((r) => ({ r, i: g(r.sourceId)! })).filter((x) => x.i?.kind === "KubernetesIngress");
          for (const { r: ingRel, i } of ingresses) evidence.push({ exposure: "PUBLIC", basis: "ingress", detail: `Ingress ${i.qualifiedName ?? i.name} routes ${strs(i.metadata.routes).join(", ") || "(default backend)"}${strs(i.metadata.hosts).length ? ` hosts=${strs(i.metadata.hosts).join(",")}` : ""}`, environment: env, path: steps([ingRel, svcRel, run]) });
          if (type !== "LoadBalancer" && type !== "NodePort" && !ingresses.length) evidence.push({ exposure: "INTERNAL", basis: "cluster-internal-service", detail: `Service ${svc.qualifiedName ?? svc.name} is ${type} with no ingress routing to it (gateway routing is not modeled)`, environment: env, path: steps([svcRel, run]) });
        }
      }
    }
    for (const rel of graph.outgoing(app.id, ["HOSTED_ON", "DEPLOYED_TO"])) {
      const host = g(rel.targetId);
      if (!host || host.kind !== "AzureResource") continue;
      const type = String(host.metadata.armType ?? "").toLowerCase();
      const pna = str(host.metadata.publicNetworkAccess)?.toLowerCase();
      const label = `${host.metadata.resourceLabel ?? host.metadata.azureKind ?? "Azure resource"} ${host.name}${host.file ? ` (${host.file})` : ""}`;
      if (type === "microsoft.web/sites" || type === "microsoft.web/staticsites") {
        if (pna === "disabled" || pna === "false") evidence.push({ exposure: "INTERNAL", basis: "azure-public-network-access-disabled", detail: `${label} declares publicNetworkAccess=${host.metadata.publicNetworkAccess}`, environment: null, path: steps([rel]) });
        else evidence.push({ exposure: "PUBLIC", basis: "azure-app-service-public-endpoint", detail: `${label} has a public default host name; public network access is ${pna ? `declared ${host.metadata.publicNetworkAccess}` : "not restricted in the declaration"} (access restrictions are not modeled)`, environment: null, path: steps([rel]) });
      } else if (type === "microsoft.app/containerapps") {
        const ext = str(host.metadata.ingressExternal)?.toLowerCase();
        if (ext === "true") evidence.push({ exposure: "PUBLIC", basis: "azure-container-app-external-ingress", detail: `${label} declares external ingress`, environment: null, path: steps([rel]) });
        else if (ext === "false") evidence.push({ exposure: "INTERNAL", basis: "azure-container-app-internal-ingress", detail: `${label} declares internal-only ingress`, environment: null, path: steps([rel]) });
      } else if (rel.metadata.external === true) evidence.push({ exposure: "PUBLIC", basis: "aspire-external-http-endpoints", detail: `the Aspire AppHost declares WithExternalHttpEndpoints for this project, deployed to ${label}`, environment: null, path: steps([rel]) });
      else if (rel.metadata.external === false) evidence.push({ exposure: "INTERNAL", basis: "aspire-internal-endpoints", detail: `the Aspire AppHost declares no external endpoints for this project, deployed to ${label}`, environment: null, path: steps([rel]) });
    }
    for (const rule of cfg.exposure) if (evaluator.matches(app, rule.select) && selectorsOk(rule.select, rule.id)) evidence.push({ exposure: rule.exposure === "public" ? "PUBLIC" : "INTERNAL", basis: `exposure-rule:${rule.id}`, detail: rule.reason ?? `declared ${rule.exposure} by enterprise metadata`, environment: null, path: [] });
    const explicit = evidence.filter((e) => e.basis.startsWith("exposure-rule:"));
    const decide = (list: ExposureEvidence[]): Exposure => (list.some((e) => e.exposure === "PUBLIC") ? "PUBLIC" : list.length ? "INTERNAL" : "UNKNOWN");
    const exposure = explicit.length ? decide(explicit) : decide(evidence);
    const envKeys = uniq(evidence.map((e) => e.environment)).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    const rec: ServiceExposure = { service: S(app), exposure, byEnvironment: envKeys.map((env) => ({ environment: env, exposure: explicit.length ? exposure : decide(evidence.filter((e) => e.environment === env)) })), workloads: workloads.length, evidence };
    services.push(rec);
    exposureOf.set(app.id, rec);
  }

  // ---- endpoints ----
  const endpoints: EndpointSecurity[] = [];
  const middlewareOf = (app: GEntity) => graph.outgoing(app.id, ["USES_MIDDLEWARE"]).map((r) => g(r.targetId)).filter((m): m is GEntity => !!m && /^Use(Authentication|Authorization)$/.test(m.name)).map((m) => `${m.name} @ ${locOf(m) ?? "-"}`);
  const authzOf = (rels: GRel[]) => {
    const metas = rels.map((r) => g(r.targetId)).filter((m): m is GEntity => !!m);
    return { policies: sortStr(metas.map((m) => str(m.metadata.policy)).filter((p): p is string => !!p)), roles: sortStr(metas.flatMap((m) => strs(m.metadata.roles))), schemes: sortStr(metas.flatMap((m) => strs(m.metadata.schemes))) };
  };
  for (const ep of byKind("Endpoint")) {
    const appRel = graph.incoming(ep.id, ["EXPOSES_ENDPOINT"]).find((r) => g(r.sourceId)?.kind === "Application");
    const app = appRel ? g(appRel.sourceId)! : null;
    const reqs = graph.outgoing(ep.id, ["REQUIRES_AUTHORIZATION"]);
    const anon = graph.outgoing(ep.id, ["ALLOWS_ANONYMOUS"]);
    const declared = str(ep.metadata.authorization);
    const authz = authzOf(reqs);
    let protection: Protection;
    if (declared === "anonymous" || (anon.length && !reqs.length)) protection = "EXPLICITLY_ANONYMOUS";
    else if (declared === "required" || reqs.length) protection = authz.policies.length || authz.roles.length ? "AUTHZ_PRESENT" : "AUTH_PRESENT_AUTHZ_UNKNOWN";
    else if (ep.metadata.routeResolved === false || !declared) protection = "UNKNOWN";
    else protection = "NO_OBSERVED_AUTH";
    const evidence = [
      ...reqs.map((r) => `${relText(r)} -> ${g(r.targetId)?.name ?? r.targetId}${r.metadata.source ? ` (${r.metadata.source})` : ""}`),
      ...anon.map((r) => `${relText(r)}${r.metadata.source ? ` (${r.metadata.source})` : ""}`),
      ...(protection === "NO_OBSERVED_AUTH" ? [`no authorization attribute or endpoint convention observed for handler ${str(ep.metadata.handler) ?? ep.name}`] : []),
      ...(protection === "UNKNOWN" ? ["route or handler could not be statically resolved"] : []),
    ];
    const exp = app ? exposureOf.get(app.id) : undefined;
    const direct = cfg.exposure.filter((r) => evaluator.matches(ep, r.select));
    const exposure: Exposure = direct.length ? (direct.some((r) => r.exposure === "public") ? "PUBLIC" : "INTERNAL") : (exp?.exposure ?? "UNKNOWN");
    const publicEvidence = exp?.evidence.filter((e) => e.exposure === "PUBLIC") ?? [];
    endpoints.push({
      endpoint: S(ep), method: str(ep.metadata.verb), route: str(ep.metadata.route), service: app ? S(app) : null, exposure,
      publicEnvironments: exposure === "PUBLIC" ? (direct.length ? [null] : uniq(publicEvidence.map((e) => e.environment))) : [],
      protection, authentication: protection === "EXPLICITLY_ANONYMOUS" ? "EXPLICITLY_ANONYMOUS" : protection === "AUTHZ_PRESENT" || protection === "AUTH_PRESENT_AUTHZ_UNKNOWN" ? "AUTHENTICATED" : "UNKNOWN",
      authorization: authz, evidence: [...evidence, ...direct.map((r) => `exposure-rule ${r.id}: ${r.exposure}`)], serviceContext: app ? middlewareOf(app) : [],
      exposurePath: [...(publicEvidence[0]?.path ?? []), ...(appRel ? steps([appRel]) : [])],
    });
  }
  for (const op of byKind("ApiOperation")) {
    if (graph.outgoing(op.id, ["IMPLEMENTED_BY"]).length) continue;
    const sec = strs(op.metadata.security).filter((s) => s !== "none-declared");
    const protection: Protection = sec.includes("(anonymous)") || sec.includes("anonymous") ? "EXPLICITLY_ANONYMOUS" : sec.some((s) => s.includes(":")) ? "AUTHZ_PRESENT" : sec.length ? "AUTH_PRESENT_AUTHZ_UNKNOWN" : "UNKNOWN";
    const app = graph.applications(op)[0] ?? null;
    const exp = app ? exposureOf.get(app.id) : undefined;
    endpoints.push({
      endpoint: S(op), method: str(op.metadata.method), route: str(op.metadata.path), service: app ? S(app) : null, exposure: exp?.exposure ?? "UNKNOWN",
      publicEnvironments: exp?.exposure === "PUBLIC" ? uniq(exp.evidence.filter((e) => e.exposure === "PUBLIC").map((e) => e.environment)) : [], protection,
      authentication: protection === "EXPLICITLY_ANONYMOUS" ? "EXPLICITLY_ANONYMOUS" : protection === "UNKNOWN" ? "UNKNOWN" : "AUTHENTICATED",
      authorization: { policies: [], roles: [], schemes: sortStr(sec.map((s) => s.split(":")[0]!)) },
      evidence: [sec.length ? `OpenAPI security requirement: ${sec.join(", ")}${op.file ? ` @ ${op.file}` : ""}` : "contract declares no security requirement; implementation not analyzed"], serviceContext: [], exposurePath: [],
    });
  }
  endpoints.sort((a, b) => (a.service?.name ?? "").localeCompare(b.service?.name ?? "") || (a.route ?? "").localeCompare(b.route ?? "") || (a.method ?? "").localeCompare(b.method ?? "") || a.endpoint.id.localeCompare(b.endpoint.id));

  // ---- secrets ----
  const secrets: SecretRecord[] = [];
  for (const s of byKind("SecretReference")) {
    const source = str(s.metadata.source) ?? "unknown";
    const valueState = str(s.metadata.valueState) ?? (s.metadata.valuePresent === true ? "literal" : null);
    const state: SecretState = source === "kubernetes-secret-reference" || valueState === "reference" ? "REFERENCE" : valueState === "literal" ? "LITERAL_VALUE_IN_SOURCE" : valueState === "placeholder" ? "PLACEHOLDER_VALUE" : valueState === "parameterized" ? "PARAMETERIZED" : "DECLARED";
    secrets.push({
      secret: S(s), name: s.name, provider: SECRET_PROVIDER[source] ?? source, state,
      detection: source === "kubernetes-secret-manifest" ? `Kubernetes Secret manifest (${strs(s.metadata.keys).length} keys)` : source === "kubernetes-secret-reference" ? "reference to a Kubernetes Secret" : "secret-like setting name",
      source: locOf(s), environments: envsOf(s), consumers: consumersOf(s.id), valueStored: false,
    });
  }
  for (const kind of ["EnvironmentVariable", "Configuration"] as const) {
    for (const c of byKind(kind)) {
      const literalSecret = c.metadata.valueKind === "redacted" && isSecretName(c.name);
      const credential = str(c.metadata.embeddedCredential);
      if (!literalSecret && !credential) continue;
      const source = str(c.metadata.source) ?? "unknown";
      secrets.push({
        secret: S(c), name: c.name, provider: SECRET_PROVIDER[source] ?? source,
        state: credential === "parameterized" ? "PARAMETERIZED" : credential === "placeholder" ? "PLACEHOLDER_VALUE" : "LITERAL_VALUE_IN_SOURCE",
        detection: credential ? "credential embedded in connection string" : "secret-like name with a literal value (value withheld)",
        source: locOf(c), environments: envsOf(c), consumers: consumersOf(c.id, ["REFERENCES_CONFIG", "DECLARES"]), valueStored: false,
      });
    }
  }
  secrets.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.secret.id.localeCompare(b.secret.id));

  // ---- data stores and other sensitive resources ----
  const hostUses = new Map<string, GEntity[]>();
  for (const kind of ["Configuration", "EnvironmentVariable"] as const) for (const c of byKind(kind)) {
    if (c.metadata.role !== "database") continue;
    for (const h of strs(c.metadata.hosts)) {
      const host = h.toLowerCase().replace(/[,:].*$/, "");
      if (host) hostUses.set(host, [...(hostUses.get(host) ?? []), c]);
    }
  }
  const storeContainers = new Map<string, { c: GEntity; type: string; tech: string }[]>();
  for (const c of byKind("Container")) {
    const image = str(c.metadata.image);
    const hit = image ? DATASTORE_IMAGES.find(([re]) => re.test(image)) : undefined;
    if (hit) storeContainers.set(c.name.toLowerCase(), [...(storeContainers.get(c.name.toLowerCase()) ?? []), { c, type: hit[1], tech: hit[2] }]);
  }
  const resources: ResourceRecord[] = [];
  const resourceEdges: FlowEdge[] = [];
  const dataStores = new Map<string, GEntity>();
  for (const host of sortStr([...hostUses.keys(), ...storeContainers.keys()])) {
    const backing = storeContainers.get(host) ?? [];
    const configs = hostUses.get(host) ?? [];
    const ds: GEntity = { id: `ds_${hashOf("datastore", host).slice(0, 22)}`, kind: "DataStore", name: host, qualifiedName: `datastore:${host}`, file: null, metadata: { host, resourceType: backing[0]?.type ?? "database", technology: backing[0]?.tech ?? null, identity: configs.length ? "connection-string-host" : "datastore-container-image" }, projectId: null, repositoryId: null };
    graph.addVirtualEntity(ds);
    dataStores.set(host, graph.entities.get(ds.id)!);
  }
  for (const [host, ds] of dataStores) {
    const configs = hostUses.get(host) ?? [];
    for (const c of configs) {
      const link = derived("CONNECTS_TO", c, ds, "connection-string host", locOf(c));
      graph.addVirtualRelationship(link);
      for (const consumer of consumersOf(c.id, ["REFERENCES_CONFIG", "DECLARES"])) for (const svc of consumer.services) {
        resourceEdges.push({ from: svc.id, to: ds.id, kind: "DATA_ACCESS", basis: `connection string ${c.name}`, steps: [...consumer.path.map((p) => graph.outgoing(p.from.id).find((r) => r.id === p.relationship.id)).filter((r): r is GRel => !!r), link], environments: sortStr([...envsOf(c), ...envsOf(g(svc.id)!)]) });
      }
    }
    for (const b of storeContainers.get(host) ?? []) {
      const w = graph.incoming(b.c.id, ["CONTAINS"]).map((r) => g(r.sourceId)).find((x) => x?.kind === "Deployment");
      if (w) graph.addVirtualRelationship(derived("CONNECTS_TO", ds, w, "datastore served by workload with matching container name", locOf(b.c)));
    }
  }
  const classify = (e: GEntity) => {
    const hits = cfg.classification.rules.filter((r) => (r.select && selectorsOk(r.select, r.id) && evaluator.matches(e, r.select)) || r.resources.includes(e.name.toLowerCase()));
    const best = hits.sort((a, b) => classificationRank(b.classification) - classificationRank(a.classification) || a.id.localeCompare(b.id))[0];
    if (best) return { classification: best.classification, sources: hits.map((h) => `classification-rule ${h.id}: ${h.classification}${h.reason ? ` (${h.reason})` : ""}`) };
    if (e.kind === "SecretReference" && e.metadata.source === "kubernetes-secret-manifest") return { classification: "SENSITIVE", sources: ["convention: a Kubernetes Secret is a secret store"] };
    return { classification: null, sources: [] as string[] };
  };
  const sensitiveRank = classificationRank(cfg.classification.sensitiveFrom);
  const addResource = (e: GEntity, resourceType: string, technology: string | null, identity: string, accessors: Consumer[], backing: ResourceRecord["backing"]) => {
    const c = classify(e);
    resources.push({ resource: S(e), resourceType, technology, identity, local: LOCAL_HOST.test(e.name), classification: c.classification, classificationSources: c.sources, sensitive: classificationRank(c.classification) >= sensitiveRank, accessors, backing, environments: sortStr([...envsOf(e), ...accessors.flatMap((a) => a.services.flatMap((s) => envsOf(g(s.id)!)))]) });
  };
  for (const [host, ds] of dataStores) {
    const accessors = (hostUses.get(host) ?? []).flatMap((c) => consumersOf(c.id, ["REFERENCES_CONFIG", "DECLARES"]).map((x) => ({ ...x, path: [...x.path, ...steps(graph.outgoing(c.id, ["CONNECTS_TO"]).filter((r) => r.targetId === ds.id))] })));
    const backing = graph.outgoing(ds.id, ["CONNECTS_TO"]).map((r) => g(r.targetId)!).filter(Boolean).map((w) => ({ workload: S(w), image: (storeContainers.get(host) ?? [])[0] ? str(storeContainers.get(host)![0]!.c.metadata.image) : null }));
    addResource(ds, String(ds.metadata.resourceType), str(ds.metadata.technology), String(ds.metadata.identity), accessors, backing);
  }
  for (const kind of ["Database", "ExternalSystem", "Storage"] as const) for (const e of byKind(kind)) {
    const rels = graph.incoming(e.id, ["USES_DATABASE", "USES_EXTERNAL_SYSTEM", "CALLS_EXTERNAL_SYSTEM", "USES_STORAGE"]).filter((r) => g(r.sourceId)?.kind !== "Repository");
    const accessors: Consumer[] = rels.map((r) => {
      const src = g(r.sourceId)!;
      const svcs = src.kind === "Configuration" || src.kind === "EnvironmentVariable" ? consumersOf(src.id, ["REFERENCES_CONFIG", "DECLARES"]).flatMap((c) => c.services) : graph.applications(src).map(S);
      for (const s of svcs) resourceEdges.push({ from: s.id, to: e.id, kind: kind === "ExternalSystem" ? "EXTERNAL_CALL" : "DATA_ACCESS", basis: `${r.type} from ${src.kind} ${src.name}`, steps: [r], environments: graph.relEnvironments(r) });
      return { entity: S(src), services: svcs, path: steps([r]) };
    });
    addResource(e, kind === "ExternalSystem" ? "external-system" : kind === "Storage" ? "storage" : "database", strs(e.metadata.systemKinds)[0] ?? null, kind === "ExternalSystem" ? "external-host" : "declared", accessors, []);
  }
  for (const kind of ["Topic", "Queue"] as const) for (const e of byKind(kind)) {
    const senders = graph.incoming(e.id, ["SENDS_TO"]).map((r) => ({ entity: S(g(r.sourceId)!), services: graph.applications(g(r.sourceId)!).map(S), path: steps([r]) })).filter((x) => x.entity);
    for (const s of senders) for (const svc of s.services) resourceEdges.push({ from: svc.id, to: e.id, kind: "TRANSPORT", basis: "sends to transport", steps: s.path.map((p) => graph.outgoing(p.from.id).find((r) => r.id === p.relationship.id)!).filter(Boolean), environments: [] });
    addResource(e, kind.toLowerCase(), str(e.metadata.broker), "declared", senders, []);
  }
  for (const s of byKind("SecretReference").filter((x) => x.metadata.source === "kubernetes-secret-manifest")) addResource(s, "secret-store", "kubernetes-secret", "declared", consumersOf(s.id), []);
  resources.sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.resource.name.localeCompare(b.resource.name) || a.resource.id.localeCompare(b.resource.id));
  const resourceById = new Map(resources.map((r) => [r.resource.id, r]));

  // ---- service-level flow edges ----
  const flowEdges: FlowEdge[] = [...resourceEdges];
  const publicNode: GEntity = { id: PUBLIC_INTERNET, kind: "TrustBoundary", name: "public-internet", qualifiedName: "trust-boundary:public-internet", file: null, metadata: { boundaryKind: "public", builtIn: true }, projectId: null, repositoryId: null };
  graph.addVirtualEntity(publicNode);
  for (const s of services) for (const ev of s.evidence.filter((e) => e.exposure === "PUBLIC")) {
    flowEdges.push({ from: PUBLIC_INTERNET, to: s.service.id, kind: "PUBLIC_ENTRY", basis: ev.basis, steps: ev.path.map((p) => graph.outgoing(p.from.id).find((r) => r.id === p.relationship.id)!).filter(Boolean), environments: ev.environment ? [ev.environment] : [] });
  }
  for (const r of graph.byType.get("CALLS_ENDPOINT") ?? []) {
    const caller = g(r.sourceId);
    const op = g(r.targetId);
    if (!caller || !op) continue;
    for (const from of graph.applications(caller)) for (const to of graph.applications(op)) if (from.id !== to.id) flowEdges.push({ from: from.id, to: to.id, kind: "SERVICE_CALL", basis: "CALLS_ENDPOINT", steps: [r], environments: graph.relEnvironments(r) });
  }
  const serviceHosts = new Map<string, { target: GEntity; via: GRel[] }[]>();
  for (const svc of byKind("KubernetesService")) {
    const names = uniq([svc.name, (svc.qualifiedName ?? "").split("Service/").pop()!.split("/").pop()!].map((n) => n.toLowerCase()).filter((n) => n && !n.includes("${")));
    for (const r of graph.outgoing(svc.id, ["ROUTES_TO"])) for (const run of graph.outgoing(r.targetId, ["RUNS"])) {
      const app = g(run.targetId);
      if (app?.kind === "Application") for (const n of names) serviceHosts.set(`${svc.repositoryId}|${n}`, [...(serviceHosts.get(`${svc.repositoryId}|${n}`) ?? []), { target: app, via: [r, run] }]);
    }
  }
  for (const kind of ["Configuration", "EnvironmentVariable"] as const) for (const c of byKind(kind)) {
    if (c.metadata.role !== "service-url") continue;
    for (const host of strs(c.metadata.hosts).map((h) => h.toLowerCase().replace(/:.*$/, ""))) {
      const targets = serviceHosts.get(`${c.repositoryId}|${host}`) ?? [];
      if (!targets.length) continue;
      for (const consumer of consumersOf(c.id, ["REFERENCES_CONFIG", "DECLARES"])) for (const from of consumer.services) for (const t of targets) {
        if (from.id === t.target.id) continue;
        const svcRel = t.via[0]!;
        const hop = derived("CONNECTS_TO", c, g(svcRel.sourceId)!, `service URL host ${host} matches Kubernetes Service name`, locOf(c));
        flowEdges.push({ from: from.id, to: t.target.id, kind: "SERVICE_CALL", basis: `service URL ${c.name} -> ${host}`, steps: [...consumer.path.map((p) => graph.outgoing(p.from.id).find((r) => r.id === p.relationship.id)!).filter(Boolean), hop, ...t.via], environments: sortStr([...envsOf(c)]) });
      }
    }
  }
  for (const r of graph.byType.get("PUBLISHES") ?? []) {
    const pub = g(r.sourceId);
    const msg = g(r.targetId);
    if (!pub || !msg) continue;
    for (const h of graph.outgoing(msg.id, ["HANDLED_BY", "CONSUMED_BY"])) {
      const handler = g(h.targetId);
      if (!handler) continue;
      for (const from of graph.applications(pub)) for (const to of graph.applications(handler)) if (from.id !== to.id) flowEdges.push({ from: from.id, to: to.id, kind: "MESSAGE", basis: `message ${msg.name}`, steps: [r, h], environments: [] });
    }
  }
  const flowKey = (f: FlowEdge) => `${f.from}|${f.to}|${f.kind}|${f.basis}`;
  const dedupFlows = [...new Map(flowEdges.map((f) => [flowKey(f), f])).values()].sort((a, b) => flowKey(a).localeCompare(flowKey(b)));
  flowEdges.length = 0;
  flowEdges.push(...dedupFlows);

  // ---- trust zones and crossings ----
  const zones = new Map<string, string>();
  const envZones = new Map<string, string[]>();
  const boundaryKind = new Map(cfg.boundaries.map((b) => [b.id, b.kind]));
  boundaryKind.set("public-internet", "public");
  const zoneOf = (e: GEntity): string | null => {
    if (e.id === PUBLIC_INTERNET) return "public-internet";
    if (zones.has(e.id)) return zones.get(e.id)!;
    const hit = cfg.boundaries.find((b) => !b.environments.length && ((b.members && selectorsOk(b.members, b.id) && evaluator.matches(e, b.members)) || b.resources.includes(e.name.toLowerCase())));
    if (hit) zones.set(e.id, hit.id);
    return hit?.id ?? null;
  };
  const envZoneOf = (e: GEntity) => {
    const cached = envZones.get(e.id);
    if (cached) return cached;
    const envs = envsOf(e);
    const out = cfg.boundaries.filter((b) => b.environments.length && envs.some((x) => b.environments.includes(x))).map((b) => b.id).sort();
    envZones.set(e.id, out);
    return out;
  };
  const crossings: Crossing[] = [];
  for (const f of flowEdges) {
    const from = g(f.from);
    const to = g(f.to);
    if (!from || !to) continue;
    const pairs: [Crossing["dimension"], string, string][] = [];
    const zf = zoneOf(from);
    const zt = zoneOf(to);
    if (zf && zt && zf !== zt) pairs.push(["zone", zf, zt]);
    const ef = envZoneOf(from);
    const et = envZoneOf(to);
    if (ef.length && et.length && !ef.some((x) => et.includes(x))) for (const a of ef) for (const b of et) pairs.push(["environment", a, b]);
    for (const [dimension, a, b] of pairs) {
      const approved = cfg.approvedCrossings.length ? cfg.approvedCrossings.some((c) => c.from === a && c.to === b) : null;
      crossings.push({ id: `tc_${hashOf(dimension, f.from, f.to, a, b, f.kind, f.basis).slice(0, 20)}`, dimension, from: S(from), to: S(to), fromBoundary: a, toBoundary: b, flowKind: f.kind, approved, environments: f.environments, path: steps(f.steps) });
    }
  }
  crossings.sort((a, b) => a.fromBoundary.localeCompare(b.fromBoundary) || a.toBoundary.localeCompare(b.toBoundary) || a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name) || a.id.localeCompare(b.id));

  // ---- security flows (public entry -> ... -> resource) ----
  const outFlows = new Map<string, FlowEdge[]>();
  for (const f of flowEdges) outFlows.set(f.from, [...(outFlows.get(f.from) ?? []), f]);
  const flows: SecurityFlow[] = [];
  const endpointsBySvc = new Map<string, EndpointSecurity[]>();
  for (const e of endpoints) if (e.service) endpointsBySvc.set(e.service.id, [...(endpointsBySvc.get(e.service.id) ?? []), e]);
  const crossingByEdge = new Map<string, string[]>();
  for (const c of crossings) crossingByEdge.set(`${c.from.id}|${c.to.id}`, [...(crossingByEdge.get(`${c.from.id}|${c.to.id}`) ?? []), `${c.fromBoundary}->${c.toBoundary}`]);
  for (const entry of outFlows.get(PUBLIC_INTERNET) ?? []) {
    const queue: { node: string; trail: FlowEdge[] }[] = [{ node: entry.to, trail: [entry] }];
    const seen = new Set([entry.to]);
    while (queue.length) {
      const { node, trail } = queue.shift()!;
      if (trail.length > 5) continue;
      for (const f of outFlows.get(node) ?? []) {
        if (seen.has(f.to)) continue;
        seen.add(f.to);
        const next = [...trail, f];
        const res = resourceById.get(f.to);
        if (res?.local) continue;
        if (res) {
          const entryEps = (endpointsBySvc.get(entry.to) ?? []).filter((e) => e.exposure === "PUBLIC");
          const protectionCounts = entryEps.reduce<Record<string, number>>((m, e) => ((m[e.protection] = (m[e.protection] ?? 0) + 1), m), {});
          const kind = res.sensitive ? "PUBLIC_TO_SENSITIVE_RESOURCE" : res.resourceType === "external-system" ? "PUBLIC_TO_EXTERNAL_SYSTEM" : `PUBLIC_TO_${res.resourceType.toUpperCase().replace(/-/g, "_")}`;
          flows.push({
            id: `sfl_${hashOf(entry.to, f.to, kind).slice(0, 20)}`, kind, entry: S(g(entry.to)!), target: res.resource, classification: res.classification,
            services: uniq(next.slice(1).map((x) => x.from)).map((id) => S(g(id)!)), entryProtection: Object.fromEntries(Object.entries(protectionCounts).sort()),
            crossings: uniq(next.flatMap((x) => crossingByEdge.get(`${x.from}|${x.to}`) ?? [])), environments: sortStr(next.flatMap((x) => x.environments)), path: steps([...new Map(next.flatMap((x) => x.steps).map((r) => [r.id, r])).values()]),
          });
        } else if (g(f.to)?.kind === "Application") queue.push({ node: f.to, trail: next });
      }
    }
  }
  flows.sort((a, b) => a.kind.localeCompare(b.kind) || a.entry.name.localeCompare(b.entry.name) || a.target.name.localeCompare(b.target.name));

  // ---- ownership ----
  const teamById = new Map(cfg.teams.map((t) => [t.id, t]));
  const handleTeam = new Map(cfg.teams.flatMap((t) => t.handles.map((h) => [h, t.id] as const)));
  const orgExternal = new Map(cfg.organizations.map((o) => [o.id, o.external]));
  const ownerRef = (id: string): OwnerRef => {
    const t = teamById.get(id);
    if (t) return { id: t.id, kind: "team", name: t.name, businessUnit: t.businessUnit, organization: t.organization, externalOrganization: !!(t.organization && orgExternal.get(t.organization)) };
    return { id, kind: "principal", name: id.replace(/^principal:/, ""), businessUnit: null, organization: null, externalOrganization: false };
  };
  const claims = new Map<string, OwnershipClaim[]>();
  const claim = (id: string, c: OwnershipClaim) => claims.set(id, [...(claims.get(id) ?? []), c]);
  const contained = (e: GEntity): { e: GEntity; via: string }[] => {
    if (e.kind === "Repository") return [...graph.entities.values()].filter((x) => x.repositoryId === e.repositoryId && x.id !== e.id && isComponentKind(x.kind) && !x.virtual).map((x) => ({ e: x, via: `repository ${e.name}` }));
    if (e.kind === "Project") return [...graph.outgoing(e.id, ["DEFINES_APPLICATION"]).flatMap((r) => { const a = g(r.targetId); return a ? [{ e: a, via: `project ${e.name}` }, ...contained(a)] : []; }), ...[...graph.entities.values()].filter((x) => x.projectId === e.id && isComponentKind(x.kind)).map((x) => ({ e: x, via: `project ${e.name}` }))];
    if (e.kind === "Application") {
      const out: { e: GEntity; via: string }[] = [];
      for (const r of graph.outgoing(e.id, ["CONTAINS", "EXPOSES_ENDPOINT"])) {
        const x = g(r.targetId);
        if (!x || !isComponentKind(x.kind)) continue;
        out.push({ e: x, via: `service ${e.name}` });
        if (x.kind === "Api") for (const op of graph.outgoing(x.id, ["CONTAINS"])) if (g(op.targetId)) out.push({ e: g(op.targetId)!, via: `service ${e.name} / api ${x.name}` });
      }
      const project = graph.project(e);
      if (project) for (const m of byKind("Message").filter((m) => m.projectId === project.id)) out.push({ e: m, via: `service ${e.name} (message declared in project)` });
      for (const { w } of workloadsOf(e)) {
        out.push({ e: w, via: `workload running service ${e.name}` });
        for (const s of graph.incoming(w.id, ["ROUTES_TO"]).map((r) => g(r.sourceId)!).filter((x) => x?.kind === "KubernetesService")) {
          out.push({ e: s, via: `service routing to ${e.name}` });
          for (const i of graph.incoming(s.id, ["ROUTES_TO"]).map((r) => g(r.sourceId)!).filter((x) => x?.kind === "KubernetesIngress")) out.push({ e: i, via: `ingress routing to ${e.name}` });
        }
      }
      return out;
    }
    if (e.kind === "Api") return graph.outgoing(e.id, ["CONTAINS"]).map((r) => g(r.targetId)).filter((x): x is GEntity => !!x).map((x) => ({ e: x, via: `api ${e.name}` }));
    return [];
  };
  for (const rule of cfg.ownership.rules) {
    for (const e of select(rule.select, rule.id)) {
      if (!isComponentKind(e.kind)) {
        warnings.push(`ownership rule ${rule.id} matches ${e.kind} ${e.name}, which is not an ownable component; ignored`);
        continue;
      }
      claim(e.id, { owner: rule.owner, source: "explicit", role: rule.role, inherited: false, definitive: true, rule: rule.id, evidence: `enterprise metadata rule ${rule.id}${rule.reason ? ` (${rule.reason})` : ""}` });
      if (rule.inherit) for (const c of contained(e)) claim(c.e.id, { owner: rule.owner, source: "explicit", role: rule.role, inherited: true, definitive: true, rule: rule.id, evidence: `inherited from ${e.kind} ${e.name} via ${c.via} (rule ${rule.id} inherit: true)` });
    }
  }
  const coRules = new Map<string, { e: GEntity; re: RegExp }[]>();
  for (const r of byKind("OwnershipRule").filter((x) => x.metadata.source === "CODEOWNERS").sort((a, b) => Number(a.metadata.order) - Number(b.metadata.order))) {
    coRules.set(r.repositoryId ?? "", [...(coRules.get(r.repositoryId ?? "") ?? []), { e: r, re: codeownersRegex(String(r.metadata.pattern ?? r.name)) }]);
  }
  const filesByRepo = new Map<string, string[]>();
  if (coRules.size) for (const e of graph.entities.values()) if (e.file && e.repositoryId && coRules.has(e.repositoryId)) filesByRepo.set(e.repositoryId, [...(filesByRepo.get(e.repositoryId) ?? []), e.file]);
  const lastMatch = (repo: string, path: string) => {
    const rules = coRules.get(repo) ?? [];
    for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.re.test(path)) return rules[i]!.e;
    return null;
  };
  const coOwner = (h: string) => handleTeam.get(h.toLowerCase()) ?? `principal:${h}`;
  for (const [repo, rules] of coRules) {
    const files = sortStr(filesByRepo.get(repo) ?? []);
    for (const e of [...graph.entities.values()].filter((x) => x.repositoryId === repo && isComponentKind(x.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
      let scope: string[];
      let where: string;
      if (e.kind === "Repository") {
        const global = [...rules].reverse().find((r) => ["*", "**", "/**", "/", "/*"].includes(String(r.e.metadata.pattern)));
        if (!global) continue;
        const owners = strs(global.e.metadata.owners);
        for (const o of owners) claim(e.id, { owner: coOwner(o), source: "codeowners", role: "owner", inherited: false, definitive: true, rule: `${global.e.file}:${global.e.line}`, evidence: `CODEOWNERS ${global.e.file}:${global.e.line} '${global.e.metadata.pattern}' ${owners.join(" ")} (repository-wide rule)` });
        continue;
      }
      if (e.kind === "Project" || e.kind === "Application") {
        const p = graph.project(e);
        const dir = (p?.qualifiedName ?? "").replace(/[^/]*$/, "");
        if (!p?.qualifiedName) continue;
        scope = files.filter((f) => f.startsWith(dir));
        where = `project directory ${dir || "/"}`;
      } else if (e.file) {
        scope = [e.file];
        where = e.file;
      } else continue;
      const matched = uniq(scope.map((f) => lastMatch(repo, f)));
      if (!matched.length) continue;
      const ownerSets = uniq(matched.map((m) => (m ? strs(m.metadata.owners).join(" ") : "")));
      const ruleText = (m: GEntity | null) => (m ? `${m.file}:${m.line} '${m.metadata.pattern}' ${strs(m.metadata.owners).join(" ") || "(no owners)"}` : "(no matching rule)");
      if (ownerSets.length > 1) {
        claim(e.id, { owner: "", source: "codeowners", role: "owner", inherited: false, definitive: false, rule: matched.map((m) => (m ? `${m.file}:${m.line}` : "-")).join(","), evidence: `CODEOWNERS assigns different owners within ${where}: ${matched.map(ruleText).join("; ")}` });
        continue;
      }
      const m = matched[0];
      if (!m) continue;
      const owners = strs(m.metadata.owners);
      if (!owners.length) claim(e.id, { owner: "", source: "codeowners", role: "owner", inherited: false, definitive: true, rule: `${m.file}:${m.line}`, evidence: `CODEOWNERS ${ruleText(m)} explicitly leaves ${where} without owner` });
      for (const o of owners) claim(e.id, { owner: coOwner(o), source: "codeowners", role: "owner", inherited: false, definitive: true, rule: `${m.file}:${m.line}`, evidence: `CODEOWNERS ${ruleText(m)} covers ${where}` });
    }
  }
  const ownership: OwnershipRecord[] = [];
  for (const e of [...graph.entities.values()].filter((x) => isComponentKind(x.kind)).sort((a, b) => a.id.localeCompare(b.id))) {
    const all = claims.get(e.id) ?? [];
    const owners = all.filter((c) => c.role === "owner");
    const explicitDirect = owners.filter((c) => c.source === "explicit" && !c.inherited);
    const explicit = explicitDirect.length ? explicitDirect : owners.filter((c) => c.source === "explicit");
    const co = owners.filter((c) => c.source === "codeowners");
    const coDefinitive = co.filter((c) => c.definitive && c.owner);
    const bySource: Record<OwnershipSource, string[]> = { explicit: sortStr(explicit.map((c) => c.owner)), codeowners: sortStr(coDefinitive.map((c) => c.owner)) };
    let state: OwnershipState;
    let resolved: string[] = [];
    let resolution: string;
    const explicitRules = uniq(explicit.map((c) => c.rule));
    const explicitConflict = bySource.explicit.length > 1;
    const pick = cfg.ownership.precedence.find((src) => bySource[src].length);
    if (pick) {
      resolved = bySource[pick];
      state = pick === "explicit" && explicitConflict ? "CONFLICT" : "OWNED";
      resolution = state === "CONFLICT" ? `explicit rules ${explicitRules.join(", ")} assign different teams and no rule decides between them` : `resolved by configured precedence (${cfg.ownership.precedence.join(" > ")}): ${pick}`;
    } else if (bySource.explicit.length || bySource.codeowners.length) {
      resolved = sortStr([...bySource.explicit, ...bySource.codeowners]);
      const disagree = bySource.explicit.length && bySource.codeowners.length && bySource.explicit.join() !== bySource.codeowners.join();
      state = explicitConflict || disagree ? "CONFLICT" : "OWNED";
      resolution = state === "CONFLICT" ? (explicitConflict ? `explicit rules ${explicitRules.join(", ")} assign different teams` : `enterprise metadata (${bySource.explicit.join(", ")}) and CODEOWNERS (${bySource.codeowners.join(", ")}) disagree`) + "; no precedence rule is configured, so both owners are kept" : bySource.codeowners.length > 1 || bySource.explicit.length > 1 ? "joint owners declared by a single source" : `single owner from ${bySource.explicit.length ? "enterprise metadata" : "CODEOWNERS"}`;
    } else if (co.some((c) => !c.definitive)) {
      state = "OWNER_UNKNOWN";
      resolution = "CODEOWNERS evidence exists but maps to different owners within this component";
    } else {
      state = "UNOWNED";
      resolution = co.length ? "CODEOWNERS explicitly declares no owner" : "no ownership evidence";
    }
    const rel = COMPONENT_RELATIONSHIP[e.kind]!;
    ownership.push({ component: S(e), category: componentCategory(e.kind), relationship: rel, state, owners: resolved.map(ownerRef), maintainers: sortStr(all.filter((c) => c.role === "maintainer").map((c) => c.owner)).map(ownerRef), claims: all, resolution });
  }
  const ownershipById = new Map(ownership.map((o) => [o.component.id, o]));
  const teams = [...cfg.teams.map((t) => t.id), ...sortStr(ownership.flatMap((o) => o.owners.filter((x) => x.kind === "principal").map((x) => x.id)))].map((id) => {
    const owned = ownership.filter((o) => o.owners.some((x) => x.id === id));
    return { team: ownerRef(id), owns: owned.reduce<Record<string, number>>((m, o) => ((m[o.category] = (m[o.category] ?? 0) + 1), m), {}), maintains: ownership.filter((o) => o.maintainers.some((x) => x.id === id)).length, components: owned.map((o) => o.component.id) };
  });

  // ---- criticality ----
  const criticality = new Map<string, { level: string; rules: string[] }>();
  for (const rule of cfg.criticality) for (const e of select(rule.select, rule.id)) {
    const cur = criticality.get(e.id);
    if (!cur) criticality.set(e.id, { level: rule.level, rules: [rule.id] });
    else criticality.set(e.id, { level: criticalityRank(rule.level) > criticalityRank(cur.level) ? rule.level : cur.level, rules: [...cur.rules, rule.id].sort() });
  }

  // ---- findings ----
  const findings: SecurityFinding[] = [];
  const severityFor = (category: string, environment: string | null): SecuritySeverity => {
    const base = { ...DEFAULT_SEVERITY[category], ...Object.fromEntries(Object.entries(cfg.severity[category] ?? {}).filter(([, v]) => v)) } as { default: SecuritySeverity; production?: SecuritySeverity };
    return stage(environment) === "production" ? (base.production ?? base.default) : base.default;
  };
  const ownershipOf = (id: string) => {
    const e = g(id);
    if (!e) return null;
    return ownershipById.get(id) ?? graph.applications(e).map((a) => ownershipById.get(a.id)).find(Boolean) ?? (graph.project(e) ? ownershipById.get(graph.project(e)!.id) : undefined) ?? (graph.repository(e) ? ownershipById.get(graph.repository(e)!.id) : undefined) ?? null;
  };
  const finding = (category: string, source: EntitySummary, target: EntitySummary | null, environment: string | null, message: string, evidence: string[], path: PathStep[], remediation: string | null, state: SecurityFinding["state"] = "OBSERVED") => {
    const own = ownershipOf(source.id);
    const repoId = g(source.id)?.repositoryId ?? (target ? g(target.id)?.repositoryId : null) ?? null;
    findings.push({
      id: `sf_${hashOf(category, source.id, target?.id ?? "", environment ?? "").slice(0, 22)}`, category, severity: severityFor(category, environment), state, message, source, target,
      repository: graph.repositoryName(repoId), environment, snapshots: sortStr([...(repoId && repoSnapshot.get(repoId) ? [repoSnapshot.get(repoId)!] : []), ...path.map((p) => p.relationship.snapshot).filter((s) => s !== "derived")]),
      owners: own?.owners.map((o) => o.id) ?? [], ownership: own?.state ?? "UNOWNED", evidence, path, remediation,
    });
  };
  for (const ep of endpoints) {
    const label = `${ep.method ?? ""} ${ep.route ?? ep.endpoint.name}`.trim();
    for (const env of ep.exposure === "PUBLIC" ? ep.publicEnvironments : []) {
      if (ep.protection === "NO_OBSERVED_AUTH") finding("PUBLIC_ENDPOINT_WITHOUT_OBSERVED_AUTH", ep.endpoint, ep.service, env, `${ep.service?.name ?? "?"} exposes ${label} publicly${env ? ` in ${env}` : ""} and no authentication or authorization metadata is observed for it`, [...ep.evidence, ...ep.serviceContext.map((m) => `service context (not endpoint-level evidence): ${m}`)], ep.exposurePath, "Confirm whether the endpoint is intentionally public; if not, add endpoint-level authorization metadata ([Authorize] or RequireAuthorization).");
      if (ep.protection === "EXPLICITLY_ANONYMOUS") finding("PUBLIC_ENDPOINT_EXPLICITLY_ANONYMOUS", ep.endpoint, ep.service, env, `${ep.service?.name ?? "?"} exposes ${label} publicly${env ? ` in ${env}` : ""} and the endpoint explicitly allows anonymous access`, ep.evidence, ep.exposurePath, null);
      if (ep.protection === "AUTH_PRESENT_AUTHZ_UNKNOWN") finding("PUBLIC_ENDPOINT_AUTHZ_UNKNOWN", ep.endpoint, ep.service, env, `${label} requires an authenticated user but no policy, role or claim requirement is observed`, ep.evidence, ep.exposurePath, null);
    }
    if (ep.protection === "UNKNOWN") finding("ENDPOINT_PROTECTION_UNKNOWN", ep.endpoint, ep.service, null, `protection of ${label} cannot be determined statically`, ep.evidence, ep.exposurePath, null, "UNKNOWN");
  }
  for (const r of byKind("AzureResource")) {
    const m = r.metadata;
    const decl = [`declared in ${r.file ?? "?"}${r.line ? `:${r.line}` : ""} (${strs(m.declaredIn).join(", ") || "infrastructure"}); a static declaration, not proof of runtime state`];
    const kind = str(m.azureKind) ?? "";
    const yes = (v: unknown) => /^(true|enabled)$/i.test(String(v ?? ""));
    const no = (v: unknown) => /^(false|disabled)$/i.test(String(v ?? ""));
    if (kind === "storage-account" && yes(m.allowBlobPublicAccess)) finding("AZURE_STORAGE_PUBLIC_BLOB_ACCESS", S(r), null, null, `storage account ${r.name} allows anonymous public blob access`, decl, [], "Set allowBlobPublicAccess to false unless anonymous reads are intended.");
    if (kind === "blob-container" && /^(blob|container)$/i.test(String(m.containerPublicAccess ?? ""))) finding("AZURE_STORAGE_PUBLIC_BLOB_ACCESS", S(r), null, null, `blob container ${r.name} declares public access level ${m.containerPublicAccess}`, decl, [], "Use publicAccess None and grant access through Entra ID or SAS.");
    if (["storage-account", "cosmos-account", "sql-server", "key-vault", "service-bus-namespace", "event-hubs-namespace", "app-configuration"].includes(kind) && (yes(m.publicNetworkAccess) || /^allow$/i.test(String(m.networkDefaultAction ?? "")))) finding("AZURE_DATA_SERVICE_PUBLIC_NETWORK", S(r), null, null, `${m.resourceLabel ?? kind} ${r.name} declares public network access (${m.publicNetworkAccess ?? `default action ${m.networkDefaultAction}`})`, decl, [], "Disable public network access and use private endpoints, or restrict network rules.");
    if (["storage-account", "service-bus-namespace", "event-hubs-namespace", "cosmos-account", "app-configuration"].includes(kind) && (yes(m.allowSharedKeyAccess) || no(m.disableLocalAuth) || yes(m.localAuthEnabled))) finding("AZURE_SHARED_KEY_ACCESS_ENABLED", S(r), null, null, `${m.resourceLabel ?? kind} ${r.name} keeps shared-key / local authentication enabled`, decl, [], "Disable local (key) authentication and use Entra ID identities.");
    if (/^(TLS1_0|TLS1_1|1\.0|1\.1)$/i.test(String(m.minimumTlsVersion ?? ""))) finding("AZURE_WEAK_TLS", S(r), null, null, `${r.name} allows TLS ${m.minimumTlsVersion}`, decl, [], "Require TLS 1.2 or later.");
    if (no(m.httpsOnly)) finding("AZURE_HTTP_ALLOWED", S(r), null, null, `${r.name} declares httpsOnly=false`, decl, [], "Set httpsOnly to true.");
    if (str(m.firewallRange) === "0.0.0.0-255.255.255.255") finding("AZURE_SQL_FIREWALL_OPEN_TO_INTERNET", S(r), null, null, `SQL firewall rule ${r.name} allows every IPv4 address`, decl, [], "Remove the rule and use private endpoints or specific ranges.");
    if (str(m.firewallRange) === "0.0.0.0-0.0.0.0") finding("AZURE_SQL_FIREWALL_ALLOWS_AZURE_SERVICES", S(r), null, null, `SQL firewall rule ${r.name} allows all Azure services (including other tenants' resources)`, decl, [], null);
    if (kind === "container-app" && yes(m.ingressExternal)) finding("AZURE_CONTAINER_APP_EXTERNAL_INGRESS", S(r), null, null, `container app ${r.name} declares external ingress`, decl, [], null);
  }
  for (const r of byKind("AzureFunction").filter((f) => f.metadata.triggerType === "http" && f.metadata.authLevel === "anonymous")) {
    const hosts = graph.outgoing(r.id, ["HOSTED_ON"]);
    finding("AZURE_FUNCTION_ANONYMOUS_HTTP", S(r), hosts[0] ? S(g(hosts[0].targetId)!) : null, null, `HTTP-triggered Function ${r.name} declares AuthorizationLevel.Anonymous (${str(r.metadata.route) ?? ""})`, [`trigger attribute at ${r.file ?? "?"}${r.line ? `:${r.line}` : ""}`, ...(hosts.length ? [] : ["no hosting resource is linked, so public reachability is not established"])], steps(hosts), "Use Function or Admin level keys, or front the function with authentication (App Service Authentication / APIM).");
  }
  for (const r of byKind("AzureResource").concat(byKind("Application"), byKind("AzureFunction"))) {
    for (const rel of graph.outgoing(r.id, ["HAS_ROLE_ON"]).filter((x) => x.metadata.highRisk === true)) {
      const target = g(rel.targetId);
      if (target) finding("AZURE_HIGH_RISK_ROLE_ASSIGNMENT", S(r), S(target), null, `${r.name} is granted ${rel.metadata.role} on ${target.name}`, [`role assignment ${rel.location ?? ""}`.trim()], steps([rel]), "Grant the narrowest data-plane role instead of Owner/Contributor/User Access Administrator.");
    }
    for (const rel of graph.outgoing(r.id, ["AUTHENTICATES_WITH"]).filter((x) => x.metadata.secretBased === true)) finding("AZURE_SECRET_BASED_CREDENTIAL", S(r), g(rel.targetId) ? S(g(rel.targetId)!) : null, null, `${r.name} authenticates with a ${rel.metadata.credentialType} credential`, [`${rel.metadata.credentialClass ?? ""} at ${rel.location ?? "?"}`], steps([rel]), "Use managed identity (DefaultAzureCredential / ManagedIdentityCredential) instead of secrets or keys.");
  }
  for (const m of [...byKind("Method"), ...byKind("Type")]) for (const rel of graph.outgoing(m.id, ["AUTHENTICATES_WITH"]).filter((x) => x.metadata.secretBased === true)) finding("AZURE_SECRET_BASED_CREDENTIAL", S(m), g(rel.targetId) ? S(g(rel.targetId)!) : null, null, `${m.qualifiedName ?? m.name} creates a ${rel.metadata.credentialType} credential`, [`${rel.metadata.credentialClass ?? ""} at ${rel.location ?? "?"}`], steps([rel]), "Use managed identity (DefaultAzureCredential / ManagedIdentityCredential) instead of secrets or keys.");
  for (const c of [...byKind("SecretReference"), ...byKind("Configuration")].filter((x) => x.metadata.source === "azure-app-settings" && x.metadata.keyMaterial === true)) finding("AZURE_KEY_BASED_CONNECTION_SETTING", S(c), null, null, `app setting ${c.name} on ${c.metadata.host} is built from account keys or a secret expression (value not stored)`, [`declared in ${c.file ?? "?"}`], [], "Prefer identity-based connections (<name>__fullyQualifiedNamespace / __serviceUri with managed identity) or Key Vault references.");
  for (const s of services.filter((x) => x.exposure === "UNKNOWN")) {
    const eps = endpointsBySvc.get(s.service.id) ?? [];
    if (!eps.length) continue;
    finding("SERVICE_EXPOSURE_UNKNOWN", s.service, null, null, `${s.service.name} exposes ${eps.length} endpoints but no deployment, ingress or exposure metadata is observed, so public reachability is unknown (${eps.filter((e) => e.protection === "NO_OBSERVED_AUTH").length} without observed auth)`, [`no workload RUNS ${s.service.name} in the analyzed snapshots`], [], "Declare exposure in enterprise metadata or analyze the repository that deploys this service.", "UNKNOWN");
  }
  const groups = new Map<string, EndpointSecurity[]>();
  for (const ep of endpoints) {
    const handler = str(g(ep.endpoint.id)?.metadata.handler);
    if (!handler || !ep.service) continue;
    const type = handler.replace(/\(.*$/, "").split(".").slice(0, -1).join(".");
    groups.set(`${ep.service.id}|${type}`, [...(groups.get(`${ep.service.id}|${type}`) ?? []), ep]);
  }
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const protectedEps = list.filter((e) => e.protection === "AUTHZ_PRESENT" || e.protection === "AUTH_PRESENT_AUTHZ_UNKNOWN");
    const open = list.filter((e) => e.protection === "NO_OBSERVED_AUTH");
    if (!protectedEps.length || !open.length) continue;
    const type = key.split("|")[1]!;
    for (const ep of open) finding("INCONSISTENT_AUTHORIZATION", ep.endpoint, ep.service, null, `${ep.method ?? ""} ${ep.route ?? ""} in ${type} has no observed authorization while ${protectedEps.length} related endpoints of the same handler type require authorization`, [...ep.evidence, ...protectedEps.slice(0, 5).map((p) => `related: ${p.method ?? ""} ${p.route ?? ""} ${p.protection} (${p.authorization.policies.join(",") || "default policy"})`)], [], "Review whether this endpoint should share the handler type's authorization requirements.");
  }
  for (const s of secrets) {
    const envs: (string | null)[] = s.environments.length ? s.environments : [null];
    if (s.state === "LITERAL_VALUE_IN_SOURCE") for (const env of envs) finding("SECRET_REFERENCE_EXPOSED_IN_UNSAFE_SOURCE", s.secret, null, env, `${s.detection}: '${s.name}' has a literal value committed in ${s.provider} source ${s.source ?? ""} (value not collected)`, [`${s.secret.kind} ${s.secret.qualifiedName ?? s.name} @ ${s.source ?? "-"}`, ...s.consumers.map((c) => `consumed by ${c.entity.kind} ${c.entity.name}${c.services.length ? ` (services ${c.services.map((x) => x.name).join(", ")})` : ""}`)], s.consumers[0]?.path ?? [], "Move the value to a secret provider and reference it instead of committing it.");
    if (cfg.secrets.approvedProviders.length && s.state !== "LITERAL_VALUE_IN_SOURCE" && !cfg.secrets.approvedProviders.includes(s.provider)) finding("SECRET_FROM_UNAPPROVED_PROVIDER", s.secret, null, s.environments.length === 1 ? s.environments[0]! : null, `secret '${s.name}' comes from provider ${s.provider}, which is not in the approved providers (${cfg.secrets.approvedProviders.join(", ")})`, [`${s.secret.kind} @ ${s.source ?? "-"}`], [], null);
  }
  for (const r of resources) {
    const own = ownershipById.get(r.resource.id);
    if (r.sensitive && (!own || own.state === "UNOWNED" || own.state === "OWNER_UNKNOWN")) {
      const prod = r.environments.find((e) => stage(e) === "production") ?? null;
      finding("SENSITIVE_RESOURCE_WITH_UNKNOWN_OWNER", r.resource, null, prod, `${r.resourceType} ${r.resource.name} is classified ${r.classification} and has ${own?.state ?? "UNOWNED"} ownership`, [...r.classificationSources, ...r.accessors.slice(0, 5).map((a) => `accessed by ${a.services.map((s) => s.name).join(", ") || a.entity.name}`)], [], "Declare an owning team for the resource in enterprise metadata.");
    }
    if (!r.classification && !r.local && (r.resourceType === "database" || r.resourceType === "cache" || r.resourceType === "storage") && r.accessors.length) finding("DATA_RESOURCE_UNCLASSIFIED", r.resource, null, null, `${r.resourceType} ${r.resource.name} is accessed by ${uniq(r.accessors.flatMap((a) => a.services.map((s) => s.name))).join(", ") || "configuration only"} but has no data classification`, [`identity: ${r.identity}`], [], "Classify the resource in enterprise metadata.", "UNKNOWN");
    if (r.resourceType === "external-system" && !zoneOf(g(r.resource.id)!)) finding("UNCLASSIFIED_EXTERNAL_BOUNDARY", r.resource, null, null, `external system ${r.resource.name} is used but belongs to no configured trust boundary`, r.accessors.map((a) => `used by ${a.entity.kind} ${a.entity.name}`), r.accessors[0]?.path ?? [], "Assign the external system to a trust boundary in enterprise metadata.");
  }
  for (const f of flows.filter((x) => x.kind === "PUBLIC_TO_SENSITIVE_RESOURCE" && (x.entryProtection.NO_OBSERVED_AUTH ?? 0) > 0)) {
    const prod = f.environments.find((e) => stage(e) === "production") ?? null;
    finding("UNPROTECTED_CROSS_BOUNDARY_FLOW", f.entry, f.target, prod, `public entry ${f.entry.name} (${f.entryProtection.NO_OBSERVED_AUTH} public endpoints without observed auth) reaches ${f.classification} resource ${f.target.name}${f.services.length > 1 ? ` via ${f.services.map((s) => s.name).join(" -> ")}` : ""}`, [`flow ${f.id}`, ...f.crossings.map((c) => `crosses ${c}`)], f.path, "Verify the unauthenticated entry points cannot reach the sensitive resource, or add authorization to them.");
  }
  for (const c of crossings) {
    if (c.approved === false) finding("UNAPPROVED_TRUST_BOUNDARY_CROSSING", c.from, c.to, c.environments.length === 1 ? c.environments[0]! : null, `${c.flowKind} ${c.from.name} -> ${c.to.name} crosses ${c.fromBoundary} -> ${c.toBoundary}, which is not an approved crossing`, [`crossing ${c.id}`], c.path, null);
    const fromStage = envsOf(g(c.from.id)!).map(stage);
    const toStage = envsOf(g(c.to.id)!).map(stage);
    if (c.dimension === "environment" && fromStage.includes("production") && toStage.length && toStage.every((s) => s === "development")) finding("PRODUCTION_DEPENDS_ON_DEVELOPMENT_RESOURCE", c.from, c.to, "production", `production component ${c.from.name} depends on ${c.to.name}, which is only declared for development environments`, [`crossing ${c.id}`], c.path, null);
  }
  for (const [id, crit] of criticality) {
    if (criticalityRank(crit.level) < criticalityRank("HIGH")) continue;
    const own = ownershipById.get(id);
    const e = g(id)!;
    if (!own || own.state === "UNOWNED" || own.state === "OWNER_UNKNOWN") finding("CRITICAL_COMPONENT_WITHOUT_OWNER", S(e), null, null, `${e.kind} ${e.name} is ${crit.level} (rules ${crit.rules.join(", ")}) and has ${own?.state ?? "UNOWNED"} ownership`, [own?.resolution ?? "component kind is not ownable"], [], "Declare an owning team.");
  }
  const sevRank = (s: SecuritySeverity) => ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(s);
  const uniqueFindings = [...new Map(findings.map((f) => [f.id, f])).values()].sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.category.localeCompare(b.category) || (a.repository ?? "").localeCompare(b.repository ?? "") || a.source.name.localeCompare(b.source.name) || a.id.localeCompare(b.id));

  for (const z of [...graph.entities.values()]) zoneOf(z);
  return {
    snapshots: set, config: { file: cfg.file, fingerprint: cfg.fingerprint }, graph, evaluator, services: services.sort((a, b) => a.service.name.localeCompare(b.service.name) || a.service.id.localeCompare(b.service.id)), endpoints, secrets, resources, flowEdges, crossings, flows,
    ownership, teams, criticality, zones, findings: uniqueFindings, warnings: sortStr(warnings),
  };
}

export function ownerOf(model: EnterpriseModel, id: string): { record: OwnershipRecord | null; via: string } {
  const g = model.graph;
  const e = g.entities.get(id);
  const byId = (x: string) => model.ownership.find((o) => o.component.id === x) ?? null;
  if (!e) return { record: null, via: "entity not in snapshot" };
  const direct = byId(id);
  if (direct) return { record: direct, via: "component" };
  for (const a of g.applications(e)) {
    const r = byId(a.id);
    if (r) return { record: r, via: `service ${a.name}` };
  }
  const p = g.project(e);
  if (p && byId(p.id)) return { record: byId(p.id), via: `project ${p.name}` };
  const repo = g.repository(e);
  if (repo && byId(repo.id)) return { record: byId(repo.id), via: `repository ${repo.name}` };
  return { record: null, via: "no ownable container" };
}

export function posture(model: EnterpriseModel, environment?: string) {
  const env = environment?.toLowerCase();
  const inEnv = (envs: (string | null)[]) => !env || envs.some((e) => e === env);
  const eps = model.endpoints.filter((e) => !env || (e.exposure === "PUBLIC" ? inEnv(e.publicEnvironments) : true));
  const pub = eps.filter((e) => e.exposure === "PUBLIC" && inEnv(e.publicEnvironments));
  const count = <T>(list: T[], f: (x: T) => string) => Object.fromEntries(Object.entries(list.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})).sort(([a], [b]) => a.localeCompare(b)));
  const secrets = model.secrets.filter((s) => !env || s.environments.includes(env) || !s.environments.length);
  const findings = model.findings.filter((f) => !env || f.environment === env || f.environment === null);
  return {
    environment: env ?? null,
    services: { total: model.services.length, byExposure: count(model.services, (s) => s.exposure) },
    endpoints: { total: eps.length, public: pub.length, byExposure: count(eps, (e) => e.exposure), byProtection: count(eps, (e) => e.protection), publicByProtection: count(pub, (e) => e.protection), withObservedAuthentication: eps.filter((e) => e.authentication === "AUTHENTICATED").length, withObservedAuthorization: eps.filter((e) => e.protection === "AUTHZ_PRESENT").length, unknownProtection: eps.filter((e) => e.protection === "UNKNOWN").length },
    secrets: { total: secrets.length, byProvider: count(secrets, (s) => s.provider), byState: count(secrets, (s) => s.state) },
    resources: { total: model.resources.length, sensitive: model.resources.filter((r) => r.sensitive).length, byType: count(model.resources, (r) => r.resourceType), byClassification: count(model.resources, (r) => r.classification ?? "UNCLASSIFIED") },
    externalIntegrations: model.resources.filter((r) => r.resourceType === "external-system").length,
    trustBoundaryCrossings: { total: model.crossings.length, unapproved: model.crossings.filter((c) => c.approved === false).length, byBoundary: count(model.crossings, (c) => `${c.fromBoundary}->${c.toBoundary}`) },
    sensitiveDataFlows: model.flows.filter((f) => f.kind === "PUBLIC_TO_SENSITIVE_RESOURCE").length,
    securityFlows: count(model.flows, (f) => f.kind),
    findings: { total: findings.length, bySeverity: count(findings, (f) => f.severity), byCategory: count(findings, (f) => f.category) },
    ownership: { components: model.ownership.length, byState: count(model.ownership, (o) => o.state) },
  };
}
