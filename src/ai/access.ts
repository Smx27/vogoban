import { AnalysisGraph, isConfirmed, type Edge, type EntityRef } from "../analysis/graph.ts";
import type { PathStep as AnalysisStep, GraphPath } from "../analysis/traversal.ts";
import type { ImpactOptions } from "../analysis/impact.ts";
import type { Linked } from "../analysis/views.ts";
import type { Entity, EntityKind, MetaRelationship, Provenance, Relationship } from "../graph/model.ts";
import { loadEnterpriseConfig, type EnterpriseConfig } from "../enterprise/config.ts";
import { buildEnterpriseModel, type EnterpriseModel } from "../enterprise/model.ts";
import { governanceEnrichment } from "../enterprise/governance.ts";
import { evaluate, snapshotSet, type EntitySummary, type GovernanceResult, type PathStep as GovStep } from "../governance/evaluate.ts";
import { loadPolicies, type PolicySet } from "../governance/policy.ts";
import type { SnapshotSet } from "../governance/graph.ts";
import { MetaQuery } from "../query/meta-query.ts";
import type { GraphStore } from "../store/store.ts";
import type { AiLimits, AiScope, Candidate, EntityLite, EvidenceItem, EvidenceStatus, ToolResult } from "./model.ts";

const MUTATING: (keyof GraphStore)[] = ["saveRepositoryGraph", "upsertCatalog", "replaceMetaCategory", "saveMetaSnapshot", "saveGraphSnapshot", "deleteGraphSnapshots", "saveBaseline", "putCachedFacts"];

export class ReadOnlyViolation extends Error {}

export function readOnlyStore(store: GraphStore): GraphStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (MUTATING.includes(prop as keyof GraphStore)) {
        return () => {
          throw new ReadOnlyViolation(`read-only AI/MCP layer attempted to call GraphStore.${String(prop)}`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface AccessOptions {
  policyPaths: string[] | null;
  enterprisePath: string | null;
  aliases: Record<string, string>;
  /** Which context sections the caller may receive inside composite results (summaries, team impact, snapshot comparisons). */
  sections?: { security: boolean; governance: boolean; ownership: boolean };
  /** Tools this caller may not run through this access (enforced by runTool, so AI planning and MCP cannot reach them). */
  deniedTools?: string[];
}

export class ScopeError extends Error {}

const ARCHITECTURAL: EntityKind[] = ["Repository", "Application", "Api", "ApiOperation", "Endpoint", "FrontendRoute", "AzureFunction", "AzureResource", "Message", "SharedContract", "Topic", "Queue", "Deployment", "KubernetesService", "KubernetesIngress", "HelmChart", "Pipeline", "ContainerImage", "ExternalSystem", "Database", "DataStore", "SecretReference", "Team", "Environment"];
const CODE_LEVEL: EntityKind[] = ["Project", "Type", "Method", "Property", "HttpClient", "ServiceRegistration", "Assembly", "Package"];

export type Resolution =
  | { status: "RESOLVED"; entity: Entity; method: string }
  | { status: "AMBIGUOUS"; candidates: Entity[]; method: string }
  | { status: "NOT_FOUND"; suggestions: Entity[] }
  | { status: "OUT_OF_SCOPE"; entity: Entity };

export class GraphAccess {
  readonly meta: MetaQuery;
  private graphCache: AnalysisGraph | null = null;
  private policyCache: PolicySet | null | undefined;
  private enterpriseCfg: EnterpriseConfig | null = null;
  private modelCache = new Map<string, EnterpriseModel>();
  private statusCache: Map<string, string> | null = null;
  private governanceCache = new Map<string, { result: GovernanceResult; model: EnterpriseModel | null }>();

  constructor(readonly store: GraphStore, readonly scope: AiScope, readonly limits: AiLimits, readonly options: AccessOptions) {
    this.meta = new MetaQuery(store);
    for (const id of scope.repositories ?? []) if (!store.getCatalog(id)) throw new ScopeError(`repository not in catalog: ${id}`);
  }

  may(section: "security" | "governance" | "ownership"): boolean {
    return this.options.sections?.[section] ?? true;
  }

  repoName(id: string | null): string | null {
    return id ? (this.store.getCatalog(id)?.name ?? id) : null;
  }

  repoIdByName(ref: string): string {
    const entry = this.store.getCatalog(ref);
    if (!entry || !this.allowed(entry.repositoryId)) throw new ScopeError(`repository not in catalog: ${ref}`);
    return entry.repositoryId;
  }

  allowed(repositoryId: string | null | undefined): boolean {
    return !repositoryId || !this.scope.repositories || this.scope.repositories.includes(repositoryId);
  }

  allowedName(repository: string | null | undefined): boolean {
    if (!repository || !this.scope.repositories) return true;
    return this.scope.repositories.some((id) => this.repoName(id) === repository || id === repository);
  }

  assertRepository(repositoryId: string) {
    if (!this.allowed(repositoryId)) throw new ScopeError(`repository ${this.repoName(repositoryId)} is outside the permitted scope (${this.scope.repositories!.map((r) => this.repoName(r)).join(", ")})`);
  }

  environment(requested: unknown): string | undefined {
    const env = typeof requested === "string" && requested ? requested.toLowerCase() : undefined;
    if (this.scope.environment && env && env !== this.scope.environment) throw new ScopeError(`environment ${env} is outside the permitted scope (${this.scope.environment})`);
    return env ?? this.scope.environment ?? undefined;
  }

  analysisGraph(environment?: string): AnalysisGraph {
    const single = this.scope.repositories?.length === 1 && this.scope.graph === "repository" ? this.scope.repositories[0] : undefined;
    const env = environment ?? this.scope.environment ?? undefined;
    if (env === (this.scope.environment ?? undefined) && this.graphCache) return this.graphCache;
    const g = new AnalysisGraph(this.store, { scope: this.scope.graph, repositoryId: single, environment: env });
    if (env === (this.scope.environment ?? undefined)) this.graphCache = g;
    return g;
  }

  impactOptions(mode: ImpactOptions["mode"], depth?: number): ImpactOptions {
    return { mode, maxDepth: Math.min(depth ?? this.limits.maxDepth, this.limits.maxDepth), maxNodes: this.limits.maxNodes, expandSeeds: true };
  }

  policies(): PolicySet | null {
    if (this.policyCache !== undefined) return this.policyCache;
    const paths = this.options.policyPaths;
    if (!paths?.length) return (this.policyCache = null);
    const set = loadPolicies(paths);
    if (set.errors.length) throw new Error(`policy validation failed (${set.errors.length} errors): ${set.errors.slice(0, 3).map((e) => `${e.file}:${e.path} ${e.message}`).join("; ")}`);
    return (this.policyCache = set);
  }

  enterpriseConfig(): EnterpriseConfig {
    if (this.enterpriseCfg) return this.enterpriseCfg;
    const cfg = loadEnterpriseConfig(this.options.enterprisePath);
    if (cfg.errors.length) throw new Error(`enterprise metadata validation failed: ${cfg.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; ")}`);
    return (this.enterpriseCfg = cfg);
  }

  snapshotSet(overrides: { repositories?: Record<string, string>; meta?: string | null } = {}): SnapshotSet {
    const set = snapshotSet(this.store, {
      repositories: this.scope.repositories ?? undefined,
      repositorySnapshots: overrides.repositories ?? (Object.keys(this.scope.snapshots.repositories).length ? this.scope.snapshots.repositories : undefined),
      metaSnapshot: overrides.meta !== undefined ? overrides.meta : this.scope.snapshots.meta,
      includeMeta: this.scope.graph !== "repository",
    });
    if (!set.repositories.length && !set.meta) throw new Error("no graph snapshots available; analyze a repository first");
    return set;
  }

  enterpriseModel(overrides: { repositories?: Record<string, string>; meta?: string | null } = {}): EnterpriseModel {
    const key = JSON.stringify(overrides);
    const cached = this.modelCache.get(key);
    if (cached) return cached;
    const model = buildEnterpriseModel(this.store, this.snapshotSet(overrides), this.enterpriseConfig(), this.policies() ?? undefined);
    this.modelCache.set(key, model);
    return model;
  }

  governance(overrides: { repositories?: Record<string, string>; meta?: string | null; asOf?: string } = {}): { result: GovernanceResult; model: EnterpriseModel | null } | null {
    const policies = this.policies();
    if (!policies) return null;
    const key = JSON.stringify(overrides);
    const cached = this.governanceCache.get(key);
    if (cached) return cached;
    let model: EnterpriseModel | null = null;
    const result = evaluate(this.store, policies, {
      set: this.snapshotSet(overrides),
      asOf: overrides.asOf ?? new Date().toISOString().slice(0, 10),
      failOn: "ERROR",
      warnOn: "WARNING",
      enrich: governanceEnrichment(this.store, this.enterpriseConfig(), (m) => (model = m)),
    });
    const out = { result, model };
    this.governanceCache.set(key, out);
    return out;
  }

  graphState(snapshots?: SnapshotSet): ToolResult["graph"] {
    this.statusCache ??= new Map(this.meta.catalog().map((c) => [c.entry.repositoryId, c.status]));
    const repos = (this.scope.repositories ?? this.store.listCatalog().map((c) => c.repositoryId)).map((id) => {
      const c = this.store.getCatalog(id);
      const snap = snapshots?.repositories.find((r) => r.repositoryId === id);
      return { name: c?.name ?? id, status: this.statusCache!.get(id) ?? "UNAVAILABLE", commit: snap?.commit ?? c?.analyzedCommit ?? null, graphVersion: snap?.graphVersion ?? c?.graphVersion ?? null, snapshot: snap?.snapshot ?? null };
    });
    return { repositories: repos, metaSnapshot: snapshots?.meta?.metaSnapshot ?? this.store.listMetaSnapshots()[0]?.id ?? null, environment: this.scope.environment };
  }

  lite(e: Entity | EntityRef | EntitySummary): EntityLite {
    const repository = "repository" in e ? e.repository : this.repoName(e.repositoryId);
    return { id: e.id, kind: e.kind, name: e.name, qualifiedName: e.qualifiedName ?? null, repository };
  }

  candidate(e: Entity): Candidate {
    return { ...this.lite(e), location: e.location ? `${e.location.file}:${e.location.startLine}` : null };
  }

  private lookup(ref: string): { list: Entity[]; method: string } {
    const alias = this.options.aliases[ref];
    if (alias) {
      const e = this.store.getEntity(alias) ?? this.store.findMetaEntities({ ids: [alias] })[0];
      if (e) return { list: [e], method: "alias" };
    }
    const byId = this.store.getEntity(ref) ?? this.store.findMetaEntities({ ids: [ref] })[0];
    if (byId) return { list: [byId], method: "id" };
    const catalog = this.store.getCatalog(ref);
    if (catalog) {
      const repo = this.store.findEntities({ kinds: ["Repository"], repositoryId: catalog.repositoryId })[0];
      if (repo) return { list: [repo], method: "repository" };
    }
    if (/^[A-Za-z]+\s+\//.test(ref.trim())) {
      const ops = this.meta.operations(ref);
      if (ops.length) return { list: ops, method: "operation-route" };
    }
    const bySymbol = this.store.findEntities({ symbolKey: ref, limit: 50 });
    if (bySymbol.length) return { list: bySymbol, method: "symbol-key" };
    const byQualified = this.store.findEntities({ qualifiedName: ref, limit: 200 });
    const metaExact = this.store.findMetaEntities({ nameLike: ref }).filter((e) => e.name === ref || e.qualifiedName === ref);
    const like = this.store.findEntities({ nameLike: ref, limit: 5000 });
    const exact = like.filter((e) => e.name === ref || e.qualifiedName?.split("(")[0] === ref);
    const union = [...new Map([...byQualified, ...metaExact, ...exact].map((e) => [e.id, e])).values()];
    if (union.length) return { list: union, method: "exact name or qualified name" };
    const lc = ref.toLowerCase();
    const ci = like.filter((e) => e.name.toLowerCase() === lc || e.qualifiedName?.split("(")[0]?.toLowerCase() === lc);
    return { list: ci, method: "name-case-insensitive" };
  }

  resolve(ref: string, options: { kinds?: EntityKind[]; repository?: string } = {}): Resolution {
    const trimmed = ref.trim();
    let { list, method } = this.lookup(trimmed);
    if (options.repository) {
      const repoId = this.repoIdByName(options.repository);
      list = list.filter((e) => e.repositoryId === repoId);
    }
    const external = list.filter((e) => e.external);
    if (list.length > external.length) list = list.filter((e) => !e.external);
    const projects = list.filter((e) => e.kind === "Project").map((e) => e.id);
    if (projects.length) {
      const defined = new Set(this.store.findRelationships({ sourceIds: projects, types: ["DEFINES_ASSEMBLY"] }).map((r) => r.targetId));
      if (defined.size) {
        list = list.filter((e) => !defined.has(e.id));
        method = `${method} (assemblies collapsed into their defining project)`;
      }
    }
    const inScope = list.filter((e) => this.allowed(e.repositoryId));
    if (!inScope.length && list.length) return { status: "NOT_FOUND", suggestions: [] };
    const tiers: EntityKind[][] = options.kinds?.length ? [options.kinds] : [ARCHITECTURAL, CODE_LEVEL];
    for (const tier of tiers) {
      const hits = inScope.filter((e) => tier.includes(e.kind));
      if (hits.length === 1) return { status: "RESOLVED", entity: hits[0]!, method: `${method}${options.kinds?.length ? ` + kind ${options.kinds.join("|")}` : ""}` };
      if (hits.length > 1) return { status: "AMBIGUOUS", candidates: hits.slice(0, 20), method };
    }
    if (!options.kinds?.length && inScope.length === 1) return { status: "RESOLVED", entity: inScope[0]!, method };
    if (!options.kinds?.length && inScope.length > 1) return { status: "AMBIGUOUS", candidates: inScope.slice(0, 20), method };
    const suggestions = this.store.findEntities({ nameLike: trimmed.split(/[\s(]/)[0]!, kinds: options.kinds, limit: 200 }).filter((e) => !e.external && this.allowed(e.repositoryId));
    return { status: "NOT_FOUND", suggestions: rank(suggestions).slice(0, 10) };
  }

  search(text: string, kinds?: EntityKind[], limit = 20): Entity[] {
    const local = this.store.findEntities({ nameLike: text, kinds, limit: 500 }).filter((e) => !e.external && this.allowed(e.repositoryId));
    const meta = this.scope.graph === "repository" ? [] : this.store.findMetaEntities({ nameLike: text, kinds });
    return rank([...local, ...meta]).slice(0, limit);
  }

  // Evidence conversion: each graph fact keeps identity, relationship, scope and provenance.
  status(evidence: string, confidence = 1): EvidenceStatus {
    return isConfirmed({ evidence, confidence } as Edge) ? "FACT" : evidence === "UNKNOWN" ? "UNKNOWN" : "INFERENCE";
  }

  fromLinked(subject: Entity | EntityRef, l: Linked, direction: "out" | "in", priority: number, tool: string): EvidenceItem {
    const s = this.lite(subject);
    const o = { ...this.lite(l.entity), repository: l.repository };
    const [src, tgt] = direction === "out" ? [s, o] : [o, s];
    return {
      key: `rel:${l.relationship.id}`, kind: "relationship", status: this.status(l.relationship.evidence), fact: `${label(src)} ${l.relationship.type} ${label(tgt)}`,
      source: src, target: tgt, relationship: { id: l.relationship.id, type: l.relationship.type, evidence: l.relationship.evidence, scope: l.relationship.graphScope },
      path: null, repository: o.repository ?? s.repository, environment: l.relationship.environment, snapshot: this.snapshotOf(src.repository), provenance: null, location: null, priority, tool,
    };
  }

  fromRelationship(r: Relationship | MetaRelationship, source: Entity | null, target: Entity | null, priority: number, tool: string): EvidenceItem {
    const meta = "category" in r;
    const src = source ? this.lite(source) : null;
    const tgt = target ? this.lite(target) : null;
    const p = r.provenance[0] ?? null;
    return {
      key: `rel:${r.id}`, kind: "relationship", status: this.status(r.evidence, r.confidence), fact: `${src ? label(src) : r.sourceId} ${r.type} ${tgt ? label(tgt) : r.targetId}`,
      source: src, target: tgt, relationship: { id: r.id, type: r.type, evidence: r.evidence, scope: meta ? "meta" : "repository" },
      path: null, repository: this.repoName(meta ? (r as MetaRelationship).sourceRepositoryId : r.repositoryId), environment: meta ? (r as MetaRelationship).environment : null,
      snapshot: meta ? (r as MetaRelationship).snapshotId : this.snapshotOf(this.repoName(r.repositoryId)), provenance: prov(p), location: loc(p), priority, tool,
    };
  }

  fromPath(path: GraphPath, priority: number, tool: string, prefix = ""): EvidenceItem {
    const steps = path.steps;
    const weakest = steps.reduce<EvidenceStatus>((acc, s) => (acc === "UNKNOWN" || this.status(s.relationship.evidence, s.relationship.confidence) === "UNKNOWN" ? "UNKNOWN" : acc === "INFERENCE" || this.status(s.relationship.evidence, s.relationship.confidence) === "INFERENCE" ? "INFERENCE" : "FACT"), "FACT");
    const last = steps[steps.length - 1];
    const first = steps[0];
    return {
      key: `path:${steps.map((s) => s.relationship.id).join(">") || path.start.id}`, kind: "path", status: weakest,
      fact: `${prefix}${label(this.lite(path.start))} ${steps.map((s) => stepText(s)).join(" ")}`.trim(),
      source: this.lite(path.start), target: this.lite(path.end),
      relationship: steps.length === 1 && first ? { id: first.relationship.id, type: first.relationship.type, evidence: first.relationship.evidence, scope: first.relationship.graphScope } : null,
      path: compress(steps.map((s) => stepText(s))),
      repository: this.repoName(path.end.repositoryId ?? path.start.repositoryId), environment: last?.relationship.environment ?? null, snapshot: this.snapshotOf(this.repoName(path.end.repositoryId)),
      provenance: prov(last?.relationship.provenance ?? null), location: loc(last?.relationship.provenance ?? null), priority, tool,
    };
  }

  fromGovPath(steps: GovStep[], fact: string, status: EvidenceStatus, priority: number, tool: string, key: string, environment: string | null): EvidenceItem {
    const first = steps[0];
    const last = steps[steps.length - 1];
    return {
      key, kind: "governance", status, fact, source: first ? this.lite(first.from) : null, target: last ? this.lite(last.to) : null,
      relationship: steps.length === 1 && first ? { id: first.relationship.id, type: first.relationship.type, evidence: first.relationship.evidence, scope: first.relationship.scope } : null,
      path: steps.length ? compress(steps.map((s) => `-[${s.relationship.type}/${s.relationship.evidence}]-> ${s.to.kind} ${s.to.qualifiedName ?? s.to.name}`)) : null,
      repository: first?.from.repository ?? null, environment, snapshot: first?.relationship.snapshot ?? null, provenance: null, location: first?.relationship.location ?? null, priority, tool,
    };
  }

  fromEntity(e: Entity | EntitySummary, fact: string, priority: number, tool: string, status: EvidenceStatus = "FACT", kind: EvidenceItem["kind"] = "entity"): EvidenceItem {
    const full = "provenance" in e ? e : null;
    const p = full?.provenance[0] ?? null;
    const lite = this.lite(e);
    return {
      key: `${kind}:${e.id}:${fact}`, kind, status, fact, source: lite, target: null, relationship: null, path: null, repository: lite.repository,
      environment: full && typeof full.metadata.environment === "string" ? full.metadata.environment : null, snapshot: this.snapshotOf(lite.repository),
      provenance: prov(p), location: full ? (full.location ? `${full.location.file}:${full.location.startLine}` : null) : ("location" in e ? (e as EntitySummary).location : null), priority, tool,
    };
  }

  unknown(fact: string, subject: EntityLite | null, tool: string): EvidenceItem {
    return { key: `unknown:${subject?.id ?? ""}:${fact}`, kind: "unknown", status: "UNKNOWN", fact, source: subject, target: null, relationship: null, path: null, repository: subject?.repository ?? null, environment: null, snapshot: null, provenance: null, location: null, priority: 6, tool };
  }

  private snapshotOf(repository: string | null): string | null {
    if (!repository) return null;
    const c = this.store.getCatalog(repository);
    return c?.graphVersion ?? null;
  }

  text(value: unknown): string {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > this.limits.maxTextChars ? `${s.slice(0, this.limits.maxTextChars)}…` : s;
  }
}

const ARCH_RANK = (k: string) => (ARCHITECTURAL.includes(k as EntityKind) ? 0 : CODE_LEVEL.includes(k as EntityKind) ? 1 : 2);
function rank(list: Entity[]): Entity[] {
  return [...new Map(list.map((e) => [e.id, e])).values()].sort((a, b) => ARCH_RANK(a.kind) - ARCH_RANK(b.kind) || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export const label = (e: { kind: string; name: string; qualifiedName: string | null; repository?: string | null }) => `${e.kind} ${e.qualifiedName ?? e.name}${e.repository ? ` [${e.repository}]` : ""}`;
const stepText = (s: AnalysisStep) => `${s.relationship.direction === "forward" ? `-[${s.relationship.type}]->` : `<-[${s.relationship.type}]-`} ${s.to.kind} ${s.to.qualifiedName ?? s.to.name}`;
const prov = (p: Provenance | null) => (p ? { plugin: p.plugin, mechanism: p.mechanism, resolver: p.resolver } : null);
const loc = (p: Provenance | null) => (p?.location ? `${p.location.file}:${p.location.startLine}` : null);

export function compress(hops: string[], keep = 6): string[] {
  if (hops.length <= keep) return hops;
  return [...hops.slice(0, 3), `… ${hops.length - keep + 1} intermediate hops omitted …`, ...hops.slice(-(keep - 3))];
}
