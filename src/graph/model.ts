export const GRAPH_SCHEMA_VERSION = 1;

export const ENTITY_KINDS = [
  "Repository",
  "Solution",
  "Project",
  "Assembly",
  "Package",
  "File",
  "Namespace",
  "Type",
  "Method",
  "Property",
  "Field",
  "Event",
  "Parameter",
  "Application",
  "Endpoint",
  "RouteGroup",
  "ServiceRegistration",
  "Middleware",
  "HostedService",
  "AuthorizationMetadata",
  "ConfigurationReference",
  "ContractDocument",
  "Api",
  "ApiOperation",
  "ApiSchema",
  "HttpClient",
  "ExternalApi",
  "Message",
  "Topic",
  "Queue",
  "Database",
  "Storage",
  "Container",
  "Deployment",
  "Pipeline",
  "PipelineStage",
  "PipelineJob",
  "PipelineTask",
  "Artifact",
  "Configuration",
  "SecretReference",
  "Dockerfile",
  "DockerStage",
  "ContainerImage",
  "HelmChart",
  "HelmRelease",
  "KubernetesNamespace",
  "KubernetesService",
  "KubernetesIngress",
  "KubernetesConfigMap",
  "ServiceAccount",
  "Environment",
  "EnvironmentVariable",
  "ExternalSystem",
  "SharedContract",
  "OwnershipRule",
  "Team",
  "BusinessUnit",
  "Organization",
  "TrustBoundary",
  "DataStore",
  "FrontendRoute",
  "AzureFunction",
  "AzureResource",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const RELATIONSHIP_TYPES = {
  code: [
    "CONTAINS",
    "DECLARES",
    "REFERENCES",
    "CALLS",
    "CONSTRUCTS",
    "IMPLEMENTS",
    "INHERITS",
    "OVERRIDES",
    "EXTENDS",
    "USES_TYPE",
    "USES_MEMBER",
    "READS_FIELD",
    "WRITES_FIELD",
    "RETURNS_TYPE",
    "ACCEPTS_PARAMETER",
    "THROWS",
    "ATTRIBUTED_WITH",
  ],
  projects: [
    "PROJECT_REFERENCES",
    "ASSEMBLY_REFERENCES",
    "PACKAGE_DEPENDS_ON",
    "PROJECT_CONTAINS",
    "ASSEMBLY_CONTAINS",
    "DEFINES_ASSEMBLY",
    "DEFINES_APPLICATION",
  ],
  application: [
    "IMPLEMENTED_BY",
    "REGISTERS",
    "RESOLVES_TO",
    "USES_MIDDLEWARE",
    "PRECEDES",
    "REQUIRES_AUTHORIZATION",
    "ALLOWS_ANONYMOUS",
  ],
  api: [
    "EXPOSES_ENDPOINT",
    "ROUTES_TO",
    "CALLS_ENDPOINT",
    "IMPLEMENTS_ENDPOINT",
    "PRODUCES_RESPONSE",
    "ACCEPTS_REQUEST",
    "USES_API_CONTRACT",
    "USES_CLIENT",
    "USES_BASE_URL",
    "CALLS_EXTERNAL_API",
  ],
  dependencyInjection: ["REGISTERS_SERVICE", "INJECTS"],
  messaging: [
    "PUBLISHES",
    "CONSUMES",
    "PRODUCES_MESSAGE",
    "HANDLES_MESSAGE",
    "SENDS_TO",
    "RECEIVES_FROM",
    "ROUTES_MESSAGE",
    "CARRIES",
    "CONSUMED_BY",
    "HANDLED_BY",
  ],
  data: ["READS_FROM", "WRITES_TO", "CONNECTS_TO", "USES_DATABASE", "USES_STORAGE"],
  infrastructure: [
    "DEPLOYED_AS",
    "DEPLOYED_BY",
    "RUNS_IN",
    "HOSTS",
    "CONTAINS_RESOURCE",
    "REFERENCES_CONFIG",
    "USES_SECRET",
    "EXPOSES_SERVICE",
    "RUNS",
    "RUNS_IMAGE",
    "BASED_ON",
    "USES_SERVICE_ACCOUNT",
    "IN_ENVIRONMENT",
    "SUPPLIES_CONFIG",
  ],
  pipelines: ["BUILDS", "PACKAGES", "PACKAGED_AS", "PRODUCES_ARTIFACT", "CONSUMES_ARTIFACT", "DEPLOYS", "TRIGGERS", "DEPENDS_ON_STAGE"],
  metagraph: [
    "PROVIDES_API",
    "CONSUMES_API",
    "PUBLISHES_MESSAGE",
    "CONSUMES_MESSAGE",
    "PRODUCES_PACKAGE",
    "USES_SHARED_PACKAGE",
    "DEPLOYS_REPOSITORY",
    "USES_EXTERNAL_SYSTEM",
    "CALLS_EXTERNAL_SYSTEM",
  ],
  enterprise: [
    "OWNS_REPOSITORY",
    "OWNS_SERVICE",
    "OWNS_API",
    "OWNS_MESSAGE",
    "OWNS_CONTRACT",
    "OWNS_INFRASTRUCTURE",
    "MAINTAINS_REPOSITORY",
    "EXPOSES_PUBLIC_ENDPOINT",
    "ACCESSES_SENSITIVE_RESOURCE",
    "CROSSES_TRUST_BOUNDARY",
  ],
  frontend: [
    "IMPORTS",
    "TYPE_IMPORTS",
    "DYNAMIC_IMPORTS",
    "REQUIRES",
    "REFERENCES_MODULE",
    "RE_EXPORTS",
    "EXPORTS",
    "RENDERS",
    "USES_COMPONENT",
    "USES_HOOK",
    "PROVIDES_CONTEXT",
    "CONSUMES_CONTEXT",
    "EXPOSES_ROUTE",
    "ROUTES_TO_COMPONENT",
    "GUARDED_BY",
    "RESOLVED_BY",
    "LOADS_MODULE",
    "LOADS_COMPONENT",
  ],
  azure: [
    "PUBLISHES_TO",
    "CONSUMES_FROM",
    "SUBSCRIBES_TO",
    "SENDS_MESSAGE",
    "RECEIVES_MESSAGE",
    "PUBLISHES_EVENT",
    "CHANGE_FEED",
    "INVOKES_ACTIVITY",
    "STARTS_ORCHESTRATION",
    "CALLS_SUB_ORCHESTRATION",
    "USES_DURABLE_ENTITY",
    "AUTHENTICATES_WITH",
    "USES_IDENTITY",
    "HAS_ROLE_ON",
    "READS_SECRET_FROM",
    "CREATES",
    "REFERENCES_RESOURCE",
    "DECLARED_BY",
    "DEPENDS_ON_RESOURCE",
    "USES_MODULE",
    "HOSTED_ON",
    "DEPLOYED_TO",
    "OBSERVED_BY",
    "LOGS_TO",
    "IN_SUBNET",
    "PRIVATE_ENDPOINT_FOR",
    "ROUTES_TRAFFIC_TO",
    "SHARES_RESOURCE",
  ],
  repositories: [
    "DEPENDS_ON_REPOSITORY",
    "CALLS_REPOSITORY",
    "PUBLISHES_TO_REPOSITORY_CONTRACT",
    "CONSUMES_REPOSITORY_CONTRACT",
    "SHARES_CONTRACT_WITH",
  ],
} as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[keyof typeof RELATIONSHIP_TYPES][number];
export const ALL_RELATIONSHIP_TYPES: readonly RelationshipType[] = Object.values(RELATIONSHIP_TYPES).flat();

export const EVIDENCE_LEVELS = [
  "EXACT",
  "COMPILER_RESOLVED",
  "DECLARED",
  "STRUCTURALLY_RESOLVED",
  "INFERRED",
  "HEURISTIC",
  "UNKNOWN",
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const GRAPH_LAYERS = ["source", "semantic", "application", "repository", "contract", "infrastructure", "meta"] as const;
export type GraphLayer = (typeof GRAPH_LAYERS)[number];

export type GraphScope = { kind: "repository"; repositoryId: string } | { kind: "meta" };

export const REPOSITORY_STATUSES = ["REGISTERED", "ANALYZING", "READY", "STALE", "FAILED", "UNAVAILABLE"] as const;
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export interface CatalogEntry {
  repositoryId: string;
  identity: string;
  name: string;
  url: string | null;
  provider: string | null;
  organization: string | null;
  defaultBranch: string | null;
  localPath: string | null;
  status: RepositoryStatus;
  registeredAt: string;
  analyzedCommit: string | null;
  analyzedDirty: boolean;
  analyzedRun: string | null;
  analyzedAt: string | null;
  graphVersion: string | null;
  analyzerVersion: string | null;
  semantic: boolean;
  lastError: string | null;
}

export interface MetaRelationship extends Relationship {
  category: string;
  sourceRepositoryId: string | null;
  targetRepositoryId: string | null;
  environment: string | null;
  snapshotId: string;
}

export interface MetaUnresolved extends UnresolvedReference {
  category: string;
}

export interface MetaConflict extends Conflict {
  category: string;
}

export interface MetaBatch {
  entities: Entity[];
  relationships: MetaRelationship[];
  unresolved: MetaUnresolved[];
  conflicts: MetaConflict[];
}

export interface MetaSnapshot {
  id: string;
  createdAt: string;
  schemaVersion: number;
  resolverVersions: Record<string, string>;
  repositories: { repositoryId: string; name: string; commit: string | null; graphVersion: string | null; status: RepositoryStatus }[];
  categories: Record<string, { fingerprint: string; recomputed: boolean; relationships: number; unresolved: number; conflicts: number }>;
}

export interface GraphSnapshotRecord {
  id: string;
  scope: "repository" | "meta";
  repositoryId: string | null;
  commit: string | null;
  graphVersion: string;
  createdAt: string;
  entities: number;
  relationships: number;
}

export interface GraphSnapshotPayload {
  entities: [id: string, kind: string, name: string, qualifiedName: string | null, file: string | null, hash: string, metadata: Metadata | null, projectId: string | null, repositoryId: string | null, line?: number | null][];
  relationships: [id: string, type: string, sourceId: string, targetId: string, evidence: string, hash: string, metadata: Metadata | null, location?: string | null][];
}

export interface SourceLocation {
  file: string;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
}

export interface Provenance {
  repositoryId: string | null;
  commit: string | null;
  location: SourceLocation | null;
  plugin: string;
  extractor: string;
  resolver: string | null;
  mechanism: string;
  analysisVersion: string;
}

export type Metadata = Record<string, string | number | boolean | null | string[] | number[]>;

export interface Entity {
  id: string;
  key: string;
  kind: EntityKind;
  layer: GraphLayer;
  name: string;
  qualifiedName: string | null;
  repositoryId: string | null;
  projectId: string | null;
  assembly: string | null;
  language: string | null;
  symbolKey: string | null;
  location: SourceLocation | null;
  external: boolean;
  metadata: Metadata;
  provenance: Provenance[];
}

export interface Relationship {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  repositoryId: string | null;
  evidence: EvidenceLevel;
  confidence: number;
  metadata: Metadata;
  provenance: Provenance[];
}

export interface UnresolvedReference {
  id: string;
  type: RelationshipType;
  sourceId: string;
  repositoryId: string;
  targetDisplay: string;
  resolver: string;
  reason: string;
  confidence: number;
  metadata: Metadata;
  provenance: Provenance[];
}

export type DiagnosticCategory = "repository" | "discovery" | "project" | "parser" | "compilation" | "semantic" | "framework" | "resolver" | "storage";
export type Severity = "info" | "warning" | "error";

export interface Diagnostic {
  id: string;
  repositoryId: string;
  category: DiagnosticCategory;
  plugin: string;
  file: string | null;
  severity: Severity;
  recoverable: boolean;
  code: string;
  message: string;
}

export type ConflictStatus = "unresolved" | "resolved" | "accepted";

export interface Conflict {
  id: string;
  repositoryId: string | null;
  kind: string;
  subject: string;
  factIds: string[];
  severity: Severity;
  status: ConflictStatus;
  description: string;
  provenance: Provenance[];
}

export interface RepositoryRecord {
  id: string;
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export interface AnalysisRun {
  id: string;
  repositoryId: string;
  commit: string | null;
  startedAt: string;
  finishedAt: string;
  schemaVersion: number;
  analyzerVersion: string;
  pluginVersions: Record<string, string>;
  stats: Record<string, number>;
}

export interface FileRecord {
  repositoryId: string;
  path: string;
  hash: string;
  size: number;
  category: FileCategory;
  language: string | null;
}

export type FileCategory = "source" | "project" | "solution" | "config" | "infrastructure" | "pipeline" | "contract" | "other";

export interface GraphBatch {
  entities: Entity[];
  relationships: Relationship[];
  unresolved: UnresolvedReference[];
  diagnostics: Diagnostic[];
  conflicts: Conflict[];
}

export function isRelationshipType(value: string): value is RelationshipType {
  return (ALL_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}
