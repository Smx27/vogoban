import type { EntityKind, RelationshipType } from "../graph/model.ts";

export const IMPACT_CATEGORIES = ["CODE", "PROJECT", "SERVICE", "API", "CONTRACT", "MESSAGE", "REPOSITORY", "INFRASTRUCTURE", "DEPLOYMENT", "EXTERNAL_SYSTEM", "CONFIGURATION"] as const;
export type ImpactCategory = (typeof IMPACT_CATEGORIES)[number];

const CATEGORY: Partial<Record<EntityKind, ImpactCategory>> = {
  Project: "PROJECT", Assembly: "PROJECT", Package: "PROJECT", Solution: "PROJECT",
  Application: "SERVICE", Endpoint: "SERVICE", FrontendRoute: "SERVICE", AzureFunction: "SERVICE", RouteGroup: "SERVICE", ServiceRegistration: "SERVICE", Middleware: "SERVICE", HostedService: "SERVICE", AuthorizationMetadata: "SERVICE", HttpClient: "SERVICE",
  Api: "API", ApiOperation: "API",
  ApiSchema: "CONTRACT", ContractDocument: "CONTRACT", SharedContract: "CONTRACT",
  Message: "MESSAGE", Topic: "MESSAGE", Queue: "MESSAGE",
  Repository: "REPOSITORY",
  Pipeline: "INFRASTRUCTURE", PipelineStage: "INFRASTRUCTURE", PipelineJob: "INFRASTRUCTURE", PipelineTask: "INFRASTRUCTURE", Artifact: "INFRASTRUCTURE", Dockerfile: "INFRASTRUCTURE", DockerStage: "INFRASTRUCTURE", ContainerImage: "INFRASTRUCTURE", HelmChart: "INFRASTRUCTURE", AzureResource: "INFRASTRUCTURE",
  Deployment: "DEPLOYMENT", Container: "DEPLOYMENT", KubernetesService: "DEPLOYMENT", KubernetesIngress: "DEPLOYMENT", HelmRelease: "DEPLOYMENT", KubernetesNamespace: "DEPLOYMENT", Environment: "DEPLOYMENT",
  ExternalApi: "EXTERNAL_SYSTEM", ExternalSystem: "EXTERNAL_SYSTEM", Database: "EXTERNAL_SYSTEM", Storage: "EXTERNAL_SYSTEM",
  ConfigurationReference: "CONFIGURATION", Configuration: "CONFIGURATION", EnvironmentVariable: "CONFIGURATION", SecretReference: "CONFIGURATION", KubernetesConfigMap: "CONFIGURATION", ServiceAccount: "CONFIGURATION",
};

export const categoryOf = (kind: EntityKind): ImpactCategory => CATEGORY[kind] ?? "CODE";

export interface Propagation {
  continues: boolean;
  potential: boolean;
  label: string;
}

export interface Rule {
  toSource?: Propagation;
  toTarget?: Propagation;
}

const dep = (label: string, potential = false, continues = true): Rule => ({ toSource: { continues, potential, label } });
const flow = (label: string, potential = false, continues = true): Rule => ({ toTarget: { continues, potential, label } });
const producer = (label: string): Rule => ({ toSource: { continues: true, potential: false, label }, toTarget: { continues: true, potential: true, label: `${label} (downstream)` } });
const delivery = (label: string): Rule => ({ toTarget: { continues: true, potential: false, label }, toSource: { continues: true, potential: true, label: `${label} (upstream)` } });
const hosting = (label: string): Rule => ({ toSource: { continues: true, potential: false, label }, toTarget: { continues: false, potential: true, label: `${label} (hosting target)` } });
const contains: Rule = { toSource: { continues: false, potential: false, label: "contains changed element" } };

const RULES: Partial<Record<RelationshipType, Rule>> = {
  CALLS: dep("calls"), CONSTRUCTS: dep("constructs"), USES_TYPE: dep("uses type"), USES_MEMBER: dep("uses member"), READS_FIELD: dep("reads"), WRITES_FIELD: dep("writes"),
  RETURNS_TYPE: dep("returns type"), ACCEPTS_PARAMETER: dep("accepts parameter"), INHERITS: dep("inherits"), EXTENDS: dep("extends"), THROWS: dep("throws", true), ATTRIBUTED_WITH: dep("attributed with", true),
  IMPLEMENTS: { toSource: { continues: true, potential: false, label: "implements" }, toTarget: { continues: true, potential: true, label: "dispatched through interface" } },
  OVERRIDES: { toSource: { continues: true, potential: false, label: "overrides" }, toTarget: { continues: true, potential: true, label: "dispatched through base member" } },
  REFERENCES: dep("references", true), INJECTS: dep("injects"), REGISTERS: dep("registers"), RESOLVES_TO: dep("resolves to"),
  USES_CLIENT: dep("uses HTTP client"), USES_BASE_URL: dep("uses base URL"), USES_MIDDLEWARE: dep("uses middleware"), REQUIRES_AUTHORIZATION: dep("requires authorization"), ALLOWS_ANONYMOUS: dep("allows anonymous", false, false),
  PROJECT_REFERENCES: dep("project reference"), ASSEMBLY_REFERENCES: dep("assembly reference"), PACKAGE_DEPENDS_ON: dep("package reference"),
  DEFINES_ASSEMBLY: flow("defines assembly"), DEFINES_APPLICATION: flow("defines application"),
  IMPLEMENTED_BY: dep("implemented by"), ROUTES_TO: dep("routes to"), EXPOSES_ENDPOINT: dep("exposes endpoint"),
  ACCEPTS_REQUEST: dep("accepts request"), PRODUCES_RESPONSE: dep("produces response"), CALLS_ENDPOINT: dep("calls endpoint"), CALLS_EXTERNAL_API: dep("calls external API"),
  PUBLISHES: dep("publishes"), SENDS_TO: dep("sends to"), CONSUMED_BY: flow("consumed by"), HANDLED_BY: flow("handled by"), CARRIES: dep("carries", false, false),
  PACKAGED_AS: flow("packaged as"), PRODUCES_ARTIFACT: flow("produces artifact"), CONSUMES_ARTIFACT: dep("consumes artifact"), PACKAGES: dep("packages"),
  RUNS_IMAGE: dep("runs image"), RUNS: dep("runs application"), EXPOSES_SERVICE: flow("exposes service"), DEPLOYS: dep("deploys", false, false),
  REFERENCES_CONFIG: dep("references configuration"), USES_SECRET: dep("uses secret"), SUPPLIES_CONFIG: flow("supplies configuration key"), USES_SERVICE_ACCOUNT: dep("uses service account"),
  DEPENDS_ON_STAGE: dep("depends on stage"),
  CONSUMES_API: dep("consumes API", true), CALLS_REPOSITORY: dep("calls repository"), DEPENDS_ON_REPOSITORY: dep("depends on repository"), CONSUMES_REPOSITORY_CONTRACT: dep("consumes repository contract"),
  DEPLOYS_REPOSITORY: dep("deploys repository", true), USES_SHARED_PACKAGE: dep("uses shared package"), PRODUCES_PACKAGE: flow("produces package"),
  SHARES_CONTRACT_WITH: { toSource: { continues: true, potential: true, label: "shares contract" }, toTarget: { continues: true, potential: true, label: "shares contract" } },
  PUBLISHES_MESSAGE: dep("publishes message contract", false, false), CONSUMES_MESSAGE: dep("consumes message contract", false, false), PROVIDES_API: contains,
  USES_EXTERNAL_SYSTEM: dep("uses external system"), CALLS_EXTERNAL_SYSTEM: dep("calls external system"), USES_DATABASE: dep("uses database"),
  IMPORTS: dep("imports module"), TYPE_IMPORTS: dep("imports types from module"), DYNAMIC_IMPORTS: dep("dynamically imports module"), REQUIRES: dep("requires module"), REFERENCES_MODULE: dep("references module", true), RE_EXPORTS: dep("re-exports"), EXPORTS: contains,
  RENDERS: dep("renders component"), USES_COMPONENT: dep("uses component"), USES_HOOK: dep("uses hook"),
  PROVIDES_CONTEXT: { toSource: { continues: true, potential: false, label: "provides context" }, toTarget: { continues: true, potential: true, label: "context value provided" } }, CONSUMES_CONTEXT: dep("consumes context"),
  EXPOSES_ROUTE: dep("exposes route"), ROUTES_TO_COMPONENT: dep("routes to component"), GUARDED_BY: dep("guarded by"), RESOLVED_BY: dep("resolved by"), LOADS_MODULE: dep("lazily loads module"), LOADS_COMPONENT: dep("lazily loads component"),
  PUBLISHES_TO: producer("publishes to"), SENDS_MESSAGE: producer("sends message to"), PUBLISHES_EVENT: producer("publishes event to"),
  CONSUMES_FROM: producer("consumes from"), RECEIVES_MESSAGE: producer("receives messages from"),
  SUBSCRIBES_TO: delivery("delivers to subscriber"), TRIGGERS: delivery("triggers"), CHANGE_FEED: delivery("change feed triggers"),
  READS_FROM: dep("reads from"), WRITES_TO: producer("writes to"),
  INVOKES_ACTIVITY: dep("invokes activity"), STARTS_ORCHESTRATION: dep("starts orchestration"), CALLS_SUB_ORCHESTRATION: dep("calls sub-orchestration"), USES_DURABLE_ENTITY: dep("uses durable entity"),
  AUTHENTICATES_WITH: dep("authenticates with"), USES_IDENTITY: dep("uses identity"), HAS_ROLE_ON: dep("has role on", true), READS_SECRET_FROM: dep("reads secret from"),
  CREATES: flow("creates resource"), REFERENCES_RESOURCE: dep("references resource"), DECLARED_BY: dep("declared by infrastructure"), DEPENDS_ON_RESOURCE: dep("depends on resource"), USES_MODULE: dep("uses module", false, false),
  HOSTED_ON: hosting("hosted on"), DEPLOYED_TO: hosting("deployed to"), OBSERVED_BY: dep("observed by", true, false), LOGS_TO: dep("logs to", true, false),
  IN_SUBNET: dep("in subnet", true), CONNECTS_TO: dep("connects to"), SHARES_RESOURCE: flow("same Azure resource in another repository"), PRIVATE_ENDPOINT_FOR: dep("private endpoint for"), ROUTES_TRAFFIC_TO: dep("routes traffic to"),
  CONTAINS: contains, DECLARES: contains, PROJECT_CONTAINS: contains, ASSEMBLY_CONTAINS: contains, CONTAINS_RESOURCE: contains,
};

const MEMBER_KINDS: EntityKind[] = ["Method", "Property", "Event"];

export function ruleFor(type: RelationshipType, sourceKind: EntityKind, targetKind: EntityKind): Rule | null {
  if ((type === "IMPLEMENTS" || type === "OVERRIDES") && !MEMBER_KINDS.includes(sourceKind)) return dep(type === "IMPLEMENTS" ? "implements" : "overrides");
  if (type === "CONTAINS" && sourceKind === "Deployment") return dep("workload contains container");
  if (type === "CONTAINS" && sourceKind === "SharedContract") return { toSource: { continues: true, potential: false, label: "member of shared contract" }, toTarget: { continues: true, potential: false, label: "same contract in another repository" } };
  if (type === "CONTAINS" && sourceKind === "Api" && targetKind === "ApiOperation") return { toSource: { continues: true, potential: true, label: "operation of API" } };
  if (type === "ROUTES_TO" && (sourceKind === "Topic" || sourceKind === "Queue")) return flow("delivers to consumer");
  if (type === "CARRIES") return { toSource: { continues: false, potential: false, label: "carries" }, toTarget: { continues: true, potential: true, label: "transport carries message" } };
  if (type === "TRIGGERS" && targetKind !== "AzureFunction") return null;
  if (type === "CONTAINS_RESOURCE" && (sourceKind === "AzureResource" || targetKind === "AzureResource")) return { toSource: { continues: false, potential: false, label: "contains changed resource" }, toTarget: { continues: true, potential: true, label: "parent resource changed" } };
  if (type === "BUILDS") return targetKind === "ContainerImage" || targetKind === "Artifact" ? flow("builds") : dep("builds project", false, false);
  if (type === "EXPOSES_ENDPOINT" && sourceKind !== "Application") return dep("exposes endpoint", false, false);
  if (type === "REFERENCES" && sourceKind === "ExternalSystem") return { toSource: { continues: true, potential: false, label: "external API identity" }, toTarget: { continues: true, potential: false, label: "external API identity" } };
  return RULES[type] ?? null;
}

export const DEPENDENCY_LEVELS = ["DIRECT", "INDIRECT", "TRANSITIVE", "POTENTIAL"] as const;
export type ImpactLevel = (typeof DEPENDENCY_LEVELS)[number];

export function levelFor(depth: number, potential: boolean): ImpactLevel {
  if (potential) return "POTENTIAL";
  return depth <= 1 ? "DIRECT" : depth === 2 ? "INDIRECT" : "TRANSITIVE";
}
