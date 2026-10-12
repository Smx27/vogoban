import type { ImpactResult } from "./impact.ts";

export interface Factor {
  factor: string;
  value: number;
  points: number;
  max: number;
  explanation: string;
}

export interface Score {
  score: number;
  band: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  meaning: string;
  factors: Factor[];
}

const log2 = (n: number) => Math.log2(1 + n);
const round = (n: number) => Math.round(n * 10) / 10;

function factor(name: string, value: number, weight: number, max: number, explanation: string, linear = false): Factor {
  return { factor: name, value, points: round(Math.min(max, (linear ? value : log2(value)) * weight)), max, explanation };
}

function band(score: number): Score["band"] {
  return score >= 60 ? "CRITICAL" : score >= 35 ? "HIGH" : score >= 15 ? "MODERATE" : "LOW";
}

export function blastRadiusFactors(result: ImpactResult): Factor[] {
  const imp = result.impacted;
  const seedRepos = new Set(result.seeds.map((s) => s.repositoryId).filter(Boolean));
  const kinds = (ks: string[]) => imp.filter((i) => ks.includes(i.entity.kind)).length;
  const otherRepos = new Set(imp.map((i) => i.entity.repositoryId).filter((r) => r && !seedRepos.has(r)));
  const crossEdges = new Set(imp.flatMap((i) => i.path.steps.filter((s) => s.relationship.crossRepository).map((s) => s.relationship.id)));
  const externalConsumers = imp.filter((i) => i.entity.repositoryId && !seedRepos.has(i.entity.repositoryId) && i.path.steps.some((s) => ["CALLS_ENDPOINT", "CONSUMED_BY", "HANDLED_BY", "CONSUMES_API", "CONSUMES_REPOSITORY_CONTRACT", "CALLS_REPOSITORY"].includes(s.relationship.type))).length;
  const contractBoundaries = new Set(imp.flatMap((i) => i.path.steps.filter((s) => ["Api", "ApiOperation", "ApiSchema", "Message", "SharedContract", "Topic", "Queue"].includes(s.from.kind)).map((s) => s.from.id))).size;
  const infraBoundaries = imp.filter((i) => i.category === "INFRASTRUCTURE" || i.category === "DEPLOYMENT").length;
  return [
    factor("direct", result.byLevel.DIRECT ?? 0, 4, 10, "entities directly dependent on the change"),
    factor("indirect+transitive", (result.byLevel.INDIRECT ?? 0) + (result.byLevel.TRANSITIVE ?? 0), 3, 10, "entities reached through two or more confirmed hops"),
    factor("potential", result.byLevel.POTENTIAL ?? 0, 1, 5, "entities reached only through inferred, dispatch or contract-level edges"),
    factor("repositories", otherRepos.size, 7.5, 15, "other repositories reached", true),
    factor("services", kinds(["Application"]), 4, 10, "applications affected"),
    factor("api-operations", kinds(["ApiOperation", "Api"]), 3, 10, "API operations or APIs affected"),
    factor("external-consumers", externalConsumers, 4, 10, "consumers in other repositories reached through API or message relationships"),
    factor("deployments", kinds(["Deployment", "KubernetesService", "KubernetesIngress", "HelmRelease"]), 3, 10, "workloads, services, ingresses or releases affected"),
    factor("cross-repository-boundaries", crossEdges.size, 5, 10, "distinct relationships crossing a repository boundary"),
    factor("contract-boundaries", contractBoundaries, 2, 5, "API/message/contract entities propagating the impact"),
    factor("infrastructure-boundaries", infraBoundaries, 2, 5, "infrastructure or deployment entities in the impact set"),
  ];
}

export function blastRadius(result: ImpactResult): Score {
  const factors = blastRadiusFactors(result);
  const score = round(Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
  return { score, band: band(score), meaning: "structural change exposure derived from graph reach; not a probability of failure", factors };
}

export interface ChangeDescriptor {
  kind: string;
  subject: string;
  breaking: boolean;
}

export function changeRisk(result: ImpactResult, changes: ChangeDescriptor[], centrality: number): Score {
  const base = blastRadiusFactors(result);
  const maxDepth = result.impacted.reduce((m, i) => Math.max(m, i.depth), 0);
  const contract = result.seeds.concat(result.changeScope.map((c) => c.entity)).filter((s) => ["ApiOperation", "Api", "ApiSchema", "Message", "SharedContract", "Topic", "Queue"].includes(s.kind)).length + changes.filter((c) => /^(API|MESSAGE|CONTRACT)_/.test(c.kind)).length;
  const breaking = changes.filter((c) => c.breaking).length;
  const exposed = result.impacted.filter((i) => i.entity.kind === "KubernetesIngress" || (i.entity.kind === "ApiOperation" && i.crossRepository)).length;
  const potentialShare = result.impacted.length ? (result.byLevel.POTENTIAL ?? 0) / result.impacted.length : 0;
  const factors = [
    ...base,
    factor("contract-change", contract, 5, 10, "changed entities that are API, message or contract boundaries"),
    factor("breaking-change-kinds", breaking, 5, 15, "change kinds that can break consumers (removed/renamed operations, changed method, route, fields or version)"),
    factor("public-exposure", exposed, 3, 5, "ingress routes or cross-repository API operations in the impact set"),
    factor("centrality", centrality, 3, 10, "direct dependents of the changed entities"),
    factor("dependency-depth", maxDepth, 1, 5, "deepest propagation hop", true),
    { factor: "uncertainty", value: result.unresolved.length, points: 0, max: 0, explanation: `${result.unresolved.length} unresolved relationships at the impact boundary; ${Math.round(potentialShare * 100)}% of impacted entities are POTENTIAL (reported, not scored)` },
  ];
  const score = round(Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
  return { score, band: band(score), meaning: "deterministic structural engineering risk; not a probability of production failure", factors };
}
