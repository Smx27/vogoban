import { hashOf } from "../graph/identity.ts";
import type { EntityKind, Metadata, RelationshipType } from "../graph/model.ts";
import type { GovernanceEnrichment, Violation, ViolationOwnership } from "../governance/evaluate.ts";
import type { GEntity, GovernanceGraph, GRel } from "../governance/graph.ts";
import type { PolicySet } from "../governance/policy.ts";
import type { GraphStore } from "../store/store.ts";
import type { EnterpriseConfig } from "./config.ts";
import { buildEnterpriseModel, ownerOf, type EnterpriseModel } from "./model.ts";

const add = (facts: Map<string, Record<string, string[]>>, id: string, key: string, values: string[]) => {
  const f = facts.get(id) ?? {};
  f[key] = [...new Set([...(f[key] ?? []), ...values])].sort();
  facts.set(id, f);
};

export function enrichGovernanceGraph(model: EnterpriseModel, cfg: EnterpriseConfig): void {
  const graph = model.graph;
  const facts = graph.facts;
  for (const s of model.services) add(facts, s.service.id, "exposure", [s.exposure]);
  for (const ep of model.endpoints) {
    add(facts, ep.endpoint.id, "exposure", [ep.exposure]);
    add(facts, ep.endpoint.id, "protection", [ep.protection]);
    for (const r of graph.incoming(ep.endpoint.id, ["IMPLEMENTED_BY"])) {
      add(facts, r.sourceId, "exposure", [ep.exposure]);
      add(facts, r.sourceId, "protection", [ep.protection]);
    }
  }
  for (const o of model.ownership) {
    add(facts, o.component.id, "ownership", [o.state]);
    if (o.owners.length) add(facts, o.component.id, "owner", o.owners.map((x) => x.id));
  }
  for (const [id, c] of model.criticality) add(facts, id, "criticality", [c.level]);
  for (const r of model.resources) if (r.classification) add(facts, r.resource.id, "classification", [r.classification]);
  for (const [id, zone] of model.zones) add(facts, id, "boundary", [zone]);
  const appEnvs = new Map<string, string[]>();
  for (const s of model.services) appEnvs.set(s.service.id, [...new Set(s.byEnvironment.map((b) => b.environment).filter((x): x is string => !!x))]);
  for (const [id, envs] of appEnvs) if (envs.length) add(facts, id, "environment", envs);
  for (const ep of model.endpoints) {
    const envs = ep.exposure === "PUBLIC" ? ep.publicEnvironments.filter((x): x is string => !!x) : ep.service ? (appEnvs.get(ep.service.id) ?? []) : [];
    if (envs.length) add(facts, ep.endpoint.id, "environment", envs);
  }
  for (const r of model.resources) if (r.environments.length && r.resource.kind === "DataStore") add(facts, r.resource.id, "environment", r.environments);
  for (const sec of model.secrets) {
    add(facts, sec.secret.id, "secretProvider", [sec.provider]);
    add(facts, sec.secret.id, "secretState", [sec.state]);
  }
  graph.invalidateEnvironments();
  for (const [id, f] of facts) {
    const e = graph.entities.get(id);
    if (e) e.metadata = { ...e.metadata, ...(Object.fromEntries(Object.entries(f).map(([k, v]) => [k === "owner" ? "owners" : k === "environment" ? "environments" : k, v])) as Metadata) };
  }

  const virtual = (id: string, kind: EntityKind, name: string, metadata: Metadata): GEntity => {
    graph.addVirtualEntity({ id, kind, name, qualifiedName: `${kind.toLowerCase()}:${name}`, file: cfg.file, metadata, projectId: null, repositoryId: null });
    return graph.entities.get(id)!;
  };
  const rel = (type: RelationshipType, sourceId: string, targetId: string, metadata: Metadata = {}, location: string | null = cfg.file) => {
    const r: GRel = { id: `ent_${hashOf(type, sourceId, targetId).slice(0, 22)}`, type, sourceId, targetId, evidence: "DECLARED", metadata, location, scope: "enterprise", snapshot: model.config.fingerprint };
    graph.addVirtualRelationship(r);
  };
  for (const o of cfg.organizations) virtual(`org:${o.id}`, "Organization", o.id, { displayName: o.name, external: o.external });
  for (const b of cfg.businessUnits) {
    virtual(`bu:${b.id}`, "BusinessUnit", b.id, { displayName: b.name, organization: b.parent });
    if (b.parent) rel("CONTAINS", `org:${b.parent}`, `bu:${b.id}`);
  }
  for (const t of cfg.teams) {
    virtual(`team:${t.id}`, "Team", t.id, { displayName: t.name, businessUnit: t.businessUnit, organization: t.organization, handles: t.handles });
    if (t.businessUnit) rel("CONTAINS", `bu:${t.businessUnit}`, `team:${t.id}`);
    else if (t.organization) rel("CONTAINS", `org:${t.organization}`, `team:${t.id}`);
  }
  for (const b of cfg.boundaries) virtual(`tb:${b.id}`, "TrustBoundary", b.id, { boundaryKind: b.kind, displayName: b.name });
  for (const o of model.ownership) {
    for (const owner of o.owners.filter((x) => x.kind === "team")) rel(o.relationship, `team:${owner.id}`, o.component.id, { source: [...new Set(o.claims.filter((c) => c.owner === owner.id).map((c) => c.source))].sort(), state: o.state });
    for (const m of o.maintainers.filter((x) => x.kind === "team")) if (o.component.kind === "Repository") rel("MAINTAINS_REPOSITORY", `team:${m.id}`, o.component.id);
  }
  for (const ep of model.endpoints) if (ep.exposure === "PUBLIC" && ep.service) rel("EXPOSES_PUBLIC_ENDPOINT", ep.service.id, ep.endpoint.id, { protection: ep.protection, environments: ep.publicEnvironments.map((e) => e ?? "(unscoped)") }, ep.exposurePath[0]?.relationship.location ?? null);
  const sensitive = new Map(model.resources.map((r) => [r.resource.id, r]));
  for (const f of model.flowEdges) {
    const res = sensitive.get(f.to);
    if (!res) continue;
    if (res.resource.kind === "DataStore") rel("USES_DATABASE", f.from, f.to, { derived: f.basis }, f.steps[f.steps.length - 1]?.location ?? null);
    if (res.sensitive) rel("ACCESSES_SENSITIVE_RESOURCE", f.from, f.to, { classification: res.classification ?? "", via: f.basis }, f.steps[f.steps.length - 1]?.location ?? null);
  }
  for (const c of model.crossings) rel("CROSSES_TRUST_BOUNDARY", c.from.id, c.to.id, { fromBoundary: c.fromBoundary, toBoundary: c.toBoundary, dimension: c.dimension, approved: c.approved === null ? "unreviewed" : String(c.approved) }, c.path[c.path.length - 1]?.relationship.location ?? null);
}

export function violationOwnership(model: EnterpriseModel, cfg: EnterpriseConfig, v: Pick<Violation, "source" | "target">): ViolationOwnership {
  const { record, via } = ownerOf(model, v.source.id);
  const repoEntity = model.graph.entities.get(v.source.id);
  const repo = repoEntity ? model.graph.repository(repoEntity) : null;
  const repoOwners = repo ? (model.ownership.find((o) => o.component.id === repo.id)?.owners.map((o) => o.id) ?? []) : [];
  const bu = new Map(cfg.businessUnits.map((b) => [b.id, b]));
  const owners = (record?.owners ?? []).map((o) => ({ id: o.id, kind: o.kind, name: o.name, businessUnit: o.businessUnit, organization: o.organization ?? (o.businessUnit ? (bu.get(o.businessUnit)?.parent ?? null) : null) }));
  return {
    component: record?.component ?? null, resolvedVia: via, state: record?.state ?? "UNOWNED", owners, repository: model.graph.repositoryName(repoEntity?.repositoryId ?? null), repositoryOwners: repoOwners,
    organizationalBoundaries: [...new Set(owners.flatMap((o) => [o.businessUnit ? `businessUnit:${o.businessUnit}` : null, o.organization ? `organization:${o.organization}` : null]).filter((x): x is string => !!x))].sort(),
  };
}

export function governanceEnrichment(store: GraphStore, cfg: EnterpriseConfig, capture?: (model: EnterpriseModel) => void): GovernanceEnrichment {
  return (graph: GovernanceGraph, policies: PolicySet) => {
    const model = buildEnterpriseModel(store, graph.set, cfg, policies, graph);
    enrichGovernanceGraph(model, cfg);
    capture?.(model);
    return (v) => violationOwnership(model, cfg, v);
  };
}
