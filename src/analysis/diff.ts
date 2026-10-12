import { hashOf } from "../graph/identity.ts";
import type { GraphSnapshotPayload, GraphSnapshotRecord, Metadata } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import { categoryOf, type ImpactCategory } from "./semantics.ts";

const FULL_METADATA = new Set([
  "Application", "Endpoint", "Api", "ApiOperation", "ApiSchema", "Message", "Topic", "Queue", "HttpClient", "Project", "Property", "Field",
  "Deployment", "Container", "KubernetesService", "KubernetesIngress", "ContainerImage", "Pipeline", "HelmRelease", "ExternalApi", "ExternalSystem", "Database", "SharedContract",
  "Package", "Environment", "KubernetesNamespace", "Repository", "AuthorizationMetadata",
  "SecretReference", "Configuration", "EnvironmentVariable", "Container", "OwnershipRule", "Middleware", "Topic", "Queue", "Storage",
  "AzureFunction", "AzureResource",
]);
const SECURITY_RELATIONSHIPS = new Set(["USES_SECRET", "REFERENCES_CONFIG", "REQUIRES_AUTHORIZATION", "ALLOWS_ANONYMOUS", "ROUTES_TO", "EXPOSES_ENDPOINT", "IN_ENVIRONMENT"]);
const loc = (p: { location: { file: string; startLine: number } | null } | undefined) => (p?.location ? `${p.location.file}:${p.location.startLine}` : null);
const ARCH_RELATIONSHIPS = new Set([
  "PROJECT_REFERENCES", "PACKAGE_DEPENDS_ON", "CALLS_ENDPOINT", "PUBLISHES", "CONSUMED_BY", "HANDLED_BY", "SENDS_TO", "CALLS_EXTERNAL_API", "USES_EXTERNAL_SYSTEM", "CALLS_EXTERNAL_SYSTEM",
  "USES_DATABASE", "RUNS", "RUNS_IMAGE", "DEPLOYS", "PACKAGED_AS", "BUILDS", "EXPOSES_SERVICE", "ACCEPTS_REQUEST", "PRODUCES_RESPONSE", "IMPLEMENTED_BY",
  "CALLS_REPOSITORY", "DEPENDS_ON_REPOSITORY", "CONSUMES_REPOSITORY_CONTRACT", "DEPLOYS_REPOSITORY", "SHARES_CONTRACT_WITH", "CONSUMES_API", "PROVIDES_API", "USES_SHARED_PACKAGE",
  "TRIGGERS", "CHANGE_FEED", "SUBSCRIBES_TO", "PUBLISHES_TO", "PUBLISHES_EVENT", "CONSUMES_FROM", "RECEIVES_MESSAGE", "READS_FROM", "WRITES_TO", "DECLARED_BY", "HOSTED_ON", "DEPLOYED_TO",
  "HAS_ROLE_ON", "AUTHENTICATES_WITH", "USES_IDENTITY", "READS_SECRET_FROM", "PRIVATE_ENDPOINT_FOR", "ROUTES_TRAFFIC_TO", "CONNECTS_TO",
]);

const metaHash = (m: Metadata) => hashOf(JSON.stringify(m)).slice(0, 16);

export function captureRepositorySnapshot(store: GraphStore, repositoryId: string, commit: string | null, graphVersion: string): GraphSnapshotRecord {
  const payload: GraphSnapshotPayload = { entities: [], relationships: [] };
  for (const e of store.iterateEntities(repositoryId)) payload.entities.push([e.id, e.kind, e.name, e.qualifiedName, e.location?.file ?? null, metaHash(e.metadata), FULL_METADATA.has(e.kind) ? e.metadata : null, e.projectId, e.repositoryId, FULL_METADATA.has(e.kind) ? (e.location?.startLine ?? null) : null]);
  const referenced = new Set<string>();
  for (const r of store.iterateRelationships(repositoryId)) {
    payload.relationships.push([r.id, r.type, r.sourceId, r.targetId, r.evidence, metaHash(r.metadata), ARCH_RELATIONSHIPS.has(r.type) || SECURITY_RELATIONSHIPS.has(r.type) ? r.metadata : null, loc(r.provenance[0])]);
    referenced.add(r.targetId);
  }
  const own = new Set(payload.entities.map((e) => e[0]));
  const external = [...referenced].filter((id) => !own.has(id));
  for (let i = 0; i < external.length; i += 400) {
    for (const e of store.findEntities({ ids: external.slice(i, i + 400) })) {
      if (e.kind === "Package" || e.kind === "ExternalApi" || e.kind === "Assembly" || e.kind === "Environment" || (e.kind === "ExternalSystem" && e.repositoryId === null)) payload.entities.push([e.id, e.kind, e.name, e.qualifiedName, null, metaHash(e.metadata), FULL_METADATA.has(e.kind) ? e.metadata : null, null, e.repositoryId]);
    }
  }
  const record: GraphSnapshotRecord = { id: `gs_${hashOf("repository", repositoryId, graphVersion).slice(0, 24)}`, scope: "repository", repositoryId, commit, graphVersion, createdAt: new Date().toISOString(), entities: payload.entities.length, relationships: payload.relationships.length };
  store.saveGraphSnapshot(record, payload);
  return record;
}

export function captureMetaSnapshot(store: GraphStore, snapshotId: string): GraphSnapshotRecord {
  const payload: GraphSnapshotPayload = { entities: [], relationships: [] };
  for (const e of store.findMetaEntities({})) payload.entities.push([e.id, e.kind, e.name, e.qualifiedName, null, metaHash(e.metadata), e.metadata, null, null]);
  const endpoints = new Set<string>();
  for (const r of store.findMetaRelationships({})) {
    const { sourceCommit: _a, targetCommit: _b, sourceGraphVersion: _c, targetGraphVersion: _d, resolver: _e, ...stable } = r.metadata;
    payload.relationships.push([r.id, r.type, r.sourceId, r.targetId, r.evidence, metaHash({ ...stable, environment: r.environment }), { ...r.metadata, environment: r.environment, sourceRepositoryId: r.sourceRepositoryId, targetRepositoryId: r.targetRepositoryId }, r.provenance.slice(1).map(loc).filter(Boolean).join(" | ") || null]);
    endpoints.add(r.sourceId).add(r.targetId);
  }
  const ids = [...endpoints];
  for (let i = 0; i < ids.length; i += 400) for (const e of store.findEntities({ ids: ids.slice(i, i + 400) })) payload.entities.push([e.id, e.kind, e.name, e.qualifiedName, e.location?.file ?? null, metaHash(e.metadata), null, e.projectId, e.repositoryId]);
  const record: GraphSnapshotRecord = { id: `gs_${hashOf("meta", snapshotId).slice(0, 24)}`, scope: "meta", repositoryId: null, commit: null, graphVersion: snapshotId, createdAt: new Date().toISOString(), entities: payload.entities.length, relationships: payload.relationships.length };
  store.saveGraphSnapshot(record, payload);
  return record;
}

type EntityRow = GraphSnapshotPayload["entities"][number];
type RelRow = GraphSnapshotPayload["relationships"][number];

export interface EntityChange {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  category: ImpactCategory;
  file: string | null;
  changedKeys?: string[];
}

export interface RelationshipChange {
  id: string;
  type: string;
  source: string;
  target: string;
  evidence: string;
  previousEvidence?: string;
}

export interface ArchitectureChange {
  kind: string;
  category: ImpactCategory;
  change: "added" | "removed" | "changed";
  subject: string;
  description: string;
  breakingPotential: boolean;
  evidence: string[];
}

export interface GraphDiff {
  old: GraphSnapshotRecord;
  new: GraphSnapshotRecord;
  graphScope: "repository" | "meta";
  repositoryId: string | null;
  entities: { added: EntityChange[]; removed: EntityChange[]; changed: EntityChange[] };
  relationships: { added: RelationshipChange[]; removed: RelationshipChange[]; changed: RelationshipChange[] };
  byCategory: Record<string, { added: number; removed: number; changed: number }>;
  architecture: ArchitectureChange[];
}

const label = (e: EntityRow | undefined) => (e ? (e[3] ?? e[2]) : "?");

export function diffSnapshots(store: GraphStore, oldId: string, newId: string): GraphDiff {
  const a = store.getGraphSnapshot(oldId);
  const b = store.getGraphSnapshot(newId);
  if (!a) throw new Error(`snapshot not found: ${oldId}`);
  if (!b) throw new Error(`snapshot not found: ${newId}`);
  if (a.record.scope !== b.record.scope) throw new Error("cannot compare a repository snapshot with a MetaGraph snapshot");
  const oldE = new Map(a.payload.entities.map((e) => [e[0], e]));
  const newE = new Map(b.payload.entities.map((e) => [e[0], e]));
  const oldR = new Map(a.payload.relationships.map((r) => [r[0], r]));
  const newR = new Map(b.payload.relationships.map((r) => [r[0], r]));
  const ownE = (rows: Map<string, EntityRow>, repo: string | null) => (id: string) => !repo || rows.get(id)?.[8] === repo;
  const isOldOwn = ownE(oldE, a.record.repositoryId);
  const isNewOwn = ownE(newE, b.record.repositoryId);
  const entityChange = (e: EntityRow, keys?: string[]): EntityChange => ({ id: e[0], kind: e[1], name: e[2], qualifiedName: e[3], category: categoryOf(e[1] as never), file: e[4], ...(keys ? { changedKeys: keys } : {}) });
  const relChange = (r: RelRow, ents: Map<string, EntityRow>, previous?: RelRow): RelationshipChange => ({ id: r[0], type: r[1], source: label(ents.get(r[2])), target: label(ents.get(r[3])), evidence: r[4], ...(previous && previous[4] !== r[4] ? { previousEvidence: previous[4] } : {}) });
  const sortBy = <T extends { id: string }>(list: T[]) => list.sort((x, y) => x.id.localeCompare(y.id));

  const added = sortBy([...newE.values()].filter((e) => !oldE.has(e[0]) && isNewOwn(e[0])).map((e) => entityChange(e)));
  const removed = sortBy([...oldE.values()].filter((e) => !newE.has(e[0]) && isOldOwn(e[0])).map((e) => entityChange(e)));
  const changed = sortBy([...newE.values()].flatMap((e) => {
    const before = oldE.get(e[0]);
    if (!before || !isNewOwn(e[0]) || (before[5] === e[5] && before[2] === e[2] && before[3] === e[3])) return [];
    const keys = before[6] && e[6] ? [...new Set([...Object.keys(before[6]), ...Object.keys(e[6])])].filter((k) => JSON.stringify(before[6]![k]) !== JSON.stringify(e[6]![k])).sort() : ["metadata"];
    return [entityChange(e, keys)];
  }));
  const relAdded = sortBy([...newR.values()].filter((r) => !oldR.has(r[0])).map((r) => relChange(r, newE)));
  const relRemoved = sortBy([...oldR.values()].filter((r) => !newR.has(r[0])).map((r) => relChange(r, oldE)));
  const relChanged = sortBy([...newR.values()].filter((r) => oldR.has(r[0]) && (oldR.get(r[0])![4] !== r[4] || (ARCH_RELATIONSHIPS.has(r[1]) && oldR.get(r[0])![5] !== r[5]))).map((r) => relChange(r, newE, oldR.get(r[0]))));

  const byCategory: GraphDiff["byCategory"] = {};
  const bump = (cat: string, k: "added" | "removed" | "changed") => {
    byCategory[cat] ??= { added: 0, removed: 0, changed: 0 };
    byCategory[cat]![k]++;
  };
  added.forEach((e) => bump(e.category, "added"));
  removed.forEach((e) => bump(e.category, "removed"));
  changed.forEach((e) => bump(e.category, "changed"));

  return {
    old: a.record, new: b.record, graphScope: a.record.scope, repositoryId: b.record.repositoryId,
    entities: { added, removed, changed },
    relationships: { added: relAdded, removed: relRemoved, changed: relChanged },
    byCategory: Object.fromEntries(Object.entries(byCategory).sort(([x], [y]) => x.localeCompare(y))),
    architecture: detectArchitectureChanges(a.payload, b.payload, oldE, newE, oldR, newR, isOldOwn, isNewOwn),
  };
}

const ENTITY_CHANGES: Record<string, string> = {
  Application: "SERVICE", Api: "API", ApiOperation: "API_OPERATION", Message: "MESSAGE_CONTRACT", Project: "PROJECT", ExternalApi: "EXTERNAL_SYSTEM", ExternalSystem: "EXTERNAL_SYSTEM", Database: "DATABASE",
  Deployment: "DEPLOYMENT", KubernetesService: "KUBERNETES_SERVICE", KubernetesIngress: "INGRESS", ContainerImage: "CONTAINER_IMAGE", Pipeline: "PIPELINE", SharedContract: "SHARED_CONTRACT",
};
const RELATIONSHIP_CHANGES: Record<string, string> = {
  PROJECT_REFERENCES: "PROJECT_DEPENDENCY", PACKAGE_DEPENDS_ON: "PACKAGE_DEPENDENCY", CALLS_ENDPOINT: "API_CONSUMER", PUBLISHES: "MESSAGE_PUBLISHER", SENDS_TO: "MESSAGE_PUBLISHER",
  CONSUMED_BY: "MESSAGE_CONSUMER", HANDLED_BY: "MESSAGE_CONSUMER", CALLS_EXTERNAL_API: "EXTERNAL_SYSTEM_DEPENDENCY", USES_EXTERNAL_SYSTEM: "EXTERNAL_SYSTEM_DEPENDENCY",
  CALLS_EXTERNAL_SYSTEM: "EXTERNAL_SYSTEM_DEPENDENCY", USES_DATABASE: "DATABASE_DEPENDENCY", RUNS: "DEPLOYMENT_RELATIONSHIP", RUNS_IMAGE: "DEPLOYMENT_RELATIONSHIP", DEPLOYS: "DEPLOYMENT_RELATIONSHIP",
  PACKAGED_AS: "DEPLOYMENT_RELATIONSHIP", EXPOSES_SERVICE: "DEPLOYMENT_RELATIONSHIP", CALLS_REPOSITORY: "REPOSITORY_DEPENDENCY", DEPENDS_ON_REPOSITORY: "REPOSITORY_DEPENDENCY",
  CONSUMES_REPOSITORY_CONTRACT: "REPOSITORY_DEPENDENCY", DEPLOYS_REPOSITORY: "REPOSITORY_DEPENDENCY", SHARES_CONTRACT_WITH: "SHARED_CONTRACT_RELATIONSHIP", CONSUMES_API: "API_CONSUMER", USES_SHARED_PACKAGE: "SHARED_PACKAGE",
};

function detectArchitectureChanges(
  a: GraphSnapshotPayload, b: GraphSnapshotPayload, oldE: Map<string, EntityRow>, newE: Map<string, EntityRow>, oldR: Map<string, RelRow>, newR: Map<string, RelRow>,
  isOldOwn: (id: string) => boolean, isNewOwn: (id: string) => boolean,
): ArchitectureChange[] {
  const out: ArchitectureChange[] = [];
  const cat = (kind: string) => categoryOf(kind as never);
  for (const e of b.entities) if (ENTITY_CHANGES[e[1]] && !oldE.has(e[0]) && isNewOwn(e[0])) out.push({ kind: `${ENTITY_CHANGES[e[1]]}_ADDED`, category: cat(e[1]), change: "added", subject: label(e), description: `new ${e[1]} ${label(e)}`, breakingPotential: false, evidence: [e[0], ...(e[4] ? [e[4]] : [])] });
  for (const e of a.entities) if (ENTITY_CHANGES[e[1]] && !newE.has(e[0]) && isOldOwn(e[0])) out.push({ kind: `${ENTITY_CHANGES[e[1]]}_REMOVED`, category: cat(e[1]), change: "removed", subject: label(e), description: `${e[1]} ${label(e)} no longer exists`, breakingPotential: ["ApiOperation", "Api", "Message"].includes(e[1]), evidence: [e[0], ...(e[4] ? [e[4]] : [])] });

  for (const r of b.relationships) if (RELATIONSHIP_CHANGES[r[1]] && !oldR.has(r[0])) out.push({ kind: `${RELATIONSHIP_CHANGES[r[1]]}_ADDED`, category: cat(newE.get(r[3])?.[1] ?? "Type"), change: "added", subject: `${label(newE.get(r[2]))} -> ${label(newE.get(r[3]))}`, description: `new ${r[1]} ${label(newE.get(r[2]))} -> ${label(newE.get(r[3]))}`, breakingPotential: false, evidence: [r[0]] });
  for (const r of a.relationships) if (RELATIONSHIP_CHANGES[r[1]] && !newR.has(r[0])) out.push({ kind: `${RELATIONSHIP_CHANGES[r[1]]}_REMOVED`, category: cat(oldE.get(r[3])?.[1] ?? "Type"), change: "removed", subject: `${label(oldE.get(r[2]))} -> ${label(oldE.get(r[3]))}`, description: `removed ${r[1]} ${label(oldE.get(r[2]))} -> ${label(oldE.get(r[3]))}`, breakingPotential: false, evidence: [r[0]] });

  const outgoing = (rels: GraphSnapshotPayload["relationships"], type: string) => {
    const m = new Map<string, string[]>();
    for (const r of rels) if (r[1] === type) m.set(r[2], [...(m.get(r[2]) ?? []), r[3]]);
    return m;
  };
  const oldImpl = outgoing(a.relationships, "IMPLEMENTED_BY");
  const newImpl = outgoing(b.relationships, "IMPLEMENTED_BY");
  const oldRoutes = outgoing(a.relationships, "ROUTES_TO");
  const newRoutes = outgoing(b.relationships, "ROUTES_TO");
  const handlers = (op: string, impl: Map<string, string[]>, routes: Map<string, string[]>) => new Set((impl.get(op) ?? []).flatMap((ep) => routes.get(ep) ?? []));
  const removedOps = a.entities.filter((e) => e[1] === "ApiOperation" && !newE.has(e[0]));
  const addedOps = b.entities.filter((e) => e[1] === "ApiOperation" && !oldE.has(e[0]));
  for (const before of removedOps) {
    const h = handlers(before[0], oldImpl, oldRoutes);
    const after = addedOps.find((x) => [...handlers(x[0], newImpl, newRoutes)].some((y) => h.has(y)));
    if (!after || !before[6] || !after[6]) continue;
    const kinds = [before[6].method !== after[6].method ? "METHOD" : null, before[6].path !== after[6].path ? "ROUTE" : null, before[6].version !== after[6].version ? "VERSION" : null].filter(Boolean);
    for (const k of kinds) out.push({ kind: `API_${k}_CHANGED`, category: "API", change: "changed", subject: label(after), description: `${label(before)} became ${label(after)} (same handler)`, breakingPotential: true, evidence: [before[0], after[0]] });
  }

  const payloadTypes = (rels: GraphSnapshotPayload["relationships"], type: string) => outgoing(rels, type);
  const members = (rels: GraphSnapshotPayload["relationships"], ents: Map<string, EntityRow>) => {
    const m = new Map<string, string[]>();
    for (const r of rels) if ((r[1] === "CONTAINS" || r[1] === "DECLARES") && ["Property", "Field"].includes(ents.get(r[3])?.[1] ?? "")) m.set(r[2], [...(m.get(r[2]) ?? []), ents.get(r[3])![2]]);
    return m;
  };
  const oldMembers = members(a.relationships, oldE);
  const newMembers = members(b.relationships, newE);
  for (const [side, type] of [["REQUEST", "ACCEPTS_REQUEST"], ["RESPONSE", "PRODUCES_RESPONSE"]] as const) {
    const before = payloadTypes(a.relationships, type);
    const after = payloadTypes(b.relationships, type);
    for (const op of b.entities.filter((e) => e[1] === "ApiOperation" && oldE.has(e[0]))) {
      const x = new Set(before.get(op[0]) ?? []);
      const y = new Set(after.get(op[0]) ?? []);
      if ([...x].some((t) => !y.has(t)) || [...y].some((t) => !x.has(t))) out.push({ kind: `API_${side}_CONTRACT_CHANGED`, category: "API", change: "changed", subject: label(op), description: `${side.toLowerCase()} contract of ${label(op)} changed`, breakingPotential: true, evidence: [op[0]] });
      for (const t of [...y].filter((t) => x.has(t))) {
        const f0 = new Set(oldMembers.get(t) ?? []);
        const f1 = new Set(newMembers.get(t) ?? []);
        const removedFields = [...f0].filter((f) => !f1.has(f)).sort();
        const addedFields = [...f1].filter((f) => !f0.has(f)).sort();
        if (removedFields.length || addedFields.length) out.push({ kind: `API_${side}_FIELD_CHANGED`, category: "API", change: "changed", subject: label(op), description: `${label(newE.get(t))} used by ${label(op)}: ${addedFields.length ? `added ${addedFields.join(", ")}` : ""}${addedFields.length && removedFields.length ? "; " : ""}${removedFields.length ? `removed ${removedFields.join(", ")}` : ""}`, breakingPotential: removedFields.length > 0 || side === "REQUEST", evidence: [op[0], t] });
      }
    }
  }
  for (const e of b.entities.filter((x) => x[1] === "ApiOperation" && oldE.get(x[0])?.[6] && x[6])) {
    const before = oldE.get(e[0])![6]!;
    if (JSON.stringify(before.parameters) !== JSON.stringify(e[6]!.parameters)) out.push({ kind: "API_PARAMETERS_CHANGED", category: "API", change: "changed", subject: label(e), description: `parameters of ${label(e)} changed`, breakingPotential: true, evidence: [e[0]] });
  }
  for (const e of b.entities.filter((x) => x[1] === "Message" && oldE.get(x[0])?.[6] && x[6])) {
    const f0 = new Set((oldE.get(e[0])![6]!.fields as string[] | undefined) ?? []);
    const f1 = new Set((e[6]!.fields as string[] | undefined) ?? []);
    const removedFields = [...f0].filter((f) => !f1.has(f));
    const addedFields = [...f1].filter((f) => !f0.has(f));
    if (removedFields.length || addedFields.length) out.push({ kind: "MESSAGE_FIELDS_CHANGED", category: "MESSAGE", change: "changed", subject: label(e), description: `${label(e)}: ${[...addedFields.map((f) => `+${f}`), ...removedFields.map((f) => `-${f}`)].join(" ")}`, breakingPotential: removedFields.length > 0, evidence: [e[0]] });
  }
  return out.sort((x, y) => x.category.localeCompare(y.category) || x.kind.localeCompare(y.kind) || x.subject.localeCompare(y.subject));
}

export function snapshotFor(store: GraphStore, ref: string, scope: "repository" | "meta", repositoryId?: string): GraphSnapshotRecord | null {
  const list = store.listGraphSnapshots({ scope, repositoryId });
  return [...list].reverse().find((s) => s.id === ref || s.graphVersion === ref || s.graphVersion.startsWith(ref) || (s.commit && s.commit.startsWith(ref))) ?? null;
}
