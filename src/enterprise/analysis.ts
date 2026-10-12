import type { Entity } from "../graph/model.ts";
import type { AnalysisGraph } from "../analysis/graph.ts";
import { propagate, type ImpactOptions, type ImpactResult } from "../analysis/impact.ts";
import type { EntitySummary, PathStep } from "../governance/evaluate.ts";
import { criticalityRank } from "./config.ts";
import { ownerOf, PUBLIC_INTERNET, type EnterpriseModel, type OwnerRef, type OwnershipRecord } from "./model.ts";

const sortStr = (xs: string[]) => [...new Set(xs)].sort();
const label = (e: { kind: string; qualifiedName: string | null; name: string }) => `${e.kind} ${e.qualifiedName ?? e.name}`;
const pathText = (steps: PathStep[]) => steps.map((s) => `${s.from.name} -[${s.relationship.type}]-> ${s.to.name}`).join(" | ");

function dependencyKind(types: string[]): string {
  if (types.some((t) => t === "CALLS_ENDPOINT" || t === "CONSUMES_API" || t === "IMPLEMENTED_BY")) return "API_CONSUMER";
  if (types.some((t) => ["PUBLISHES", "HANDLED_BY", "CONSUMED_BY", "SENDS_TO", "CARRIES"].includes(t))) return "MESSAGE_CONSUMER";
  if (types.some((t) => ["RUNS", "RUNS_IMAGE", "DEPLOYS", "PACKAGED_AS", "EXPOSES_SERVICE", "ROUTES_TO", "DEPLOYS_REPOSITORY", "BUILDS"].includes(t))) return "INFRASTRUCTURE";
  if (types.some((t) => ["PROJECT_REFERENCES", "PACKAGE_DEPENDS_ON", "USES_SHARED_PACKAGE", "DEPENDS_ON_REPOSITORY"].includes(t))) return "BUILD_DEPENDENCY";
  return "CODE";
}

export interface TeamImpact {
  seeds: { entity: EntitySummary | { id: string; kind: string; name: string; qualifiedName: string | null }; owners: OwnerRef[]; ownership: string; resolvedVia: string }[];
  owningTeams: string[];
  impactedTeams: { team: OwnerRef; crossTeam: boolean; crossOrganization: boolean; byDependency: Record<string, number>; components: { component: EntitySummary; category: string; level: string; dependency: string; via: string; path: string }[] }[];
  unownedImpacted: { component: EntitySummary | null; entity: string; level: string; ownership: string; path: string }[];
  crossTeamDependencies: number;
  crossOrganizationTeams: string[];
  impact: { total: number; byLevel: Record<string, number>; truncated: boolean };
}

export function teamImpact(model: EnterpriseModel, graph: AnalysisGraph, seeds: Entity[], options: ImpactOptions, result?: ImpactResult): TeamImpact {
  const impact = result ?? propagate(graph, seeds, options);
  const seedInfo = seeds.map((s) => {
    const { record, via } = ownerOf(model, s.id);
    return { entity: { id: s.id, kind: s.kind, name: s.name, qualifiedName: s.qualifiedName }, owners: record?.owners ?? [], ownership: record?.state ?? "UNOWNED", resolvedVia: via };
  });
  const owningTeams = sortStr(seedInfo.flatMap((s) => s.owners.map((o) => o.id)));
  const seedOrgs = new Set(seedInfo.flatMap((s) => s.owners.map((o) => o.organization).filter((o): o is string => !!o)));
  const teams = new Map<string, TeamImpact["impactedTeams"][number]>();
  const unowned = new Map<string, TeamImpact["unownedImpacted"][number]>();
  for (const i of impact.impacted) {
    const { record } = ownerOf(model, i.entity.id);
    const types = i.path.steps.map((s) => s.relationship.type);
    const dependency = dependencyKind(types);
    const path = i.path.steps.map((s) => `${s.relationship.direction === "reverse" ? "<-" : "->"}${s.relationship.type} ${s.to.name}`).join(" ");
    if (!record || !record.owners.length) {
      const key = record?.component.id ?? i.entity.id;
      if (!unowned.has(key)) unowned.set(key, { component: record?.component ?? null, entity: label(i.entity), level: i.level, ownership: record?.state ?? "UNOWNED", path });
      continue;
    }
    for (const owner of record.owners) {
      const t = teams.get(owner.id) ?? { team: owner, crossTeam: !owningTeams.includes(owner.id), crossOrganization: !!owner.organization && seedOrgs.size > 0 && !seedOrgs.has(owner.organization), byDependency: {}, components: [] };
      if (!t.components.some((c) => c.component.id === record.component.id)) {
        t.components.push({ component: record.component, category: record.category, level: i.level, dependency, via: label(i.entity), path });
        t.byDependency[dependency] = (t.byDependency[dependency] ?? 0) + 1;
      }
      teams.set(owner.id, t);
    }
  }
  const serviceIds = new Set([...seeds, ...impact.impacted.map((i) => model.graph.entities.get(i.entity.id)).filter((e): e is NonNullable<typeof e> => !!e)].flatMap((e) => model.graph.applications(e as never).map((a) => a.id)));
  for (const f of model.flowEdges) {
    if (!serviceIds.has(f.to) || f.from === PUBLIC_INTERNET || serviceIds.has(f.from) || (f.kind !== "SERVICE_CALL" && f.kind !== "MESSAGE")) continue;
    const { record } = ownerOf(model, f.from);
    const consumer = model.graph.entities.get(f.from);
    if (!consumer) continue;
    const path = `${consumer.name} -${f.kind}-> ${model.graph.entities.get(f.to)?.name ?? f.to} (${f.basis}; ${f.steps.map((r) => r.type).join(" ")})`;
    if (!record || !record.owners.length) {
      if (!unowned.has(f.from)) unowned.set(f.from, { component: model.evaluator.summary(consumer), entity: label(consumer), level: "DIRECT", ownership: record?.state ?? "UNOWNED", path });
      continue;
    }
    const dependency = f.kind === "MESSAGE" ? "MESSAGE_CONSUMER" : "SERVICE_CONSUMER";
    for (const owner of record.owners) {
      const t = teams.get(owner.id) ?? { team: owner, crossTeam: !owningTeams.includes(owner.id), crossOrganization: !!owner.organization && seedOrgs.size > 0 && !seedOrgs.has(owner.organization), byDependency: {}, components: [] };
      if (!t.components.some((c) => c.component.id === record.component.id && c.dependency === dependency)) {
        t.components.push({ component: record.component, category: record.category, level: "DIRECT", dependency, via: `security-graph flow ${f.basis}`, path });
        t.byDependency[dependency] = (t.byDependency[dependency] ?? 0) + 1;
      }
      teams.set(owner.id, t);
    }
  }
  const impactedTeams = [...teams.values()].sort((a, b) => Number(b.crossTeam) - Number(a.crossTeam) || a.team.id.localeCompare(b.team.id));
  const rank = (c: string) => ["SERVICE", "API", "MESSAGE", "CONTRACT", "RESOURCE", "EXTERNAL_INTEGRATION", "PROJECT", "REPOSITORY", "SECRET", "INFRASTRUCTURE"].indexOf(c);
  for (const t of impactedTeams) t.components.sort((a, b) => rank(a.category) - rank(b.category) || a.component.name.localeCompare(b.component.name) || a.component.id.localeCompare(b.component.id));
  return {
    seeds: seedInfo, owningTeams, impactedTeams, unownedImpacted: [...unowned.values()].sort((a, b) => a.entity.localeCompare(b.entity)),
    crossTeamDependencies: impactedTeams.filter((t) => t.crossTeam).reduce((n, t) => n + t.components.length, 0),
    crossOrganizationTeams: impactedTeams.filter((t) => t.crossOrganization).map((t) => t.team.id),
    impact: { total: impact.impacted.length, byLevel: impact.byLevel, truncated: impact.truncated },
  };
}

export interface TeamDependency {
  from: OwnerRef;
  to: OwnerRef;
  crossBusinessUnit: boolean;
  crossOrganization: boolean;
  dependencies: { from: EntitySummary; to: EntitySummary; kind: string; basis: string; path: string }[];
}

export function teamDependencies(model: EnterpriseModel): { edges: TeamDependency[]; unattributed: number } {
  const g = model.graph;
  const out = new Map<string, TeamDependency>();
  let unattributed = 0;
  const S = (id: string) => model.evaluator.summary(g.entities.get(id)!);
  const record = (from: string, to: string, kind: string, basis: string, path: string) => {
    const a = ownerOf(model, from).record;
    const b = ownerOf(model, to).record;
    if (!a?.owners.length || !b?.owners.length) {
      unattributed++;
      return;
    }
    for (const x of a.owners) for (const y of b.owners) {
      if (x.id === y.id) continue;
      const key = `${x.id}|${y.id}`;
      const d = out.get(key) ?? { from: x, to: y, crossBusinessUnit: x.businessUnit !== y.businessUnit, crossOrganization: x.organization !== y.organization, dependencies: [] };
      if (!d.dependencies.some((z) => z.from.id === from && z.to.id === to && z.basis === basis)) d.dependencies.push({ from: S(from), to: S(to), kind, basis, path });
      out.set(key, d);
    }
  };
  for (const f of model.flowEdges) if (f.from !== PUBLIC_INTERNET && g.entities.get(f.from) && g.entities.get(f.to)) record(f.from, f.to, f.kind, f.basis, f.steps.map((r) => r.type).join(" "));
  for (const type of ["DEPENDS_ON_REPOSITORY", "CALLS_REPOSITORY", "CONSUMES_REPOSITORY_CONTRACT", "DEPLOYS_REPOSITORY", "RUNS"] as const) {
    for (const r of g.byType.get(type) ?? []) if (g.entities.get(r.sourceId) && g.entities.get(r.targetId)) record(r.sourceId, r.targetId, type === "RUNS" ? "INFRASTRUCTURE" : "REPOSITORY_DEPENDENCY", type, `${r.type} ${r.id}${r.location ? ` @ ${r.location}` : ""}`);
  }
  const edges = [...out.values()].sort((a, b) => a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id));
  for (const e of edges) e.dependencies.sort((a, b) => a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name) || a.basis.localeCompare(b.basis));
  return { edges, unattributed };
}

export interface SecurityImpact {
  component: EntitySummary;
  kind: string;
  classification: string | null;
  owners: string[];
  consumers: { service: EntitySummary; via: string; path: string }[];
  publicConsumers: string[];
  impact: ImpactResult | null;
  teams: TeamImpact | null;
}

export function securityImpact(model: EnterpriseModel, graph: AnalysisGraph, ref: string, options: ImpactOptions): SecurityImpact | null {
  const lc = ref.toLowerCase();
  const secret = model.secrets.find((s) => s.secret.id === ref || s.secret.qualifiedName === ref || s.name.toLowerCase() === lc);
  const resource = model.resources.find((r) => r.resource.id === ref || r.resource.name.toLowerCase() === lc || r.resource.qualifiedName === ref);
  const endpoint = model.endpoints.find((e) => e.endpoint.id === ref);
  const service = model.services.find((s) => s.service.id === ref || s.service.name.toLowerCase() === lc);
  let component: EntitySummary;
  let kind: string;
  let classification: string | null = null;
  let consumers: SecurityImpact["consumers"];
  if (secret) {
    component = secret.secret;
    kind = `secret-reference (${secret.provider}, ${secret.state})`;
    consumers = secret.consumers.flatMap((c) => c.services.map((s) => ({ service: s, via: `${c.entity.kind} ${c.entity.name}`, path: pathText(c.path) })));
  } else if (resource) {
    component = resource.resource;
    kind = resource.resourceType;
    classification = resource.classification;
    consumers = resource.accessors.flatMap((c) => c.services.map((s) => ({ service: s, via: `${c.entity.kind} ${c.entity.name}`, path: pathText(c.path) })));
  } else if (endpoint) {
    component = endpoint.endpoint;
    kind = `endpoint (${endpoint.exposure}, ${endpoint.protection})`;
    consumers = endpoint.service ? [{ service: endpoint.service, via: "EXPOSES_ENDPOINT", path: pathText(endpoint.exposurePath) }] : [];
  } else if (service) {
    component = service.service;
    kind = `service (${service.exposure})`;
    consumers = [{ service: service.service, via: "self", path: "" }];
  } else return null;
  const uniqueConsumers = [...new Map(consumers.map((c) => [`${c.service.id}|${c.via}`, c])).values()].sort((a, b) => a.service.name.localeCompare(b.service.name) || a.via.localeCompare(b.via));
  const seeds = [...graph.entities(uniqueConsumers.map((c) => c.service.id)).values()].sort((a, b) => a.id.localeCompare(b.id));
  const impact = seeds.length ? propagate(graph, seeds, options) : null;
  const exposure = new Map(model.services.map((s) => [s.service.id, s.exposure]));
  return {
    component, kind, classification, owners: ownerOf(model, component.id).record?.owners.map((o) => o.id) ?? [], consumers: uniqueConsumers,
    publicConsumers: sortStr([...uniqueConsumers.map((c) => c.service.id), ...(impact?.impacted.filter((i) => i.entity.kind === "Application").map((i) => i.entity.id) ?? [])].filter((id) => exposure.get(id) === "PUBLIC").map((id) => model.services.find((s) => s.service.id === id)!.service.name)),
    impact, teams: impact ? teamImpact(model, graph, seeds, options, impact) : null,
  };
}

export interface ContextFactor {
  factor: string;
  value: number | string;
  explanation: string;
  evidence: string[];
}

export function enterpriseRiskContext(model: EnterpriseModel, seeds: Entity[], impact: ImpactResult, teams: TeamImpact): ContextFactor[] {
  const ids = new Set([...seeds.map((s) => s.id), ...impact.impacted.map((i) => i.entity.id)]);
  const serviceIds = new Set([...ids].flatMap((id) => {
    const e = model.graph.entities.get(id);
    return e ? model.graph.applications(e).map((a) => a.id) : [];
  }));
  const publicServices = model.services.filter((s) => serviceIds.has(s.service.id) && s.exposure === "PUBLIC");
  const sensitive = model.resources.filter((r) => r.sensitive && r.accessors.some((a) => a.services.some((s) => serviceIds.has(s.id))));
  const crit = [...new Set([...ids, ...serviceIds])].map((id) => ({ id, c: model.criticality.get(id) })).filter((x) => x.c).sort((a, b) => criticalityRank(b.c!.level) - criticalityRank(a.c!.level));
  const gaps = teams.unownedImpacted.filter((u) => u.component && ["SERVICE", "API", "RESOURCE", "REPOSITORY", "INFRASTRUCTURE"].includes(model.ownership.find((o) => o.component.id === u.component!.id)?.category ?? ""));
  const crossings = model.crossings.filter((c) => serviceIds.has(c.from.id) || serviceIds.has(c.to.id));
  const name = (id: string) => model.graph.entities.get(id)?.name ?? id;
  return [
    { factor: "PUBLIC_EXPOSURE", value: publicServices.length, explanation: publicServices.length ? `${publicServices.length} affected services are publicly exposed` : "no affected service has observed public exposure", evidence: publicServices.map((s) => `${s.service.name}: ${s.evidence.filter((e) => e.exposure === "PUBLIC").map((e) => e.detail).slice(0, 2).join("; ")}`) },
    { factor: "SENSITIVE_RESOURCES", value: sensitive.length, explanation: sensitive.length ? `affected services access ${sensitive.length} resources classified at or above the sensitive threshold` : "no affected service accesses a classified sensitive resource", evidence: sensitive.map((r) => `${r.resource.name} (${r.classification})`) },
    { factor: "CRITICALITY", value: crit[0]?.c?.level ?? "UNSPECIFIED", explanation: crit.length ? `highest configured criticality among seeds and affected components is ${crit[0]!.c!.level}` : "no configured criticality applies", evidence: crit.slice(0, 10).map((x) => `${name(x.id)}: ${x.c!.level} (${x.c!.rules.join(", ")})`) },
    { factor: "OWNERSHIP_GAPS", value: gaps.length, explanation: gaps.length ? `${gaps.length} affected components have no resolved owner` : "every affected component has a resolved owner or none is ownable", evidence: gaps.slice(0, 10).map((u) => `${u.component!.name}: ${u.ownership}`) },
    { factor: "CROSS_TEAM_PROPAGATION", value: teams.impactedTeams.filter((t) => t.crossTeam).length, explanation: `impact reaches ${teams.impactedTeams.filter((t) => t.crossTeam).length} teams other than the owners of the changed components (${teams.owningTeams.join(", ") || "owner unknown"})`, evidence: teams.impactedTeams.filter((t) => t.crossTeam).map((t) => `${t.team.id}: ${t.components.length} components`) },
    { factor: "CROSS_ORGANIZATION_PROPAGATION", value: teams.crossOrganizationTeams.length, explanation: teams.crossOrganizationTeams.length ? `impact reaches teams of another organization: ${teams.crossOrganizationTeams.join(", ")}` : "no impacted team belongs to a different organization", evidence: teams.crossOrganizationTeams },
    { factor: "TRUST_BOUNDARY_CROSSINGS", value: crossings.length, explanation: `${crossings.length} configured trust-boundary crossings involve affected services (${crossings.filter((c) => c.approved === false).length} not approved)`, evidence: crossings.slice(0, 10).map((c) => `${c.from.name} -> ${c.to.name}: ${c.fromBoundary} -> ${c.toBoundary}${c.approved === false ? " (not approved)" : ""}`) },
  ];
}

export interface InventoryRow {
  category: string;
  component: EntitySummary;
  repository: string | null;
  environments: string[];
  owners: string[];
  ownership: string;
  criticality: string | null;
  classification: string | null;
  exposure: string | null;
  detail: string;
}

export function inventory(model: EnterpriseModel): InventoryRow[] {
  const rows: InventoryRow[] = [];
  const own = (id: string) => ownerOf(model, id).record;
  const row = (category: string, component: EntitySummary, detail: string, extra: Partial<InventoryRow> = {}) => {
    const o = own(component.id);
    rows.push({ category, component, repository: component.repository, environments: [], owners: o?.owners.map((x) => x.id) ?? [], ownership: o?.state ?? "UNOWNED", criticality: model.criticality.get(component.id)?.level ?? null, classification: null, exposure: null, detail, ...extra });
  };
  for (const s of model.services) {
    const pub = model.endpoints.filter((e) => e.service?.id === s.service.id && e.exposure === "PUBLIC");
    if (pub.length) row("PUBLIC_API", s.service, `${pub.length} public endpoints (${Object.entries(pub.reduce<Record<string, number>>((m, e) => ((m[e.protection] = (m[e.protection] ?? 0) + 1), m), {})).map(([k, n]) => `${k}=${n}`).join(", ")})`, { exposure: "PUBLIC", environments: sortStr(pub.flatMap((e) => e.publicEnvironments.map((x) => x ?? "(unscoped)"))) });
  }
  for (const r of model.resources) {
    if (r.resourceType === "external-system") row("EXTERNAL_INTEGRATION", r.resource, `${r.accessors.length} accessors; boundary ${model.zones.get(r.resource.id) ?? "unclassified"}`, { classification: r.classification, environments: r.environments });
    if (r.sensitive) row("SENSITIVE_RESOURCE", r.resource, `${r.resourceType}${r.technology ? `/${r.technology}` : ""}; ${r.classificationSources.join("; ")}`, { classification: r.classification, environments: r.environments });
  }
  for (const s of model.secrets) row("SECRET_REFERENCE", s.secret, `${s.provider} ${s.state} @ ${s.source ?? "-"} (value not collected)`, { environments: s.environments });
  for (const [id, c] of model.criticality) {
    const e = model.graph.entities.get(id);
    if (!e || criticalityRank(c.level) < criticalityRank("HIGH")) continue;
    row(e.kind === "Application" ? "CRITICAL_SERVICE" : "CRITICAL_INFRASTRUCTURE", model.evaluator.summary(e), `rules ${c.rules.join(", ")}`, { criticality: c.level });
  }
  for (const o of model.ownership) {
    if (!["SERVICE", "API", "RESOURCE", "REPOSITORY", "EXTERNAL_INTEGRATION", "MESSAGE", "CONTRACT"].includes(o.category) || o.component.kind === "Endpoint" || o.component.kind === "ApiOperation") continue;
    if (o.state === "UNOWNED" || o.state === "OWNER_UNKNOWN") row("UNOWNED_COMPONENT", o.component, o.resolution);
    if (o.state === "CONFLICT") row("OWNERSHIP_CONFLICT", o.component, o.resolution);
  }
  for (const d of teamDependencies(model).edges) {
    const first = d.dependencies[0]!;
    rows.push({ category: d.crossOrganization ? "CROSS_ORGANIZATION_DEPENDENCY" : "CROSS_TEAM_DEPENDENCY", component: first.from, repository: first.from.repository, environments: [], owners: [d.from.id], ownership: "OWNED", criticality: null, classification: null, exposure: null, detail: `${d.from.id} -> ${d.to.id}: ${d.dependencies.length} dependencies (${[...new Set(d.dependencies.map((x) => x.kind))].join(", ")})` });
  }
  for (const c of model.crossings) rows.push({ category: "TRUST_BOUNDARY_CROSSING", component: c.from, repository: c.from.repository, environments: c.environments, owners: own(c.from.id)?.owners.map((x) => x.id) ?? [], ownership: own(c.from.id)?.state ?? "UNOWNED", criticality: null, classification: null, exposure: null, detail: `${c.from.name} -> ${c.to.name}: ${c.fromBoundary} -> ${c.toBoundary} (${c.approved === null ? "unreviewed" : c.approved ? "approved" : "NOT approved"})` });
  return rows.sort((a, b) => a.category.localeCompare(b.category) || (a.repository ?? "").localeCompare(b.repository ?? "") || a.component.name.localeCompare(b.component.name) || a.component.id.localeCompare(b.component.id));
}

export interface Change {
  kind: string;
  subject: EntitySummary;
  before: string | null;
  after: string | null;
  evidence: string[];
}

const ownersText = (o: OwnershipRecord | undefined) => (o ? `${o.state}${o.owners.length ? ` ${o.owners.map((x) => x.id).join(",")}` : ""}` : null);

export function ownershipDiff(a: EnterpriseModel, b: EnterpriseModel): { changes: Change[]; summary: Record<string, number> } {
  const before = new Map(a.ownership.map((o) => [o.component.id, o]));
  const after = new Map(b.ownership.map((o) => [o.component.id, o]));
  const changes: Change[] = [];
  const evidence = (o: OwnershipRecord | undefined, side: string) => (o ? [...new Set([`${side}: ${o.resolution}`, ...o.claims.map((c) => `${side}: ${c.evidence}`)])] : []);
  const owned = (o: OwnershipRecord) => o.state === "OWNED" || o.state === "CONFLICT";
  for (const [id, n] of after) {
    const o = before.get(id);
    const push = (kind: string) => changes.push({ kind, subject: n.component, before: ownersText(o), after: ownersText(n), evidence: [...evidence(o, "before"), ...evidence(n, "after")] });
    if (!o) {
      push(owned(n) ? "NEW_COMPONENT_OWNED" : "NEW_COMPONENT_UNOWNED");
      continue;
    }
    const x = o.owners.map((z) => z.id).join(",");
    const y = n.owners.map((z) => z.id).join(",");
    if (!owned(o) && owned(n)) push("NEWLY_OWNED");
    else if (owned(o) && !owned(n)) push("NEWLY_UNOWNED");
    else if (o.state !== "CONFLICT" && n.state === "CONFLICT") push("CONFLICT_INTRODUCED");
    else if (o.state === "CONFLICT" && n.state !== "CONFLICT") push("CONFLICT_RESOLVED");
    else if (x !== y) {
      const xs = new Set(o.owners.map((z) => z.id));
      const ys = new Set(n.owners.map((z) => z.id));
      push([...xs].every((v) => ys.has(v)) ? "OWNER_ADDED" : [...ys].every((v) => xs.has(v)) ? "OWNER_REMOVED" : "OWNER_CHANGED");
    } else if (o.claims.map((c) => c.evidence).sort().join("\n") !== n.claims.map((c) => c.evidence).sort().join("\n")) push("OWNERSHIP_EVIDENCE_CHANGED");
  }
  for (const [id, o] of before) if (!after.has(id) && owned(o)) changes.push({ kind: "OWNED_COMPONENT_REMOVED", subject: o.component, before: ownersText(o), after: null, evidence: evidence(o, "before") });
  changes.sort((p, q) => p.kind.localeCompare(q.kind) || p.subject.kind.localeCompare(q.subject.kind) || (p.subject.qualifiedName ?? p.subject.name).localeCompare(q.subject.qualifiedName ?? q.subject.name) || p.subject.id.localeCompare(q.subject.id));
  return { changes, summary: Object.fromEntries(Object.entries(changes.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {})).sort(([p], [q]) => p.localeCompare(q))) };
}

export function securityDiff(a: EnterpriseModel, b: EnterpriseModel): { changes: Change[]; summary: Record<string, number>; posture: { metric: string; before: number; after: number }[] } {
  const changes: Change[] = [];
  const push = (kind: string, subject: EntitySummary, before: string | null, after: string | null, evidence: string[]) => changes.push({ kind, subject, before, after, evidence });
  const epA = new Map(a.endpoints.map((e) => [e.endpoint.id, e]));
  const epB = new Map(b.endpoints.map((e) => [e.endpoint.id, e]));
  const authed = (p: string) => p === "AUTHZ_PRESENT" || p === "AUTH_PRESENT_AUTHZ_UNKNOWN";
  const epText = (e: (typeof a.endpoints)[number]) => `${e.exposure}/${e.protection}${e.authorization.policies.length ? ` policies=${e.authorization.policies.join(",")}` : ""}`;
  for (const [id, n] of epB) {
    const o = epA.get(id);
    const ev = [...n.evidence, ...n.exposurePath.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}${p.relationship.location ? ` @ ${p.relationship.location}` : ""}`)];
    if (n.exposure === "PUBLIC" && (!o || o.exposure !== "PUBLIC")) push("NEW_PUBLIC_ENDPOINT", n.endpoint, o ? epText(o) : null, epText(n), ev);
    if (!o) continue;
    if (!authed(o.protection) && authed(n.protection)) push("AUTHENTICATION_METADATA_ADDED", n.endpoint, epText(o), epText(n), ev);
    else if (authed(o.protection) && !authed(n.protection)) push("AUTHENTICATION_METADATA_REMOVED", n.endpoint, epText(o), epText(n), ev);
    else if (o.protection !== n.protection || o.authorization.policies.join() !== n.authorization.policies.join() || o.authorization.roles.join() !== n.authorization.roles.join()) push("AUTHORIZATION_METADATA_CHANGED", n.endpoint, epText(o), epText(n), ev);
    if (o.exposure === "PUBLIC" && n.exposure !== "PUBLIC") push("ENDPOINT_NO_LONGER_PUBLIC", n.endpoint, epText(o), epText(n), ev);
  }
  for (const [id, o] of epA) if (!epB.has(id) && o.exposure === "PUBLIC") push("PUBLIC_ENDPOINT_REMOVED", o.endpoint, epText(o), null, o.evidence);
  const svA = new Map(a.services.map((s) => [s.service.id, s]));
  for (const s of b.services) {
    const o = svA.get(s.service.id);
    if (o && o.exposure !== s.exposure) push("SERVICE_EXPOSURE_CHANGED", s.service, o.exposure, s.exposure, s.evidence.map((e) => `${e.exposure} ${e.basis}: ${e.detail}`));
  }
  const secA = new Map(a.secrets.map((s) => [s.secret.id, s]));
  const secB = new Map(b.secrets.map((s) => [s.secret.id, s]));
  for (const [id, s] of secB) {
    const o = secA.get(id);
    if (!o) push("NEW_SECRET_REFERENCE", s.secret, null, `${s.provider}/${s.state}`, [`${s.detection} @ ${s.source ?? "-"}`]);
    else if (o.state !== s.state || o.provider !== s.provider) push("SECRET_REFERENCE_CHANGED", s.secret, `${o.provider}/${o.state}`, `${s.provider}/${s.state}`, [`@ ${s.source ?? "-"}`]);
  }
  for (const [id, s] of secA) if (!secB.has(id)) push("SECRET_REFERENCE_REMOVED", s.secret, `${s.provider}/${s.state}`, null, [`@ ${s.source ?? "-"}`]);
  const resA = new Map(a.resources.map((r) => [r.resource.id, r]));
  const resB = new Map(b.resources.map((r) => [r.resource.id, r]));
  for (const [id, r] of resB) {
    const o = resA.get(id);
    if (r.sensitive && !o?.sensitive) push("SENSITIVE_RESOURCE_INTRODUCED", r.resource, o ? (o.classification ?? "UNCLASSIFIED") : null, r.classification, r.classificationSources);
    else if (o && o.classification !== r.classification) push("CLASSIFICATION_CHANGED", r.resource, o.classification ?? "UNCLASSIFIED", r.classification ?? "UNCLASSIFIED", r.classificationSources);
    if (r.resourceType === "external-system" && !o) push("NEW_EXTERNAL_INTEGRATION", r.resource, null, r.resource.name, r.accessors.map((x) => `${x.entity.kind} ${x.entity.name}`));
  }
  for (const [id, r] of resA) if (!resB.has(id) && r.sensitive) push("SENSITIVE_RESOURCE_REMOVED", r.resource, r.classification, null, r.classificationSources);
  const crA = new Map(a.crossings.map((c) => [c.id, c]));
  const crB = new Map(b.crossings.map((c) => [c.id, c]));
  for (const [id, c] of crB) if (!crA.has(id)) push("NEW_TRUST_BOUNDARY_CROSSING", c.from, null, `${c.fromBoundary}->${c.toBoundary} ${c.to.name}`, [pathText(c.path)]);
  for (const [id, c] of crA) if (!crB.has(id)) push("TRUST_BOUNDARY_CROSSING_REMOVED", c.from, `${c.fromBoundary}->${c.toBoundary} ${c.to.name}`, null, [pathText(c.path)]);
  for (const [id, c] of b.criticality) {
    if (criticalityRank(c.level) < criticalityRank("HIGH") || (a.criticality.get(id) && criticalityRank(a.criticality.get(id)!.level) >= criticalityRank("HIGH"))) continue;
    const e = b.graph.entities.get(id);
    if (e) push("NEW_CRITICAL_COMPONENT", b.evaluator.summary(e), a.criticality.get(id)?.level ?? null, c.level, [`rules ${c.rules.join(", ")}`]);
  }
  const fA = new Map(a.findings.map((f) => [f.id, f]));
  const fB = new Map(b.findings.map((f) => [f.id, f]));
  for (const [id, f] of fB) if (!fA.has(id)) push("NEW_SECURITY_FINDING", f.source, null, `${f.severity} ${f.category}${f.environment ? ` env=${f.environment}` : ""}`, [f.message, ...f.evidence.slice(0, 3)]);
  for (const [id, f] of fA) if (!fB.has(id)) push("SECURITY_FINDING_RESOLVED", f.source, `${f.severity} ${f.category}${f.environment ? ` env=${f.environment}` : ""}`, null, [f.message]);
  const own = ownershipDiff(a, b).changes.filter((c) => ["SERVICE", "RESOURCE", "EXTERNAL_INTEGRATION", "SECRET"].includes(b.ownership.find((o) => o.component.id === c.subject.id)?.category ?? a.ownership.find((o) => o.component.id === c.subject.id)?.category ?? ""));
  for (const c of own) if (["NEWLY_UNOWNED", "OWNER_CHANGED", "OWNER_REMOVED", "OWNED_COMPONENT_REMOVED", "CONFLICT_INTRODUCED"].includes(c.kind)) push(c.kind === "OWNED_COMPONENT_REMOVED" ? "OWNERSHIP_REMOVED" : c.kind === "NEWLY_UNOWNED" ? "OWNERSHIP_REMOVED" : "OWNERSHIP_CHANGED", c.subject, c.before, c.after, c.evidence);
  changes.sort((p, q) => p.kind.localeCompare(q.kind) || (p.subject.repository ?? "").localeCompare(q.subject.repository ?? "") || (p.subject.qualifiedName ?? p.subject.name).localeCompare(q.subject.qualifiedName ?? q.subject.name) || p.subject.id.localeCompare(q.subject.id));
  const metric = (m: EnterpriseModel) => ({
    "public endpoints": m.endpoints.filter((e) => e.exposure === "PUBLIC").length,
    "public endpoints without observed auth": m.endpoints.filter((e) => e.exposure === "PUBLIC" && e.protection === "NO_OBSERVED_AUTH").length,
    "endpoints with observed authentication": m.endpoints.filter((e) => authed(e.protection)).length,
    "endpoints with observed authorization": m.endpoints.filter((e) => e.protection === "AUTHZ_PRESENT").length,
    "secret references": m.secrets.length,
    "literal secret values in source": m.secrets.filter((s) => s.state === "LITERAL_VALUE_IN_SOURCE").length,
    "sensitive resources": m.resources.filter((r) => r.sensitive).length,
    "external integrations": m.resources.filter((r) => r.resourceType === "external-system").length,
    "trust-boundary crossings": m.crossings.length,
    "sensitive data flows": m.flows.filter((f) => f.kind === "PUBLIC_TO_SENSITIVE_RESOURCE").length,
    "security findings": m.findings.length,
  });
  const ma = metric(a);
  const mb = metric(b);
  return {
    changes,
    summary: Object.fromEntries(Object.entries(changes.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {})).sort(([p], [q]) => p.localeCompare(q))),
    posture: Object.keys(ma).map((k) => ({ metric: k, before: ma[k as keyof typeof ma], after: mb[k as keyof typeof mb] })),
  };
}
