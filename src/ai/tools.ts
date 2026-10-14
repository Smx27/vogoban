import { ref as entityRef, type EntityRef } from "../analysis/graph.ts";
import { propagate, type ImpactResult } from "../analysis/impact.ts";
import { blastRadius, type Score } from "../analysis/risk.ts";
import { findPaths, traverse } from "../analysis/traversal.ts";
import { diffSnapshots, snapshotFor, type GraphDiff } from "../analysis/diff.ts";
import { API_CHANGE_KINDS, apiImpact, messageImpact, repositoryImpact, serviceImpact, type Linked } from "../analysis/views.ts";
import { ENTITY_KINDS, isRelationshipType, type Entity, type EntityKind, type RelationshipType } from "../graph/model.ts";
import { ownershipDiff, securityDiff, teamImpact } from "../enterprise/analysis.ts";
import { ownerOf, type EnterpriseModel, type OwnershipRecord } from "../enterprise/model.ts";
import { governanceDiff, type EntitySummary, type Violation } from "../governance/evaluate.ts";
import { SEVERITIES } from "../governance/policy.ts";
import { InfrastructureQuery } from "../query/infrastructure-query.ts";
import { AzureQuery } from "../query/azure-query.ts";
import { compress, label, ReadOnlyViolation, ScopeError, type GraphAccess } from "./access.ts";
import { jsonSchema, validateInput, type EvidenceItem, type InputSchema, type ToolResult, type ToolStatus } from "./model.ts";

type Args = Record<string, any>;
type Partial = { status?: ToolStatus; summary: string[]; data: unknown; evidence?: EvidenceItem[]; unknowns?: string[]; candidates?: ToolResult["candidates"]; truncated?: boolean; snapshots?: Parameters<GraphAccess["graphState"]>[0] };

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  input: InputSchema;
  run(access: GraphAccess, args: Args): Partial;
}

const KINDS = ENTITY_KINDS as readonly string[];
const ENTITY = { type: "string", required: true, maxLength: 400, description: "Entity reference: stable id, symbol key, qualified name, exact name, repository name, or \"VERB /route\" for an API operation" } as const;
const KIND = { type: "string[]", enum: KINDS, maxItems: 6, description: "Restrict resolution to these entity kinds" } as const;
const REPO = { type: "string", maxLength: 200, description: "Repository (catalog name or id) that the entity belongs to" } as const;
const ENV = { type: "string", maxLength: 60, description: "Environment scope (e.g. production, staging); must match the session scope when one is set" } as const;
const LIMIT = { type: "integer", min: 1, max: 200, default: 40, description: "Maximum number of rows returned" } as const;
const DEPTH = { type: "integer", min: 1, max: 8, default: 3, description: "Maximum traversal depth (bounded by the session limit)" } as const;
const SNAP = { type: "string", maxLength: 100, description: "Snapshot id, graph version prefix or commit prefix" } as const;

class Early extends Error {
  constructor(readonly result: Partial) {
    super("early");
  }
}

function subject(access: GraphAccess, args: Args, key: string, kinds?: EntityKind[]): Entity {
  const requested = (args[`${key}Kind`] as EntityKind[] | undefined) ?? (args.kind as EntityKind[] | undefined);
  const r = access.resolve(String(args[key]), { kinds: requested?.length ? requested : kinds, repository: args.repository });
  if (r.status === "RESOLVED") return r.entity;
  if (r.status === "AMBIGUOUS") {
    throw new Early({ status: "AMBIGUOUS", summary: [`'${args[key]}' is ambiguous: ${r.candidates.length} entities match. Specify the id, kind or repository.`, ...r.candidates.map((c) => `  ${c.id}  ${label(access.lite(c))}`)], data: { reference: args[key], matchedBy: r.method }, candidates: r.candidates.map((c) => access.candidate(c)) });
  }
  if (r.status === "OUT_OF_SCOPE") throw new Early({ status: "OUT_OF_SCOPE", summary: [`'${args[key]}' exists only outside the permitted repository scope.`], data: { reference: args[key] } });
  throw new Early({ status: "NOT_FOUND", summary: [`No entity in the graph matches '${args[key]}'${kinds?.length || requested?.length ? ` as ${(requested ?? kinds)!.join("/")}` : ""}.${r.suggestions.length ? " Similar names exist (not selected):" : ""}`, ...r.suggestions.map((c) => `  ${c.id}  ${label(access.lite(c))}`)], data: { reference: args[key] }, candidates: r.suggestions.map((c) => access.candidate(c)), unknowns: [`the graph contains no entity named '${args[key]}'`] });
}

const lrow = (l: Linked) => ({ entity: l.entity, repository: l.repository, relationship: l.relationship.type, relationshipId: l.relationship.id, evidence: l.relationship.evidence, scope: l.relationship.graphScope, environment: l.relationship.environment });
const name = (e: { name: string; qualifiedName: string | null }) => e.qualifiedName ?? e.name;
const count = <T>(list: T[], f: (x: T) => string) => list.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${k}=${n}`).join(" ") || "-";

function impactRows(access: GraphAccess, r: ImpactResult, tool: string, basePriority: number, environment?: string) {
  const visible = r.impacted.filter((i) => access.allowed(i.entity.repositoryId));
  const withheld = r.impacted.length - visible.length;
  const shown = visible.slice(0, access.limits.maxResults);
  const evidence = shown.map((i) => access.fromPath(i.path, basePriority + (i.level === "DIRECT" ? 0 : i.level === "INDIRECT" ? 1 : 2), tool, `[${i.level} ${i.category}] `));
  const unknowns = [
    ...(r.truncated ? [`traversal stopped at ${r.limits.maxNodes} nodes; further impact not evaluated`] : []),
    ...(r.unresolved.length ? [`${r.unresolved.length} unresolved references at the traversal boundary; anything reached only through them is unknown`] : []),
    ...(withheld ? [`${withheld} results in repositories outside the permitted scope were withheld`] : []),
    ...(visible.length > shown.length ? [`${visible.length - shown.length} further results omitted by the result limit`] : []),
    ...r.graphState.warnings,
    ...(environment ? [`environment scope ${environment} excludes only facts tagged with another environment; untagged relationships and entities are included`] : []),
  ];
  return {
    rows: shown.map((i) => ({ level: i.level, category: i.category, entity: i.entity, repository: access.repoName(i.entity.repositoryId), depth: i.depth, confirmed: i.confirmed, crossRepository: i.crossRepository, reason: i.reason, path: compress(i.path.steps.map((s) => `${s.relationship.direction === "forward" ? "->" : "<-"}${s.relationship.type} ${s.to.name}`)) })),
    evidence,
    unknowns,
    truncated: r.truncated || visible.length > shown.length,
    meta: { total: visible.length, byLevel: count(visible, (i) => i.level), byCategory: count(visible, (i) => i.category), repositories: r.repositories.filter((x) => access.allowed(x.repositoryId)), limits: r.limits, conflicts: r.conflicts.length, unresolved: r.unresolved.length, graphState: r.graphState },
  };
}

const scoreEvidence = (access: GraphAccess, e: Entity, s: Score, title: string, tool: string): EvidenceItem[] => [
  access.fromEntity(e, `${title} of ${label(access.lite(e))}: ${s.score} (${s.band}) — ${s.meaning}`, 3, tool, "FACT", "analysis"),
  ...s.factors.filter((f) => f.points > 0).map((f) => access.fromEntity(e, `${title} factor ${f.factor}=${f.value} (${f.points}/${f.max}): ${f.explanation}`, 4, tool, "FACT", "analysis")),
];

function ownershipEvidence(access: GraphAccess, record: OwnershipRecord | null, via: string, subjectLite: ReturnType<GraphAccess["lite"]>, tool: string): EvidenceItem[] {
  if (!record) return [access.unknown(`No ownership evidence for ${label(subjectLite)} (${via})`, subjectLite, tool)];
  if (record.state === "UNOWNED" || record.state === "OWNER_UNKNOWN") return [access.unknown(`${record.state} for ${label(subjectLite)}${via !== "component" ? ` (via ${via})` : ""}: ${record.resolution}`, subjectLite, tool)];
  return record.claims.map((c) => ({
    ...access.fromEntity(record.component, `${c.role} claim ${c.owner} on ${record.component.kind} ${name(record.component)} from ${c.source}${c.inherited ? " (inherited)" : ""}: ${c.evidence}`, 5, tool, "FACT", "ownership"),
    key: `owner:${record.component.id}:${c.owner}:${c.rule}`,
    provenance: { plugin: c.source === "codeowners" ? "ownership.codeowners" : `ownership.${c.source}`, mechanism: c.inherited ? "inherited-ownership-rule" : "ownership-rule", resolver: c.rule },
  }));
}

function ownersOf(access: GraphAccess, model: EnterpriseModel, e: Entity) {
  const { record, via } = ownerOf(model, e.id);
  return { state: record?.state ?? "UNOWNED", owners: record?.owners.map((o) => ({ id: o.id, kind: o.kind, name: o.name, businessUnit: o.businessUnit, organization: o.organization })) ?? [], maintainers: record?.maintainers.map((o) => o.id) ?? [], resolvedVia: via, resolution: record?.resolution ?? "no ownable container in snapshot", component: record?.component ?? null, claims: record?.claims ?? [], record };
}

function inModel(access: GraphAccess, model: EnterpriseModel, e: Entity) {
  if (!model.graph.entities.get(e.id)) throw new Early({ status: "UNKNOWN", summary: [`${label(access.lite(e))} is not present in the analyzed snapshots (${model.snapshots.repositories.map((r) => `${r.name}@${r.commit?.slice(0, 8) ?? "-"}`).join(", ")}); its governance/security/ownership state is unknown.`], data: { entity: access.lite(e) }, unknowns: ["entity not present in the evaluated snapshot"], snapshots: model.snapshots });
}

const violationRow = (v: Violation) => ({
  id: v.id, rule: v.rule, ruleName: v.ruleName, policy: v.policy, severity: v.severity, mode: v.mode, status: v.status, baseline: v.baseline, environment: v.environment, message: v.message,
  source: v.source, target: v.target, relationship: v.relationship, path: v.path, exception: v.exception, resolvedBy: v.resolvedBy, ownership: v.ownership ? { state: v.ownership.state, owners: v.ownership.owners.map((o) => o.id), component: v.ownership.component } : null,
});

function violationEvidence(access: GraphAccess, v: Violation, tool: string): EvidenceItem {
  const extra = [v.exception ? `exception ${v.exception.id} (${v.exception.status}${v.exception.expires ? `, expires ${v.exception.expires}` : ""}): ${access.text(v.exception.reason)}` : null, v.baseline ? `baseline ${v.baseline}` : null, v.resolvedBy ? `resolved by ${v.resolvedBy.rule} (${v.resolvedBy.policy})` : null].filter(Boolean).join("; ");
  return access.fromGovPath(v.path, `[${v.severity}] rule ${v.rule} '${v.ruleName}' (${v.mode}, policy ${v.policy}) ${v.status}: ${access.text(v.message)}${extra ? ` — ${extra}` : ""}`, "FACT", 4, tool, `violation:${v.id}`, v.environment);
}

function involves(v: { source: EntitySummary; target: EntitySummary | null; path: { from: EntitySummary; to: EntitySummary }[] }, id: string) {
  return v.source.id === id || v.target?.id === id || v.path.some((p) => p.from.id === id || p.to.id === id);
}

function diffPair(access: GraphAccess, args: Args): { from: string; to: string; scope: "repository" | "meta"; repositoryId?: string } {
  const scope = args.meta ? "meta" : "repository";
  let repositoryId: string | undefined;
  if (scope === "repository") {
    if (args.repository) repositoryId = access.repoIdByName(args.repository);
    else {
      const ids = access.scope.repositories ?? access.store.listCatalog().map((c) => c.repositoryId);
      if (ids.length !== 1) throw new ScopeError("snapshot comparison needs 'repository' (or meta=true) when several repositories are in scope");
      repositoryId = ids[0]!;
    }
  }
  const list = access.store.listGraphSnapshots({ scope, repositoryId });
  const pick = (ref: string | undefined, back: number) => (ref ? snapshotFor(access.store, ref, scope, repositoryId) : (list[list.length - back] ?? null));
  const from = pick(args.from, 2);
  const to = pick(args.to, 1);
  if (!from || !to) throw new Early({ status: "UNKNOWN", summary: [`Need two ${scope} snapshots${repositoryId ? ` for ${access.repoName(repositoryId)}` : ""}; ${list.length} available${args.from || args.to ? " or the requested snapshot was not found" : ""}. Historical change cannot be established.`], data: { available: list.map((s) => ({ id: s.id, commit: s.commit, createdAt: s.createdAt })) }, unknowns: ["no second snapshot to compare against"] });
  if (from.id === to.id) throw new ScopeError("from and to resolve to the same snapshot");
  return { from: from.id, to: to.id, scope, repositoryId };
}

const diffHeader = (access: GraphAccess, d: GraphDiff) => `${d.graphScope} diff ${d.old.id} (${d.old.commit?.slice(0, 12) ?? d.old.graphVersion.slice(0, 12)}, ${d.old.createdAt}) -> ${d.new.id} (${d.new.commit?.slice(0, 12) ?? d.new.graphVersion.slice(0, 12)}, ${d.new.createdAt})${d.repositoryId ? ` for ${access.repoName(d.repositoryId)}` : ""}`;

const diffEvidence = (access: GraphAccess, d: GraphDiff, a: GraphDiff["architecture"][number], tool: string): EvidenceItem => ({
  key: `diff:${d.old.id}:${d.new.id}:${a.kind}:${a.subject}`, kind: "diff", status: "FACT", fact: `${a.change.toUpperCase()} ${a.kind}${a.breakingPotential ? " (potentially breaking)" : ""}: ${access.text(a.description)} [${d.old.commit?.slice(0, 8) ?? d.old.id} -> ${d.new.commit?.slice(0, 8) ?? d.new.id}]`,
  source: null, target: null, relationship: null, path: null, repository: access.repoName(d.repositoryId), environment: null, snapshot: d.new.id, provenance: { plugin: "analysis.diff", mechanism: "snapshot-diff", resolver: null }, location: null, priority: 1, tool,
});

function snapshotModels(access: GraphAccess, pair: ReturnType<typeof diffPair>) {
  const side = (id: string) => (pair.scope === "meta" ? { meta: access.store.getGraphSnapshot(id)!.record.graphVersion } : { repositories: { [pair.repositoryId!]: id } });
  return { from: side(pair.from), to: side(pair.to) };
}

function firstSeen(access: GraphAccess, diffs: GraphDiff[], archHits: GraphDiff[], relHits: GraphDiff[], entity: string): string {
  const first = diffs.find((d) => archHits.includes(d) || relHits.includes(d));
  return first ? `First stored change involving '${entity}': between ${first.old.commit?.slice(0, 12) ?? first.old.id} (${first.old.createdAt}) and ${first.new.commit?.slice(0, 12) ?? first.new.id} (${first.new.createdAt}); it is not visible in earlier stored snapshots.` : `No stored snapshot pair shows a change involving '${entity}'; it either predates the oldest stored snapshot or never changed.`;
}

const infra = (access: GraphAccess) => new InfrastructureQuery(access.store);

const azureQuery = (access: GraphAccess) => new AzureQuery(access.store);
const visibleRepo = (access: GraphAccess, args: Args) => (args.repository ? access.repoIdByName(String(args.repository)) : undefined);

const AZURE_TOOLS: ToolDefinition[] = [
  {
    name: "get_azure_functions",
    title: "Azure Functions",
    description: "Azure Functions with what triggers them (HTTP endpoint, timer, Service Bus queue/subscription, Event Hub, Event Grid subscription, Blob, Queue, Cosmos DB change feed, durable), their input/output bindings, durable relationships, authorization level and hosting resource. Static repository analysis; no Azure access.",
    input: { repository: REPO, trigger: { type: "string", maxLength: 40, description: "Only functions with this trigger type (http, timer, serviceBus, eventHub, eventGrid, blob, queue, cosmosDB, orchestration, activity, entity)" }, limit: LIMIT },
    run(access, args) {
      const repo = visibleRepo(access, args);
      const all = azureQuery(access).functions(repo).filter((f) => access.allowed(f.function.repositoryId) && (!args.trigger || f.function.metadata.triggerType === args.trigger));
      const shown = all.slice(0, Number(args.limit ?? 40));
      const evidence = shown.map((f) => access.fromEntity(f.function, `${name(f.function)} triggered by ${f.triggers.map((t) => `${t.type} ${t.source ? name(t.source) : "?"} [${t.evidence}]`).join(", ") || "(no trigger source resolved)"}${f.bindings.length ? `; bindings: ${f.bindings.map((b) => `${b.type} ${b.target ? name(b.target) : "?"}`).join(", ")}` : ""}${f.function.metadata.authLevel ? `; auth ${f.function.metadata.authLevel}` : ""}`, 1, "get_azure_functions"));
      return {
        status: all.length ? "OK" : "EMPTY",
        summary: [`${all.length} Azure Functions${args.trigger ? ` with ${args.trigger} triggers` : ""}.`, ...evidence.slice(0, 10).map((e) => `  ${e.fact}`)],
        data: { functions: shown.map((f) => ({ function: access.candidate(f.function), trigger: f.function.metadata.triggerType ?? null, authLevel: f.function.metadata.authLevel ?? null, triggers: f.triggers.map((t) => ({ relationship: t.type, source: t.source && access.lite(t.source), evidence: t.evidence })), bindings: f.bindings.map((b) => ({ relationship: b.type, target: b.target && access.lite(b.target), evidence: b.evidence })), hostedOn: f.hosting.map((h) => access.lite(h)) })) },
        evidence,
        unknowns: ["functions are found from source attributes and function.json; trigger sources come from stored relationships only", ...(all.length > shown.length ? [`${all.length - shown.length} further functions omitted by the result limit`] : [])],
        truncated: all.length > shown.length,
      };
    },
  },
  {
    name: "get_azure_resources",
    title: "Azure resources",
    description: "Azure resources declared in Bicep, ARM, Terraform or .NET Aspire, with name resolution state (exact / partially-resolved / unresolved), declaring files and code references. Filter by kind (e.g. service-bus-topic, cosmos-container, key-vault), service (service-bus, storage, ...) or ARM type.",
    input: { repository: REPO, kind: { type: "string", maxLength: 80, description: "azureKind, service or ARM type" }, limit: LIMIT },
    run(access, args) {
      const repo = visibleRepo(access, args);
      const all = azureQuery(access).resources(repo, args.kind ? String(args.kind) : undefined).filter((r) => access.allowed(r.resource.repositoryId));
      const shown = all.slice(0, Number(args.limit ?? 40));
      const evidence = shown.map((r) => access.fromEntity(r.resource, `${r.resource.metadata.armType ?? r.resource.metadata.azureKind} ${r.resource.name} [${r.resource.metadata.nameState ?? "-"}] declared in ${[r.resource.metadata.declaredIn ?? []].flat().join(", ") || "code"}${r.codeReferences ? `; referenced by ${r.codeReferences} code-side resources` : ""}`, 1, "get_azure_resources"));
      return {
        status: all.length ? "OK" : "EMPTY",
        summary: [`${all.length} declared Azure resources${args.kind ? ` matching ${args.kind}` : ""}.`, ...evidence.slice(0, 12).map((e) => `  ${e.fact}`)],
        data: { resources: shown.map((r) => ({ resource: access.candidate(r.resource), armType: r.resource.metadata.armType ?? null, azureKind: r.resource.metadata.azureKind ?? null, nameState: r.resource.metadata.nameState ?? null, declaredIn: r.resource.metadata.declaredIn ?? null, codeReferences: r.codeReferences })) },
        evidence,
        unknowns: ["declared state from repository files; the live Azure subscription is never inspected", ...(all.length > shown.length ? [`${all.length - shown.length} further resources omitted by the result limit`] : [])],
        truncated: all.length > shown.length,
      };
    },
  },
  {
    name: "get_azure_triggers",
    title: "Azure Function triggers",
    description: "Every Azure Function trigger edge: which function is triggered by which HTTP endpoint, timer, Service Bus queue/subscription, Event Hub, Event Grid subscription, Blob, Queue or Cosmos DB change feed, with the evidence level. Functions whose trigger source could not be resolved are listed with an UNKNOWN source.",
    input: { repository: REPO, limit: LIMIT },
    run(access, args) {
      const repo = visibleRepo(access, args);
      const all = azureQuery(access).triggers(repo).filter((t) => access.allowed(t.function.repositoryId) && (!t.source || access.allowed(t.source.repositoryId)));
      const shown = all.slice(0, Number(args.limit ?? 40));
      const evidence = shown.map((t) => access.fromEntity(t.function, `${name(t.function)} <- ${t.type} ${t.source ? name(t.source) : "(unresolved source)"} [${t.evidence}]`, 1, "get_azure_triggers"));
      return {
        status: all.length ? "OK" : "EMPTY",
        summary: [`${all.length} Azure Function trigger edges.`, ...evidence.slice(0, 12).map((e) => `  ${e.fact}`)],
        data: { triggers: shown.map((t) => ({ function: access.candidate(t.function), relationship: t.type, source: t.source && access.lite(t.source), evidence: t.evidence })) },
        evidence,
        unknowns: ["trigger sources come from stored relationships only; an unresolved binding (dynamic name, unresolved setting) has no source", ...(all.length > shown.length ? [`${all.length - shown.length} further triggers omitted by the result limit`] : [])],
        truncated: all.length > shown.length,
      };
    },
  },
  {
    name: "get_azure_messaging",
    title: "Azure messaging topology",
    description: "Azure Service Bus queues/topics and Event Hubs/Event Grid topics with their publishers, receivers, subscriptions, consuming functions, carried messages and declaring infrastructure. Static repository analysis; no Azure access.",
    input: { repository: REPO, limit: LIMIT },
    run(access, args) {
      const repo = visibleRepo(access, args);
      const visible = (x: { entity: Entity | null }) => !x.entity || access.allowed(x.entity.repositoryId);
      const all = azureQuery(access).messaging(repo).filter((m) => access.allowed(m.transport.repositoryId)).map((m) => ({ ...m, publishers: m.publishers.filter(visible), receivers: m.receivers.filter(visible), subscriptions: m.subscriptions.filter(visible), consumers: m.consumers.filter(visible), messages: m.messages.filter(visible), declaredBy: m.declaredBy.filter(visible) }));
      const shown = all.slice(0, Number(args.limit ?? 40));
      const side = (list: { type: string; entity: Entity | null; evidence: string }[]) => list.map((x) => `${x.entity ? name(x.entity) : "?"}[${x.evidence}]`).join(", ") || "-";
      const evidence = shown.map((m) => access.fromEntity(m.transport, `${m.transport.metadata.broker} ${m.transport.kind.toLowerCase()} ${name(m.transport)}: publishers ${side(m.publishers)}; consumers ${side([...m.consumers, ...m.receivers])}; subscriptions ${side(m.subscriptions)}; declared by ${side(m.declaredBy)}`, 1, "get_azure_messaging"));
      const link = (list: { type: string; entity: Entity | null; evidence: string }[]) => list.map((x) => ({ relationship: x.type, entity: x.entity && access.lite(x.entity), evidence: x.evidence }));
      return {
        status: all.length ? "OK" : "EMPTY",
        summary: [`${all.length} Azure messaging transports.`, ...evidence.slice(0, 12).map((e) => `  ${e.fact}`)],
        data: { transports: shown.map((m) => ({ transport: access.candidate(m.transport), broker: m.transport.metadata.broker ?? null, publishers: link(m.publishers), receivers: link(m.receivers), subscriptions: link(m.subscriptions), consumers: link(m.consumers), messages: link(m.messages), declaredBy: link(m.declaredBy) })) },
        evidence,
        unknowns: ["only stored relationships are reported; a transport whose namespace is unresolved is not linked to declared infrastructure", ...(all.length > shown.length ? [`${all.length - shown.length} further transports omitted by the result limit`] : [])],
        truncated: all.length > shown.length,
      };
    },
  },
  {
    name: "get_azure_infrastructure",
    title: "Azure infrastructure",
    description: "Infrastructure-as-code view: Bicep/ARM/Terraform files with the Azure resources they create and the modules they use, resource-to-resource relationships (hosting, identity, role assignments, private endpoints, diagnostics) and which applications are hosted on which resources. Static repository analysis; no Azure access.",
    input: { repository: REPO, limit: LIMIT },
    run(access, args) {
      const repo = visibleRepo(access, args);
      const infra = azureQuery(access).infrastructure(repo);
      const files = infra.files.filter((f) => access.allowed(f.file.repositoryId));
      const relationships = infra.relationships.filter((r) => access.allowed(r.source.repositoryId) && (!r.target || access.allowed(r.target.repositoryId)));
      const hosting = infra.hosting.filter((h) => access.allowed(h.resource.repositoryId) && (!h.application || access.allowed(h.application.repositoryId)));
      const limit = Number(args.limit ?? 40);
      const evidence = [
        ...files.slice(0, limit).map((f) => access.fromEntity(f.file, `${f.file.qualifiedName ?? f.file.name} creates ${f.creates.map((e) => name(e)).join(", ") || "-"}${f.modules.length ? `; modules ${f.modules.join(", ")}` : ""}`, 1, "get_azure_infrastructure")),
        ...hosting.slice(0, limit).map((h) => access.fromEntity(h.resource, `${h.application ? name(h.application) : "?"} ${h.type} ${name(h.resource)} [${h.evidence}]`, 2, "get_azure_infrastructure")),
      ];
      const truncated = files.length > limit || relationships.length > limit || hosting.length > limit;
      return {
        status: files.length || relationships.length || hosting.length ? "OK" : "EMPTY",
        summary: [`${files.length} infrastructure files, ${relationships.length} resource relationships, ${hosting.length} hosting assignments.`, ...evidence.slice(0, 12).map((e) => `  ${e.fact}`)],
        data: {
          files: files.slice(0, limit).map((f) => ({ file: access.lite(f.file), creates: f.creates.map((e) => access.lite(e)), references: f.references, modules: f.modules })),
          relationships: relationships.slice(0, limit).map((r) => ({ relationship: r.type, source: access.lite(r.source), target: r.target && access.lite(r.target), evidence: r.evidence })),
          hosting: hosting.slice(0, limit).map((h) => ({ relationship: h.type, application: h.application && access.lite(h.application), resource: access.lite(h.resource), evidence: h.evidence })),
        },
        evidence,
        unknowns: ["declared state from repository files; the live Azure subscription is never inspected", ...(truncated ? ["results were cut at the result limit"] : [])],
        truncated,
      };
    },
  },
  {
    name: "trace_azure_flow",
    title: "Azure architecture flow",
    description: "Follow stored relationships from an entity. downstream answers 'what happens when this event/message/request enters' (triggers, handlers, services, publishes, writes, declarations, hosting); upstream answers 'what reaches this' (publishers, API operations, frontend clients, components and routes). Crosses repositories through MetaGraph relationships.",
    input: { entity: ENTITY, kind: KIND, repository: REPO, direction: { type: "string", enum: ["downstream", "upstream"], default: "downstream", description: "downstream or upstream" }, depth: { type: "integer", min: 1, max: 20, default: 12, description: "Maximum hops" }, limit: LIMIT },
    run(access, args) {
      const e = subject(access, args, "entity");
      const flow = azureQuery(access).flow(e.id, args.direction === "upstream" ? "upstream" : "downstream", Number(args.depth ?? 12));
      if (!flow) throw new Early({ status: "NOT_FOUND", summary: [`no entity ${args.entity}`], data: {} });
      const visible = flow.paths.filter((p) => p.path.every((h) => access.allowed(h.entity.repositoryId) || h.entity.repositoryId === null));
      const shown = visible.slice(0, Number(args.limit ?? 40));
      const fmt = (p: (typeof shown)[number]) => p.path.map((h, i) => (i === 0 ? name(h.entity) : `${h.via!.reversed ? "<-" : "->"}${h.via!.type}[${h.via!.evidence}] ${name(h.entity)}`)).join(" ");
      const evidence = shown.map((p) => access.fromEntity(p.target, fmt(p), 1, "trace_azure_flow", p.path.some((h) => h.via && (h.via.evidence === "INFERRED" || h.via.evidence === "HEURISTIC")) ? "INFERENCE" : "FACT", "path"));
      return {
        status: shown.length ? "OK" : "EMPTY",
        summary: [`${flow.direction} from ${label(access.lite(e))}: ${visible.length} architectural endpoints reachable through ${flow.hops.length} entities${flow.truncated ? " (truncated)" : ""}.`, ...evidence.slice(0, 10).map((x) => `  ${x.fact}`)],
        data: { subject: access.lite(e), direction: flow.direction, paths: shown.map((p) => ({ target: access.lite(p.target), hops: p.path.slice(1).map((h) => ({ relationship: h.via!.type, reversed: h.via!.reversed, evidence: h.via!.evidence, scope: h.via!.scope, entity: access.lite(h.entity) })) })) },
        evidence,
        unknowns: ["only stored relationships are followed; unresolved references (dynamic names, unresolved settings) end a path", ...(flow.truncated ? ["traversal stopped at the node limit"] : []), ...(flow.paths.length > visible.length ? [`${flow.paths.length - visible.length} paths through repositories outside the permitted scope were withheld`] : [])],
        truncated: flow.truncated || visible.length > shown.length,
      };
    },
  },
];

export const TOOLS: ToolDefinition[] = [
  {
    name: "resolve_entity",
    title: "Resolve entity",
    description: "Deterministically resolve a name or reference to exactly one graph entity (alias, id, repository, symbol key, qualified name, exact name). Returns AMBIGUOUS with candidates instead of guessing.",
    input: { query: { ...ENTITY, description: "Reference to resolve" }, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, { ...args, entity: args.query }, "entity");
      return { summary: [`Resolved '${args.query}' to ${label(access.lite(e))} (${e.id}).`], data: { entity: access.candidate(e), layer: e.layer, external: e.external }, evidence: [access.fromEntity(e, `${label(access.lite(e))} exists in the graph`, 1, "resolve_entity")] };
    },
  },
  {
    name: "search_entities",
    title: "Search entities",
    description: "Substring search over entity names and qualified names, ranked architecture-first. Results are candidates, not resolutions.",
    input: { text: { type: "string", required: true, maxLength: 200, description: "Text to search for" }, kind: KIND, limit: { ...LIMIT, default: 20, max: 100 } },
    run(access, args) {
      const hits = access.search(args.text, args.kind, Math.min(args.limit, access.limits.maxResults));
      return { status: hits.length ? "OK" : "EMPTY", summary: [`${hits.length} entities match '${args.text}'.`], data: { results: hits.map((e) => access.candidate(e)) }, candidates: hits.map((e) => access.candidate(e)) };
    },
  },
  {
    name: "get_entity",
    title: "Get entity",
    description: "Entity identity, location, metadata (untrusted text truncated), temporal first/last seen and its direct relationships with evidence levels.",
    input: { entity: ENTITY, kind: KIND, repository: REPO, limit: { ...LIMIT, default: 30 } },
    run(access, args) {
      const e = subject(access, args, "entity");
      const meta = e.layer === "meta";
      const out = meta ? access.store.findMetaRelationships({ sourceIds: [e.id] }) : access.store.findRelationships({ sourceIds: [e.id] });
      const inc = meta ? access.store.findMetaRelationships({ targetIds: [e.id] }) : access.store.findRelationships({ targetIds: [e.id] });
      const metaOut = meta ? [] : access.store.findMetaRelationships({ sourceIds: [e.id] });
      const metaIn = meta ? [] : access.store.findMetaRelationships({ targetIds: [e.id] });
      const rels = [...out, ...metaOut, ...inc, ...metaIn];
      const others = access.meta.entities(rels.flatMap((r) => [r.sourceId, r.targetId]));
      const visible = rels.filter((r) => access.allowed(others.get(r.sourceId)?.repositoryId) && access.allowed(others.get(r.targetId)?.repositoryId));
      const limit = Math.min(args.limit, access.limits.maxResults);
      const metadata = Object.fromEntries(Object.entries(e.metadata).slice(0, 40).map(([k, v]) => [k, Array.isArray(v) ? (v as unknown[]).slice(0, 10).map((x) => access.text(x)) : typeof v === "string" ? access.text(v) : v]));
      return {
        summary: [`${label(access.lite(e))} (${e.id})${e.location ? ` at ${e.location.file}:${e.location.startLine}` : ""}: ${visible.length} relationships (${kv(count(visible, (r) => r.type))}).`],
        data: { entity: access.candidate(e), layer: e.layer, symbolKey: e.symbolKey, project: e.projectId, external: e.external, metadata, temporal: meta ? null : access.store.temporal(e.id), relationshipsByType: count(visible, (r) => r.type), relationships: visible.slice(0, limit).map((r) => ({ id: r.id, type: r.type, direction: r.sourceId === e.id ? "out" : "in", other: others.get(r.sourceId === e.id ? r.targetId : r.sourceId) ? access.lite(others.get(r.sourceId === e.id ? r.targetId : r.sourceId)!) : null, evidence: r.evidence, scope: "category" in r ? "meta" : "repository" })) },
        evidence: [access.fromEntity(e, `${label(access.lite(e))} exists`, 1, "get_entity"), ...visible.slice(0, limit).map((r) => access.fromRelationship(r, others.get(r.sourceId) ?? null, others.get(r.targetId) ?? null, 2, "get_entity"))],
        truncated: visible.length > limit,
      };
    },
  },
  {
    name: "get_neighborhood",
    title: "Get graph neighborhood",
    description: "Return a bounded, focused architecture subgraph around one entity. This is a direct graph traversal, not an inferred architecture summary; every edge retains evidence and provenance.",
    input: {
      entity: ENTITY,
      kind: KIND,
      repository: REPO,
      direction: { type: "string", enum: ["forward", "reverse", "both"], default: "both", description: "Relationship direction to follow" },
      depth: { ...DEPTH, default: 2 },
      types: { type: "string[]", maxItems: 20, description: "Restrict to actual relationship types" },
      targetKinds: { ...KIND, description: "Restrict reached entity kinds" },
      environment: ENV,
      limit: LIMIT,
    },
    run(access, args) {
      const entity = subject(access, args, "entity");
      const types = (args.types as string[] | undefined)?.map((type) => type.toUpperCase());
      if (types?.some((type) => !isRelationshipType(type))) throw new ScopeError(`unknown relationship type(s): ${types.filter((type) => !isRelationshipType(type)).join(", ")}`);
      const limit = Math.min(Number(args.limit ?? 40), access.limits.maxResults);
      const result = traverse(access.analysisGraph(access.environment(args.environment)), entity.id, {
        direction: args.direction ?? "both",
        types: types as RelationshipType[] | undefined,
        kinds: args.targetKinds as EntityKind[] | undefined,
        maxDepth: Math.min(Number(args.depth ?? 2), access.limits.maxDepth),
        maxNodes: Math.min(access.limits.maxNodes, limit),
      });
      const reached = result.reached.filter((row) => access.allowed(row.entity.repositoryId)).slice(0, limit);
      const nodes = [entity, ...reached.map((row) => row.entity)].map((item) => access.lite(item));
      const edges = new Map<string, { id: string; type: string; from: EntityRef; to: EntityRef; direction: string; evidence: string; confidence: number; scope: string; provenance: unknown }>();
      for (const row of reached) for (const step of row.path.steps) edges.set(step.relationship.id, {
        id: step.relationship.id, type: step.relationship.type, from: step.from, to: step.to, direction: step.relationship.direction,
        evidence: step.relationship.evidence, confidence: step.relationship.confidence, scope: step.relationship.graphScope, provenance: step.relationship.provenance,
      });
      const evidence = [access.fromEntity(entity, `${label(access.lite(entity))} is the neighborhood center`, 1, "get_neighborhood"), ...reached.map((row) => access.fromPath(row.path, 2, "get_neighborhood"))];
      return {
        status: reached.length ? "OK" : "EMPTY",
        summary: [`Neighborhood of ${label(access.lite(entity))}: ${reached.length} related entities, ${edges.size} relationships within ${args.direction ?? "both"} traversal depth ${Math.min(Number(args.depth ?? 2), access.limits.maxDepth)}.`, ...(result.truncated ? [`Traversal stopped at the configured node limit.`] : []), ...(reached.length ? [] : ["No recorded relationships match this bounded query."])],
        data: { center: access.lite(entity), direction: args.direction ?? "both", nodes, edges: [...edges.values()], depth: Math.min(Number(args.depth ?? 2), access.limits.maxDepth) },
        evidence,
        unknowns: [...(result.truncated ? ["result set was truncated; additional relationships may exist"] : []), ...(reached.length ? [] : ["absence means no matching relationship was found in the analyzed graph, not proof of no runtime relationship"])],
        truncated: result.truncated,
      };
    },
  },
  ...(["dependencies", "dependents"] as const).map((mode): ToolDefinition => ({
    name: `get_${mode}`,
    title: mode === "dependents" ? "Get dependents" : "Get dependencies",
    description: mode === "dependents"
      ? "Entities that depend on the subject (reverse traversal with per-relationship propagation semantics, across repositories through the MetaGraph). Each result carries level, category and explanation path."
      : "Entities the subject depends on (forward traversal with per-relationship semantics). Each result carries level, category and explanation path.",
    input: { entity: ENTITY, kind: KIND, repository: REPO, depth: DEPTH, environment: ENV },
    run(access, args) {
      const e = subject(access, args, "entity");
      const env = access.environment(args.environment);
      const graph = access.analysisGraph(env);
      const r = propagate(graph, [e], access.impactOptions(mode, args.depth));
      const x = impactRows(access, r, `get_${mode}`, 1, env);
      const byLevel = (["DIRECT", "INDIRECT", "TRANSITIVE", "POTENTIAL"] as const).map((level) => [level, x.rows.filter((row) => row.level === level)] as const).filter(([, rows]) => rows.length);
      return {
        status: x.rows.length ? "OK" : "EMPTY",
        summary: [`${x.meta.total} ${mode} of ${label(access.lite(e))} within depth ${r.limits.maxDepth}: levels ${kv(x.meta.byLevel)}; categories ${kv(x.meta.byCategory)}; repositories ${x.meta.repositories.map((p) => `${p.name}(${p.impacted})`).join(", ") || "-"}.`, ...byLevel.map(([level, rows]) => `  ${level}: ${rows.slice(0, 12).map((row) => `${row.entity.kind} ${row.entity.name}${row.repository && row.repository !== access.repoName(e.repositoryId) ? ` [${row.repository}]` : ""}`).join("; ")}${rows.length > 12 ? `; +${rows.length - 12} more` : ""}`), ...(x.rows.length ? [] : [`No ${mode} recorded in the graph within the traversal bounds.`])],
        data: { subject: access.lite(e), ...x.meta, results: x.rows }, evidence: x.evidence,
        unknowns: [...x.unknowns, ...(x.rows.length ? [] : [`no recorded ${mode} is not proof of none: only analyzed repositories and statically resolvable relationships (not runtime, gRPC or configuration-only links) are covered`])], truncated: x.truncated,
      };
    },
  })),
  {
    name: "find_paths",
    title: "Find paths",
    description: "Shortest relationship paths between two entities across repository and MetaGraph edges, with evidence and provenance per hop.",
    input: { from: { ...ENTITY, description: "Start entity reference" }, to: { ...ENTITY, description: "End entity reference" }, direction: { type: "string", enum: ["forward", "reverse", "both"], default: "both", description: "Edge direction to follow" }, depth: { ...DEPTH, default: 8 }, limit: { type: "integer", min: 1, max: 10, default: 1, description: "Number of paths" }, types: { type: "string[]", maxItems: 20, description: "Restrict to these relationship types" }, environment: ENV },
    run(access, args) {
      const from = subject(access, args, "from");
      const to = subject(access, args, "to");
      const types = (args.types as string[] | undefined)?.map((t) => t.toUpperCase());
      if (types?.some((t) => !isRelationshipType(t))) throw new ScopeError(`unknown relationship type(s): ${types.filter((t) => !isRelationshipType(t)).join(", ")}`);
      const depth = Math.min(args.depth, 8);
      const r = findPaths(access.analysisGraph(access.environment(args.environment)), from.id, to.id, { direction: args.direction, types: types as RelationshipType[] | undefined, maxDepth: depth, maxNodes: access.limits.maxNodes * 10, limit: Math.min(args.limit, access.limits.maxPaths) });
      const paths = r.paths.filter((p) => p.steps.every((s) => access.allowed(s.to.repositoryId)));
      return {
        status: paths.length ? "OK" : "EMPTY",
        summary: paths.length ? paths.map((p, i) => `Path ${i + 1} (${p.length} hops, ${p.crossRepositoryHops} cross-repository): ${label(access.lite(p.start))} ${p.steps.map((s) => `${s.relationship.direction === "forward" ? "->" : "<-"}[${s.relationship.type}/${s.relationship.evidence}] ${s.to.name}`).join(" ")}`) : [`No path from ${label(access.lite(from))} to ${label(access.lite(to))} within ${depth} hops.`],
        data: { from: access.lite(from), to: access.lite(to), paths: paths.map((p) => ({ length: p.length, repositories: p.repositories.map((x) => access.repoName(x)), crossRepositoryHops: p.crossRepositoryHops, steps: p.steps.map((s) => ({ from: s.from, to: s.to, relationship: { ...s.relationship, provenance: s.relationship.provenance ? { plugin: s.relationship.provenance.plugin, mechanism: s.relationship.provenance.mechanism, location: s.relationship.provenance.location } : null } })) })) },
        evidence: paths.map((p) => access.fromPath(p, 1, "find_paths")),
        unknowns: [...(paths.length ? [] : [`absence of a path is established only within ${depth} hops and the analyzed relationship types`]), ...(r.truncated ? [paths.length ? "search for further alternative paths stopped at the node limit" : "path search stopped at the node limit; a longer path may exist"] : [])],
        truncated: r.truncated && !paths.length,
      };
    },
  },
  {
    name: "find_impact",
    title: "Change impact",
    description: "Phase 7 change impact: API operations use API impact (consumers, breaking potential), messages use message impact, applications use service impact, repositories use repository impact, anything else uses impact propagation. Includes blast radius and optionally team impact.",
    input: { entity: ENTITY, kind: KIND, repository: REPO, change: { type: "string", enum: API_CHANGE_KINDS, description: "API change kind for breaking-change classification" }, depth: { ...DEPTH, default: 4 }, teams: { type: "boolean", default: false, description: "Add owning/impacted teams" }, environment: ENV },
    run(access, args) {
      const e = subject(access, args, "entity");
      const env = access.environment(args.environment);
      const graph = access.analysisGraph(env);
      const opts = access.impactOptions("impact", args.depth);
      const tool = "find_impact";
      let result: ImpactResult;
      let score: Score;
      const summary: string[] = [];
      const evidence: EvidenceItem[] = [];
      let view: Record<string, unknown> = {};
      if (e.kind === "ApiOperation") {
        const v = apiImpact(graph, e, args.change ?? null, opts);
        result = v.impact;
        score = v.blastRadius;
        const consumers = v.consumers.filter((c) => access.allowedName(c.repository));
        view = { engine: "api-impact", api: v.api && lrow(v.api), provider: v.provider && lrow(v.provider), endpoints: v.endpoints.map(lrow), handlers: v.handlers.map(lrow), change: v.change, consumers: consumers.map((c) => ({ ...lrow(c), applications: c.applications, deployments: c.deployments, breakingPotential: c.breakingPotential })), consumerRepositories: v.consumerRepositories.filter((r) => access.allowedName(r)) };
        summary.push(`API operation ${name(e)}: ${consumers.length} consumers in ${[...new Set(consumers.map((c) => c.repository))].join(", ") || "no analyzed repository"}${v.change ? `; change '${v.change.kind}' is ${v.change.breaking ? `potentially breaking for ${v.change.affects === "all" ? "all consumers" : `consumers using the ${v.change.affects}`}` : "additive"}` : ""}.`);
        evidence.push(...consumers.map((c) => access.fromPath(c.path, 1, tool, `consumer${c.breakingPotential ? " (potentially broken)" : ""}: `)), ...v.endpoints.map((l) => access.fromLinked(e, l, "out", 2, tool)));
      } else if (e.kind === "Message" || e.kind === "SharedContract") {
        const v = messageImpact(graph, e, opts);
        result = v.impact;
        score = v.blastRadius;
        view = { engine: "message-impact", producers: v.producerSide.map((p) => ({ ...lrow(p), applications: p.applications })), consumers: v.consumerSide.map((p) => ({ ...lrow(p), applications: p.applications })), transports: v.transports.map((t) => ({ transport: lrow(t.transport), senders: t.senders.map(lrow), deliversTo: t.deliversTo.map(lrow) })), repositories: v.repositories.filter((r) => access.allowedName(r)) };
        summary.push(`Message ${name(e)}: ${v.producerSide.length} producers, ${v.consumerSide.length} consumers, ${v.transports.length} transports across ${v.repositories.join(", ") || "-"}.`);
        evidence.push(...v.producerSide.map((l) => access.fromLinked(e, l, "in", 1, tool)), ...v.consumerSide.map((l) => access.fromLinked(e, l, "out", 1, tool)));
      } else if (e.kind === "Application") {
        const v = serviceImpact(graph, e, opts);
        result = v.upstream;
        score = v.blastRadius;
        view = { engine: "service-impact", apis: v.apis.map(lrow), operations: v.operations, apiConsumers: v.apiConsumers.filter((l) => access.allowedName(l.repository)).map(lrow), publishes: v.publishes.map(lrow), consumes: v.consumes.map(lrow), deployments: v.deployments.map((d) => ({ workload: lrow(d.workload), services: d.services.map(lrow), ingresses: d.ingresses.map(lrow) })) };
        summary.push(`Service ${e.name}: ${v.apis.length} APIs (${v.operations} operations), ${v.apiConsumers.length} API consumer calls, publishes ${v.publishes.length}, consumes ${v.consumes.length}, ${v.deployments.length} declared deployments.`);
        evidence.push(...v.apiConsumers.filter((l) => access.allowedName(l.repository)).map((l) => ({ ...access.fromLinked(e, l, "in", 1, tool), fact: `${label(access.lite(l.entity))} calls an API operation of ${e.name} (${l.relationship.type}/${l.relationship.evidence})` })));
      } else if (e.kind === "Repository") {
        const v = repositoryImpact(access.analysisGraph(), e, opts);
        result = v.impact;
        score = v.blastRadius;
        view = { engine: "repository-impact", dependents: v.dependents.filter((l) => access.allowedName(l.repository)).map(lrow), dependsOn: v.dependsOn.filter((l) => access.allowedName(l.repository)).map(lrow), providedApis: v.providedApis.map(lrow), consumedApis: v.consumedApis.map(lrow), deployedBy: v.deployedBy.map(lrow) };
        summary.push(`Repository ${e.name}: ${v.dependents.length} dependent repository relationships, ${v.dependsOn.length} upstream, ${v.providedApis.length} provided APIs.`);
        evidence.push(...v.dependents.filter((l) => access.allowedName(l.repository)).map((l) => access.fromLinked(e, l, "in", 1, tool)));
      } else {
        result = propagate(graph, [e], opts);
        score = blastRadius(result);
        view = { engine: "impact-propagation" };
      }
      const x = impactRows(access, result, tool, 1, env);
      summary.push(`Impact propagation: ${x.meta.total} impacted entities (levels ${kv(x.meta.byLevel)}; categories ${kv(x.meta.byCategory)}) in ${x.meta.repositories.map((p) => `${p.name}(${p.impacted})`).join(", ") || "-"}. Blast radius ${score.score} (${score.band}).`);
      evidence.push(...x.evidence, ...scoreEvidence(access, e, score, "Blast radius", tool));
      const unknowns = [...x.unknowns];
      let teams: unknown = null;
      if (args.teams && !access.may("ownership")) unknowns.push("team impact omitted: ownership data is not permitted for this caller");
      else if (args.teams) {
        try {
          const model = access.enterpriseModel();
          const t = teamImpact(model, graph, [e], opts, result);
          teams = { owningTeams: t.owningTeams, impactedTeams: t.impactedTeams.map((i) => ({ team: i.team.id, crossTeam: i.crossTeam, crossOrganization: i.crossOrganization, components: i.components.length, byDependency: i.byDependency })), unownedImpacted: t.unownedImpacted.length };
          summary.push(`Teams: owning ${t.owningTeams.join(", ") || "none established"}; impacted ${t.impactedTeams.map((i) => i.team.id).join(", ") || "none established"}; ${t.unownedImpacted.length} impacted components without an owner.`);
          evidence.push(...t.impactedTeams.map((i) => access.fromEntity(e, `team ${i.team.id} owns ${i.components.length} impacted components (${kv(i.byDependency)})${i.crossTeam ? " — cross-team" : ""}`, 5, tool, "FACT", "ownership")));
          if (!t.owningTeams.length) unknowns.push("owning team of the changed component is not established by ownership evidence");
        } catch (error) {
          unknowns.push(`team impact unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { status: "OK", summary, data: { subject: access.lite(e), ...view, impact: { ...x.meta, results: x.rows }, blastRadius: score, teams }, evidence, unknowns, truncated: x.truncated };
    },
  },
  {
    name: "get_blast_radius",
    title: "Blast radius",
    description: "Structural exposure score (not failure probability) of changing an entity, computed from Phase 7 impact propagation, with contributing factors.",
    input: { entity: ENTITY, kind: KIND, repository: REPO, depth: { ...DEPTH, default: 4 }, environment: ENV },
    run(access, args) {
      const e = subject(access, args, "entity");
      const r = propagate(access.analysisGraph(access.environment(args.environment)), [e], access.impactOptions("impact", args.depth));
      const s = blastRadius(r);
      const x = impactRows(access, r, "get_blast_radius", 2);
      return { summary: [`Blast radius of ${label(access.lite(e))}: ${s.score} (${s.band}) — ${s.meaning}.`, ...s.factors.filter((f) => f.points).map((f) => `  ${f.factor}: ${f.value} (${f.points}/${f.max}) ${f.explanation}`)], data: { subject: access.lite(e), score: s, impact: x.meta }, evidence: [...scoreEvidence(access, e, s, "Blast radius", "get_blast_radius"), ...x.evidence.slice(0, 20)], unknowns: x.unknowns, truncated: x.truncated };
    },
  },
  {
    name: "get_api_consumers",
    title: "API consumers",
    description: "Consumers of an API, API operation, endpoint or the APIs of an application: cross-repository (MetaGraph CALLS_ENDPOINT/CONSUMES_API) and same-repository callers.",
    input: { api: { ...ENTITY, description: "Api, ApiOperation, Endpoint or Application reference" }, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, args, "api", ["Api", "ApiOperation", "Endpoint", "Application"]);
      let subjects: Entity[] = [e];
      if (e.kind === "Application") subjects = access.meta.entities(access.store.findRelationships({ sourceIds: [e.id], types: ["CONTAINS"] }).map((r) => r.targetId)).values().filter((x) => x.kind === "Api").toArray();
      if (e.kind === "Endpoint") subjects = access.meta.entities(access.store.findRelationships({ targetIds: [e.id], types: ["IMPLEMENTED_BY"] }).map((r) => r.sourceId)).values().filter((x) => x.kind === "ApiOperation").toArray();
      const evidence: EvidenceItem[] = [];
      const rows: unknown[] = [];
      for (const s of subjects) {
        const c = access.meta.consumers(s.id);
        for (const x of [...c.crossRepository, ...c.sameRepository]) {
          if (!x.consumer || !access.allowed(x.consumer.repositoryId)) continue;
          evidence.push(access.fromRelationship(x.relationship, x.consumer, x.operation, 1, "get_api_consumers"));
          rows.push({ consumer: access.lite(x.consumer), operation: x.operation ? access.lite(x.operation) : null, relationship: x.relationship.type, relationshipId: x.relationship.id, evidence: x.relationship.evidence, confidence: x.relationship.confidence, scope: "category" in x.relationship ? "meta" : "repository", environment: "environment" in x.relationship ? x.relationship.environment : null });
        }
      }
      const repos = [...new Set(evidence.map((x) => x.source?.repository).filter(Boolean))];
      const unresolved = access.store.findMetaUnresolved({ category: "api" }).length;
      return {
        status: rows.length ? "OK" : "EMPTY",
        summary: rows.length ? [`${rows.length} consumer relationships of ${label(access.lite(e))} from repositories ${repos.join(", ")}: ${[...new Set(evidence.map((x) => x.source ? `${x.source.kind} ${x.source.name}` : ""))].slice(0, 15).join("; ")}.`] : [`No consumer of ${label(access.lite(e))} is recorded in the graph.`],
        data: { subject: access.lite(e), apis: subjects.map((s) => access.lite(s)), consumers: rows, consumerRepositories: repos },
        evidence,
        unknowns: [...(rows.length ? [] : ["no recorded consumers does not prove there are none: only analyzed repositories and statically resolvable HTTP calls are covered"]), ...(unresolved ? [`${unresolved} cross-repository API calls are unresolved in the MetaGraph and may target this API`] : [])],
      };
    },
  },
  {
    name: "get_api_providers",
    title: "API providers",
    description: "Provider repositories, APIs and implementing endpoints for an API or API operation.",
    input: { api: { ...ENTITY, description: "Api or ApiOperation reference" }, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, args, "api", ["Api", "ApiOperation"]);
      const p = access.meta.providers(e.id);
      const evidence: EvidenceItem[] = [];
      for (const x of p) {
        for (const ep of x.endpoints) evidence.push({ ...access.fromEntity(ep, `${label(access.lite(x.subject))} IMPLEMENTED_BY ${label(access.lite(ep))}`, 1, "get_api_providers"), key: `impl:${x.subject.id}:${ep.id}` });
        const ents = access.meta.entities(x.providedBy.map((r) => r.sourceId));
        for (const r of x.providedBy) evidence.push(access.fromRelationship(r, ents.get(r.sourceId) ?? null, x.subject, 1, "get_api_providers"));
      }
      const containers = access.store.findRelationships({ targetIds: [e.id], types: ["CONTAINS"] });
      const owners = access.meta.entities(containers.map((r) => r.sourceId));
      for (const r of containers) if (["Api", "Application"].includes(owners.get(r.sourceId)?.kind ?? "")) evidence.push(access.fromRelationship(r, owners.get(r.sourceId)!, e, 1, "get_api_providers"));
      return { status: evidence.length ? "OK" : "EMPTY", summary: [`${label(access.lite(e))} is provided by repository ${access.repoName(e.repositoryId) ?? "-"}${p.flatMap((x) => x.endpoints).length ? `; implemented by ${p.flatMap((x) => x.endpoints).map((x) => name(x)).slice(0, 10).join(", ")}` : "; no implementing endpoint recorded"}.`], data: { subject: access.lite(e), providers: p.map((x) => ({ subject: access.lite(x.subject), repository: x.repository, endpoints: x.endpoints.map((y) => access.candidate(y)), providedBy: x.providedBy.map((r) => ({ id: r.id, source: r.sourceId, evidence: r.evidence })) })) }, evidence };
    },
  },
  ...(["publishers", "consumers"] as const).map((side): ToolDefinition => ({
    name: `get_message_${side}`,
    title: `Message ${side}`,
    description: `${side === "publishers" ? "Publishers" : "Consumers/handlers"} of a message contract within repositories (PUBLISHES${side === "consumers" ? ", CONSUMED_BY, HANDLED_BY" : ""}) and across repositories through shared message contracts (MetaGraph).`,
    input: { message: { ...ENTITY, description: "Message or SharedContract reference" }, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, args, "message", ["Message", "SharedContract"]);
      const tool = `get_message_${side}`;
      const r = access.meta.messages(e.name);
      const evidence: EvidenceItem[] = [];
      const rows: unknown[] = [];
      const contracts = r.contracts.filter((c) => c.contract.id === e.id || c.members.some((m) => m.message?.id === e.id));
      for (const c of contracts) {
        for (const x of side === "publishers" ? c.publishers : c.consumers) {
          if (!x.repository || !access.allowed(x.repository.repositoryId)) continue;
          evidence.push(access.fromRelationship(x.relationship, x.repository, c.contract, 1, tool));
          rows.push({ repository: x.repository.name, contract: access.lite(c.contract), relationship: x.relationship.type, relationshipId: x.relationship.id, evidence: x.relationship.evidence, environment: x.relationship.environment });
        }
        if (side === "consumers") for (const h of c.handlers) if (h.handler && access.allowed(h.handler.repositoryId)) evidence.push(access.fromRelationship(h.relationship, c.contract, h.handler, 1, tool));
      }
      const messages = e.kind === "Message" ? [e] : contracts.flatMap((c) => c.members.map((m) => m.message).filter((m): m is Entity => !!m));
      const local = side === "publishers" ? access.store.findRelationships({ targetIds: messages.map((m) => m.id), types: ["PUBLISHES", "SENDS_TO"] }) : access.store.findRelationships({ sourceIds: messages.map((m) => m.id), types: ["CONSUMED_BY", "HANDLED_BY"] });
      const ents = access.meta.entities(local.flatMap((x) => [x.sourceId, x.targetId]));
      for (const x of local) {
        const other = ents.get(side === "publishers" ? x.sourceId : x.targetId);
        if (!other || !access.allowed(other.repositoryId)) continue;
        evidence.push(access.fromRelationship(x, ents.get(x.sourceId) ?? null, ents.get(x.targetId) ?? null, 1, tool));
        rows.push({ entity: access.lite(other), relationship: x.type, relationshipId: x.id, evidence: x.evidence, repository: access.repoName(x.repositoryId) });
      }
      const unresolved = r.unlinked.filter((u) => messages.some((m) => m.id === u.message.id)).flatMap((u) => u.unresolved.map((x) => x.reason));
      return { status: rows.length || evidence.length ? "OK" : "EMPTY", summary: [rows.length ? `${rows.length} ${side} of ${label(access.lite(e))}: ${evidence.map((x) => (side === "publishers" ? x.source : x.target)?.name).filter(Boolean).slice(0, 15).join(", ")}.` : `No ${side} of ${label(access.lite(e))} are recorded in the graph.`], data: { subject: access.lite(e), contracts: contracts.map((c) => access.lite(c.contract)), [side]: rows }, evidence, unknowns: [...(rows.length ? [] : [`absence of recorded ${side} only covers analyzed repositories and supported messaging frameworks`]), ...unresolved] };
    },
  })),
  {
    name: "get_repository_dependencies",
    title: "Repository dependencies",
    description: "Cross-repository topology from the MetaGraph: downstream repositories (what this repository depends on/calls) or upstream (which repositories depend on it), with external systems.",
    input: { repository: { ...REPO, required: true }, direction: { type: "string", enum: ["downstream", "upstream"], default: "downstream", description: "downstream = dependencies; upstream = dependents" }, depth: { ...DEPTH, default: 2, max: 6 }, environment: ENV },
    run(access, args) {
      const repoId = access.repoIdByName(args.repository);
      const env = access.environment(args.environment);
      const t = access.meta.topology(repoId, args.direction === "upstream", Math.min(args.depth, access.limits.maxDepth), env);
      const steps = t.steps.filter((s) => access.allowed(s.repository));
      const ents = access.meta.entities(steps.flatMap((s) => [s.via.sourceId, s.via.targetId]));
      const evidence = [...steps.map((s) => ({ ...access.fromRelationship(s.via, ents.get(s.via.sourceId) ?? null, ents.get(s.via.targetId) ?? null, s.depth === 1 ? 1 : 2, "get_repository_dependencies"), fact: `${access.repoName(s.from)} ${args.direction === "upstream" ? "is depended on by" : "depends on"} ${access.repoName(s.repository)} via ${s.via.type} (${s.via.evidence}, confidence ${s.via.confidence}${s.via.environment ? `, env ${s.via.environment}` : ""}; ${(s.via.metadata.evidenceKinds as string[] | undefined)?.join(", ") ?? ""})` })), ...t.external.map((r) => access.fromRelationship(r, null, t.externalEntities.get(r.targetId) ?? null, 2, "get_repository_dependencies"))];
      const snap = access.store.listMetaSnapshots()[0];
      return {
        status: steps.length || t.external.length ? "OK" : "EMPTY",
        summary: [`${access.repoName(repoId)} ${args.direction === "upstream" ? "is depended on by" : "depends on"} ${steps.length ? steps.map((s) => `${access.repoName(s.repository)} (depth ${s.depth}, ${s.via.type})`).join(", ") : "no catalog repository according to the MetaGraph"}${t.external.length ? `; external systems: ${t.external.map((r) => t.externalEntities.get(r.targetId)?.name ?? r.targetId).join(", ")}` : ""}.`],
        data: { repository: access.repoName(repoId), direction: args.direction, environment: env ?? null, metaSnapshot: snap?.id ?? null, steps: steps.map((s) => ({ depth: s.depth, from: access.repoName(s.from), repository: access.repoName(s.repository), relationship: s.via.type, relationshipId: s.via.id, evidence: s.via.evidence, confidence: s.via.confidence, environment: s.via.environment, evidenceKinds: s.via.metadata.evidenceKinds ?? [] })), external: t.external.map((r) => ({ system: t.externalEntities.get(r.targetId)?.name ?? r.targetId, relationship: r.type, evidence: r.evidence })) },
        evidence,
        unknowns: [...(snap ? [] : ["no MetaGraph has been built; cross-repository relationships are unavailable (run 'metagraph build')"]), ...(t.steps.length > steps.length ? [`${t.steps.length - steps.length} repositories outside the permitted scope were withheld`] : []), ...access.meta.catalog().filter((c) => c.status !== "READY" && access.allowed(c.entry.repositoryId)).map((c) => `repository ${c.entry.name} is ${c.status}${c.reason ? ` (${c.reason})` : ""}; its cross-repository facts may be missing or stale`)],
      };
    },
  },
  {
    name: "get_deployments",
    title: "Deployment topology",
    description: "Declared (static) deployment topology: application -> container image -> Kubernetes workload -> service -> ingress, building pipelines, environments, and cross-repository DEPLOYS_REPOSITORY edges.",
    input: { entity: { ...ENTITY, description: "Application or Repository reference" }, kind: KIND, repository: REPO, environment: ENV },
    run(access, args) {
      const e = subject(access, args, "entity", ["Application", "Repository"]);
      const env = access.environment(args.environment);
      if (!["Application", "Repository"].includes(e.kind)) throw new ScopeError(`deployments need an Application or Repository, got ${e.kind}`);
      const all = infra(access).topology({ repositoryId: e.repositoryId ?? undefined, application: e.kind === "Application" ? e.id : undefined });
      const paths = all.filter((t) => !env || !t.environment.length || t.environment.some((x) => x.toLowerCase() === env));
      const unscoped = env ? paths.filter((t) => !t.environment.length).length : 0;
      const evidence = paths.map((t) => ({
        ...access.fromEntity(t.workload ?? t.image ?? t.application ?? e, [t.application ? `Application ${t.application.name}` : "(no application link)", t.pipelines.length ? `built by ${t.pipelines.map((p) => p.name).join(", ")}` : null, t.image ? `image ${name(t.image)}` : null, t.workload ? `workload ${name(t.workload)}${t.environment.length ? ` [env ${t.environment.join(",")}]` : " [no environment declared]"}` : "no workload declared", t.services.length ? `service ${t.services.map((s) => s.name).join(",")}` : null, t.ingresses.length ? `ingress ${t.ingresses.map((s) => s.name).join(",")}` : null].filter(Boolean).join(" -> "), 1, "get_deployments", "FACT", "path"),
        key: `topology:${t.application?.id ?? ""}:${t.workload?.id ?? t.image?.id ?? ""}`,
        environment: t.environment.join(",") || null,
      }));
      const deploysRepo = e.kind === "Repository" ? access.store.findMetaRelationships({ types: ["DEPLOYS_REPOSITORY"], repositoryId: e.repositoryId! }) : [];
      const dents = access.meta.entities(deploysRepo.flatMap((r) => [r.sourceId, r.targetId]));
      evidence.push(...deploysRepo.filter((r) => access.allowed(r.sourceRepositoryId) && access.allowed(r.targetRepositoryId)).map((r) => access.fromRelationship(r, dents.get(r.sourceId) ?? null, dents.get(r.targetId) ?? null, 1, "get_deployments")));
      const rows = paths.map((t) => ({ application: t.application && access.lite(t.application), image: t.image && access.lite(t.image), workload: t.workload && access.candidate(t.workload), services: t.services.map((s) => access.lite(s)), ingresses: t.ingresses.map((s) => access.lite(s)), pipelines: t.pipelines.map((s) => access.lite(s)), environments: t.environment }));
      return {
        status: rows.length || deploysRepo.length ? "OK" : "EMPTY",
        summary: [rows.length ? `${rows.length} declared deployment paths for ${label(access.lite(e))}${env ? ` in ${env}` : ""}: ${rows.filter((r) => r.workload).length} with a workload, ${rows.filter((r) => r.ingresses.length).length} reachable through an ingress.` : `No declared deployment of ${label(access.lite(e))}${env ? ` in ${env}` : ""} was found.`, ...evidence.slice(0, 8).map((x) => `  ${x.fact}`)],
        data: { subject: access.lite(e), environment: env ?? null, paths: rows, deploysRepository: deploysRepo.map((r) => ({ id: r.id, from: access.repoName(r.sourceRepositoryId), to: access.repoName(r.targetRepositoryId), evidence: r.evidence, environment: r.environment })) },
        evidence,
        unknowns: [`deployment facts are declared in static files (Dockerfiles, Helm, Kubernetes manifests, pipelines), not observed runtime state`, ...(unscoped ? [`${unscoped} paths declare no environment, so membership in ${env} is unknown`] : []), ...(rows.length ? [] : ["no deployment evidence: how this reaches any environment is unknown"])],
      };
    },
  },
  {
    name: "get_owners",
    title: "Owners",
    description: "Ownership of a component from CODEOWNERS and enterprise metadata, with claims, provenance, inheritance and conflicts; includes the owning repository's owners.",
    input: { entity: ENTITY, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, args, "entity");
      const model = access.enterpriseModel();
      inModel(access, model, e);
      const o = ownersOf(access, model, e);
      const repoEntity = e.repositoryId ? access.store.findEntities({ kinds: ["Repository"], repositoryId: e.repositoryId })[0] : undefined;
      const repo = repoEntity && repoEntity.id !== e.id ? ownersOf(access, model, repoEntity) : null;
      const lite = access.lite(e);
      const text = o.state === "OWNED" ? `${label(lite)} is owned by ${o.owners.map((x) => x.id).join(", ")}${o.resolvedVia !== "component" ? ` (resolved via ${o.resolvedVia})` : ""}.` : o.state === "CONFLICT" ? `Ownership of ${label(lite)} is CONFLICTING: ${o.owners.map((x) => x.id).join(" vs ")} (${o.resolution}).` : `Owner of ${label(lite)} is ${o.state === "OWNER_UNKNOWN" ? "unknown (OWNER_UNKNOWN)" : "not established (UNOWNED)"}: ${o.resolution}.`;
      const unknowns = [...(o.state === "OWNED" ? [] : [`no definitive ownership evidence for ${label(lite)}`]), ...(model.config.file ? [] : ["no enterprise metadata file loaded; teams come only from CODEOWNERS"]), ...model.warnings.slice(0, 5)];
      return {
        status: o.state === "OWNED" || o.state === "CONFLICT" ? "OK" : "UNKNOWN",
        summary: [text, ...(repo ? [`Repository ${repoEntity!.name}: ${repo.state}${repo.owners.length ? ` ${repo.owners.map((x) => x.id).join(", ")}` : ""}.`] : [])],
        data: { subject: lite, ownership: { state: o.state, owners: o.owners, maintainers: o.maintainers, resolvedVia: o.resolvedVia, resolution: o.resolution, component: o.component, claims: o.claims }, repository: repo && { state: repo.state, owners: repo.owners, resolution: repo.resolution }, enterpriseMetadata: model.config },
        evidence: [...ownershipEvidence(access, o.record, o.resolvedVia, lite, "get_owners"), ...(repo ? ownershipEvidence(access, repo.record, repo.resolvedVia, access.lite(repoEntity!), "get_owners").map((x) => ({ ...x, priority: 6 })) : [])],
        unknowns,
        snapshots: model.snapshots,
      };
    },
  },
  {
    name: "get_endpoint_security",
    title: "Endpoint exposure and protection",
    description: "Service exposure (PUBLIC/INTERNAL/UNKNOWN from ingress, LoadBalancer/NodePort or exposure rules) and endpoint protection (NO_OBSERVED_AUTH, EXPLICITLY_ANONYMOUS, AUTH_PRESENT_AUTHZ_UNKNOWN, AUTHZ_PRESENT, UNKNOWN) with the evidence path.",
    input: { entity: { ...ENTITY, required: false, description: "Optional Application, Endpoint, ApiOperation or Repository" }, kind: KIND, repository: REPO, exposure: { type: "string", enum: ["PUBLIC", "INTERNAL", "UNKNOWN"], description: "Filter endpoints by exposure" }, protection: { type: "string[]", enum: ["NO_OBSERVED_AUTH", "EXPLICITLY_ANONYMOUS", "AUTH_PRESENT_AUTHZ_UNKNOWN", "AUTHZ_PRESENT", "UNKNOWN"], description: "Filter endpoints by protection" }, environment: ENV, limit: LIMIT },
    run(access, args) {
      const model = access.enterpriseModel();
      const env = access.environment(args.environment);
      const e = args.entity ? subject(access, args, "entity", ["Application", "Endpoint", "ApiOperation", "Repository"]) : null;
      if (e) inModel(access, model, e);
      let services = model.services.filter((s) => access.allowedName(s.service.repository));
      let eps = model.endpoints.filter((x) => access.allowedName(x.endpoint.repository));
      if (e?.kind === "Application") {
        services = services.filter((s) => s.service.id === e.id);
        eps = eps.filter((x) => x.service?.id === e.id);
      } else if (e?.kind === "Repository") {
        services = services.filter((s) => s.service.repository === e.name || s.service.repository === access.repoName(e.repositoryId));
        eps = eps.filter((x) => x.endpoint.repository === access.repoName(e.repositoryId));
      } else if (e) {
        const ids = new Set([e.id, ...access.store.findRelationships({ sourceIds: [e.id], types: ["IMPLEMENTED_BY"] }).map((r) => r.targetId)]);
        eps = eps.filter((x) => ids.has(x.endpoint.id));
        services = services.filter((s) => eps.some((x) => x.service?.id === s.service.id));
      }
      if (args.exposure) eps = eps.filter((x) => x.exposure === args.exposure);
      if (env) eps = eps.filter((x) => x.exposure !== "PUBLIC" || x.publicEnvironments.includes(env) || x.publicEnvironments.includes(null));
      if (args.protection) eps = eps.filter((x) => args.protection.includes(x.protection));
      const limit = Math.min(args.limit, access.limits.maxResults);
      const tool = "get_endpoint_security";
      const evidence: EvidenceItem[] = [
        ...(e ? services : []).map((s) => (s.evidence.length ? access.fromGovPath(s.evidence[0]!.path, `Service ${s.service.name} exposure ${s.exposure} (${s.evidence.map((x) => `${x.basis}: ${access.text(x.detail)}${x.environment ? ` [${x.environment}]` : ""}`).slice(0, 3).join("; ")})`, "FACT", 1, tool, `exposure:${s.service.id}`, s.evidence[0]!.environment) : access.unknown(`Service ${s.service.name} exposure ${s.exposure}: no deployment evidence of ingress or externally reachable service`, access.lite(s.service), tool))),
        ...eps.slice(0, limit).map((x) => ({ ...access.fromGovPath(x.exposurePath, `Endpoint ${x.method ?? ""} ${x.route ?? x.endpoint.name} of ${x.service?.name ?? "?"}: exposure ${x.exposure}${x.publicEnvironments.length ? ` [${x.publicEnvironments.map((p) => p ?? "unscoped").join(",")}]` : ""}, protection ${x.protection}, authentication ${x.authentication}${x.authorization.policies.length ? `, policies ${x.authorization.policies.join(",")}` : ""}${x.authorization.roles.length ? `, roles ${x.authorization.roles.join(",")}` : ""}; evidence: ${x.evidence.map((v) => access.text(v)).join("; ") || "none"}`, x.protection === "UNKNOWN" || x.exposure === "UNKNOWN" ? "UNKNOWN" : "FACT", x.exposure === "PUBLIC" ? 1 : 2, tool, `endpoint-security:${x.endpoint.id}`, null), source: x.endpoint, location: x.endpoint.location })),
      ];
      const pub = eps.filter((x) => x.exposure === "PUBLIC");
      return {
        status: services.length || eps.length ? "OK" : "EMPTY",
        summary: [
          ...(!e ? [] : services.length && services.length <= 10 ? services.map((s) => `Service ${s.service.name} [${s.service.repository ?? "-"}]: exposure ${s.exposure}${s.byEnvironment.length ? ` (${s.byEnvironment.map((b) => `${b.environment ?? "unscoped"}=${b.exposure}`).join(", ")})` : ""}.`) : [`${services.length} services: ${kv(count(services, (s) => s.exposure))}.`]),
          `${eps.length} matching endpoints: exposure ${kv(count(eps, (x) => x.exposure))}; protection ${kv(count(eps, (x) => x.protection))}; public ${pub.length}.`,
          ...(args.exposure || args.protection ? eps.slice(0, 15).map((x) => `  ${x.service?.name ?? "?"} [${x.endpoint.repository ?? "-"}]: ${x.method ?? ""} ${x.route ?? x.endpoint.name} — ${x.exposure}, ${x.protection}`) : []),
          ...(args.exposure || args.protection ? (eps.length > 15 ? [`  +${eps.length - 15} more`] : []) : []),
        ],
        data: { services: services.map((s) => ({ service: s.service, exposure: s.exposure, byEnvironment: s.byEnvironment, workloads: s.workloads, evidence: s.evidence.map((x) => ({ exposure: x.exposure, basis: x.basis, detail: x.detail, environment: x.environment })) })), endpoints: eps.slice(0, limit).map((x) => ({ endpoint: x.endpoint, method: x.method, route: x.route, service: x.service, exposure: x.exposure, publicEnvironments: x.publicEnvironments, protection: x.protection, authentication: x.authentication, authorization: x.authorization, evidence: x.evidence, serviceContext: x.serviceContext })), total: eps.length },
        evidence,
        unknowns: ["protection reflects endpoint-level authorization metadata and OpenAPI security only; gateway or runtime controls are not modeled", ...(eps.some((x) => x.exposure === "UNKNOWN") ? ["some endpoints have UNKNOWN exposure (no deployment evidence)"] : [])],
        truncated: eps.length > limit,
        snapshots: model.snapshots,
      };
    },
  },
  {
    name: "get_security_findings",
    title: "Security findings",
    description: "Structural security findings (not vulnerability claims) from the enterprise security model, optionally for one component, with severity, state (OBSERVED/UNKNOWN), owners, evidence and path.",
    input: { entity: { ...ENTITY, required: false, description: "Optional component reference" }, kind: KIND, repository: REPO, severity: { type: "string[]", maxItems: 5, description: "Severities to include" }, category: { type: "string", maxLength: 80, description: "Finding category" }, id: { type: "string", maxLength: 120, description: "Finding id" }, environment: ENV, limit: LIMIT },
    run(access, args) {
      const model = access.enterpriseModel();
      const env = access.environment(args.environment);
      const e = args.entity ? subject(access, args, "entity") : null;
      if (e) inModel(access, model, e);
      let list = model.findings.filter((f) => access.allowedName(f.repository));
      if (e) list = list.filter((f) => (e.kind === "Repository" ? f.repository === access.repoName(e.repositoryId) : involves(f, e.id)));
      if (args.severity) list = list.filter((f) => (args.severity as string[]).map((s) => s.toUpperCase()).includes(f.severity));
      if (args.category) list = list.filter((f) => f.category === String(args.category).toUpperCase());
      if (args.id) list = list.filter((f) => f.id === args.id);
      if (env) list = list.filter((f) => !f.environment || f.environment === env);
      const limit = Math.min(args.limit, access.limits.maxResults);
      return {
        status: list.length ? "OK" : "EMPTY",
        summary: [`${list.length} security findings${e ? ` involving ${label(access.lite(e))}` : ""}: severity ${kv(count(list, (f) => f.severity))}; categories ${kv(count(list, (f) => f.category))}.`],
        data: { findings: list.slice(0, limit).map((f) => ({ id: f.id, category: f.category, severity: f.severity, state: f.state, message: f.message, source: f.source, target: f.target, repository: f.repository, environment: f.environment, owners: f.owners, ownership: f.ownership, evidence: f.evidence, path: f.path, remediation: f.remediation, snapshots: f.snapshots })), total: list.length },
        evidence: list.slice(0, limit).map((f) => ({ ...access.fromGovPath(f.path, `[${f.severity}] ${f.category}${f.state === "UNKNOWN" ? " (state UNKNOWN)" : ""}: ${access.text(f.message)}; evidence: ${f.evidence.map((x) => access.text(x)).join("; ")}`, f.state === "OBSERVED" ? "FACT" : "UNKNOWN", 4, "get_security_findings", `finding:${f.id}`, f.environment), kind: "security" as const, source: access.lite(f.source), repository: f.repository })),
        unknowns: ["findings are structural statements from static evidence, not vulnerability claims", ...(list.length ? [] : ["no findings does not prove the absence of risk; only modeled conditions are evaluated"])],
        truncated: list.length > limit,
        snapshots: model.snapshots,
      };
    },
  },
  {
    name: "get_governance_violations",
    title: "Governance violations",
    description: "Architecture rule evaluation (Phase 8 policy-as-code) with the violated rule definition, violating relationship and path, exception, baseline and ownership. Optionally restricted to violations involving one or two entities.",
    input: { entity: { ...ENTITY, required: false, description: "Optional entity involved in the violation" }, target: { ...ENTITY, required: false, description: "Optional second entity (e.g. the forbidden dependency target)" }, kind: KIND, repository: REPO, rule: { type: "string", maxLength: 120, description: "Rule id" }, id: { type: "string", maxLength: 120, description: "Violation id" }, severity: { type: "string", enum: SEVERITIES, description: "Minimum severity" }, status: { type: "string", enum: ["VIOLATION", "EXCEPTED", "OVERRIDDEN", "POLICY_CONFLICT"], description: "Violation status" }, environment: ENV, limit: LIMIT },
    run(access, args) {
      const gov = access.governance();
      if (!gov) throw new Early({ status: "UNKNOWN", summary: ["No architecture policies are configured (--policy, $VOGOBAN_POLICIES or ./vogoban-policies); governance state is unknown, not compliant."], data: { policies: null }, unknowns: ["no architecture rules loaded"] });
      const env = access.environment(args.environment);
      const a = args.entity ? subject(access, args, "entity") : null;
      const b = args.target ? subject(access, { ...args, kind: undefined }, "target") : null;
      let list = gov.result.violations.filter((v) => v.repositories.every((r) => access.allowedName(r)));
      const touches = (v: Violation, x: Entity) => involves(v, x.id) || v.ownership?.component?.id === x.id || (x.kind === "Application" && !!x.projectId && involves(v, x.projectId)) || (x.kind === "Repository" && v.repositories.includes(x.name));
      if (a) list = list.filter((v) => touches(v, a));
      if (b) list = list.filter((v) => touches(v, b));
      if (args.rule) list = list.filter((v) => v.rule === args.rule);
      if (args.id) list = list.filter((v) => v.id === args.id);
      if (args.severity) list = list.filter((v) => SEVERITIES.indexOf(v.severity) >= SEVERITIES.indexOf(args.severity));
      if (args.status) list = list.filter((v) => v.status === args.status);
      if (env) list = list.filter((v) => !v.environment || v.environment === env);
      const limit = Math.min(args.limit, access.limits.maxResults);
      const ruleIds = new Set(list.map((v) => v.rule));
      const policySet = access.policies()!;
      const layersOf = (sel: { layer?: string[] } | null) => (sel?.layer ?? []).map((l) => `${l}=${JSON.stringify(policySet.layers.get(l)?.selector ?? null)}`);
      const rules = policySet.rules.filter((r) => ruleIds.has(r.id)).map((r) => ({ layers: [...layersOf(r.from), ...layersOf(r.to)], id: r.id, name: r.name, description: r.description, policy: r.policy, file: r.file, severity: r.severity, mode: r.mode, from: r.from, to: r.to, relationships: r.relationships, match: r.match, maxDepth: r.maxDepth, environments: r.environments, exclusive: r.exclusive }));
      const tool = "get_governance_violations";
      return {
        status: list.length ? "OK" : "EMPTY",
        summary: [`Governance ${gov.result.summary.outcome}: ${list.length} matching violations${a ? ` involving ${label(access.lite(a))}` : ""}${b ? ` and ${label(access.lite(b))}` : ""} (status ${kv(count(list, (v) => v.status))}; severity ${kv(count(list, (v) => v.severity))}).`, ...list.slice(0, 5).map((v) => `  [${v.severity}] ${v.rule} ${v.status}: ${access.text(v.message)}`)],
        data: { outcome: gov.result.summary.outcome, asOf: gov.result.asOf, policyFingerprint: gov.result.policyFingerprint, snapshots: gov.result.snapshots, rules, violations: list.slice(0, limit).map(violationRow), total: list.length },
        evidence: [...list.slice(0, limit).map((v) => violationEvidence(access, v, tool)), ...rules.map((r) => ({ key: `rule:${r.id}`, kind: "governance" as const, status: "FACT" as const, fact: `Rule ${r.id} '${r.name}' (${r.mode}, ${r.severity}, policy ${r.policy}): ${access.text(r.description ?? "no description")}; from ${JSON.stringify(r.from)}${r.to ? ` to ${JSON.stringify(r.to)}` : ""}${r.relationships.length ? ` via ${r.relationships.join(",")}` : ""}${r.layers.length ? `; layers ${r.layers.join("; ")}` : ""}`, source: null, target: null, relationship: null, path: null, repository: null, environment: null, snapshot: null, provenance: { plugin: "governance.policy", mechanism: "policy-file", resolver: null }, location: r.file, priority: 4, tool }))],
        unknowns: list.length ? [] : [a || b ? "no rule violation involving these entities was found under the loaded policies" : "no violations under the loaded policies"],
        truncated: list.length > limit,
        snapshots: gov.result.snapshots,
      };
    },
  },
  {
    name: "get_data_flows",
    title: "Data flows",
    description: "Security flows from public entry points to resources and trust-boundary crossings (service calls, messages, data access, external calls) with full graph paths.",
    input: { entity: { ...ENTITY, required: false, description: "Optional entity on the flow (entry, target or traversed service)" }, kind: KIND, repository: REPO, limit: LIMIT },
    run(access, args) {
      const model = access.enterpriseModel();
      const e = args.entity ? subject(access, args, "entity") : null;
      if (e) inModel(access, model, e);
      const flows = model.flows.filter((f) => !e || f.entry.id === e.id || f.target.id === e.id || f.services.some((s) => s.id === e.id) || involves({ source: f.entry, target: f.target, path: f.path }, e.id)).filter((f) => access.allowedName(f.entry.repository));
      const crossings = model.crossings.filter((c) => !e || c.from.id === e.id || c.to.id === e.id || involves({ source: c.from, target: c.to, path: c.path }, e.id)).filter((c) => access.allowedName(c.from.repository));
      const accessed = e ? model.resources.filter((r) => r.accessors.some((a) => a.entity.id === e.id || a.services.some((s) => s.id === e.id)) || r.resource.id === e.id) : [];
      const limit = Math.min(args.limit, access.limits.maxResults);
      const tool = "get_data_flows";
      return {
        status: flows.length || crossings.length || accessed.length ? "OK" : "EMPTY",
        summary: [`${flows.length} security flows (${kv(count(flows, (f) => f.kind))}), ${crossings.length} trust-boundary crossings${e ? ` involving ${label(access.lite(e))}` : ""}${accessed.length ? `; resources accessed: ${accessed.map((r) => `${r.resource.name} (${r.resourceType}${r.classification ? `, ${r.classification}` : ""})`).join(", ")}` : ""}.`],
        data: { flows: flows.slice(0, limit).map((f) => ({ id: f.id, kind: f.kind, entry: f.entry, target: f.target, classification: f.classification, services: f.services, environments: f.environments, crossings: f.crossings, path: f.path })), crossings: crossings.slice(0, limit).map((c) => ({ id: c.id, from: c.from, to: c.to, fromBoundary: c.fromBoundary, toBoundary: c.toBoundary, flowKind: c.flowKind, approved: c.approved, path: c.path })), resources: accessed.map((r) => ({ resource: r.resource, type: r.resourceType, technology: r.technology, classification: r.classification, sensitive: r.sensitive, accessors: r.accessors.filter((a) => !e || a.entity.id === e.id || a.services.some((s) => s.id === e.id)).map((a) => ({ entity: a.entity, path: a.path })) })) },
        evidence: [
          ...flows.slice(0, limit).map((f) => access.fromGovPath(f.path, `${f.kind}: ${f.entry.name} -> ${f.target.name}${f.classification ? ` (${f.classification})` : ""} through ${f.services.map((s) => s.name).join(", ") || "-"}`, "FACT", 2, tool, `flow:${f.id}`, f.environments.join(",") || null)),
          ...crossings.slice(0, limit).map((c) => access.fromGovPath(c.path, `Trust-boundary crossing ${c.fromBoundary} -> ${c.toBoundary}: ${c.from.name} -> ${c.to.name} (${c.flowKind}, ${c.approved === null ? "unreviewed" : c.approved ? "approved" : "NOT approved"})`, "FACT", 4, tool, `crossing:${c.id}`, c.environments.join(",") || null)),
          ...accessed.flatMap((r) => r.accessors.filter((a) => !e || a.entity.id === e.id || a.services.some((s) => s.id === e.id)).slice(0, 5).map((a) => access.fromGovPath(a.path, `${a.entity.name} accesses ${r.resourceType} ${r.resource.name}${r.technology ? ` (${r.technology})` : ""}`, "FACT", 1, tool, `access:${r.resource.id}:${a.entity.id}`, null))),
        ],
        unknowns: ["flows are derived from static relationships; relationships matched by host name are marked derived", ...(e && !accessed.length ? [`no data-store access by ${e.name} is recorded`] : [])],
        truncated: flows.length > limit || crossings.length > limit,
        snapshots: model.snapshots,
      };
    },
  },
  {
    name: "get_external_systems",
    title: "External systems",
    description: "External systems, databases, data stores, transports and secret stores used by an application or repository (enterprise resource model and MetaGraph external systems), with accessor paths.",
    input: { entity: { ...ENTITY, required: false, description: "Optional Application or Repository" }, kind: KIND, repository: REPO, filter: { type: "string", maxLength: 100, description: "Name filter" }, limit: LIMIT },
    run(access, args) {
      const model = access.enterpriseModel();
      const e = args.entity ? subject(access, args, "entity", ["Application", "Repository"]) : null;
      const repoName = e ? access.repoName(e.repositoryId) : null;
      const filter = args.filter ? String(args.filter).toLowerCase() : null;
      const resources = model.resources.filter((r) => (!filter || r.resource.name.toLowerCase().includes(filter)) && (!e || r.accessors.some((a) => (e.kind === "Application" ? a.services.some((s) => s.id === e.id) || a.entity.id === e.id : a.entity.repository === repoName))));
      const metaSystems = access.scope.graph === "repository" ? [] : access.meta.externalSystems(args.filter).filter((x) => !e || x.repositories.includes(repoName!));
      const limit = Math.min(args.limit, access.limits.maxResults);
      const tool = "get_external_systems";
      return {
        status: resources.length || metaSystems.length ? "OK" : "EMPTY",
        summary: [`${resources.length} resources${e ? ` used by ${label(access.lite(e))}` : ""}: ${resources.slice(0, 12).map((r) => `${r.resource.name} (${r.resourceType}${r.technology ? `/${r.technology}` : ""})`).join(", ") || "-"}${metaSystems.length ? `; MetaGraph external systems: ${metaSystems.map((x) => `${x.system.name} [${x.repositories.join(",")}]`).join(", ")}` : ""}.`],
        data: { resources: resources.slice(0, limit).map((r) => ({ resource: r.resource, type: r.resourceType, technology: r.technology, identity: r.identity, classification: r.classification, sensitive: r.sensitive, environments: r.environments, accessors: r.accessors.slice(0, 10).map((a) => ({ entity: a.entity, services: a.services.map((s) => s.name) })) })), externalSystems: metaSystems.map((x) => ({ system: access.lite(x.system), repositories: x.repositories, environments: x.environments })) },
        evidence: [
          ...resources.slice(0, limit).flatMap((r) => r.accessors.filter((a) => !e || (e.kind === "Application" ? a.services.some((s) => s.id === e.id) || a.entity.id === e.id : a.entity.repository === repoName)).slice(0, 3).map((a) => access.fromGovPath(a.path, `${a.entity.kind} ${a.entity.name}${a.services.length ? ` (service ${a.services.map((s) => s.name).join(",")})` : ""} uses ${r.resourceType} ${r.resource.name}${r.technology ? ` (${r.technology})` : ""}${r.identity ? ` identity ${access.text(r.identity)}` : ""}`, "FACT", 1, tool, `resource:${r.resource.id}:${a.entity.id}`, r.environments.join(",") || null))),
          ...metaSystems.map((x) => access.fromEntity(x.system, `${x.system.kind} ${x.system.name} is used by repositories ${x.repositories.join(", ")}${x.environments.length ? ` [env ${x.environments.join(",")}]` : ""}`, 2, tool)),
        ],
        unknowns: ["resources are identified from connection strings, configuration and container images; runtime-only integrations are not visible"],
        truncated: resources.length > limit,
        snapshots: model.snapshots,
      };
    },
  },
  {
    name: "list_snapshots",
    title: "List snapshots",
    description: "Stored graph snapshots (repository or MetaGraph) with commit, graph version and time, for temporal questions.",
    input: { repository: REPO, meta: { type: "boolean", default: false, description: "List MetaGraph snapshots" } },
    run(access, args) {
      const repositoryId = args.repository ? access.repoIdByName(args.repository) : undefined;
      const list = access.store.listGraphSnapshots({ scope: args.meta ? "meta" : "repository", repositoryId }).filter((s) => access.allowed(s.repositoryId));
      return { status: list.length ? "OK" : "EMPTY", summary: [`${list.length} ${args.meta ? "MetaGraph" : "repository"} snapshots${repositoryId ? ` for ${access.repoName(repositoryId)}` : ""}.`, ...list.slice(-10).map((s) => `  ${s.id} ${access.repoName(s.repositoryId) ?? "meta"} ${s.commit?.slice(0, 12) ?? s.graphVersion.slice(0, 12)} ${s.createdAt}`)], data: { snapshots: list.map((s) => ({ ...s, repository: access.repoName(s.repositoryId) })) } };
    },
  },
  {
    name: "compare_snapshots",
    title: "Compare snapshots",
    description: "Compare two stored snapshots (default: the latest two) of a repository or the MetaGraph: graph diff counts and categories, and optionally governance, security and ownership diffs evaluated on each snapshot.",
    input: { repository: REPO, meta: { type: "boolean", default: false, description: "Compare MetaGraph snapshots" }, from: SNAP, to: SNAP, aspects: { type: "string[]", enum: ["graph", "governance", "security", "ownership"], maxItems: 4, default: "graph", description: "What to compare" }, limit: LIMIT },
    run(access, args) {
      const pair = diffPair(access, args);
      const aspects = (Array.isArray(args.aspects) ? args.aspects : String(args.aspects).split(",")) as string[];
      const denied = aspects.filter((a) => a !== "graph" && !access.may(a as "security" | "governance" | "ownership"));
      if (denied.length) throw new ScopeError(`not permitted to compare ${denied.join(", ")}`);
      const d = diffSnapshots(access.store, pair.from, pair.to);
      const tool = "compare_snapshots";
      const limit = Math.min(args.limit, access.limits.maxResults);
      const graphAspect = aspects.includes("graph");
      const summary = [graphAspect ? `Entities +${d.entities.added.length} -${d.entities.removed.length} ~${d.entities.changed.length}; relationships +${d.relationships.added.length} -${d.relationships.removed.length} ~${d.relationships.changed.length}; ${d.architecture.length} architecture changes (${d.architecture.filter((a) => a.breakingPotential).length} potentially breaking) in ${diffHeader(access, d)}.` : `Compared ${diffHeader(access, d)}.`];
      const evidence: EvidenceItem[] = graphAspect ? [...d.architecture].sort((a, b) => Number(b.breakingPotential) - Number(a.breakingPotential)).slice(0, limit).map((a) => diffEvidence(access, d, a, tool)) : [];
      const data: Record<string, unknown> = { from: d.old, to: d.new, graph: { entities: { added: d.entities.added.length, removed: d.entities.removed.length, changed: d.entities.changed.length }, relationships: { added: d.relationships.added.length, removed: d.relationships.removed.length, changed: d.relationships.changed.length }, byCategory: d.byCategory, architecture: d.architecture.slice(0, limit) } };
      const unknowns: string[] = [];
      const sides = snapshotModels(access, pair);
      if (aspects.includes("governance")) {
        const a = access.governance({ ...sides.from, asOf: d.old.createdAt.slice(0, 10) });
        const b = access.governance(sides.to);
        if (!a || !b) unknowns.push("no architecture policies configured; governance change is unknown");
        else {
          const g = governanceDiff(a.result, b.result);
          data.governance = { outcome: { from: a.result.summary.outcome, to: b.result.summary.outcome }, newViolations: g.newViolations.slice(0, limit).map(violationRow), resolvedViolations: g.resolvedViolations.slice(0, limit).map(violationRow), unchanged: g.unchanged, statusChanges: g.statusChanges };
          summary.push(`Governance ${a.result.summary.outcome} -> ${b.result.summary.outcome}: ${g.newViolations.length} new, ${g.resolvedViolations.length} resolved violations.`);
          evidence.push({ key: `govdiff:${d.old.id}:${d.new.id}`, kind: "governance", status: "FACT", fact: `Governance evaluated on ${d.old.commit?.slice(0, 8) ?? d.old.id} is ${a.result.summary.outcome} and on ${d.new.commit?.slice(0, 8) ?? d.new.id} is ${b.result.summary.outcome} (policies ${b.result.policyFingerprint}): ${g.newViolations.length} new, ${g.resolvedViolations.length} resolved, ${g.unchanged} unchanged violations`, source: null, target: null, relationship: null, path: null, repository: access.repoName(d.repositoryId), environment: null, snapshot: d.new.id, provenance: { plugin: "governance.evaluate", mechanism: "governance-diff", resolver: null }, location: null, priority: 1, tool });
          evidence.push(...g.newViolations.slice(0, limit).map((v) => ({ ...violationEvidence(access, v, tool), fact: `NEW violation: ${violationEvidence(access, v, tool).fact}`, priority: 1 })), ...g.resolvedViolations.slice(0, limit).map((v) => ({ ...violationEvidence(access, v, tool), key: `resolved:${v.id}`, fact: `RESOLVED violation: ${v.rule} ${access.text(v.message)}`, priority: 2 })));
        }
      }
      if (aspects.includes("security") || aspects.includes("ownership")) {
        const a = access.enterpriseModel(sides.from);
        const b = access.enterpriseModel(sides.to);
        for (const aspect of ["security", "ownership"] as const) {
          if (!aspects.includes(aspect)) continue;
          const x = aspect === "security" ? securityDiff(a, b) : ownershipDiff(a, b);
          data[aspect] = { summary: x.summary, changes: x.changes.slice(0, limit), ...("posture" in x ? { posture: (x.posture as { metric: string; before: number; after: number }[]).filter((p) => p.before !== p.after) } : {}) };
          summary.push(`${aspect === "security" ? "Security" : "Ownership"} changes: ${kv(x.summary)}.`);
          evidence.push(...x.changes.slice(0, limit).map((c) => ({ ...access.fromEntity(c.subject, `${c.kind}: ${c.subject.kind} ${name(c.subject)} ${c.before ?? "(none)"} -> ${c.after ?? "(none)"}${c.evidence.length ? `; ${c.evidence.slice(0, 3).map((x) => access.text(x)).join("; ")}` : ""}`, 1, tool, "FACT", "diff"), snapshot: d.new.id })));
        }
      }
      if (!graphAspect) summary.push(summary.shift()!);
      return { summary, data, evidence, unknowns, truncated: graphAspect && d.architecture.length > limit };
    },
  },
  {
    name: "get_architecture_diff",
    title: "Architecture diff",
    description: "Architecture-level changes (APIs, messages, dependencies, deployments, ...) between two snapshots, potentially breaking first; with 'entity' and history=true scans consecutive snapshot pairs to find when changes involving the entity appeared.",
    input: { repository: REPO, meta: { type: "boolean", default: false, description: "MetaGraph snapshots" }, from: SNAP, to: SNAP, entity: { type: "string", maxLength: 300, description: "Only changes whose subject mentions this name" }, category: { type: "string", maxLength: 40, description: "Impact category (API, MESSAGE, PROJECT, DEPLOYMENT, ...)" }, change: { type: "string", enum: ["added", "removed", "changed"], description: "Only this kind of change" }, breakingOnly: { type: "boolean", default: false, description: "Only potentially breaking changes" }, history: { type: "boolean", default: false, description: "Scan up to the last 10 snapshot pairs" }, limit: LIMIT },
    run(access, args) {
      const tool = "get_architecture_diff";
      const limit = Math.min(args.limit, access.limits.maxResults);
      const needle = args.entity ? String(args.entity).toLowerCase() : null;
      const keep = (a: GraphDiff["architecture"][number]) => (!needle || a.subject.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle)) && (!args.category || a.category === String(args.category).toUpperCase()) && (!args.breakingOnly || a.breakingPotential) && (!args.change || a.change === args.change);
      const relKeep = (r: GraphDiff["relationships"]["added"][number]) => !!needle && (r.source.toLowerCase().includes(needle) || r.target.toLowerCase().includes(needle));
      let diffs: GraphDiff[];
      let oldest: string | null = null;
      if (args.history) {
        const pair = diffPair(access, { ...args, from: undefined, to: undefined });
        const list = access.store.listGraphSnapshots({ scope: pair.scope, repositoryId: pair.repositoryId }).slice(-11);
        diffs = list.slice(1).map((s, i) => diffSnapshots(access.store, list[i]!.id, s.id));
        if (needle) {
          const payload = access.store.getGraphSnapshot(list[0]!.id)!.payload;
          const present = payload.entities.filter((row) => `${row[3] ?? row[2]}`.toLowerCase().includes(needle) && !["File", "Parameter"].includes(row[1])).length;
          oldest = present ? `'${args.entity}' already exists in the oldest stored snapshot (${list[0]!.commit?.slice(0, 12) ?? list[0]!.id}, ${list[0]!.createdAt}; ${present} matching entities): its first appearance predates the stored history and cannot be dated from the graph.` : `'${args.entity}' is absent from the oldest stored snapshot (${list[0]!.commit?.slice(0, 12) ?? list[0]!.id}).`;
        }
      } else {
        const pair = diffPair(access, args);
        diffs = [diffSnapshots(access.store, pair.from, pair.to)];
      }
      const rows = diffs.flatMap((d) => d.architecture.filter(keep).map((a) => ({ diff: d, a })));
      rows.sort((x, y) => Number(y.a.breakingPotential) - Number(x.a.breakingPotential));
      const rels = diffs.flatMap((d) => [...d.relationships.added.filter(relKeep).map((r) => ({ d, r, change: "added" })), ...d.relationships.removed.filter(relKeep).map((r) => ({ d, r, change: "removed" }))]);
      const evidence = [...rows.slice(0, limit).map((x) => diffEvidence(access, x.diff, x.a, tool)), ...rels.slice(0, limit).map((x) => ({ key: `reldiff:${x.d.new.id}:${x.r.id}:${x.change}`, kind: "diff" as const, status: "FACT" as const, fact: `Relationship ${x.r.source} -[${x.r.type}/${x.r.evidence}]-> ${x.r.target} ${x.change.toUpperCase()} between ${x.d.old.commit?.slice(0, 8) ?? x.d.old.id} (${x.d.old.createdAt}) and ${x.d.new.commit?.slice(0, 8) ?? x.d.new.id} (${x.d.new.createdAt})`, source: null, target: null, relationship: { id: x.r.id, type: x.r.type, evidence: x.r.evidence, scope: x.d.graphScope }, path: null, repository: access.repoName(x.d.repositoryId), environment: null, snapshot: x.d.new.id, provenance: { plugin: "analysis.diff", mechanism: "snapshot-diff", resolver: null }, location: null, priority: 2, tool }))];
      return {
        status: rows.length || rels.length ? "OK" : "EMPTY",
        summary: [`${rows.length} matching architecture changes (${rows.filter((x) => x.a.breakingPotential).length} potentially breaking)${needle ? `, ${rels.length} relationship changes involving '${args.entity}'` : ""} across ${diffs.length} snapshot comparison(s).`, ...(oldest ? [oldest] : []), ...(needle && args.history && !oldest?.includes("already exists") ? [firstSeen(access, diffs, rows.map((x) => x.diff), rels.map((x) => x.d), String(args.entity))] : []), ...diffs.map((d) => `  ${diffHeader(access, d)}`), ...rows.slice(0, 8).map((x) => `  [${x.a.category}] ${x.a.kind}${x.a.breakingPotential ? " (potentially breaking)" : ""}: ${access.text(x.a.description)}`)],
        data: { snapshots: diffs.map((d) => ({ from: { id: d.old.id, commit: d.old.commit, createdAt: d.old.createdAt }, to: { id: d.new.id, commit: d.new.commit, createdAt: d.new.createdAt } })), changes: rows.slice(0, limit).map((x) => ({ ...x.a, from: x.diff.old.id, to: x.diff.new.id })), relationshipChanges: rels.slice(0, limit).map((x) => ({ ...x.r, change: x.change, from: x.d.old.id, to: x.d.new.id })) },
        evidence: oldest ? [{ key: `oldest:${needle}`, kind: "diff" as const, status: "FACT" as const, fact: oldest, source: null, target: null, relationship: null, path: null, repository: null, environment: null, snapshot: diffs[0]?.old.id ?? null, provenance: { plugin: "analysis.diff", mechanism: "snapshot-payload", resolver: null }, location: null, priority: 1, tool }, ...evidence] : evidence,
        unknowns: [`changes are only known between stored snapshots (${diffs.length} compared); changes between them are not individually observable`],
        truncated: rows.length > limit || rels.length > limit,
      };
    },
  },
  {
    name: "summarize_entity",
    title: "Architecture summary",
    description: "Deterministic architecture summary generated from graph facts. Services: APIs, consumers, messages, outgoing calls, external systems, deployments, owner, exposure, findings, violations. Repositories: projects, services, APIs, messages, cross-repository dependencies, deployments, owners. APIs/messages: providers, consumers, contracts.",
    input: { entity: ENTITY, kind: KIND, repository: REPO },
    run(access, args) {
      const e = subject(access, args, "entity");
      const graph = access.analysisGraph();
      const opts = access.impactOptions("impact", 2);
      const tool = "summarize_entity";
      const evidence: EvidenceItem[] = [access.fromEntity(e, `${label(access.lite(e))} exists${e.location ? ` (declared at ${e.location.file}:${e.location.startLine})` : ""}`, 1, tool)];
      const summary: string[] = [];
      const unknowns: string[] = [];
      const facts: Record<string, unknown> = { subject: access.candidate(e) };
      const add = (key: string, list: Linked[], direction: "out" | "in", title: string, priority = 1) => {
        const visible = list.filter((l) => access.allowedName(l.repository));
        facts[key] = visible.slice(0, access.limits.maxResults).map(lrow);
        summary.push(`${title} (${visible.length}): ${[...new Set(visible.map((l) => `${l.entity.qualifiedName ?? l.entity.name}${l.repository && l.repository !== access.repoName(e.repositoryId) ? ` [${l.repository}]` : ""}`))].slice(0, 12).join("; ") || "none recorded"}`);
        evidence.push(...visible.slice(0, 15).map((l) => access.fromLinked(e, l, direction, priority, tool)));
        if (!visible.length) evidence.push(access.fromEntity(e, `${title} of ${e.name}: none recorded in the graph (no confirmed relationship; not proof of absence)`, 6, tool, "UNKNOWN", "analysis"));
      };
      if (e.kind === "Application") {
        const v = serviceImpact(graph, e, opts);
        summary.push(`Service ${e.name} in repository ${access.repoName(e.repositoryId)} (${String(e.metadata.applicationKind ?? e.metadata.kind ?? "application")}).`);
        add("apis", v.apis, "out", "APIs");
        add("apiConsumers", v.apiConsumers, "in", "API consumer calls");
        add("publishes", v.publishes, "out", "Publishes / sends");
        add("consumes", v.consumes, "in", "Consumes / handles");
        add("outgoingCalls", v.outgoingCalls, "out", "Outgoing HTTP calls", 2);
        add("externalSystems", v.externalSystems, "out", "External systems / databases", 2);
        facts.deployments = v.deployments.map((d) => ({ workload: lrow(d.workload), services: d.services.map(lrow), ingresses: d.ingresses.map(lrow) }));
        if (!v.deployments.length) evidence.push(access.fromEntity(e, `Deployments of ${e.name}: no declared deployment found`, 6, tool, "UNKNOWN", "analysis"));
        summary.push(`Deployments (${v.deployments.length}): ${v.deployments.map((d) => `${d.workload.entity.name} -> ${d.services.map((s) => s.entity.name).join(",") || "no service"} -> ${d.ingresses.map((i) => i.entity.name).join(",") || "no ingress"}`).join("; ") || "no declared deployment"}`);
        for (const d of v.deployments) evidence.push(access.fromLinked(e, d.workload, "in", 2, tool));
        summary.push(`Blast radius ${v.blastRadius.score} (${v.blastRadius.band}); ${v.upstream.impacted.length} upstream impacted, ${v.downstream.impacted.length} downstream dependencies (depth 2).`);
      } else if (e.kind === "Repository") {
        const v = repositoryImpact(graph, e, opts);
        const profile = access.meta.profile(e.repositoryId!);
        facts.profile = profile;
        const apps = access.store.findEntities({ kinds: ["Application"], repositoryId: e.repositoryId! });
        summary.push(`Repository ${e.name}: roles ${profile.roles.join(", ")}; ${profile.projects} projects, ${profile.applications} applications, ${profile.apis} APIs (${profile.operations} operations), ${profile.messages} messages, ${profile.pipelines} pipelines, ${profile.workloads} workloads, ${profile.charts} Helm charts.`);
        summary.push(`Applications: ${apps.map((a) => a.name).join(", ") || "none"}`);
        evidence.push(...apps.slice(0, 20).map((a) => access.fromEntity(a, `Application ${a.name} is defined in repository ${e.name}`, 1, tool)));
        add("dependsOn", v.dependsOn, "out", "Depends on repositories");
        add("dependents", v.dependents, "in", "Dependent repositories");
        add("providedApis", v.providedApis, "out", "Provided APIs", 2);
        add("consumedApis", v.consumedApis, "out", "Consumed APIs", 2);
        add("sharedPackages", v.sharedPackages, "out", "Shared packages", 3);
        add("deployedBy", v.deployedBy, "in", "Deployed by", 2);
        facts.infrastructure = v.infrastructure;
        summary.push(`Infrastructure: ${kv(v.infrastructure)}`);
      } else if (e.kind === "ApiOperation") {
        const v = apiImpact(graph, e, null, opts);
        if (v.provider) add("provider", [v.provider], "in", "Provider");
        add("endpoints", v.endpoints, "out", "Implemented by");
        add("handlers", v.handlers, "out", "Handlers");
        add("requestContracts", v.requestContracts, "out", "Request contracts", 2);
        add("responseContracts", v.responseContracts, "out", "Response contracts", 2);
        add("consumers", v.consumers, "in", "Consumers");
      } else if (e.kind === "Api") {
        add("operations", graph.out([e.id], ["CONTAINS"]).get(e.id)!.flatMap((edge) => { const t = graph.entity(edge.targetId); return t ? [{ entity: entityRef(t), relationship: { id: edge.id, type: edge.type, evidence: edge.evidence, graphScope: edge.graphScope, environment: edge.environment }, repository: access.repoName(t.repositoryId) }] : []; }), "out", "Operations");
        add("container", graph.in([e.id], ["CONTAINS", "PROVIDES_API"]).get(e.id)!.flatMap((edge) => { const s = graph.entity(edge.sourceId); return s ? [{ entity: entityRef(s), relationship: { id: edge.id, type: edge.type, evidence: edge.evidence, graphScope: edge.graphScope, environment: edge.environment }, repository: access.repoName(s.repositoryId) }] : []; }), "in", "Provided by");
      } else if (e.kind === "Message" || e.kind === "SharedContract") {
        const v = messageImpact(graph, e, opts);
        add("producers", v.producerSide, "in", "Producers");
        add("consumers", v.consumerSide, "out", "Consumers");
        facts.transports = v.transports.map((t) => lrow(t.transport));
        summary.push(`Transports: ${v.transports.map((t) => t.transport.entity.name).join(", ") || "none recorded"}`);
      } else {
        const out = [...graph.out([e.id]).get(e.id)!];
        const inc = [...graph.in([e.id]).get(e.id)!];
        const ents = graph.entities([...out.map((x) => x.targetId), ...inc.map((x) => x.sourceId)]);
        const toLinked = (edge: (typeof out)[number], id: string): Linked[] => { const o = ents.get(id); return o ? [{ entity: entityRef(o), relationship: { id: edge.id, type: edge.type, evidence: edge.evidence, graphScope: edge.graphScope, environment: edge.environment }, repository: access.repoName(o.repositoryId) }] : []; };
        add("outgoing", out.flatMap((x) => toLinked(x, x.targetId)), "out", "Outgoing relationships");
        add("incoming", inc.flatMap((x) => toLinked(x, x.sourceId)), "in", "Incoming relationships");
      }
      try {
        const model = access.may("ownership") || access.may("security") ? access.enterpriseModel() : null;
        if (model && model.graph.entities.get(e.id)) {
          const o = ownersOf(access, model, e);
          if (access.may("ownership")) {
            facts.ownership = { state: o.state, owners: o.owners.map((x) => x.id), resolvedVia: o.resolvedVia };
            summary.push(`Ownership: ${o.state}${o.owners.length ? ` ${o.owners.map((x) => x.id).join(", ")}` : ""}${o.resolvedVia !== "component" ? ` (via ${o.resolvedVia})` : ""}`);
            evidence.push(...ownershipEvidence(access, o.record, o.resolvedVia, access.lite(e), tool));
          }
          const svc = access.may("security") ? model.services.find((s) => s.service.id === e.id) : undefined;
          if (svc) {
            const eps = model.endpoints.filter((x) => x.service?.id === e.id);
            facts.security = { exposure: svc.exposure, endpoints: eps.length, protection: count(eps, (x) => x.protection) };
            summary.push(`Exposure: ${svc.exposure}; endpoint protection ${kv(count(eps, (x) => x.protection))}`);
            evidence.push(svc.evidence.length ? access.fromGovPath(svc.evidence[0]!.path, `Service ${svc.service.name} exposure ${svc.exposure} (${svc.evidence.map((x) => x.basis).join(", ")})`, "FACT", 4, tool, `exposure:${svc.service.id}`, svc.evidence[0]!.environment) : access.unknown(`Service ${svc.service.name} exposure ${svc.exposure}`, access.lite(e), tool));
          }
          const findings = access.may("security") ? model.findings.filter((f) => (e.kind === "Repository" ? f.repository === e.name : involves(f, e.id))) : null;
          if (findings) {
          facts.findings = count(findings, (f) => f.severity);
          summary.push(`Security findings: ${findings.length} (${kv(count(findings, (f) => f.severity))})`);
          evidence.push(access.fromEntity(e, `Security findings involving ${e.name} in the evaluated snapshot: ${findings.length}${findings.length ? ` (${kv(count(findings, (f) => f.severity))}; ${[...new Set(findings.map((f) => f.category))].join(", ")})` : ""}`, 4, tool, "FACT", "analysis"));
          }
        } else if (model) unknowns.push("entity is not present in the evaluated snapshot; ownership and security posture unknown");
      } catch (error) {
        unknowns.push(`ownership/security context unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const gov = access.may("governance") ? access.governance() : null;
        if (!access.may("governance")) { /* governance context not permitted for this caller */ }
        else if (!gov) unknowns.push("no architecture policies configured; governance state unknown");
        else {
          const v = gov.result.violations.filter((x) => involves(x, e.id) || (e.kind === "Application" && !!e.projectId && involves(x, e.projectId)) || (e.kind === "Repository" && x.repositories.includes(e.name)));
          facts.violations = count(v, (x) => `${x.status}:${x.severity}`);
          summary.push(`Governance violations: ${v.length} (${kv(count(v, (x) => x.status))})`);
          evidence.push(access.fromEntity(e, `Architecture rule violations involving ${e.name} under policies ${gov.result.policyFingerprint}: ${v.length}${v.length ? ` (${[...new Set(v.map((x) => x.rule))].join(", ")})` : ""}`, 4, tool, "FACT", "analysis"));
          evidence.push(...v.slice(0, 5).map((x) => violationEvidence(access, x, tool)));
        }
      } catch (error) {
        unknowns.push(`governance context unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { summary, data: facts, evidence, unknowns };
    },
  },
];

TOOLS.push(...AZURE_TOOLS);

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

export function toolCatalog() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: jsonSchema(t.input), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
}

export function runTool(access: GraphAccess, name: string, input: unknown): ToolResult {
  const tool = TOOL_INDEX.get(name);
  const base = { tool: name, input: (input && typeof input === "object" ? input : {}) as Record<string, unknown>, summary: [], data: null, evidence: [], unknowns: [], candidates: [], truncated: false };
  if (!tool) return { ...base, status: "ERROR", error: `unknown tool '${name}'`, graph: access.graphState() };
  if (access.options.deniedTools?.includes(name)) return { ...base, status: "OUT_OF_SCOPE", error: `tool '${name}' is not permitted for this caller`, summary: [`Not permitted: ${name}.`], graph: access.graphState() };
  const { value, errors } = validateInput(tool.input, input);
  if (errors.length) return { ...base, status: "ERROR", error: `invalid input: ${errors.join("; ")}`, graph: access.graphState() };
  try {
    const r = tool.run(access, value);
    return finish(access, name, value, r);
  } catch (error) {
    if (error instanceof Early) return finish(access, name, value, error.result);
    if (error instanceof ScopeError) return { ...base, input: value, status: "OUT_OF_SCOPE", error: error.message, summary: [error.message], graph: access.graphState() };
    if (error instanceof ReadOnlyViolation) return { ...base, input: value, status: "ERROR", error: error.message, graph: access.graphState() };
    return { ...base, input: value, status: "ERROR", error: error instanceof Error ? error.message : String(error), graph: access.graphState() };
  }
}

function finish(access: GraphAccess, name: string, input: Record<string, unknown>, r: Partial): ToolResult {
  return {
    tool: name, input, status: r.status ?? "OK", summary: r.summary, data: r.data, evidence: (r.evidence ?? []).map((e) => ({ ...e, tool: name })), unknowns: [...new Set(r.unknowns ?? [])], candidates: r.candidates ?? [], truncated: r.truncated ?? false,
    graph: access.graphState(r.snapshots),
  };
}

export type { EntityRef };
