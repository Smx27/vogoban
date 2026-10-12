import { hashOf } from "../graph/identity.ts";
import type { GraphStore } from "../store/store.ts";
import { GovernanceGraph, snapshotSet, type GEntity, type GRel, type SnapshotSet } from "./graph.ts";
import { FACT_SELECTOR_KEYS, SEVERITIES, type ExceptionDef, type MetadataCondition, type PolicySet, type Rule, type Selector, type Severity } from "./policy.ts";

export type ViolationStatus = "VIOLATION" | "EXCEPTED" | "OVERRIDDEN" | "POLICY_CONFLICT";

export interface EntitySummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  repository: string | null;
  location: string | null;
}

export interface PathStep {
  from: EntitySummary;
  relationship: { id: string; type: string; evidence: string; scope: "repository" | "meta" | "enterprise"; location: string | null; snapshot: string };
  to: EntitySummary;
}

export interface Violation {
  id: string;
  rule: string;
  ruleName: string;
  policy: string;
  severity: Severity;
  mode: Rule["mode"];
  status: ViolationStatus;
  message: string;
  source: EntitySummary;
  target: EntitySummary | null;
  relationship: PathStep["relationship"] | null;
  path: PathStep[];
  repositories: string[];
  environment: string | null;
  evidence: string[];
  exception: { id: string; status: ExceptionStatus; reason: string; owner: string | null; expires: string | null } | null;
  resolvedBy: { rule: string; policy: string; precedence: number } | null;
  baseline: "BASELINED" | "NEW" | null;
  ownership: ViolationOwnership | null;
}

export interface ViolationOwnership {
  component: EntitySummary | null;
  resolvedVia: string;
  state: string;
  owners: { id: string; kind: string; name: string; businessUnit: string | null; organization: string | null }[];
  repository: string | null;
  repositoryOwners: string[];
  organizationalBoundaries: string[];
}

export type ExceptionStatus = "active" | "expired" | "revoked" | "invalid";

export interface RuleOutcome {
  rule: string;
  name: string;
  policy: string;
  severity: Severity;
  mode: Rule["mode"];
  enabled: boolean;
  evaluated: number;
  violations: number;
  excepted: number;
  status: "PASS" | "FAIL" | "DISABLED" | "NOT_APPLICABLE" | "PERMIT";
}

export interface GovernanceResult {
  evaluatedAt: string;
  asOf: string;
  policyFingerprint: string;
  snapshots: SnapshotSet;
  rules: RuleOutcome[];
  violations: Violation[];
  exceptions: { id: string; rule: string; status: ExceptionStatus; matched: number; reason: string; owner: string | null; expires: string | null; approvedBy: string | null; policy: string }[];
  conflicts: { violation: string; forbidden: string; allowed: string; precedence: number }[];
  baseline: { name: string; createdAt: string } | null;
  summary: { bySeverity: Record<string, number>; byStatus: Record<string, number>; outcome: "PASS" | "WARN" | "FAIL"; counted: number };
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

function metadataMatches(meta: Record<string, unknown>, cond: MetadataCondition): boolean {
  return Object.entries(cond).every(([key, expected]) => {
    const actual = meta[key];
    const values = Array.isArray(actual) ? actual.map(String) : actual === undefined || actual === null ? [] : [String(actual)];
    const wants = Array.isArray(expected) ? expected.map(String) : [String(expected)];
    return wants.every((w) => {
      if (w.startsWith("!")) return !values.some((v) => glob(w.slice(1)).test(v));
      if (w === "*") return values.length > 0;
      return values.some((v) => glob(w).test(v));
    });
  });
}

export class Evaluator {
  private readonly layerCache = new Map<string, Set<string>>();

  constructor(readonly graph: GovernanceGraph, readonly policies: PolicySet) {}

  summary(e: GEntity): EntitySummary {
    return { id: e.id, kind: e.kind, name: e.name, qualifiedName: e.qualifiedName, repository: this.graph.repositoryName(e.repositoryId), location: e.file };
  }

  candidates(sel: Selector): GEntity[] {
    if (sel.id) return sel.id.map((id) => this.graph.entities.get(id)).filter((e): e is GEntity => !!e);
    if (sel.kind) return sel.kind.flatMap((k) => this.graph.byKind.get(k) ?? []);
    return [...new Set(sel.layer!.flatMap((l) => [...this.layer(l)]))].map((id) => this.graph.entities.get(id)!).filter(Boolean);
  }

  layer(name: string): Set<string> {
    const cached = this.layerCache.get(name);
    if (cached) return cached;
    const sel = this.policies.layers.get(name)!.selector;
    const ids = new Set(this.candidates(sel).filter((e) => this.matches(e, sel)).map((e) => e.id));
    this.layerCache.set(name, ids);
    return ids;
  }

  matches(e: GEntity, sel: Selector): boolean {
    if (sel.kind && !sel.kind.includes(e.kind)) return false;
    if (sel.id && !sel.id.includes(e.id)) return false;
    const any = (patterns: string[], value: string) => patterns.some((p) => glob(p).test(value));
    if (sel.name && !any(sel.name, e.name)) return false;
    if (sel.qualifiedName && !any(sel.qualifiedName, e.qualifiedName ?? e.name)) return false;
    if (sel.namespace) {
      const ns = e.kind === "Namespace" ? (e.qualifiedName ?? e.name) : (e.qualifiedName ?? "").replace(/\(.*$/, "").split(".").slice(0, -1).join(".");
      if (!any(sel.namespace, ns)) return false;
    }
    if (sel.repository) {
      const repo = this.graph.repositoryName(e.repositoryId);
      if (!sel.repository.some((r) => r === e.repositoryId || (repo && glob(r).test(repo)))) return false;
    }
    if (sel.project) {
      const p = this.graph.project(e);
      if (!p || !any(sel.project, p.name)) return false;
    }
    if (sel.application && !this.graph.applications(e).some((a) => any(sel.application!, a.name))) return false;
    if (sel.environment && !this.graph.environments(e).some((env) => sel.environment!.some((w) => w.toLowerCase() === env))) return false;
    if (sel.technology) {
      const tech = ["applicationKind", "frameworks", "framework", "broker", "contractSource", "resourceKind", "platform", "language", "systemKinds"].flatMap((k) => (Array.isArray(e.metadata[k]) ? (e.metadata[k] as unknown[]).map(String) : e.metadata[k] ? [String(e.metadata[k])] : []));
      if (!sel.technology.some((t) => tech.some((x) => x.toLowerCase() === t.toLowerCase()))) return false;
    }
    if (sel.tags && !sel.tags.every((t) => (Array.isArray(e.metadata.tags) ? (e.metadata.tags as unknown[]).map(String) : []).includes(t))) return false;
    if (sel.metadata && !metadataMatches(e.metadata, sel.metadata)) return false;
    for (const key of FACT_SELECTOR_KEYS) {
      const wanted = sel[key];
      if (!wanted) continue;
      const have = this.graph.facts.get(e.id)?.[key] ?? [];
      if (!wanted.some((w) => (w.startsWith("!") ? !have.some((h) => glob(w.slice(1)).test(h)) : have.some((h) => glob(w).test(h))))) return false;
    }
    if (sel.layer && !sel.layer.some((l) => this.layer(l).has(e.id))) return false;
    return true;
  }

  private aggregateKinds(sel: Selector): string[] {
    const kinds = sel.kind ?? sel.layer?.flatMap((l) => this.policies.layers.get(l)?.selector.kind ?? []) ?? [];
    return kinds.filter((k) => k === "Project" || k === "Application" || k === "Repository");
  }

  lift(e: GEntity, sel: Selector): GEntity[] {
    const kinds = this.aggregateKinds(sel);
    if (!kinds.length || kinds.includes(e.kind)) return [e];
    const out: GEntity[] = [];
    if (kinds.includes("Project")) {
      const p = this.graph.project(e);
      if (p) out.push(p);
    }
    if (kinds.includes("Application")) out.push(...this.graph.applications(e));
    if (kinds.includes("Repository")) {
      const r = this.graph.repository(e);
      if (r) out.push(r);
    }
    return out;
  }

  matchesLifted(e: GEntity, sel: Selector): GEntity | null {
    return this.lift(e, sel).find((x) => this.matches(x, sel)) ?? null;
  }

  private step(r: GRel): PathStep | null {
    const s = this.graph.entities.get(r.sourceId);
    const t = this.graph.entities.get(r.targetId);
    if (!s || !t) return null;
    return { from: this.summary(s), relationship: { id: r.id, type: r.type, evidence: r.evidence, scope: r.scope, location: r.location, snapshot: r.snapshot }, to: this.summary(t) };
  }

  private envScope(rule: Rule, envs: string[]): (string | null)[] | null {
    if (!rule.environments.length) return [envs.length === 1 ? envs[0]! : null];
    const hits = rule.environments.map((e) => e.toLowerCase()).filter((e) => envs.includes(e)).sort();
    return hits.length ? hits : null;
  }

  private inRepositories(rule: Rule, e: GEntity): boolean {
    if (!rule.repositories.length) return true;
    const repo = this.graph.repositoryName(e.repositoryId);
    return rule.repositories.some((r) => r === e.repositoryId || (!!repo && glob(r).test(repo)));
  }

  private violation(rule: Rule, source: GEntity, target: GEntity | null, rels: GRel[], environment: string | null, message: string): Violation {
    const path = rels.map((r) => this.step(r)).filter((s): s is PathStep => !!s);
    const last = path[path.length - 1] ?? null;
    const repos = [...new Set([source, ...(target ? [target] : []), ...path.flatMap((p) => [p.from, p.to])].map((x) => ("repository" in x ? x.repository : this.graph.repositoryName(x.repositoryId))).filter((x): x is string => !!x))].sort();
    const id = `gv_${hashOf(rule.id, source.id, target?.id ?? "", rels[rels.length - 1]?.type ?? "", environment ?? "").slice(0, 24)}`;
    return {
      id, rule: rule.id, ruleName: rule.name, policy: rule.policy, severity: rule.severity, mode: rule.mode, status: "VIOLATION", message,
      source: this.summary(source), target: target ? this.summary(target) : null, relationship: last?.relationship ?? null, path, repositories: repos, environment,
      evidence: [
        ...path.map((p) => `${p.relationship.type} ${p.relationship.id} [${p.relationship.evidence}, ${p.relationship.scope}]${p.relationship.location ? ` @ ${p.relationship.location}` : ""} (snapshot ${p.relationship.snapshot})`),
        ...(source.file ? [`source declared @ ${source.file}`] : []),
      ],
      exception: null, resolvedBy: null, baseline: null, ownership: null,
    };
  }

  evaluateRule(rule: Rule): { violations: Violation[]; evaluated: number } {
    const out: Violation[] = [];
    const types = rule.relationships;
    const edgeOk = (r: GRel) => !rule.relationshipMetadata || metadataMatches(r.metadata, rule.relationshipMetadata);
    const emitEdge = (source: GEntity, target: GEntity, rels: GRel[], text: string) => {
      const scopes = this.envScope(rule, [...new Set(rels.flatMap((r) => this.graph.relEnvironments(r)))].sort());
      if (!scopes) return;
      for (const env of scopes) out.push(this.violation(rule, source, target, rels, env, text));
    };

    if (rule.mode === "required") {
      const subjects = this.candidates(rule.from).filter((e) => this.matches(e, rule.from) && this.inRepositories(rule, e));
      let evaluated = 0;
      for (const subject of subjects) {
        const scopes = this.envScope(rule, this.graph.environments(subject));
        if (!scopes) continue;
        evaluated++;
        const problems: string[] = [];
        if (rule.require) {
          const rels = rule.require.direction === "out" ? this.graph.outgoing(subject.id, rule.require.relationships) : this.graph.incoming(subject.id, rule.require.relationships);
          const satisfying = rels.filter((r) => {
            const other = this.graph.entities.get(rule.require!.direction === "out" ? r.targetId : r.sourceId);
            return !!other && (!rule.require!.to || !!this.matchesLifted(other, rule.require!.to));
          });
          if (satisfying.length < rule.require.min) problems.push(`requires at least ${rule.require.min} ${rule.require.direction === "out" ? "outgoing" : "incoming"} ${rule.require.relationships.join("/")}${rule.require.to ? " to a matching entity" : ""}, found ${satisfying.length}`);
        }
        if (rule.requireMetadata && !metadataMatches(subject.metadata, rule.requireMetadata)) problems.push(`requires metadata ${JSON.stringify(rule.requireMetadata)}, found ${JSON.stringify(Object.fromEntries(Object.keys(rule.requireMetadata).map((k) => [k, subject.metadata[k] ?? null])))}`);
        if (problems.length) for (const env of scopes) out.push(this.violation(rule, subject, null, [], env, problems.join("; ")));
      }
      return { violations: out, evaluated };
    }

    if (rule.match === "members") {
      const aggregates = this.candidates(rule.from).filter((e) => this.matches(e, rule.from) && this.inRepositories(rule, e));
      const aggregateIds = new Set(aggregates.map((a) => a.id));
      const seen = new Set<string>();
      for (const type of types) {
        for (const r of this.graph.byType.get(type) ?? []) {
          if (!edgeOk(r)) continue;
          const s = this.graph.entities.get(r.sourceId);
          const t = this.graph.entities.get(r.targetId);
          if (!s || !t) continue;
          const owners = this.lift(s, rule.from).filter((x) => aggregateIds.has(x.id));
          if (!owners.length) continue;
          for (const owner of owners) {
            const targetOwners = this.lift(t, rule.to ?? rule.from);
            if (targetOwners.some((x) => x.id === owner.id)) continue;
            const hit = rule.to ? this.matchesLifted(t, rule.to) : null;
            if (rule.mode === "forbidden" && hit) {
              const key = `${owner.id}|${hit.id}|${r.type}`;
              if (!seen.has(key)) {
                seen.add(key);
                emitEdge(owner, hit, [r], `${owner.kind} ${owner.name} ${r.type} ${hit.kind} ${hit.name} through ${s.kind} ${s.qualifiedName ?? s.name}, which the rule forbids`);
              }
            }
            if (rule.mode === "allowed" && !hit && (!rule.universe || this.matchesLifted(t, rule.universe))) {
              const lifted = targetOwners[0] ?? t;
              const key = `${owner.id}|${lifted.id}|${r.type}`;
              if (!seen.has(key)) {
                seen.add(key);
                emitEdge(owner, lifted, [r], `${owner.kind} ${owner.name} ${r.type} ${lifted.kind} ${lifted.name}, which is not among the allowed targets`);
              }
            }
          }
        }
      }
      return { violations: out, evaluated: aggregates.length };
    }

    if (rule.mode === "allowed" && rule.governs === "target") {
      const targets = this.candidates(rule.to!).filter((e) => this.matches(e, rule.to!) && this.inRepositories(rule, e));
      for (const target of targets) {
        for (const r of this.graph.incoming(target.id, types).filter(edgeOk)) {
          const source = this.graph.entities.get(r.sourceId);
          if (!source || this.matchesLifted(source, rule.from)) continue;
          emitEdge(source, target, [r], `${source.kind} ${source.qualifiedName ?? source.name} ${r.type} ${target.kind} ${target.qualifiedName ?? target.name} but is not an allowed ${r.type === "PUBLISHES" ? "publisher" : "consumer"}`);
        }
      }
      return { violations: out, evaluated: targets.length };
    }

    const sources = this.candidates(rule.from).filter((e) => this.matches(e, rule.from) && this.inRepositories(rule, e));
    for (const source of sources) {
      const parent = new Map<string, GRel>();
      let frontier = [source.id];
      const seen = new Set([source.id]);
      for (let depth = 1; depth <= rule.maxDepth && frontier.length; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const r of this.graph.outgoing(id, types).filter(edgeOk)) {
            if (seen.has(r.targetId)) continue;
            const t = this.graph.entities.get(r.targetId);
            if (!t) continue;
            seen.add(r.targetId);
            parent.set(r.targetId, r);
            next.push(r.targetId);
            const chain: GRel[] = [];
            for (let c: string = r.targetId; c !== source.id; c = parent.get(c)!.sourceId) chain.unshift(parent.get(c)!);
            const hit = this.matchesLifted(t, rule.to!);
            if (rule.mode === "forbidden" && hit) emitEdge(source, hit, chain, `${source.kind} ${source.qualifiedName ?? source.name} ${depth > 1 ? `transitively (${depth} hops) ` : ""}${chain[0]!.type} ${hit.kind} ${hit.qualifiedName ?? hit.name}, which the rule forbids`);
            if (rule.mode === "allowed" && depth === 1 && !hit && (!rule.universe || this.matchesLifted(t, rule.universe))) emitEdge(source, t, chain, `${source.kind} ${source.qualifiedName ?? source.name} ${r.type} ${t.kind} ${t.qualifiedName ?? t.name}, which is not among the allowed targets`);
          }
        }
        frontier = next;
      }
    }
    return { violations: out, evaluated: sources.length };
  }
}

export function exceptionStatus(e: ExceptionDef, rules: Set<string>, asOf: string): ExceptionStatus {
  if (!rules.has(e.rule) || (!e.violation && !e.source)) return "invalid";
  if (e.status === "revoked") return "revoked";
  if (e.expires && e.expires.slice(0, 10) < asOf) return "expired";
  return "active";
}

export type GovernanceEnrichment = (graph: GovernanceGraph, policies: PolicySet) => (v: Violation) => ViolationOwnership | null;

export function evaluate(store: GraphStore, policies: PolicySet, options: { set: SnapshotSet; asOf: string; failOn: Severity; warnOn: Severity; baseline?: string; rules?: string[]; enrich?: GovernanceEnrichment }): GovernanceResult {
  const graph = new GovernanceGraph(store, options.set);
  const ownershipOf = options.enrich ? options.enrich(graph, policies) : null;
  const evaluator = new Evaluator(graph, policies);
  const rules = policies.rules.filter((r) => !options.rules || options.rules.includes(r.id));
  const outcomes: RuleOutcome[] = [];
  let violations: Violation[] = [];
  for (const rule of rules) {
    if (!rule.enabled) {
      outcomes.push({ rule: rule.id, name: rule.name, policy: rule.policy, severity: rule.severity, mode: rule.mode, enabled: false, evaluated: 0, violations: 0, excepted: 0, status: "DISABLED" });
      continue;
    }
    if (rule.mode === "allowed" && !rule.exclusive) {
      outcomes.push({ rule: rule.id, name: rule.name, policy: rule.policy, severity: rule.severity, mode: rule.mode, enabled: true, evaluated: 0, violations: 0, excepted: 0, status: "PERMIT" });
      continue;
    }
    const { violations: found, evaluated } = evaluator.evaluateRule(rule);
    const unique = [...new Map(found.map((v) => [v.id, v])).values()];
    violations.push(...unique);
    outcomes.push({ rule: rule.id, name: rule.name, policy: rule.policy, severity: rule.severity, mode: rule.mode, enabled: true, evaluated, violations: unique.length, excepted: 0, status: evaluated === 0 ? "NOT_APPLICABLE" : unique.length ? "FAIL" : "PASS" });
  }

  const conflicts: GovernanceResult["conflicts"] = [];
  const permits = rules.filter((r) => r.enabled && r.mode === "allowed" && r.governs === "source" && r.match === "direct");
  for (const v of violations.filter((x) => x.mode === "forbidden" && x.target && x.relationship)) {
    const forbidden = rules.find((r) => r.id === v.rule)!;
    const source = graph.entities.get(v.source.id)!;
    const target = graph.entities.get(v.target!.id)!;
    for (const p of permits) {
      if (!p.relationships.includes(v.relationship!.type as never) || !evaluator.matchesLifted(source, p.from) || !evaluator.matchesLifted(target, p.to!)) continue;
      if (p.precedence > forbidden.precedence) {
        v.status = "OVERRIDDEN";
        v.resolvedBy = { rule: p.id, policy: p.policy, precedence: p.precedence };
      } else if (p.precedence === forbidden.precedence) {
        v.status = "POLICY_CONFLICT";
        v.resolvedBy = { rule: p.id, policy: p.policy, precedence: p.precedence };
        conflicts.push({ violation: v.id, forbidden: forbidden.id, allowed: p.id, precedence: p.precedence });
      }
    }
  }

  const ruleIds = new Set(policies.rules.map((r) => r.id));
  const exceptions = policies.exceptions.map((e) => ({ def: e, status: exceptionStatus(e, ruleIds, options.asOf), matched: 0 }));
  for (const v of violations) {
    const source = graph.entities.get(v.source.id)!;
    const target = v.target ? graph.entities.get(v.target.id) : undefined;
    const ex = exceptions.find((x) => x.def.rule === v.rule && (x.def.violation ? x.def.violation === v.id : evaluator.matches(source, x.def.source!) && (!x.def.target || (!!target && !!evaluator.matchesLifted(target, x.def.target)))) && (!x.def.environment || x.def.environment.toLowerCase() === v.environment));
    if (!ex) continue;
    ex.matched++;
    v.exception = { id: ex.def.id, status: ex.status, reason: ex.def.reason, owner: ex.def.owner, expires: ex.def.expires };
    if (ex.status === "active" && v.status === "VIOLATION") v.status = "EXCEPTED";
  }

  let baseline: GovernanceResult["baseline"] = null;
  if (options.baseline) {
    const b = store.getBaseline(options.baseline);
    if (!b) throw new Error(`baseline not found: ${options.baseline}`);
    const known = new Set((b.data as { violations: string[] }).violations);
    for (const v of violations) v.baseline = known.has(v.id) ? "BASELINED" : "NEW";
    baseline = { name: b.name, createdAt: b.createdAt };
  }

  if (ownershipOf) for (const v of violations) v.ownership = ownershipOf(v);
  const severityRank = (s: Severity) => SEVERITIES.indexOf(s);
  violations = violations.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.rule.localeCompare(b.rule) || (a.source.qualifiedName ?? a.source.name).localeCompare(b.source.qualifiedName ?? b.source.name) || a.id.localeCompare(b.id));
  for (const o of outcomes) o.excepted = violations.filter((v) => v.rule === o.rule && v.status !== "VIOLATION" && v.status !== "POLICY_CONFLICT").length;
  const active = violations.filter((v) => (v.status === "VIOLATION" || v.status === "POLICY_CONFLICT") && v.baseline !== "BASELINED");
  const count = (f: (v: Violation) => string) => Object.fromEntries(Object.entries(violations.reduce<Record<string, number>>((m, v) => ((m[f(v)] = (m[f(v)] ?? 0) + 1), m), {})).sort(([a], [b]) => a.localeCompare(b)));
  const outcome = active.some((v) => severityRank(v.severity) >= severityRank(options.failOn)) ? "FAIL" : active.some((v) => severityRank(v.severity) >= severityRank(options.warnOn)) ? "WARN" : "PASS";
  return {
    evaluatedAt: new Date().toISOString(),
    asOf: options.asOf,
    policyFingerprint: policies.fingerprint,
    snapshots: options.set,
    rules: outcomes,
    violations,
    exceptions: exceptions.map((x) => ({ id: x.def.id, rule: x.def.rule, status: x.status, matched: x.matched, reason: x.def.reason, owner: x.def.owner, expires: x.def.expires, approvedBy: x.def.approvedBy, policy: x.def.policy })),
    conflicts,
    baseline,
    summary: { bySeverity: count((v) => v.severity), byStatus: count((v) => v.status), outcome, counted: active.length },
  };
}

export interface GovernanceDiff {
  from: { snapshots: SnapshotSet; asOf: string };
  to: { snapshots: SnapshotSet; asOf: string };
  newViolations: Violation[];
  resolvedViolations: Violation[];
  unchanged: number;
  statusChanges: { id: string; rule: string; from: ViolationStatus; to: ViolationStatus }[];
  severityChanges: { id: string; rule: string; from: Severity; to: Severity }[];
  newlyExpiredExceptions: string[];
  newlyActiveExceptions: string[];
  outcome: { from: GovernanceResult["summary"]["outcome"]; to: GovernanceResult["summary"]["outcome"] };
}

export function governanceDiff(a: GovernanceResult, b: GovernanceResult): GovernanceDiff {
  const before = new Map(a.violations.map((v) => [v.id, v]));
  const after = new Map(b.violations.map((v) => [v.id, v]));
  const exBefore = new Map(a.exceptions.map((e) => [e.id, e.status]));
  return {
    from: { snapshots: a.snapshots, asOf: a.asOf },
    to: { snapshots: b.snapshots, asOf: b.asOf },
    newViolations: b.violations.filter((v) => !before.has(v.id)),
    resolvedViolations: a.violations.filter((v) => !after.has(v.id)),
    unchanged: b.violations.filter((v) => before.has(v.id)).length,
    statusChanges: b.violations.filter((v) => before.has(v.id) && before.get(v.id)!.status !== v.status).map((v) => ({ id: v.id, rule: v.rule, from: before.get(v.id)!.status, to: v.status })),
    severityChanges: b.violations.filter((v) => before.has(v.id) && before.get(v.id)!.severity !== v.severity).map((v) => ({ id: v.id, rule: v.rule, from: before.get(v.id)!.severity, to: v.severity })),
    newlyExpiredExceptions: b.exceptions.filter((e) => e.status === "expired" && exBefore.get(e.id) === "active").map((e) => e.id),
    newlyActiveExceptions: b.exceptions.filter((e) => e.status === "active" && exBefore.get(e.id) !== "active").map((e) => e.id),
    outcome: { from: a.summary.outcome, to: b.summary.outcome },
  };
}

export { snapshotSet };
