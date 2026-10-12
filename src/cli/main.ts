#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { isEntityKind, isRelationshipType, type Entity, type EntityKind, type RelationshipType } from "../graph/model.ts";
import { createLogger } from "../log.ts";
import { AnalysisError, analyzeRepository } from "../pipeline/analyze.ts";
import { defaultPlugins } from "../plugins/registry.ts";
import { ApplicationQuery } from "../query/application-query.ts";
import { ContractQuery } from "../query/contract-query.ts";
import { InfrastructureQuery } from "../query/infrastructure-query.ts";
import { MetaQuery } from "../query/meta-query.ts";
import { buildMetaGraph } from "../metagraph/build.ts";
import { syncRepository, syncHistory, SyncUsageError, type SyncResult } from "../incremental/sync.ts";
import { syncStatus } from "../incremental/status.ts";
import { summarizeChangeSet } from "../incremental/changeset.ts";
import { changeSetFromGit } from "../incremental/git.ts";
import { installHooks, uninstallHooks, hookStatus, type HookMode } from "../incremental/hooks.ts";
import { discoverRepository, repositoryRoot } from "../pipeline/discovery.ts";
import { loadConfig as loadRepoConfig } from "../pipeline/config.ts";
import { registerRepository } from "../metagraph/catalog.ts";
import { exportAnalysis, exportMetaGraph } from "../export/export.ts";
import { AnalysisGraph, type AnalysisScope } from "../analysis/graph.ts";
import { propagate, type ImpactOptions, type ImpactResult } from "../analysis/impact.ts";
import { blastRadius, changeRisk, type Score } from "../analysis/risk.ts";
import { findPaths, type GraphPath } from "../analysis/traversal.ts";
import { diffSnapshots, snapshotFor, type GraphDiff } from "../analysis/diff.ts";
import { CYCLE_KINDS, findCycleSet, findOrphans, type CycleKind } from "../analysis/structure.ts";
import { loadPolicies, SEVERITIES, type PolicySet, type Severity as RuleSeverity } from "../governance/policy.ts";
import { evaluate, governanceDiff, snapshotSet, type GovernanceResult, type Violation } from "../governance/evaluate.ts";
import { API_CHANGE_KINDS, apiImpact, messageImpact, repositoryImpact, serviceImpact } from "../analysis/views.ts";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { GraphQuery } from "../query/graph-query.ts";
import { loadEnterpriseConfig, type EnterpriseConfig } from "../enterprise/config.ts";
import { buildEnterpriseModel, ownerOf, posture, type EnterpriseModel, type SecurityFinding } from "../enterprise/model.ts";
import { governanceEnrichment } from "../enterprise/governance.ts";
import { enterpriseRiskContext, inventory, ownershipDiff, securityDiff, securityImpact, teamDependencies, teamImpact, type Change } from "../enterprise/analysis.ts";
import { SqliteGraphStore } from "../store/sqlite.ts";
import type { GraphStats, GraphStore } from "../store/store.ts";
import { exportGraph, type ExportFormat } from "../export/export.ts";
import { label, relLine, table, tree, where } from "./format.ts";
import { FrontendQuery } from "../query/frontend-query.ts";
import { AzureQuery, type FlowHop } from "../query/azure-query.ts";
import { GraphAccess, readOnlyStore } from "../ai/access.ts";
import { ask, loadSession, readAudit, saveSession, sessionPath } from "../ai/assistant.ts";
import { DEFAULT_LIMITS, LIMIT_CAPS, type AiRequest } from "../ai/model.ts";
import { explicitPlan, planQuestion, validatePlan, type PlanStep } from "../ai/plan.ts";
import { aiDestination, describeConfig, loadAiConfig, type AiConfig } from "../ai/provider.ts";
import { runTool, toolCatalog } from "../ai/tools.ts";
import { McpServer } from "../ai/mcp.ts";
import { answerText, planText } from "./ai-format.ts";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const HELP = `vogoban - .NET-first enterprise code and architecture graph

Usage: vogoban <command> [args] [options]

Analysis
  analyze <path>                 Analyze a repository into the graph store (--no-semantic for syntax only)

Inspection
  repos                          List repositories in the store (the MetaGraph catalog)
  repo [repo]                    Repository metadata and analysis runs
  stats [--repo R]               Entity / relationship / evidence statistics
  find <text> [--kind K]         Search entities by name or qualified name
  show <entity>                  Entity identity, location, and all relationships
  project <project>              Project frameworks, assembly, references, packages, compilation state
  deps <entity> [--reverse]      Dependency traversal (reverse = dependents)
  callers <method> [--dispatch]  Callers (--dispatch adds callers of implemented/overridden members)
  callees <method>
  implementations <type|member>  Implementations, derived types, overrides
  inheritance <type|member>      Ancestors and descendants
  references <entity>            Resolved references to an entity, with source locations
  path <from> <to>               Shortest relationship path between two entities
  projects [--repo R]            Project dependency graph with cycle detection
Application graph
  applications                   ASP.NET Core / generic-host applications with detection signals
  endpoints [--method M] [--route R] [--app A] [--auth required|anonymous|none-declared]
  endpoint <id|"VERB /route">    Handler, binding, request/response types, authorization, provenance
  routes [--app A]               Effective routes and route groups
  services | registrations [--service T] [--lifetime L]   DI registrations (registrations includes framework Add* calls)
  middleware [--app A]           Middleware pipelines in static source order
  hosted-services                Hosted services and their registrations
  authorization                  Authorization metadata and endpoint counts
  config                         Configuration keys and environment variables referenced by code

Contract graph
  apis                           APIs (OpenAPI documents and code-first) with operation counts
  api <id|name>                  Operations of one API
  operations [--method M] [--path P] [--source openapi|code]
  operation <id|"VERB /path">    Contract, implementations, consumers, request/response schemas
  openapi                        OpenAPI documents with parse status
  contracts                      All contract entities (APIs, schemas, messages, transports)
  contract <id>                  Any contract entity with its relationships
  messages | message <id|name>   Message contracts with publishers, consumers, transports, schema
  publishers | consumers [--message M]
  transports                     Topics, exchanges and queues with senders, receivers and carried messages
  http-clients                   Named/typed/Refit clients, base addresses, and every static HTTP call
  contract-provenance <id>       Sources and evidence for a contract entity
  unresolved-contracts           Unresolved operations, HTTP calls, $refs, message types and transports

Frontend graph (TypeScript / JavaScript, Angular, React)
  frontend                       npm packages, frontend applications, roles, routes and HTTP call resolution
  components [--role R]          Components, hooks, services, contexts, guards, interceptors (R = component|hook|service|...)
  frontend-routes [--app A]      Angular / React Router / Next.js routes with components, lazy modules and guards
  frontend-chain <entity>        Trace a route/component/hook/service through HTTP calls to API operations and backend handlers

Azure graph (static repository analysis; never contacts Azure)
  azure [summary]                Functions, Azure resources by service and declaring language, unresolved Azure references
  azure functions                Azure Functions with trigger sources, bindings, hosting and authorization level
  azure triggers                 Trigger source -> Function rows (HTTP, timer, Service Bus, Event Hubs, Event Grid, Blob, Queue, Cosmos DB, durable)
  azure resources [--kind K]     Declared Azure resources (Bicep, ARM, Terraform, Aspire) with name resolution state
  azure messaging                Service Bus / Event Hubs / Event Grid / Storage queues with publishers, subscriptions, consumers, declarations
  azure infrastructure           IaC files -> created resources and modules; hosting, identity, roles, networking, observability
  azure flow <entity> [--upstream] [--to E] [--exclude TYPES]  Architecture flow through stored relationships (downstream: what happens next; upstream: what reaches it)

Infrastructure graph (static, declared state only)
  infrastructure                 Infrastructure statistics
  pipelines                      Azure Pipelines with triggers, stages, artifacts, builds and deployments
  pipeline <id|file>             Stages, jobs, tasks, dependencies, variables, artifacts of one pipeline
  artifacts                      Build artifacts with producers, packaged images/charts and consuming deployment jobs
  images                         Container images with producers, packaged applications, tags and deployments
  docker                         Dockerfiles with stages, base images, packaged projects and built images
  helm                           Helm charts, value profiles/releases and rendered resources
  deployments [--app A]          Kubernetes workloads with containers, images, applications, services, environments
  k8s-services | ingress         Kubernetes services (selector routing) and ingress routes
  configuration [secret|env|configmap] [--role service-url|database] [--source S]
  environments                   Environments and the resources declared for them
  topology [--app A]             Application -> image -> workload -> service -> ingress, with building pipelines
  unresolved-infrastructure      Unresolved infrastructure relationships

MetaGraph (multi-repository; repository graphs stay authoritative for their own facts)
  register <path> [--no-semantic]  Add a repository to the catalog without analyzing it
  analyze-repo <repo>            Analyze one catalog repository from its registered path
  analyze-all                    Analyze every catalog repository (failures do not stop the others)
  repositories                   Catalog: identity, analyzed commit, graph version, status (READY/STALE/FAILED/...)
  repository <repo>              Catalog entry, roles, analysis runs and cross-repository connections
  metagraph [build|stats|snapshots|unresolved|conflicts|export] [--force] [--format F --out P]
  connections [repo]             Cross-repository relationships with evidence and environment
  providers <api|"VERB /path">   (alias api-providers) Provider repositories, APIs and implementing endpoints
  api-consumers <api|"VERB /path">  Cross-repository and same-repository consumers
  message-publishers <message> | message-consumers <message>
  shared-packages [--package P]  Packages used by several catalog repositories, with classification
  external-systems [filter]      External systems and databases with the repositories that use them
  metagraph-topology <repo> [--reverse] [--depth N] [--env E]   Downstream (or upstream) repositories

Impact & architecture analysis (deterministic; --scope repository|meta|all, --env E, --depth N, --max-nodes N, --out F --format json|jsonl|csv)
  impact <entity...>             Change impact with level, category and explanation path per impacted entity
  blast-radius <entity...>       Structural exposure score with contributing factors
  dependencies <entity> | dependents <entity>   Direct / indirect / transitive dependencies
  paths <from> <to> [--all N] [--direction forward|reverse|both] [--type T] [--via-kind K]
  api-impact <operation> [--change removed|route|method|version|request-field|required-field|parameter|request-contract|response-field|response-contract|additive-field]
  message-impact <message|shared contract>   Producer, consumer, contract and transport impact
  service-impact <application>   Upstream/downstream impact, APIs, consumers, messages, deployments
  repository-impact <repo>       Cross-repository impact over the MetaGraph
  risk <entity...> [--change K] | risk --diff [--repo R --from S --to S]   Change-risk score with factors
  graph-snapshots [--repo R | --meta] [--prune]   Stored graph snapshots (--prune deletes snapshots superseded by a newer analysis of the same commit)
  diff [--repo R | --meta] [--from S --to S]   Graph diff and architecture changes between snapshots
  cycles [project|repository|service|relationship --type T] [--repo R]   Cycles with full paths
  orphaned [--repo R] [--label L]   NO_OBSERVED_CONSUMER / UNREFERENCED / UNREACHABLE / ORPHANED structures

Architecture governance (policy-as-code; --policy <file|dir>[,...] or $VOGOBAN_POLICIES, default ./vogoban-policies)
  validate-rules                 Validate policy files (exit 2 on errors)
  policies | policy <id>         Loaded policies, levels, precedence, layers, exceptions
  rules | rule <id>              Rules with mode, severity and scope; 'rule' also evaluates it
  governance [--repo R [--at S]] [--as-of D] [--baseline B] [--fail-on S] [--warn-on S] [--rule ID]
                                 Evaluate all rules; exit 0 PASS, 3 WARN, 4 FAIL
  violations [--severity S] [--status S] [--entity TEXT] [--env E]   Violations with path and evidence
  exceptions [--status active|expired|revoked|invalid]
  baseline save <name> | baseline list | baseline show <name>
  governance-diff [--repo R --from S --to S] [--meta-from S --meta-to S]   New / resolved / unchanged violations

Security, ownership & enterprise governance (static evidence only; --enterprise <file|none> or $VOGOBAN_ENTERPRISE, default ./vogoban-enterprise.yaml;
  snapshot-based like governance: --repo R [--at S]; structured output with --json or --out F --format json|jsonl|csv)
  validate-enterprise            Validate enterprise metadata (teams, ownership, classification, criticality, boundaries; exit 2 on errors)
  security | security-posture [--env E]   Structural posture indicators (security also lists findings)
  security-findings [--severity S] [--category C] [--state OBSERVED|UNKNOWN] [--env E] [--owner T|none] [--entity TEXT]
  security-endpoints [--exposure public|internal|unknown] [--protection NO_OBSERVED_AUTH|EXPLICITLY_ANONYMOUS|AUTH_PRESENT_AUTHZ_UNKNOWN|AUTHZ_PRESENT|UNKNOWN] [--app A] [--env E] [--criticality C]
  secrets [--state S] [--source provider] [--env E]   Secret references (names, providers, consumers; never values)
  sensitive-resources [--show-all] [--classification C]   Classified data stores, secret stores, external systems, transports
  trust-boundaries [--status unapproved] | security-flows   Boundary crossings and public-entry -> resource flows with paths
  ownership [component] | owners | unowned | ownership-conflicts [--category C] [--kind K] [--owner T] [--criticality C]
  ownership-history <component> [--repo R]   Owners of a component in every stored snapshot of its repository
  teams [team] | team-dependencies [team] [--reverse]   Teams, owned components and cross-team dependencies
  team-impact <entity...>        Owning team -> impacted components -> impacted teams (Phase 7 impact + ownership)
  security-impact <secret|resource|endpoint|service>   Consumers and blast radius of a security-sensitive component
  inventory [--category C] [--owner T] [--criticality C]   Governance-sensitive components (public APIs, secrets, unowned, ...)
  governance-context <entity>    Rules, violations, findings, ownership and facts that apply to a component
  security-diff | ownership-diff [--repo R --from S --to S] [--meta-from S --meta-to S]   Evidence-backed snapshot comparison

AI intelligence, Graph RAG & MCP (read-only; answers are built from deterministic graph tools and cite graph evidence)
  ask <question...>              (aliases ai, ai-query) Plan -> validate -> deterministic graph tools -> evidence -> answer.
                                 Questions answerable from graph results directly (owners, consumers, dependents, ...) make no LLM call.
                                 [--session S] [--no-llm | --llm] [--llm-plan] [--evidence] [--plan] [--repo R[,R]] [--env E] [--scope S] [--at S]
  explain service|repository|api|message|deployment|entity <ref>   Evidence-backed explanation of one component
  explain path|dependency <from> <to>     Why/how two components are connected (dependency adds governance rules)
  explain violation|finding <id>          Explain a governance violation or security finding
  ai-plan <question...>          Show the structured query plan, entity resolution and validation without executing it
  ai-tools | mcp-tools [tool]    Deterministic graph tools with their strict input schemas
  ai-tool <tool> [json-input]    Run one graph tool directly (structured result with evidence)
  ai-config                      LLM provider configuration and AI request destination (credentials shown only as the environment variable name)
  privacy | diagnostics          Operating mode, telemetry status (off), storage, AI destination, git remotes, hosted status, outbound network
  ai-audit [record-id]           AI answer records: question -> plan -> tools -> evidence -> answer
  mcp                            MCP server on stdio exposing the read-only tools, resources and prompts (scope with --repo/--env/--scope)
  AI configuration: --ai-config <file>, $VOGOBAN_AI or ./vogoban-ai.yaml (provider none|openai-compatible|azure-openai|anthropic, model,
  endpoint, apiKeyEnv, apiVersion, temperature, maxOutputTokens, contextTokens, timeoutMs, retries, planner, audit, aliases);
  $VOGOBAN_AI_PROVIDER / _MODEL / _ENDPOINT / _API_KEY_ENV override. Limits: --depth, --limit, --max-nodes, --max-evidence.

  unresolved | diagnostics | conflicts [--repo R]
  provenance <id>                Evidence for an entity, relationship, or unresolved reference
  shared                         Entities referenced from more than one repository
  export --format json|jsonl|csv --out <path> [--repo R]
  backup --out <path>            Consistent single-file copy of the local graph (no network, no vendor)
  restore --from <path>          Replace the local graph store from a backup (closes, swaps, reopens)

Incremental graph synchronization (Change -> Detect -> Invalidate -> Analyze -> Reconcile -> Version)
  graph sync [path]              Detect changes and update the graph incrementally (full rebuild when unsafe)
    --since <commit>             Sync changes since a commit; --from/--to or --base/--head for a commit range (CI)
    --staged                     Use staged changes;  --full forces a rebuild;  --meta also reconciles the MetaGraph
    --quiet                      Suppress human output (hooks);  --json for machine-readable result
    --strict-incremental         Exit 5 when an incremental request on an existing graph ran as a full rebuild (CI)
    Exit codes: 0 success / no-op / safe full-rebuild fallback (requestedMode, actualMode, fallbackCode in --json);
                2 invalid request (unresolvable or malformed --head/--to, non-Git commit range, head not checked out);
                3 failed (previous graph preserved); 4 degraded (plugin crashed); 5 fallback under --strict-incremental;
                1 unexpected environment error, e.g. graph store not writable (previous graph preserved)
  graph status [path]            UP_TO_DATE / CHANGES_DETECTED / FULL_REBUILD_REQUIRED / NEVER_ANALYZED / FAILED
  graph changes [path]           Show the detected change set (same flags as sync)
  graph history [path]           Recent synchronizations with mode, status, and metrics
  hooks install|uninstall|status [path]   Optional Git hooks (--hook-mode notify|background|sync; notify default)

Enterprise platform
  platform serve | worker | migrate | config | tenant | token | audit   Multi-tenant API, web application, workers (bun src/cli/main.ts platform help)

Options
  --db <path>        Graph store (default: $VOGOBAN_DB or ./.vogoban/graph.db)
  --json             Machine-readable JSON output
  --depth <n>        Traversal depth (default 1; path default 8)
  --type <T,...>     Restrict relationship types
  --kind <K,...>     Restrict entity kinds
  --limit <n>        Maximum rows
  --offline          Refuse any non-local network (external AI endpoints); local graph, MCP and local models still work
  --mode <m>         LOCAL (default) | SELF_HOSTED | HOSTED; shown by 'privacy' (local usage needs no mode and no account)
  --log-level <lvl>  debug|info|warn|error (default info for analyze, warn otherwise)
  --log-json         Structured JSON logs on stderr
  --version          Print the vogoban version and exit`;

const PACKAGE_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;

const USAGE = `usage: vogoban <command> [options]  (run 'vogoban --help' for the command list)`;

const parseCli = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\. To specify a positional argument.*$/s, "");
    console.error(`error: ${message.split("\n")[0]}\n${USAGE}`);
    process.exit(2);
  }
};

const { values: opts, positionals } = parseCli(() => parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    version: { type: "boolean", default: false },
    db: { type: "string" },
    json: { type: "boolean", default: false },
    repo: { type: "string" },
    depth: { type: "string" },
    type: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    reverse: { type: "boolean", default: false },
    upstream: { type: "boolean", default: false },
    exclude: { type: "string" },
    dispatch: { type: "boolean", default: false },
    format: { type: "string" },
    method: { type: "string" },
    route: { type: "string" },
    app: { type: "string" },
    auth: { type: "string" },
    service: { type: "string" },
    lifetime: { type: "string" },
    path: { type: "string" },
    source: { type: "string" },
    message: { type: "string" },
    role: { type: "string" },
    package: { type: "string" },
    env: { type: "string" },
    force: { type: "boolean", default: false },
    "max-nodes": { type: "string" },
    scope: { type: "string" },
    change: { type: "string" },
    direction: { type: "string" },
    "via-kind": { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    meta: { type: "boolean", default: false },
    label: { type: "string" },
    diff: { type: "boolean", default: false },
    all: { type: "string" },
    policy: { type: "string" },
    "as-of": { type: "string" },
    "fail-on": { type: "string" },
    "warn-on": { type: "string" },
    baseline: { type: "string" },
    rule: { type: "string" },
    severity: { type: "string" },
    status: { type: "string" },
    entity: { type: "string" },
    "meta-from": { type: "string" },
    at: { type: "string" },
    "meta-to": { type: "string" },
    enterprise: { type: "string" },
    exposure: { type: "string" },
    protection: { type: "string" },
    criticality: { type: "string" },
    classification: { type: "string" },
    owner: { type: "string" },
    category: { type: "string" },
    state: { type: "string" },
    "show-all": { type: "boolean", default: false },
    prune: { type: "boolean", default: false },
    out: { type: "string" },
    "no-semantic": { type: "boolean", default: false },
    "log-level": { type: "string" },
    "log-json": { type: "boolean", default: false },
    session: { type: "string" },
    "no-llm": { type: "boolean", default: false },
    llm: { type: "boolean", default: false },
    "llm-plan": { type: "boolean", default: false },
    evidence: { type: "boolean", default: false },
    plan: { type: "boolean", default: false },
    "ai-config": { type: "string" },
    offline: { type: "boolean", default: false },
    mode: { type: "string" },
    "max-evidence": { type: "string" },
    once: { type: "boolean", default: false },
    "admin-email": { type: "string" },
    "scope-repo": { type: "string" },
    days: { type: "string" },
    "to-version": { type: "string" },
    since: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    full: { type: "boolean", default: false },
    staged: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    untrusted: { type: "boolean", default: false },
    "trust-repository": { type: "boolean", default: false },
    "strict-incremental": { type: "boolean", default: false },
    "hook-mode": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
}));
if (opts.version) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}

// `graph <sub>` is sugar for the flat incremental commands, matching the Phase 14 spec
// while keeping the existing single-token CLI convention.
const GRAPH_SUBCOMMANDS: Record<string, string> = { sync: "sync", status: "sync-status", changes: "sync-changes", diff: "diff", history: "sync-history" };
if (positionals[0] === "graph" && positionals[1] && GRAPH_SUBCOMMANDS[positionals[1]]) {
  positionals.splice(0, 2, GRAPH_SUBCOMMANDS[positionals[1]]!);
}
const [command, ...args] = positionals;
if (!command || opts.help) {
  console.log(HELP);
  process.exit(command || opts.help ? 0 : 1);
}

class CliError extends Error {
  constructor(message: string, readonly payload?: unknown) {
    super(message);
  }
}

const output = (human: () => string, data: unknown) => console.log(opts.json ? JSON.stringify(data, null, 2) : human());

function renderSync(r: SyncResult): string {
  const m = r.metrics;
  const label = r.status === "NO_OP" ? "no-op" : r.mode === "full" ? (r.fallbackReason ? "full (fallback)" : "full") : r.mode;
  const lines = [
    `${r.repository}: ${label.toUpperCase()} — ${r.reason}`,
    r.fallbackReason ? `  fallback: ${r.fallbackReason} [${r.fallbackCode}] (requested ${r.requestedMode}, ran ${r.actualMode})` : null,
    `  commit ${r.previousCommit?.slice(0, 12) ?? "?"} -> ${r.currentCommit?.slice(0, 12) ?? "?"}  [${r.changeSource}]`,
    r.graphVersion ? `  graph version ${r.previousGraphVersion?.slice(0, 12) ?? "(none)"} -> ${r.graphVersion.slice(0, 12)}` : null,
  ];
  if (r.status === "SUCCESS") {
    lines.push(
      `  changed files ${m.changedFiles}  ·  analyzed ${m.filesAnalyzed}  ·  affected projects ${m.affectedProjects}`,
      `  reconciled entities +${m.entitiesCreated} ~${m.entitiesUpdated} -${m.entitiesDeleted}  relationships +${m.relationshipsCreated} ~${m.relationshipsUpdated} -${m.relationshipsDeleted}`,
      `  duration ${m.durationMs} ms${m.baselineDurationMs ? ` (baseline full ${m.baselineDurationMs} ms)` : ""}`,
      r.plan.affected.domains.length ? `  domains: ${r.plan.affected.domains.join(", ")}` : null,
      r.diffSnapshotFrom && r.diffSnapshotTo ? `  diff: vogoban diff --from ${r.diffSnapshotFrom} --to ${r.diffSnapshotTo}` : null,
    );
  } else if (r.status === "FAILED") {
    lines.push(`  FAILED: ${r.error}`, `  previous graph version ${r.previousGraphVersion?.slice(0, 12) ?? "(none)"} preserved`);
  }
  return lines.filter(Boolean).join("\n");
}
const intOpt = (v: string | undefined, fallback: number) => (v ? Number.parseInt(v, 10) : fallback);
const types = (): RelationshipType[] | undefined => {
  if (!opts.type) return undefined;
  const list = opts.type.split(",").map((t) => t.trim().toUpperCase());
  const bad = list.filter((t) => !isRelationshipType(t));
  if (bad.length) throw new CliError(`unknown relationship type(s): ${bad.join(", ")}`);
  return list as RelationshipType[];
};
const kinds = (): EntityKind[] | undefined => {
  if (!opts.kind) return undefined;
  const list = opts.kind.split(",").map((k) => k.trim());
  const bad = list.filter((k) => !isEntityKind(k));
  if (bad.length) throw new CliError(`unknown entity kind(s): ${bad.join(", ")}`);
  return list as EntityKind[];
};

function repoId(store: GraphStore, explicit?: string): string | undefined {
  const ref = explicit ?? opts.repo;
  if (!ref) {
    const repos = store.listRepositories();
    return repos.length === 1 ? repos[0]!.id : undefined;
  }
  const repo = store.getRepository(ref);
  if (!repo) throw new CliError(`repository not found: ${ref}`);
  return repo.id;
}

function one(query: GraphQuery, ref: string | undefined, store: GraphStore): Entity {
  if (!ref) throw new CliError("an entity reference is required (id, symbol key, qualified name, or name)");
  const matches = query.resolve(ref, { kinds: kinds(), repositoryId: opts.repo ? repoId(store) : undefined });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliError(`no entity matches '${ref}'`);
  const exact = matches.filter((m) => m.qualifiedName === ref || m.symbolKey === ref);
  if (exact.length === 1) return exact[0]!;
  throw new CliError(
    `'${ref}' is ambiguous (${matches.length} matches); use an id or --kind:\n${matches.slice(0, 20).map((m) => `  ${m.id}  ${label(m)}  ${where(m)}`).join("\n")}`,
    matches.map((m) => ({ id: m.id, kind: m.kind, qualifiedName: m.qualifiedName })),
  );
}

function summary(stats: GraphStats): [string, number][] {
  const e = stats.entitiesByKind;
  const r = stats.relationshipsByType;
  const t = stats.typesBySymbolKind;
  const n = (v: number | undefined) => v ?? 0;
  return [
    ["Projects", n(e.Project)],
    ["Assemblies", n(e.Assembly)],
    ["Files", stats.files],
    ["Namespaces", n(e.Namespace)],
    ["Types", n(e.Type)],
    ["  Classes", n(t.Class)],
    ["  Records", n(t.Record) + n(t.RecordStruct)],
    ["  Structs", n(t.Struct)],
    ["  Interfaces", n(t.Interface)],
    ["  Enums", n(t.Enum)],
    ["  Delegates", n(t.Delegate)],
    ["Methods", n(e.Method)],
    ["Properties", n(e.Property)],
    ["Fields", n(e.Field)],
    ["Events", n(e.Event)],
    ["Parameters", n(e.Parameter)],
    ["Calls", n(r.CALLS)],
    ["Constructions", n(r.CONSTRUCTS)],
    ["Type References", n(r.USES_TYPE) + n(r.RETURNS_TYPE)],
    ["Member References", n(r.USES_MEMBER) + n(r.READS_FIELD) + n(r.WRITES_FIELD)],
    ["Inheritance / Implementations", n(r.INHERITS) + n(r.IMPLEMENTS) + n(r.EXTENDS)],
    ["Overrides", n(r.OVERRIDES)],
    ["Project References", n(r.PROJECT_REFERENCES)],
    ["Assembly References", n(r.ASSEMBLY_REFERENCES)],
    ["Package Dependencies", n(r.PACKAGE_DEPENDS_ON)],
    ["Unresolved References", stats.unresolved],
    ["Compilation Diagnostics", n(stats.diagnosticsByCategory.compilation)],
  ];
}

async function main() {
  if (process.platform === "win32") console.error("warning: Windows is not a supported or validated platform for Vogoban (path, junction and reparse-point handling is unverified); run on Linux, in a Linux container, or under WSL2");
  if (opts.offline || process.env.VOGOBAN_OFFLINE === "1") process.env.VOGOBAN_OFFLINE = "1";
  // Repository build files can execute code during MSBuild evaluation (property functions read files and environment).
  // Local analysis of your own checkout is trusted; CI base/head synchronization (typically pull-request code) is not
  // unless the operator explicitly opts in.
  const ciSync = command === "sync" && Boolean(opts.base || opts.head);
  if (opts.untrusted || (ciSync && !opts["trust-repository"])) {
    process.env.VOGOBAN_MSBUILD_EVALUATION = "0";
    if (ciSync && !opts.untrusted && !opts.json) console.error("note: repository build evaluation is disabled in CI mode (static analysis only); use --trust-repository on a trusted repository for full fidelity");
  }
  if (command === "platform") {
    const { platformCommand } = await import("../platform/cli.ts");
    try {
      await platformCommand(args, opts);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  const isAnalyze = command === "analyze";
  const log = createLogger({ level: opts["log-level"] ?? (isAnalyze ? "info" : "warn"), json: opts["log-json"], base: process.env.VOGOBAN_CORRELATION_ID ? { correlation_id: process.env.VOGOBAN_CORRELATION_ID, job: process.env.VOGOBAN_JOB_ID } : {} });
  const store = new SqliteGraphStore(opts.db ?? process.env.VOGOBAN_DB ?? ".vogoban/graph.db");
  const query = new GraphQuery(store);
  const appQuery = new ApplicationQuery(store);
  const contractQuery = new ContractQuery(store);
  const frontendQuery = new FrontendQuery(store);
  const azureQuery = new AzureQuery(store);
  const infraQuery = new InfrastructureQuery(store);
  const metaQuery = new MetaQuery(store);
  const repoName = (id: string | null) => (id ? (store.getCatalog(id)?.name ?? id) : "meta");
  const metaRelLine = (r: import("../graph/model.ts").MetaRelationship) => `${r.evidence}${r.confidence < 1 ? ` ${r.confidence}` : ""}${r.environment ? ` env=${r.environment}` : ""} [${(r.metadata.evidenceKinds as string[]).join(", ")}]`;
  const depthOpt = (fallback: number) => {
    const d = intOpt(opts.depth, fallback);
    if (!Number.isFinite(d) || d < 1) throw new CliError("--depth must be a positive integer");
    if (d > 12) throw new CliError("--depth cannot exceed 12 (traversal guard)");
    return d;
  };
  const rowLimit = () => intOpt(opts.limit, 40);
  const viaKinds = (): EntityKind[] | undefined => {
    if (!opts["via-kind"]) return undefined;
    const list = opts["via-kind"].split(",").map((k) => k.trim());
    const bad = list.filter((k) => !isEntityKind(k));
    if (bad.length) throw new CliError(`unknown entity kind(s): ${bad.join(", ")}`);
    return list as EntityKind[];
  };
  const analysisGraph = (forced?: AnalysisScope) => {
    const scope = (forced ?? opts.scope ?? "all") as AnalysisScope;
    if (!["repository", "meta", "all"].includes(scope)) throw new CliError("--scope must be repository, meta or all");
    return new AnalysisGraph(store, { scope, repositoryId: opts.repo ? catalogRef(opts.repo).repositoryId : undefined, environment: opts.env });
  };
  const impactOptions = (mode: ImpactOptions["mode"]): ImpactOptions => ({ mode, maxDepth: depthOpt(mode === "impact" ? 6 : 3), maxNodes: intOpt(opts["max-nodes"], 2000), expandSeeds: true });
  const target = (ref: string | undefined): Entity => {
    if (!ref) throw new CliError("an entity reference is required");
    const meta = store.findMetaEntities({ ids: [ref] })[0] ?? store.findMetaEntities({ nameLike: ref }).filter((e) => e.name === ref || e.qualifiedName === ref)[0];
    if (meta) return meta;
    const repo = store.getCatalog(ref);
    if (repo) {
      const entity = store.findEntities({ kinds: ["Repository"], repositoryId: repo.repositoryId })[0];
      if (entity) return entity;
    }
    return one(query, ref, store);
  };
  const stepText = (s: GraphPath["steps"][number]) => {
    const rel = `${s.relationship.type}${s.relationship.graphScope === "meta" ? "@meta" : ""}${s.relationship.evidence === "INFERRED" || s.relationship.evidence === "HEURISTIC" ? "?" : ""}${s.relationship.environment ? ` env=${s.relationship.environment}` : ""}`;
    const arrow = s.relationship.direction === "forward" ? `-[${rel}]->` : `<-[${rel}]-`;
    return `${arrow} ${s.to.kind} ${s.to.qualifiedName ?? s.to.name}${s.relationship.crossRepository ? `  <crosses into ${repoName(s.to.repositoryId)}>` : ""}`;
  };
  const pathText = (p: GraphPath) => [`  ${p.start.kind} ${p.start.qualifiedName ?? p.start.name} [${repoName(p.start.repositoryId)}]`, ...p.steps.map((s, i) => `  ${"  ".repeat(i + 1)}${stepText(s)}${s.relationship.provenance?.location ? `  (${s.relationship.provenance.location.file}:${s.relationship.provenance.location.startLine})` : ""}`)].join("\n");
  const impactRow = (i: ImpactResult["impacted"][number]) => ({
    level: i.level, category: i.category, kind: i.entity.kind, entity: i.entity.qualifiedName ?? i.entity.name, id: i.entity.id, repository: repoName(i.entity.repositoryId), depth: i.depth,
    confirmed: i.confirmed, crossRepository: i.crossRepository, reason: i.reason, path: i.path.steps.map((s) => `${s.relationship.type}${s.relationship.direction === "reverse" ? "<" : ">"}${s.to.name}`).join(" "),
  });
  const impactSummary = (r: ImpactResult) => {
    const limit = rowLimit();
    const rows = r.impacted.slice(0, limit);
    return [
      `${r.mode} of ${r.seeds.map((s) => `${s.kind} ${s.qualifiedName ?? s.name}`).join(", ")}${r.changeScope.length ? ` (+${r.changeScope.length} contained elements in change scope)` : ""}`,
      `  ${r.impacted.length} entities  levels: ${Object.entries(r.byLevel).map(([k, n]) => `${k}=${n}`).join(" ") || "-"}  categories: ${Object.entries(r.byCategory).map(([k, n]) => `${k}=${n}`).join(" ") || "-"}`,
      `  repositories: ${r.repositories.map((x) => `${x.name}(${x.impacted})`).join(", ") || "-"}  unresolved at boundary: ${r.unresolved.length}  conflicts: ${r.conflicts.length}${r.truncated ? `  TRUNCATED at ${r.limits.maxNodes} nodes` : ""}`,
      `  graph: ${r.graphState.repositories.map((x) => `${x.name}@${x.commit?.slice(0, 8) ?? "-"}/${x.graphVersion?.slice(0, 8) ?? "-"} ${x.status}`).join(", ") || "-"}${r.graphState.metaSnapshot ? `  meta=${r.graphState.metaSnapshot}` : ""}`,
      ...r.graphState.warnings.map((w) => `  warning: ${w}`),
      ...(rows.length ? [table(rows.map((i) => [i.level, i.category, `${i.entity.kind} ${i.entity.qualifiedName ?? i.entity.name}`, i.entity.repositoryId ? repoName(i.entity.repositoryId) : i.entity.graphScope === "meta" ? "meta" : "external", i.reason, i.path.steps.map((s) => `${s.relationship.direction === "reverse" ? "<-" : "->"}${s.relationship.type}${s.relationship.crossRepository ? "*" : ""}`).join(" ")]), ["level", "category", "entity", "repository", "because", "path (* crosses repository)"])] : []),
      r.impacted.length > limit ? `  (${r.impacted.length - limit} more; --limit N, --json or --out for all; 'paths <seed> <entity>' explains any row)` : "",
    ].filter(Boolean).join("\n");
  };
  const scoreText = (title: string, s: Score) => [`${title}: ${s.score} (${s.band}) - ${s.meaning}`, table(s.factors.map((f) => [f.factor, f.value, `${f.points}/${f.max}`, f.explanation]), ["factor", "value", "points", "explanation"])].join("\n");
  const maybeExport = async (kind: string, result: unknown, rows: Record<string, unknown>[]) => {
    if (!opts.out) return;
    const format = (opts.format ?? "json") as ExportFormat;
    if (!["json", "jsonl", "csv"].includes(format)) throw new CliError("--format must be json, jsonl, or csv");
    const n = await exportAnalysis(format, opts.out, kind, result, rows);
    console.error(`exported ${kind} (${n} rows) to ${opts.out}`);
  };
  const resolveDiff = (): GraphDiff => {
    const scope = opts.meta ? "meta" : "repository";
    const repositoryId = scope === "repository" ? (opts.repo ? catalogRef(opts.repo).repositoryId : repoId(store)) : undefined;
    if (scope === "repository" && !repositoryId) throw new CliError("diff needs --repo when the store holds several repositories");
    const list = store.listGraphSnapshots({ scope, repositoryId });
    const pick = (ref: string | undefined, fallback: number) => {
      if (!ref) return list[list.length - fallback] ?? null;
      return snapshotFor(store, ref, scope, repositoryId);
    };
    const from = pick(opts.from, 2);
    const to = pick(opts.to, 1);
    if (!from || !to) throw new CliError(`need two ${scope} snapshots${repositoryId ? ` for ${repoName(repositoryId)}` : ""} (found ${list.length}); analyze another commit or pass --from/--to`);
    if (from.id === to.id) throw new CliError("--from and --to resolve to the same snapshot");
    return diffSnapshots(store, from.id, to.id);
  };
  let policyCache: PolicySet | null = null;
  const policySet = (strict = true): PolicySet => {
    if (policyCache) return policyCache;
    const paths = (opts.policy ?? process.env.VOGOBAN_POLICIES ?? "vogoban-policies").split(",").map((p) => p.trim()).filter(Boolean);
    try {
      policyCache = loadPolicies(paths);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    if (strict && policyCache.errors.length) throw new CliError(`policy validation failed (${policyCache.errors.length} errors):\n${policyCache.errors.map((e) => `  ${e.file}:${e.path} ${e.message}`).join("\n")}`, policyCache.errors);
    return policyCache;
  };
  const severityOpt = (v: string | undefined, fallback: RuleSeverity): RuleSeverity => {
    const s = (v ?? fallback).toUpperCase();
    if (!(SEVERITIES as readonly string[]).includes(s)) throw new CliError(`severity must be one of ${SEVERITIES.join(", ")}`);
    return s as RuleSeverity;
  };
  const asOf = () => {
    const d = opts["as-of"] ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new CliError("--as-of must be YYYY-MM-DD");
    return d;
  };
  const runGovernance = (overrides: { repositorySnapshots?: Record<string, string>; metaSnapshot?: string | null; asOf?: string; baseline?: string } = {}, capture?: (m: EnterpriseModel) => void): GovernanceResult => {
    const policies = policySet();
    const repositories = opts.repo ? [catalogRef(opts.repo).repositoryId] : undefined;
    try {
      if (opts.at && !opts.repo) throw new CliError("--at needs --repo");
      const set = snapshotSet(store, { repositories, repositorySnapshots: overrides.repositorySnapshots ?? (opts.at ? { [repositories![0]!]: opts.at } : undefined), metaSnapshot: overrides.metaSnapshot, includeMeta: opts.scope !== "repository" });
      if (!set.repositories.length && !set.meta) throw new Error("no graph snapshots available; analyze a repository first");
      return evaluate(store, policies, { set, asOf: overrides.asOf ?? asOf(), failOn: severityOpt(opts["fail-on"], "ERROR"), warnOn: severityOpt(opts["warn-on"], "WARNING"), baseline: overrides.baseline ?? opts.baseline, rules: opts.rule ? opts.rule.split(",") : undefined, enrich: governanceEnrichment(store, enterpriseConfig(), capture) });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  };
  const violationRow = (v: Violation) => ({
    id: v.id, severity: v.severity, rule: v.rule, policy: v.policy, status: v.status, baseline: v.baseline, environment: v.environment, source: v.source.qualifiedName ?? v.source.name, sourceKind: v.source.kind,
    target: v.target ? (v.target.qualifiedName ?? v.target.name) : null, relationship: v.relationship?.type ?? null, repositories: v.repositories.join(";"), exception: v.exception ? `${v.exception.id}:${v.exception.status}` : null,
    path: v.path.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}`).join(" | "), message: v.message,
    ownership: v.ownership?.state ?? null, owners: v.ownership?.owners.map((o) => o.id).join(";") ?? null, ownedComponent: v.ownership?.component ? (v.ownership.component.qualifiedName ?? v.ownership.component.name) : null, organizationalBoundaries: v.ownership?.organizationalBoundaries.join(";") ?? null,
  });
  const violationText = (v: Violation) => [
    `[${v.severity}] ${v.rule} ${v.ruleName}  ${v.status}${v.baseline ? ` ${v.baseline}` : ""}${v.environment ? `  env=${v.environment}` : ""}  (${v.id})`,
    `    ${v.message}`,
    ...v.path.map((p, i) => `    ${"  ".repeat(i)}${p.from.kind} ${p.from.qualifiedName ?? p.from.name} [${p.from.repository ?? "-"}] -[${p.relationship.type}/${p.relationship.evidence}${p.relationship.scope === "meta" ? "@meta" : ""}]-> ${p.to.kind} ${p.to.qualifiedName ?? p.to.name} [${p.to.repository ?? "-"}]${p.relationship.location ? `  @ ${p.relationship.location}` : ""}`),
    ...(!v.path.length ? [`    subject ${v.source.kind} ${v.source.qualifiedName ?? v.source.name} [${v.source.repository ?? "-"}]${v.source.location ? ` @ ${v.source.location}` : ""}`] : []),
    ...(v.ownership ? [`    owner: ${v.ownership.owners.length ? v.ownership.owners.map((o) => `${o.id}${o.businessUnit ? `/${o.businessUnit}` : ""}${o.organization ? `/${o.organization}` : ""}`).join(", ") : v.ownership.state}${v.ownership.owners.length && v.ownership.state === "CONFLICT" ? " (CONFLICT)" : ""}${v.ownership.component ? ` via ${v.ownership.component.kind} ${v.ownership.component.name}` : ""}${v.ownership.repository ? `  repository ${v.ownership.repository}${v.ownership.repositoryOwners.length ? ` (${v.ownership.repositoryOwners.join(", ")})` : ""}` : ""}`] : []),
    ...(v.exception ? [`    exception ${v.exception.id} (${v.exception.status}${v.exception.expires ? `, expires ${v.exception.expires}` : ""}): ${v.exception.reason}`] : []),
    ...(v.resolvedBy ? [`    ${v.status === "POLICY_CONFLICT" ? "conflicts with allowing rule" : "overridden by"} ${v.resolvedBy.rule} (${v.resolvedBy.policy}, precedence ${v.resolvedBy.precedence})${v.status === "POLICY_CONFLICT" ? "; no precedence decides it, both results are kept" : ""}`] : []),
  ].join("\n");
  const snapshotText = (r: GovernanceResult) => `snapshots: ${r.snapshots.repositories.map((x) => `${x.name}@${x.commit?.slice(0, 8) ?? "-"} (${x.snapshot})`).join(", ") || "-"}${r.snapshots.meta ? `  meta ${r.snapshots.meta.metaSnapshot} (${r.snapshots.meta.snapshot})` : ""}  as-of ${r.asOf}  policies ${r.policyFingerprint}`;
  const exitFor = (outcome: GovernanceResult["summary"]["outcome"]) => {
    if (outcome === "FAIL") process.exitCode = 4;
    else if (outcome === "WARN") process.exitCode = 3;
  };
  const catalogRef = (ref: string | undefined) => {
    if (!ref) throw new CliError("a repository reference is required (id, identity, or name)");
    const entry = store.getCatalog(ref);
    if (!entry) throw new CliError(`repository not in catalog: ${ref}`);
    return entry;
  };
  const names = (list: Entity[]) => list.map((e) => e.qualifiedName ?? e.name).join(", ") || "-";
  let enterpriseCache: EnterpriseConfig | null = null;
  const enterpriseConfig = (strict = true): EnterpriseConfig => {
    if (enterpriseCache) return enterpriseCache;
    const requested = opts.enterprise ?? process.env.VOGOBAN_ENTERPRISE ?? (existsSync("vogoban-enterprise.yaml") ? "vogoban-enterprise.yaml" : null);
    const path = requested === "none" ? null : requested;
    try {
      enterpriseCache = loadEnterpriseConfig(path);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    if (strict && enterpriseCache.errors.length) throw new CliError(`enterprise metadata validation failed (${enterpriseCache.errors.length} errors):\n${enterpriseCache.errors.map((e) => `  ${enterpriseCache!.file}:${e.path} ${e.message}`).join("\n")}`, enterpriseCache.errors);
    return enterpriseCache;
  };
  const optionalPolicies = () => (opts.policy || process.env.VOGOBAN_POLICIES || existsSync("vogoban-policies") ? policySet() : undefined);
  const enterpriseModel = (overrides: { repositorySnapshots?: Record<string, string>; metaSnapshot?: string | null } = {}): EnterpriseModel => {
    const repositories = opts.repo ? [catalogRef(opts.repo).repositoryId] : undefined;
    try {
      if (opts.at && !opts.repo) throw new CliError("--at needs --repo");
      const set = snapshotSet(store, { repositories, repositorySnapshots: overrides.repositorySnapshots ?? (opts.at ? { [repositories![0]!]: opts.at } : undefined), metaSnapshot: overrides.metaSnapshot, includeMeta: opts.scope !== "repository" });
      if (!set.repositories.length && !set.meta) throw new Error("no graph snapshots available; analyze a repository first");
      return buildEnterpriseModel(store, set, enterpriseConfig(), optionalPolicies());
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  };
  const enterpriseHeader = (m: EnterpriseModel) => `[snapshots ${m.snapshots.repositories.map((r) => `${r.name}@${r.commit?.slice(0, 8) ?? "-"}`).join(", ")}${m.snapshots.meta ? ` meta ${m.snapshots.meta.metaSnapshot}` : ""}; enterprise metadata ${m.config.file ?? "none"}]`;
  const modelEntity = (m: EnterpriseModel, ref: string) => {
    const direct = m.graph.entities.get(ref);
    if (direct) return direct;
    const lc = ref.toLowerCase();
    const hits = [...m.graph.entities.values()].filter((e) => (e.qualifiedName === ref || e.name.toLowerCase() === lc) && m.ownership.some((o) => o.component.id === e.id) && (!opts.kind || opts.kind.split(",").includes(e.kind)) && (!opts.repo || m.graph.repositoryName(e.repositoryId) === catalogRef(opts.repo).name));
    if (hits.length === 1) return hits[0]!;
    if (!hits.length) return m.graph.entities.get(target(ref).id) ?? (() => { throw new CliError(`'${ref}' is not in the analyzed snapshots`); })();
    throw new CliError(`'${ref}' is ambiguous (${hits.length} components); use an id, --kind or --repo:\n${hits.slice(0, 20).map((h) => `  ${h.id}  ${h.kind} ${h.qualifiedName ?? h.name}  [${m.graph.repositoryName(h.repositoryId) ?? "-"}]`).join("\n")}`);
  };
  const findingRow = (f: SecurityFinding) => ({
    id: f.id, severity: f.severity, category: f.category, state: f.state, environment: f.environment, repository: f.repository, source: f.source.qualifiedName ?? f.source.name, sourceKind: f.source.kind, target: f.target ? (f.target.qualifiedName ?? f.target.name) : null,
    owners: f.owners.join(";"), ownership: f.ownership, snapshots: f.snapshots.join(";"), message: f.message, evidence: f.evidence.join(" | "), path: f.path.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}`).join(" | "), remediation: f.remediation,
  });
  const findingText = (f: SecurityFinding) => [
    `[${f.severity}] ${f.category}${f.state === "UNKNOWN" ? " (state UNKNOWN)" : ""}${f.environment ? `  env=${f.environment}` : ""}  ${f.repository ?? "-"}  (${f.id})`,
    `    ${f.message}`,
    `    owner: ${f.owners.join(", ") || f.ownership}`,
    ...f.evidence.slice(0, 4).map((e) => `    evidence: ${e}`),
    ...f.path.slice(0, 6).map((p, i) => `    ${"  ".repeat(i)}${p.from.kind} ${p.from.qualifiedName ?? p.from.name} -[${p.relationship.type}${p.relationship.scope === "enterprise" ? " derived" : ""}]-> ${p.to.kind} ${p.to.qualifiedName ?? p.to.name}${p.relationship.location ? `  @ ${p.relationship.location}` : ""}`),
    ...(f.remediation ? [`    context: ${f.remediation}`] : []),
  ].join("\n");
  const changeRow = (c: Change) => ({ change: c.kind, id: c.subject.id, kind: c.subject.kind, subject: c.subject.qualifiedName ?? c.subject.name, repository: c.subject.repository, before: c.before, after: c.after, evidence: c.evidence.join(" | ") });
  const changeText = (c: Change) => `  ${c.kind}: ${c.subject.kind} ${c.subject.qualifiedName ?? c.subject.name} [${c.subject.repository ?? "-"}]  ${c.before ?? "(none)"} -> ${c.after ?? "(none)"}${c.evidence.length ? `\n      ${c.evidence.slice(0, 3).join("\n      ")}` : ""}`;
  const enterpriseDiffModels = () => {
    const list = opts.repo ? store.listGraphSnapshots({ scope: "repository", repositoryId: catalogRef(opts.repo).repositoryId }) : [];
    const fromRef = opts.from ?? (opts.repo ? list[list.length - 2]?.id : undefined);
    const toRef = opts.to ?? (opts.repo ? list[list.length - 1]?.id : undefined);
    if (opts.repo && (!fromRef || !toRef)) throw new CliError(`need two snapshots for ${opts.repo}; analyze another commit or pass --from/--to`);
    if ((opts.from || opts.to) && !opts.repo) throw new CliError("--from/--to need --repo");
    const pick = (ref: string | undefined) => (ref && opts.repo ? { [catalogRef(opts.repo).repositoryId]: ref } : undefined);
    const from = enterpriseModel({ repositorySnapshots: pick(fromRef), metaSnapshot: opts["meta-from"] ?? null });
    const to = enterpriseModel({ repositorySnapshots: pick(toRef), metaSnapshot: opts["meta-to"] ?? null });
    const describe = (m: EnterpriseModel) => m.snapshots.repositories.filter((r) => !opts.repo || r.repositoryId === catalogRef(opts.repo).repositoryId).map((r) => `${r.name}@${r.commit?.slice(0, 12) ?? "-"} (${r.snapshot})`).join(", ") + (m.snapshots.meta ? ` meta ${m.snapshots.meta.metaSnapshot}` : "");
    return { from, to, fromLabel: describe(from), toLabel: describe(to) };
  };
  let aiConfigCache: AiConfig | null = null;
  const aiConfig = (): AiConfig => {
    if (aiConfigCache) return aiConfigCache;
    const path = opts["ai-config"] ?? process.env.VOGOBAN_AI ?? (existsSync("vogoban-ai.yaml") ? "vogoban-ai.yaml" : null);
    try {
      aiConfigCache = loadAiConfig(path);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
    return aiConfigCache;
  };
  const dbDir = dirname(opts.db ?? process.env.VOGOBAN_DB ?? ".vogoban/graph.db");
  const aiAccess = () => {
    const cfg = aiConfig();
    const repositories = opts.repo ? opts.repo.split(",").map((r) => catalogRef(r.trim()).repositoryId) : null;
    if (opts.at && repositories?.length !== 1) throw new CliError("--at needs exactly one --repo");
    const scope = (opts.scope ?? "all") as AnalysisScope;
    if (!["repository", "meta", "all"].includes(scope)) throw new CliError("--scope must be repository, meta or all");
    const bounded = (v: string | undefined, fallback: number, cap: number, name: string) => {
      const n = intOpt(v, fallback);
      if (!Number.isFinite(n) || n < 1) throw new CliError(`--${name} must be a positive integer`);
      if (n > cap) throw new CliError(`--${name} cannot exceed ${cap}`);
      return n;
    };
    const limits = {
      ...DEFAULT_LIMITS,
      maxDepth: bounded(opts.depth, DEFAULT_LIMITS.maxDepth, LIMIT_CAPS.maxDepth, "depth"),
      maxResults: bounded(opts.limit, DEFAULT_LIMITS.maxResults, LIMIT_CAPS.maxResults, "limit"),
      maxNodes: bounded(opts["max-nodes"], DEFAULT_LIMITS.maxNodes, LIMIT_CAPS.maxNodes, "max-nodes"),
      maxEvidence: bounded(opts["max-evidence"], DEFAULT_LIMITS.maxEvidence, LIMIT_CAPS.maxEvidence, "max-evidence"),
      maxContextTokens: cfg.contextTokens,
    };
    const policyPaths = opts.policy || process.env.VOGOBAN_POLICIES || existsSync("vogoban-policies") ? (opts.policy ?? process.env.VOGOBAN_POLICIES ?? "vogoban-policies").split(",").map((p) => p.trim()).filter(Boolean) : null;
    const requested = opts.enterprise ?? process.env.VOGOBAN_ENTERPRISE ?? (existsSync("vogoban-enterprise.yaml") ? "vogoban-enterprise.yaml" : null);
    try {
      return new GraphAccess(readOnlyStore(store), { graph: scope, repositories, environment: opts.env?.toLowerCase() ?? null, snapshots: { repositories: opts.at ? { [repositories![0]!]: opts.at } : {}, meta: null } }, limits, { policyPaths, enterprisePath: requested === "none" ? null : requested, aliases: cfg.aliases });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error));
    }
  };
  const aiRequest = (access: GraphAccess, question: string, conversation: AiRequest["conversation"]): AiRequest => {
    if (opts.llm && opts["no-llm"]) throw new CliError("--llm and --no-llm are mutually exclusive");
    return { question, scope: access.scope, limits: access.limits, conversation, llm: opts["no-llm"] ? "off" : opts.llm ? "required" : "auto", llmPlanning: opts["llm-plan"] || aiConfig().planner === "llm" };
  };
  const auditPath = join(dbDir, "ai-audit.jsonl");
  const runAsk = async (question: string, explicit?: (access: GraphAccess) => ReturnType<typeof explicitPlan>) => {
    if (!question.trim()) throw new CliError("a question is required");
    if (question.length > 2000) throw new CliError("questions are limited to 2000 characters");
    if (!opts["no-llm"]) {
      const dest = aiDestination(aiConfig());
      if (dest.external) console.error(`AI destination: ${dest.label}. Local graph evidence within the requested scope will be sent to this provider. Use --no-llm for a deterministic answer with no external call.`);
      else if (dest.kind === "local-model") console.error(`AI destination: ${dest.label}; no data leaves this machine.`);
    }
    const access = aiAccess();
    const session = opts.session ? sessionPath(join(dbDir, "ai-sessions"), opts.session) : null;
    const turns = session ? loadSession(session) : [];
    const answer = await ask(access, aiRequest(access, question, turns), { config: aiConfig(), auditPath }, explicit?.(access));
    if (session) saveSession(session, turns, answer);
    output(() => answerText(answer, { evidence: opts.evidence, plan: opts.plan }), answer);
    if (["AMBIGUOUS", "NOT_FOUND", "REJECTED_PLAN", "OUT_OF_SCOPE", "ERROR", "UNSUPPORTED"].includes(answer.status)) process.exitCode = 3;
  };
  try {
    switch (command) {
      case "ask":
      case "ai":
      case "ai-query":
        await runAsk(args.join(" "));
        break;
      case "explain": {
        const what = args[0];
        const refs = args.slice(1);
        const single = (kinds: EntityKind[] | null, steps: PlanStep[]) => {
          if (refs.length !== 1) throw new CliError(`explain ${what} needs one reference`);
          return runAsk(`Explain ${what} ${refs[0]}`, (access) => explicitPlan(access, `Explain ${what} ${refs[0]}`, [{ text: refs[0]!, kinds }], steps));
        };
        const pair = (steps: PlanStep[]) => {
          if (refs.length !== 2) throw new CliError(`explain ${what} needs <from> <to>`);
          return runAsk(`Explain the ${what} from ${refs[0]} to ${refs[1]}`, (access) => explicitPlan(access, `Explain the ${what} from ${refs[0]} to ${refs[1]}`, [{ text: refs[0]!, kinds: null }, { text: refs[1]!, kinds: null }], steps));
        };
        const id = (tool: string, purpose: string) => {
          if (refs.length !== 1) throw new CliError(`explain ${what} needs an id`);
          return runAsk(`Explain ${what} ${refs[0]}`, (access) => ({ ...explicitPlan(access, `Explain ${what} ${refs[0]}`, [], [{ tool, args: { id: refs[0] }, purpose }]) }));
        };
        switch (what) {
          case "service": await single(["Application"], [{ tool: "summarize_entity", args: { entity: "$0" }, purpose: "service summary from graph facts" }, { tool: "get_deployments", args: { entity: "$0" }, purpose: "how it is deployed" }]); break;
          case "repository": await single(["Repository"], [{ tool: "summarize_entity", args: { entity: "$0" }, purpose: "repository summary" }, { tool: "get_repository_dependencies", args: { repository: refs[0], direction: "upstream" }, purpose: "dependent repositories" }]); break;
          case "api": await single(["Api", "ApiOperation"], [{ tool: "summarize_entity", args: { entity: "$0" }, purpose: "API summary" }, { tool: "get_api_consumers", args: { api: "$0" }, purpose: "consumers" }]); break;
          case "message": await single(["Message", "SharedContract"], [{ tool: "summarize_entity", args: { entity: "$0" }, purpose: "message producers, consumers and transports" }]); break;
          case "deployment": await single(["Application", "Repository"], [{ tool: "get_deployments", args: { entity: "$0" }, purpose: "declared deployment topology" }]); break;
          case "entity": await single(null, [{ tool: "summarize_entity", args: { entity: "$0" }, purpose: "architecture summary" }]); break;
          case "path": await pair([{ tool: "find_paths", args: { from: "$0", to: "$1", limit: 3 }, purpose: "relationship paths" }]); break;
          case "dependency": await pair([{ tool: "find_paths", args: { from: "$0", to: "$1", direction: "forward", limit: 3 }, purpose: "why the dependency exists" }, { tool: "get_governance_violations", args: { entity: "$0", target: "$1" }, purpose: "rules that govern it" }]); break;
          case "violation": await id("get_governance_violations", "the violation with its rule, path, exception and baseline"); break;
          case "finding": await id("get_security_findings", "the finding with its evidence and path"); break;
          default: throw new CliError("explain service|repository|api|message|deployment|entity <ref> | explain path|dependency <from> <to> | explain violation|finding <id>");
        }
        break;
      }
      case "ai-plan": {
        const question = args.join(" ");
        if (!question.trim()) throw new CliError("ai-plan requires a question");
        const access = aiAccess();
        const turns = opts.session ? loadSession(sessionPath(join(dbDir, "ai-sessions"), opts.session)) : [];
        const plan = planQuestion(access, question, turns);
        const validation = validatePlan(plan, access);
        output(() => planText(plan, validation), { plan, validation });
        break;
      }
      case "ai-tools":
      case "mcp-tools": {
        const list = toolCatalog().filter((t) => !args[0] || t.name === args[0]);
        if (args[0] && !list.length) throw new CliError(`unknown tool ${args[0]}`);
        output(() => (args[0] ? JSON.stringify(list[0], null, 2) : table(list.map((t) => [t.name, Object.keys(t.inputSchema.properties).map((k) => `${k}${t.inputSchema.required.includes(k) ? "*" : ""}`).join(","), t.description.slice(0, 90)]), ["tool (all read-only)", "input (* required)", "description"])), list);
        break;
      }
      case "ai-tool": {
        if (!args[0]) throw new CliError("ai-tool requires a tool name (see ai-tools)");
        let input: unknown = {};
        if (args[1]) {
          try {
            input = JSON.parse(args.slice(1).join(" "));
          } catch {
            throw new CliError("tool input must be a JSON object");
          }
        }
        const r = runTool(aiAccess(), args[0], input);
        output(() => [`${r.tool} -> ${r.status}${r.error ? `: ${r.error}` : ""}`, ...r.summary, ...(r.unknowns.length ? ["Unknowns:", ...r.unknowns.map((u) => `  - ${u}`)] : []), ...(r.evidence.length ? [`Evidence (${r.evidence.length}):`, ...r.evidence.slice(0, opts.evidence ? undefined : 15).map((e) => `  ${e.status.padEnd(9)} ${e.fact}${e.location ? `  @ ${e.location}` : ""}`)] : []), ...(r.truncated ? ["(truncated by limits)"] : [])].join("\n"), r);
        if (["ERROR", "AMBIGUOUS", "NOT_FOUND", "OUT_OF_SCOPE"].includes(r.status)) process.exitCode = 3;
        break;
      }
      case "privacy":
      case "diagnostics": {
        const cfg = aiConfig();
        const d = aiDestination(cfg);
        const mode = (opts.mode ?? process.env.VOGOBAN_MODE ?? "LOCAL").toUpperCase();
        const offline = process.env.VOGOBAN_OFFLINE === "1";
        const dbPath = opts.db ?? process.env.VOGOBAN_DB ?? ".vogoban/graph.db";
        const remoteHost = (u: string | null | undefined) => {
          if (!u) return "(local path only)";
          const m = u.replace(/^git@([^:]+):/, "$1/").match(/^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i);
          return m ? m[1]! : "(local path only)";
        };
        const gitRemotes = store.listRepositories().map((r) => ({ repository: r.name, remote: remoteHost(r.remoteUrl) })).slice(0, 50);
        const report = {
          mode,
          offline,
          telemetry: { enabled: false, note: "the local CLI and local MCP send no telemetry, analytics, usage, crash reports, or heartbeats; there is no vendor endpoint in the binary" },
          phoneHome: { enabled: false, updateChecks: false, crashReporting: false, licenseHeartbeat: false },
          storage: { kind: dbPath.startsWith("postgres") ? "postgres" : "local sqlite", location: dbPath, note: "architecture graph stays on this machine" },
          ai: { configured: cfg.provider !== "none", provider: cfg.provider, model: cfg.model, destination: d.kind, destinationLabel: d.label, external: d.external, sendsGraphContext: d.external, credentialRef: cfg.apiKeyEnv },
          mcp: { mode: "local stdio (bun src/cli/main.ts mcp)", vendorDependency: false, note: "runs against the local graph; no network required" },
          git: { analysisReads: "local checkout only", remotesConfigured: gitRemotes },
          hosted: { enabled: mode === "HOSTED", endpoint: mode === "HOSTED" ? (process.env.VOGOBAN_HOSTED_ENDPOINT ?? null) : null, note: mode === "LOCAL" ? "hosted platform is not used; no data leaves this machine" : mode === "SELF_HOSTED" ? "you run the platform; data stays on your infrastructure" : "explicitly using a configured hosted platform" },
          outboundNetwork: [
            cfg.provider !== "none" ? `AI provider (${d.label})${d.external ? "" : " — local, no egress"}` : null,
            mode === "HOSTED" ? "configured hosted platform endpoint" : null,
          ].filter(Boolean),
        };
        output(() => [
          `Operating mode: ${mode}${offline ? " (OFFLINE: external AI endpoints are refused)" : ""}`,
          `Telemetry: OFF (none implemented; no vendor endpoint exists in this product)`,
          `Phone-home: none  ·  update checks: none  ·  crash reporting: none  ·  license heartbeat: none`,
          `Storage: ${report.storage.kind} at ${report.storage.location} (architecture data stays local)`,
          `AI: ${cfg.provider === "none" ? "not configured (deterministic answers only; no external calls)" : d.label}${d.external ? "  [graph evidence is sent here when you run ask/explain without --no-llm]" : ""}`,
          `MCP: ${report.mcp.mode} — no vendor dependency`,
          `Git: analysis reads the local checkout only. Configured remotes: ${gitRemotes.map((g) => g.remote).join(", ") || "none"}`,
          `Hosted platform: ${report.hosted.enabled ? report.hosted.endpoint ?? "(endpoint not set)" : "disabled"} — ${report.hosted.note}`,
          `Outbound network for this configuration: ${report.outboundNetwork.length ? report.outboundNetwork.join("; ") : "none"}`,
        ].join("\n"), report);
        break;
      }
      case "ai-config": {
        const d = describeConfig(aiConfig());
        output(() => [`provider ${d.provider}  destination ${d.destination.label}${d.model ? `  model ${d.model}` : ""}${d.endpoint ? `  endpoint ${d.endpoint}` : ""}${d.apiVersion ? `  api-version ${d.apiVersion}` : ""}`, `credential ${d.credential ? `from $${d.credential.env} (${d.credential.present ? "set" : "NOT set"})` : "none"}`, `temperature ${d.temperature}  max output tokens ${d.maxOutputTokens}  context tokens ${d.contextTokens}  timeout ${d.timeoutMs} ms  retries ${d.retries}  planner ${d.planner}  audit ${d.audit}  aliases ${d.aliases}`, `config file ${d.file ?? "(none)"}`, ...d.errors.map((e) => `error: ${e}`)].join("\n"), d);
        if (d.errors.length) process.exitCode = 2;
        break;
      }
      case "ai-audit": {
        const records = readAudit(auditPath);
        if (args[0]) {
          const r = records.find((x) => x.id === args[0]);
          if (!r) throw new CliError(`no AI record ${args[0]} in ${auditPath}`);
          output(() => [
            `${r.id}  ${r.at}  ${r.status}  ${r.mode}`, `question: ${r.question}`,
            `scope: graph=${r.scope.graph} repositories=${r.scope.repositories?.join(",") ?? "all"} environment=${r.scope.environment ?? "-"}`,
            `graph: ${r.graph?.repositories.map((x) => `${x.name}@${x.commit?.slice(0, 12) ?? "-"}/${x.graphVersion?.slice(0, 12) ?? "-"} ${x.status}`).join(", ") ?? "-"}  meta ${r.graph?.metaSnapshot ?? "-"}`,
            `plan: ${r.plan.intent} (${r.plan.source}, ${r.plan.valid ? "valid" : `rejected: ${r.plan.errors.join("; ")}`})`,
            ...r.plan.mentions.map((m) => `  entity '${m.text}' -> ${m.status} ${m.entity ?? ""} ${m.method ?? ""}`),
            ...r.plan.steps.map((s, i) => `  ${i + 1}. ${s.tool} ${JSON.stringify(s.args)}`),
            `tools: ${r.tools.map((t) => `${t.tool}=${t.status}(${t.evidence})`).join(", ") || "-"}`,
            `evidence: ${r.evidence.length} items  ${r.evidence.slice(0, 20).map((e) => `${e.id}:${e.relationship ?? e.key.slice(0, 40)}`).join(" ")}`,
            `llm: ${r.llm ? `${r.llm.provider}/${r.llm.model} calls=${r.llm.calls}${r.llm.error ? ` error=${r.llm.error}` : ""}` : "none"}`,
            `answer:\n${r.answer}`,
          ].join("\n"), r);
          break;
        }
        const recent = records.slice(-intOpt(opts.limit, 20));
        output(() => (recent.length ? table(recent.map((r) => [r.id, r.at, r.status, r.mode, r.plan.intent, r.tools.map((t) => t.tool).join(","), r.question.slice(0, 60)]), ["record", "at", "status", "mode", "intent", "tools", "question"]) : `No AI records in ${auditPath}.`), recent);
        break;
      }
      case "mcp": {
        const version = (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;
        aiAccess();
        console.error(`vogoban MCP server ${version} on stdio (read-only; scope repositories=${opts.repo ?? "all"} environment=${opts.env ?? "all"} graph=${opts.scope ?? "all"})`);
        await new McpServer(aiAccess, version).serve();
        break;
      }
      case "analyze": {
        const path = args[0] ?? ".";
        const { run, repositoryId } = await analyzeRepository(path, store, defaultPlugins(), { semantic: !opts["no-semantic"] }, log);
        const stats = store.stats(repositoryId);
        const failedPlugins = [...new Set(store.findDiagnostics({ repositoryId, limit: 100000 }).filter((d) => d.code === "plugin-failed").map((d) => d.plugin))];
        if (failedPlugins.length) console.error(`WARNING: graph is degraded; plugin(s) failed: ${failedPlugins.join(", ")} (see 'diagnostics')`);
        output(
          () => [
            `Analyzed ${store.getRepository(repositoryId)?.name} @ ${run.commit?.slice(0, 12) ?? "(no commit)"} in ${run.stats.durationMs} ms`,
            table(summary(stats).map(([k, v]) => [k, v]), ["", "count"]),
            `evidence: ${Object.entries(stats.relationshipsByEvidence).map(([k, n]) => `${k}=${n}`).join(" ")}`,
            `unresolved: ${Object.entries(stats.unresolvedByCategory).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
            "",
            table(appQuery.statistics(repositoryId).map(([k, v]) => [k, v]), ["application graph", "count"]),
            "",
            table(contractQuery.statistics(repositoryId).map(([k, v]) => [k, v]), ["contract graph", "count"]),
            "",
            table(infraQuery.statistics(repositoryId).map(([k, v]) => [k, v]), ["infrastructure graph (declared)", "count"]),
          ].join("\n"),
          { run, summary: Object.fromEntries(summary(stats).map(([k, v]) => [k.trim(), v])), applicationGraph: Object.fromEntries(appQuery.statistics(repositoryId).map(([k, v]) => [k.trim(), v])), infrastructureGraph: Object.fromEntries(infraQuery.statistics(repositoryId).map(([k, v]) => [k.trim(), v])), stats },
        );
        break;
      }
      case "repos": {
        const repos = store.listRepositories();
        output(() => table(repos.map((r) => [r.id, r.name, r.branch ?? "", r.commit?.slice(0, 12) ?? "", r.rootPath]), ["id", "name", "branch", "commit", "root"]), repos);
        break;
      }
      case "repo": {
        const id = repoId(store, args[0]);
        if (!id) throw new CliError("specify a repository (multiple in store)");
        const repo = store.getRepository(id)!;
        const runs = store.listRuns(id);
        output(() => [
          `${repo.name} (${repo.id})`, `  root    ${repo.rootPath}`, `  remote  ${repo.remoteUrl ?? "-"}`, `  branch  ${repo.branch ?? "-"}`,
          `  commit  ${repo.commit ?? "-"}${repo.dirty ? " (dirty)" : ""}`, `  runs:`,
          ...runs.slice(0, 10).map((r) => `    ${r.startedAt}  ${r.commit?.slice(0, 12) ?? ""}  entities=${r.stats.entities} rels=${r.stats.relationships} ${r.stats.durationMs}ms`),
        ].join("\n"), { repository: repo, runs });
        break;
      }
      case "stats": {
        const id = repoId(store);
        const stats = store.stats(id);
        output(() => [
          "Summary", table(summary(stats).map(([k, v]) => [k, v]), ["", "count"]), "",
          "Application graph", table(appQuery.statistics(id).map(([k, v]) => [k, v]), ["", "count"]), "",
          "Contract graph", table(contractQuery.statistics(id).map(([k, v]) => [k, v]), ["", "count"]), "",
          "Infrastructure graph (declared)", table(infraQuery.statistics(id).map(([k, v]) => [k, v]), ["", "count"]), "",
          "Entities", table(Object.entries(stats.entitiesByKind).map(([k, n]) => [k, n]), ["kind", "count"]), "",
          "Relationships", table(Object.entries(stats.relationshipsByType).map(([k, n]) => [k, n]), ["type", "count"]), "",
          "Evidence", table(Object.entries(stats.relationshipsByEvidence).map(([k, n]) => [k, n]), ["level", "count"]), "",
          "Unresolved", table(Object.entries(stats.unresolvedByCategory).map(([k, n]) => [k, n]), ["category", "count"]), "",
          "Diagnostics", table(Object.entries(stats.diagnosticsByCategory).map(([k, n]) => [k, n]), ["category", "count"]), "",
          `files=${stats.files} unresolved=${stats.unresolved} diagnostics=${stats.diagnostics} conflicts=${stats.conflicts}`,
        ].join("\n"), stats);
        break;
      }
      case "find": {
        if (!args[0]) throw new CliError("find requires search text");
        const found = query.find({ nameLike: args[0], kinds: kinds(), repositoryId: repoId(store), limit: intOpt(opts.limit, 50) });
        output(() => table(found.map((e) => [e.id, label(e), where(e)]), ["id", "entity", "location"]), found);
        break;
      }
      case "show": {
        const entity = one(query, args[0], store);
        const outgoing = query.outgoing(entity.id, types());
        const incoming = query.incoming(entity.id, types());
        const related = new Map(query.find({ ids: [...new Set([...outgoing.map((r) => r.targetId), ...incoming.map((r) => r.sourceId)])] }).map((e) => [e.id, e]));
        const unresolved = store.findUnresolved({ sourceIds: [entity.id] });
        const limit = intOpt(opts.limit, 200);
        output(() => [
          label(entity),
          `  id         ${entity.id}`,
          `  symbol     ${entity.symbolKey ?? "-"}`,
          `  repository ${entity.repositoryId ?? "(external)"}`,
          `  project    ${entity.projectId ? label(store.getEntity(entity.projectId)) : "-"}`,
          `  assembly   ${entity.assembly ?? "-"}`,
          `  location   ${where(entity) || "-"}`,
          `  metadata   ${JSON.stringify(entity.metadata)}`,
          "",
          `Outgoing (${outgoing.length})`, ...outgoing.slice(0, limit).map((r) => `  ${relLine(r, related.get(r.targetId), "out")}`),
          "",
          `Incoming (${incoming.length})`, ...incoming.slice(0, limit).map((r) => `  ${relLine(r, related.get(r.sourceId), "in")}`),
          ...(unresolved.length ? ["", `Unresolved (${unresolved.length})`, ...unresolved.slice(0, limit).map((u) => `  -[${u.type}]-> ? ${u.targetDisplay}  (${u.reason})`)] : []),
        ].join("\n"), { entity, outgoing, incoming, unresolved, related: [...related.values()] });
        break;
      }
      case "deps":
      case "callers":
      case "callees": {
        const entity = one(query, args[0], store);
        const depth = intOpt(opts.depth, 1);
        const steps = command === "callers" ? query.callers(entity.id, depth, opts.dispatch) : command === "callees" ? query.callees(entity.id, depth) : query.dependencies(entity.id, { reverse: opts.reverse, depth, types: types() });
        output(() => `${tree(steps)}\n(${steps.length - 1} ${command === "deps" ? (opts.reverse ? "dependents" : "dependencies") : command})`, steps.map((s) => ({ depth: s.depth, entity: s.entity, via: s.via, parentId: s.parentId })));
        break;
      }
      case "implementations": {
        const entity = one(query, args[0], store);
        const steps = query.implementations(entity.id);
        const registered = appQuery.registeredImplementations(entity.id);
        output(() => [
          `${tree(steps)}\n(${steps.length - 1} implementations/derivations)`,
          ...(registered.length ? ["", "Registered via dependency injection", ...registered.map((r) => `  -> ${label(r.implementation)}  (${r.relationship.metadata.lifetime}${r.relationship.metadata.keyed ? `, key=${r.relationship.metadata.key}` : ""}, ${r.relationship.evidence}) @ ${r.registration ? where(r.registration) : "-"}`)] : []),
        ].join("\n"), { implementations: steps.map((s) => ({ depth: s.depth, entity: s.entity, via: s.via })), registered });
        break;
      }
      case "inheritance": {
        const entity = one(query, args[0], store);
        const { ancestors, descendants } = query.inheritance(entity.id);
        output(() => ["Ancestors", tree(ancestors), "", "Descendants", tree(descendants)].join("\n"), {
          ancestors: ancestors.map((s) => ({ depth: s.depth, entity: s.entity, via: s.via })),
          descendants: descendants.map((s) => ({ depth: s.depth, entity: s.entity, via: s.via })),
        });
        break;
      }
      case "references": {
        const entity = one(query, args[0], store);
        const refs = query.references(entity.id, types());
        const limit = intOpt(opts.limit, 200);
        output(() => [
          `${label(entity)}  (${refs.length} referencing facts)`,
          ...refs.slice(0, limit).map(({ relationship: r, source }) => {
            const locs = r.provenance.map((p) => (p.location ? `${p.location.file}:${p.location.startLine}` : "")).filter(Boolean);
            return `  ${r.type.padEnd(16)} ${label(source)}  ${locs.slice(0, 3).join(", ")}${locs.length > 3 ? ` (+${locs.length - 3})` : ""}`;
          }),
        ].join("\n"), refs);
        break;
      }
      case "project": {
        const entity = one(query, args[0], store);
        if (entity.kind !== "Project") throw new CliError(`${label(entity)} is not a project`);
        const out = query.outgoing(entity.id);
        const incoming = query.incoming(entity.id, ["PROJECT_REFERENCES"]);
        const related = new Map(query.find({ ids: [...new Set([...out.map((r) => r.targetId), ...incoming.map((r) => r.sourceId)])] }).map((e) => [e.id, e]));
        const pick = (type: string) => out.filter((r) => r.type === type).map((r) => ({ rel: r, entity: related.get(r.targetId) }));
        const m = entity.metadata;
        const namespaces = pick("CONTAINS").filter((x) => x.entity?.kind === "Namespace").length;
        const types = query.find({ projectId: entity.id, kinds: ["Type"] }).length;
        output(() => [
          `${entity.name}  (${entity.qualifiedName})`,
          `  assembly          ${pick("DEFINES_ASSEMBLY").map((x) => x.entity?.name).join(", ") || "-"}  [${m.outputType}]`,
          `  target frameworks ${(m.targetFrameworks as string[] | undefined)?.join(", ") || "-"}`,
          `  semantic context  ${(m.referencePacks as string[] | undefined)?.join("; ") || "not analyzed"}`,
          `  compilation       errors=${m.compilerErrors ?? "-"} warnings=${m.compilerWarnings ?? "-"}`,
          `  contents          ${namespaces} namespaces, ${types} types, ${m.sourceFiles} source files`,
          `  project refs      ${pick("PROJECT_REFERENCES").map((x) => x.entity?.name).join(", ") || "-"}`,
          `  referenced by     ${incoming.map((r) => related.get(r.sourceId)?.name).join(", ") || "-"}`,
          `  packages          ${pick("PACKAGE_DEPENDS_ON").filter((x) => x.rel.metadata.direct).map((x) => `${x.entity?.name}@${x.rel.metadata.version ?? "?"}`).join(", ") || "-"}`,
          `  assemblies used   ${pick("ASSEMBLY_REFERENCES").map((x) => `${x.entity?.name}(${x.rel.metadata.source ?? "declared"})`).join(", ") || "-"}`,
        ].join("\n"), { project: entity, relationships: out, referencedBy: incoming });
        break;
      }
      case "apis": {
        const rows = contractQuery.apis(repoId(store));
        output(() => table(rows.map((r) => [r.api.qualifiedName ?? r.api.name, String(r.api.metadata.contractSource), r.operations, r.api.id]), ["api", "source", "operations", "id"]), rows);
        break;
      }
      case "api": {
        const api = store.getEntity(args[0] ?? "") ?? query.find({ kinds: ["Api"], repositoryId: repoId(store) }).find((a) => a.name === args[0] || a.qualifiedName === args[0]);
        if (!api || api.kind !== "Api") throw new CliError(`no API matches '${args[0] ?? ""}'`);
        const ops = query.outgoing(api.id, ["CONTAINS"]).map((r) => store.getEntity(r.targetId)).filter((e): e is Entity => e?.kind === "ApiOperation");
        output(() => [`${api.qualifiedName}  (${api.metadata.contractSource})`, `  servers: ${(api.metadata.servers as string[] | undefined)?.join(", ") || "-"}`, table(ops.map((o) => [String(o.metadata.method), String(o.metadata.path), String(o.metadata.version ?? "-"), String(o.metadata.operationId ?? "-"), String(o.metadata.implementationStatus), o.id]), ["method", "path", "version", "operationId", "implementation", "id"])].join("\n"), { api, operations: ops });
        break;
      }
      case "operations": {
        const ops = contractQuery.operations({ repositoryId: repoId(store), method: opts.method, path: opts.path ?? args[0], source: opts.source });
        output(() => table(ops.map((o) => [String(o.metadata.method), String(o.metadata.path), String(o.metadata.version ?? "-"), String(o.metadata.contractSource), String(o.metadata.implementationStatus), (o.qualifiedName ?? "").split(":")[0]!, o.id]), ["method", "path", "version", "source", "implementation", "api", "id"]), ops);
        break;
      }
      case "operation": {
        if (!args[0]) throw new CliError("operation requires an id or \"VERB /path\"");
        const direct = store.getEntity(args[0]);
        const [verb, path] = args[0].includes(" ") ? args[0].split(/\s+/, 2) : [undefined, args[0]];
        const candidates = direct ? [direct] : contractQuery.operations({ repositoryId: repoId(store) }).filter((o) => String(o.metadata.path).toLowerCase() === path!.toLowerCase() && (!verb || String(o.metadata.method) === verb.toUpperCase()));
        if (!candidates.length) throw new CliError(`no operation matches '${args[0]}'`);
        const details = candidates.map((c) => contractQuery.operation(c.id)!).filter(Boolean);
        output(() => details.map((d) => {
          const m = d.operation.metadata;
          return [
            `${d.operation.qualifiedName}  [${m.contractSource}]`,
            `  id              ${d.operation.id}`,
            `  location        ${where(d.operation)}`,
            `  operationId     ${m.operationId ?? "-"}   version ${m.version ?? "-"}   implementation ${m.implementationStatus}`,
            `  parameters      ${(m.parameters as string[]).join(", ") || "-"}`,
            `  security        ${(m.security as string[]).join(", ") || "-"}`,
            `  request         ${d.requests.map((r) => `${label(r.schema)}${r.relationship.metadata.contentType ? ` (${r.relationship.metadata.contentType})` : ""}`).join(", ") || "-"}`,
            `  responses       ${d.responses.map((r) => `${r.relationship.metadata.status ? `${r.relationship.metadata.status} ` : ""}${label(r.schema)}`).join(", ") || "-"}`,
            `  implemented by  ${d.implementations.map((e) => `${e.name} (${where(e)})`).join(", ") || "-"}`,
            `  called by       ${d.consumers.map((c) => `${c.caller.qualifiedName} [${c.relationship.evidence}]`).join(", ") || "-"}`,
            ...(d.unresolved.length ? [`  unresolved      ${d.unresolved.map((u) => `${u.type}: ${u.reason}`).join("; ")}`] : []),
          ].join("\n");
        }).join("\n\n"), details);
        break;
      }
      case "openapi": {
        const docs = query.find({ kinds: ["ContractDocument"], repositoryId: repoId(store) });
        output(() => (docs.length ? table(docs.map((d) => [d.qualifiedName ?? d.name, String(d.metadata.specVersion ?? "-"), String(d.metadata.title ?? "-"), String(d.metadata.version ?? "-"), String(d.metadata.status), Number(d.metadata.operations), Number(d.metadata.schemas), Number(d.metadata.issues)]), ["document", "spec", "title", "version", "status", "operations", "schemas", "issues"]) : "No OpenAPI documents found."), docs);
        break;
      }
      case "contracts": {
        const kinds: Entity["kind"][] = ["ContractDocument", "Api", "ApiSchema", "Message", "Topic", "Queue", "ExternalApi"];
        const list = query.find({ kinds, repositoryId: repoId(store) }).concat(repoId(store) ? query.find({ kinds: ["ExternalApi"] }) : []);
        const unique = [...new Map(list.map((e) => [e.id, e])).values()];
        output(() => table(unique.map((e) => [e.kind, e.qualifiedName ?? e.name, where(e), e.id]), ["kind", "contract", "location", "id"]), unique);
        break;
      }
      case "contract": {
        const entity = store.getEntity(args[0] ?? "") ?? one(query, args[0], store);
        const outgoing = query.outgoing(entity.id);
        const incoming = query.incoming(entity.id);
        const related = new Map(query.find({ ids: [...outgoing.map((r) => r.targetId), ...incoming.map((r) => r.sourceId)] }).map((e) => [e.id, e]));
        output(() => [label(entity), `  id        ${entity.id}`, `  location  ${where(entity) || "-"}`, `  metadata  ${JSON.stringify(entity.metadata)}`,
          ...outgoing.map((r) => `  ${relLine(r, related.get(r.targetId), "out")}`), ...incoming.map((r) => `  ${relLine(r, related.get(r.sourceId), "in")}`)].join("\n"), { entity, outgoing, incoming });
        break;
      }
      case "messages": {
        const list = contractQuery.messages(repoId(store));
        output(() => table(list.map((m) => [m.message.qualifiedName ?? m.message.name, (m.message.metadata.frameworks as string[] | undefined)?.join(",") ?? "-", (m.message.metadata.dispatch as string[] | undefined)?.join(",") ?? "-", m.publishers.length, m.consumers.map((c) => c.consumer.name).join(", ") || "-", m.transports.map((t) => t.transport.name).join(", ") || "-"]), ["message", "frameworks", "dispatch", "publishers", "consumers", "transports"]), list);
        break;
      }
      case "message": {
        const target = store.getEntity(args[0] ?? "") ?? query.find({ kinds: ["Message"], repositoryId: repoId(store) }).find((m) => m.name === args[0] || m.qualifiedName === args[0]);
        const d = target ? contractQuery.message(target.id) : null;
        if (!d) throw new CliError(`no message contract matches '${args[0] ?? ""}'`);
        const m = d.message.metadata;
        output(() => [
          `${d.message.qualifiedName}  (${(m.frameworks as string[]).join(", ")}; ${(m.dispatch as string[]).join(", ")})`,
          `  id          ${d.message.id}`,
          `  declared    ${where(d.message) || String(m.contractDeclaredIn)}   version ${m.version ?? "-"}`,
          `  schema      ${d.schemaType ? label(d.schemaType) : "-"}`,
          `  fields      ${(m.fields as string[]).join(", ") || "-"}`,
          `  publishers  ${d.publishers.map((p) => `${p.publisher.qualifiedName} [${p.relationship.metadata.operation}, ${p.relationship.evidence}]`).join("; ") || "-"}`,
          `  consumers   ${d.consumers.map((c) => `${c.consumer.qualifiedName} [${c.relationship.type}, ${c.relationship.evidence}]`).join("; ") || "-"}`,
          `  transports  ${d.transports.map((t) => `${t.transport.qualifiedName} [${t.relationship.evidence}]`).join("; ") || "-"}`,
        ].join("\n"), d);
        break;
      }
      case "publishers":
      case "consumers": {
        const list = contractQuery.messages(repoId(store)).filter((m) => !opts.message || (m.message.qualifiedName ?? "").toLowerCase().includes(opts.message.toLowerCase()));
        const rows = list.flatMap((m) => command === "publishers"
          ? m.publishers.map((p) => [p.publisher.qualifiedName ?? p.publisher.name, m.message.name, String(p.relationship.metadata.framework), String(p.relationship.metadata.operation ?? "-"), p.relationship.evidence, p.relationship.provenance[0]?.location ? `${p.relationship.provenance[0].location.file}:${p.relationship.provenance[0].location.startLine}` : ""])
          : m.consumers.map((c) => [c.consumer.qualifiedName ?? c.consumer.name, m.message.name, String(c.relationship.metadata.framework), c.relationship.type, c.relationship.evidence, where(c.consumer)]));
        output(() => table(rows, [command === "publishers" ? "publisher" : "consumer", "message", "framework", command === "publishers" ? "operation" : "relationship", "evidence", "location"]), rows);
        break;
      }
      case "transports": {
        const list = contractQuery.transports(repoId(store));
        output(() => (list.length ? table(list.map((t) => [t.transport.qualifiedName ?? t.transport.name, t.senders.map((s) => s.name).join(", ") || "-", t.receivers.map((r) => r.qualifiedName ?? r.name).join(", ") || "-", t.messages.map((m) => m.name).join(", ") || "-", t.routes.map((r) => r.name).join(", ") || "-"]), ["transport", "senders", "receivers", "carries", "routes to"]) : "No transports detected."), list);
        break;
      }
      case "http-clients": {
        const id = repoId(store);
        const clients = contractQuery.httpClients(id);
        const calls = contractQuery.httpCalls(id);
        const loc = (r: { provenance: { location: { file: string; startLine: number } | null }[] }) => (r.provenance[0]?.location ? `${r.provenance[0].location.file}:${r.provenance[0].location.startLine}` : "");
        output(() => [
          "Clients",
          table(clients.map((c) => [c.client.name, String(c.client.metadata.clientKind), String(c.client.metadata.baseAddress ?? (c.client.metadata.baseConfigurationKey ? `config:${c.client.metadata.baseConfigurationKey}` : "-")), c.users.length, where(c.client)]), ["client", "kind", "base address", "callers", "registered"]),
          "",
          "Calls",
          table([
            ...calls.resolved.map((r) => [String(r.metadata.verb), String(r.metadata.url), `-> ${calls.entities.get(r.targetId)?.qualifiedName ?? r.targetId}`, r.evidence, calls.entities.get(r.sourceId)?.name ?? "", loc(r)]),
            ...calls.external.map((r) => [String(r.metadata.verb), String(r.metadata.url), `-> external ${calls.entities.get(r.targetId)?.name}`, r.evidence, calls.entities.get(r.sourceId)?.name ?? "", loc(r)]),
            ...calls.unresolved.map((u) => [String(u.metadata.verb ?? "?"), String(u.metadata.url ?? "-"), `unresolved: ${u.metadata.category}`, "-", calls.entities.get(u.sourceId)?.name ?? "", loc(u)]),
          ], ["verb", "url", "target", "evidence", "caller", "location"]),
        ].join("\n"), { clients, calls: { resolved: calls.resolved, external: calls.external, unresolved: calls.unresolved } });
        break;
      }
      case "frontend": {
        const sum = frontendQuery.summary(repoId(store));
        output(() => [
          "Packages",
          table(sum.packages.map((p) => [p.name, p.qualifiedName ?? "", ((p.metadata.frameworks as string[]) ?? []).join(",") || "-", String(p.metadata.tsconfig ?? "-"), String(p.metadata.typescriptSemantic ?? "syntax-only")]), ["package", "manifest", "frameworks", "tsconfig", "semantic"]),
          "",
          "Applications",
          table(sum.applications.map((a) => [a.name, String(a.metadata.framework), String(a.metadata.root || "."), ((a.metadata.signals as string[]) ?? []).join("; ")]), ["application", "framework", "root", "signals"]),
          "",
          table([["TS/JS files", sum.files], ["Symbols", sum.symbols], ...Object.entries(sum.roles).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]): [string, number] => [`  ${r}s`, n]), ["Routes", sum.routes], ["Module imports", sum.imports], ["HTTP calls resolved to API operations", sum.httpCalls.resolved], ["HTTP calls to external hosts", sum.httpCalls.external], ["Unresolved HTTP calls", sum.httpCalls.unresolved]], ["", "count"]),
        ].join("\n"), sum);
        break;
      }
      case "components": {
        const list = frontendQuery.components(repoId(store), opts.role);
        output(() => table(list.map((e) => [String(e.metadata.frontendRole), String(e.metadata.framework ?? "-"), e.name, String(e.metadata.selector ?? "-"), where(e), e.id]), ["role", "framework", "name", "selector", "location", "id"]), list);
        break;
      }
      case "frontend-routes": {
        const list = frontendQuery.routes(repoId(store), opts.app);
        output(() => table(list.map((r) => [r.applications.map((a) => a.name).join(",") || "-", r.route.name, [...r.components.map((c) => c.name), ...r.modules.map((m) => `lazy:${m.name}`)].join(", ") || (r.route.metadata.redirectTo ? `-> ${r.route.metadata.redirectTo}` : "-"), r.guards.map((g) => g.name).join(", ") || "-", where(r.route)]), ["application", "route", "component / module", "guards (static)", "location"]), list);
        break;
      }
      case "azure": {
        const sub = args[0] ?? "summary";
        const repo = repoId(store);
        const name = (e: Entity | null | undefined) => (e ? label(e) : "-");
        if (sub === "summary") {
          const sum = azureQuery.summary(repo);
          output(() => table([["Azure Functions", sum.functions], ...Object.entries(sum.triggers).map(([t, n]): [string, number] => [`  ${t}`, n]), ["Declared Azure resources", sum.resources], ...Object.entries(sum.byService).sort(([a], [b]) => a.localeCompare(b)).map(([s, n]): [string, number] => [`  ${s}`, n]), ...Object.entries(sum.declaredBy).map(([l, n]): [string, number] => [`  declared in ${l}`, n]), ["Code-side data/messaging resources", sum.logicalResources], ["Unresolved Azure references", sum.unresolved], ...Object.entries(sum.unresolvedByCategory).sort(([a], [b]) => a.localeCompare(b)).map(([c, n]): [string, number] => [`  ${c}`, n])], ["", "count"]), sum);
        } else if (sub === "functions") {
          const list = azureQuery.functions(repo);
          output(() => table(list.map((f) => [f.function.qualifiedName ?? f.function.name, String(f.function.metadata.triggerType ?? "-"), f.triggers.map((t) => `${name(t.source)} (${t.evidence})`).join("; ") || "-", f.bindings.map((b) => `${b.type} ${name(b.target)}`).join("; ") || "-", String(f.function.metadata.authLevel ?? "-"), f.hosting.map((h) => h.name).join(", ") || "-", where(f.function)]), ["function", "trigger", "trigger source", "bindings / durable", "auth", "hosted on", "location"]), list);
        } else if (sub === "triggers") {
          const list = azureQuery.triggers(repo);
          output(() => table(list.map((t) => [String(t.function.metadata.triggerType ?? "-"), name(t.source), t.type, t.function.qualifiedName ?? t.function.name, t.evidence, where(t.function)]), ["trigger", "source", "relationship", "function", "evidence", "location"]), list);
        } else if (sub === "resources") {
          const list = azureQuery.resources(repo, opts.kind);
          output(() => table(list.map((r) => [String(r.resource.metadata.armType ?? r.resource.metadata.azureKind), r.resource.name, String(r.resource.metadata.nameState ?? "-"), ((r.resource.metadata.declaredIn as string[] | string | undefined) ?? []).toString(), String(r.resource.metadata.declaredState ?? "-"), r.codeReferences, where(r.resource)]), ["type", "name", "name state", "declared in", "state", "code refs", "location"]), list);
        } else if (sub === "messaging") {
          const list = azureQuery.messaging(repo);
          const names = (xs: { entity: Entity | null; type: string }[]) => xs.map((x) => `${x.type} ${name(x.entity)}`).join("; ") || "-";
          output(() => list.map((m) => [`${String(m.transport.metadata.broker)} ${m.transport.name}  [${String(m.transport.metadata.resolution ?? m.transport.metadata.nameEvidence ?? "-")}]`, `  publishers:    ${names(m.publishers)}`, `  receivers:     ${names(m.receivers)}`, `  subscriptions: ${names(m.subscriptions)}`, `  consumers:     ${names(m.consumers)}`, `  messages:      ${names(m.messages)}`, `  declared by:   ${names(m.declaredBy)}`].join("\n")).join("\n\n") || "no Azure messaging resources", list);
        } else if (sub === "infrastructure") {
          const inf = azureQuery.infrastructure(repo);
          output(() => [
            "IaC files",
            table(inf.files.map((f) => [f.file.qualifiedName ?? f.file.name, f.creates.length, f.references, f.modules.join(", ") || "-"]), ["file", "creates", "references existing", "modules"]),
            "",
            "Hosting",
            table(inf.hosting.map((h) => [name(h.application), h.type, name(h.resource), h.evidence, String(h.metadata.rule ?? h.metadata.via ?? "-")]), ["application", "relationship", "resource", "evidence", "rule"]),
            "",
            "Resource relationships",
            table(inf.relationships.map((r) => [name(r.source), r.type, name(r.target), r.evidence, String(r.metadata.role ?? r.metadata.relation ?? r.metadata.identityType ?? r.metadata.via ?? "")]), ["resource", "relationship", "target", "evidence", "detail"]),
          ].join("\n"), inf);
        } else if (sub === "flow") {
          const entity = store.getEntity(args[1] ?? "") ?? one(query, args[1], store);
          const flow = azureQuery.flow(entity.id, opts.upstream ? "upstream" : "downstream", Number(opts.depth ?? 14), 4000, (opts.exclude ?? "").split(",").filter(isRelationshipType));
          if (!flow) throw new CliError(`no entity ${args[1]}`);
          const to = opts.to ? (store.getEntity(opts.to) ?? one(query, opts.to, store)) : null;
          if (to) flow.paths = flow.paths.filter((p) => p.target.id === to.id);
          const fmt = (path: FlowHop[]) => path.map((h, i) => (i === 0 ? `    ${label(h.entity)}` : `      ${h.via!.reversed ? "<-" : "-"}[${h.via!.type}/${h.via!.evidence}${h.via!.scope === "meta" ? "/meta" : ""}]${h.via!.reversed ? "-" : "->"} ${label(h.entity)}`)).join("\n");
          output(() => [`${label(flow.root)}  ${flow.direction}: ${flow.hops.length} reachable entities${flow.truncated ? " (truncated)" : ""}`, "", ...flow.paths.slice(0, Number(opts.limit ?? 40)).map((p) => fmt([{ entity: flow.root, via: null, depth: 0, parent: null }, ...p.path.slice(1)]))].join("\n"), { root: flow.root, direction: flow.direction, truncated: flow.truncated, paths: flow.paths.map((p) => ({ target: p.target, hops: p.path.map((h) => ({ entity: { id: h.entity.id, kind: h.entity.kind, name: h.entity.name, qualifiedName: h.entity.qualifiedName }, via: h.via })) })) });
        } else throw new CliError(`unknown azure view '${sub}' (summary | functions | triggers | resources | messaging | infrastructure | flow)`);
        break;
      }
      case "frontend-chain": {
        const entity = store.getEntity(args[0] ?? "") ?? one(query, args[0], store);
        const chain = frontendQuery.chain(entity.id, Number(opts.depth ?? 12));
        if (!chain) throw new CliError(`no entity ${args[0]}`);
        const fmt = (path: { entity: Entity; via: { type: string; evidence: string } | null }[]) => path.map((h, i) => (i === 0 ? `    ${label(h.entity)}` : `      -[${h.via!.type}/${h.via!.evidence}]-> ${label(h.entity)}`)).join("\n");
        output(() => [
          `${label(chain.root)}  (${chain.visited} reachable entities${chain.truncated ? ", truncated" : ""})`,
          "",
          `API operations (${chain.operations.length})`,
          ...chain.operations.map((o) => fmt(o.path)),
          "",
          `Backend handlers (${chain.backend.length})`,
          ...chain.backend.slice(0, 50).map((b) => fmt(b.path)),
          ...(chain.external.length ? ["", `External APIs (${chain.external.length})`, ...chain.external.map((x) => fmt(x.path))] : []),
          ...(chain.unresolvedCalls.length ? ["", `Unresolved HTTP calls (${chain.unresolvedCalls.length})`, ...chain.unresolvedCalls.map((u) => `    ${u.display}  ${u.reason}  @ ${u.location ?? "-"}`)] : []),
        ].join("\n"), chain);
        break;
      }
      case "contract-provenance": {
        const entity = store.getEntity(args[0] ?? "") ?? one(query, args[0], store);
        const report = query.provenance(entity.id)!;
        const sources = [...new Set(entity.provenance.map((p) => p.location?.file).filter(Boolean))];
        output(() => [`${label(entity)}`, `  sources: ${sources.join(", ") || "-"}`, ...report.provenance.map((p) => `  - ${p.plugin}/${p.extractor} via ${p.mechanism} @ ${p.location ? `${p.location.file}:${p.location.startLine}` : "-"}  commit=${p.commit?.slice(0, 12) ?? "-"} v${p.analysisVersion}`),
          ...(entity.metadata.conflictingDefinitions ? [`  conflicting definitions: ${(entity.metadata.conflictingDefinitions as string[]).join(", ")}`] : [])].join("\n"), { entity, provenance: report });
        break;
      }
      case "unresolved-contracts": {
        const list = contractQuery.unresolved(repoId(store));
        const ents = new Map(query.find({ ids: list.map((u) => u.sourceId) }).map((e) => [e.id, e]));
        output(() => table(list.map((u) => [u.type, String(u.metadata.category ?? "-"), u.targetDisplay, ents.get(u.sourceId)?.qualifiedName ?? u.sourceId, u.provenance[0]?.location ? `${u.provenance[0].location.file}:${u.provenance[0].location.startLine}` : ""]), ["type", "category", "target", "source", "location"]), list);
        break;
      }
      case "path": {
        const from = one(query, args[0], store);
        const to = one(query, args[1], store);
        const pathOptions = { maxDepth: intOpt(opts.depth, 8), types: types() };
        const chain = query.path(from.id, to.id, { ...pathOptions, direction: opts.reverse ? "in" : "out" }) ?? query.path(from.id, to.id, { ...pathOptions, direction: "both" });
        if (!chain) throw new CliError(`no path from ${label(from)} to ${label(to)}`);
        const ents = new Map(query.find({ ids: chain.flatMap((r) => [r.sourceId, r.targetId]) }).map((e) => [e.id, e]));
        let cursor = from.id;
        const lines = chain.map((r) => {
          const forward = r.sourceId === cursor;
          cursor = forward ? r.targetId : r.sourceId;
          return `  ${forward ? `-[${r.type}/${r.evidence}]->` : `<-[${r.type}/${r.evidence}]-`} ${label(ents.get(cursor))}`;
        });
        output(() => [label(from), ...lines].join("\n"), chain);
        break;
      }
      case "projects": {
        const id = repoId(store);
        if (!id) throw new CliError("specify --repo");
        const graph = query.projectGraph(id);
        const names = new Map(graph.projects.map((p) => [p.id, p.name]));
        output(() => [
          ...graph.projects.map((p) => {
            const refs = graph.references.filter((r) => r.sourceId === p.id).map((r) => names.get(r.targetId) ?? r.targetId);
            const dependents = graph.references.filter((r) => r.targetId === p.id).length;
            const meta = p.metadata;
            return `${p.name}  [${(meta.targetFrameworks as string[] | undefined)?.join(",") ?? "?"}, ${meta.outputType}${meta.isWeb ? ", web" : ""}]  dependents=${dependents}\n    -> ${refs.length ? refs.join(", ") : "(no project references)"}`;
          }),
          graph.cycles.length ? `\nCycles:\n${graph.cycles.map((c) => `  ${c.map((id) => names.get(id)).join(" <-> ")}`).join("\n")}` : "\nNo project reference cycles.",
        ].join("\n"), graph);
        break;
      }
      case "applications": {
        const rows = appQuery.applications(repoId(store));
        output(() => (rows.length ? table(rows.map((r) => [r.application.name, String(r.application.metadata.applicationKind), r.counts.endpoints!, r.counts.registrations!, r.counts.middleware!, r.counts.hostedServices!, (r.application.metadata.signals as string[]).join("; ")]), ["application", "kind", "endpoints", "registrations", "middleware", "hosted", "signals"]) : "No applications detected."), rows);
        break;
      }
      case "endpoints": {
        const list = appQuery.endpoints({ repositoryId: repoId(store), method: opts.method, route: opts.route, application: opts.app, authorization: opts.auth });
        output(() => table(list.map((e) => [String(e.metadata.verb), String(e.metadata.route), String(e.metadata.authorization), String(e.metadata.handler), e.id]), ["verb", "route", "auth", "handler", "id"]), list);
        break;
      }
      case "endpoint": {
        if (!args[0]) throw new CliError("endpoint requires an id or \"VERB /route\"");
        const [verb, route] = args[0].includes(" ") ? args[0].split(/\s+/, 2) : [undefined, undefined];
        const candidates = store.getEntity(args[0]) ? [store.getEntity(args[0])!] : appQuery.endpoints({ repositoryId: repoId(store) }).filter((e) => (verb ? String(e.metadata.verb) === verb.toUpperCase() && String(e.metadata.route).toLowerCase() === route!.toLowerCase() : String(e.metadata.route).toLowerCase() === args[0]!.toLowerCase()));
        if (candidates.length !== 1) throw new CliError(candidates.length ? `ambiguous endpoint:\n${candidates.map((c) => `  ${c.id}  ${c.name}  ${where(c)}`).join("\n")}` : `no endpoint matches '${args[0]}'`);
        const d = appQuery.endpoint(candidates[0]!.id);
        if (!d) throw new CliError(`${candidates[0]!.id} is not an endpoint (try 'operation' or 'contract')`);
        const m = d.endpoint.metadata;
        output(() => [
          `${d.endpoint.name}  (${m.framework})`,
          `  id            ${d.endpoint.id}`,
          `  location      ${where(d.endpoint)}`,
          `  application   ${d.applications.map((a) => a.name).join(", ") || "-"}`,
          `  controller    ${d.controller ? label(d.controller) : "-"}`,
          `  route groups  ${d.groups.map((g) => g.name).join(", ") || "-"}`,
          `  handler       ${d.handlers.map(label).join(", ") || "(unresolved)"}  [${m.handlerKind}${m.handlerLocation ? ` @ ${m.handlerLocation}` : ""}]`,
          `  parameters    ${(m.parameters as string[]).join(", ") || "-"}`,
          `  request       ${d.requests.map((r) => `${label(r.type)} (${r.relationship.metadata.bindingSource}, ${r.relationship.evidence})`).join(", ") || "-"}`,
          `  response      ${d.responses.map((r) => `${label(r.type)}${r.relationship.metadata.collection ? ` [${r.relationship.metadata.collection}]` : ""} (${r.relationship.metadata.rule})`).join(", ") || "-"}  declared: ${m.declaredReturnType ?? "-"}`,
          `  authorization ${m.authorization}: ${d.authorization.map((a) => `${a.metadata.name} (${a.relationship.metadata.source})`).join(", ") || "-"}`,
          `  metadata      routeName=${m.routeName ?? "-"} name=${m.endpointName ?? "-"} tags=${(m.tags as string[]).join(",") || "-"} produces=${(m.produces as string[]).join(",") || "-"} consumes=${(m.consumes as string[]).join(",") || "-"}`,
          `  provenance    ${d.endpoint.provenance.map((p) => `${p.plugin}/${p.extractor} @ ${p.location ? `${p.location.file}:${p.location.startLine}` : "-"}`).join("; ")}`,
        ].join("\n"), d);
        break;
      }
      case "routes": {
        const id = repoId(store);
        const endpoints = appQuery.endpoints({ repositoryId: id, application: opts.app });
        const byRoute = new Map<string, Set<string>>();
        for (const e of endpoints) byRoute.set(String(e.metadata.route), new Set([...(byRoute.get(String(e.metadata.route)) ?? []), String(e.metadata.verb)]));
        const groups = query.find({ kinds: ["RouteGroup"], repositoryId: id });
        output(() => [
          table([...byRoute].sort(([a], [b]) => a.localeCompare(b)).map(([route, verbs]) => [route, [...verbs].sort().join(",")]), ["route", "verbs"]),
          ...(groups.length ? ["", "Route groups", table(groups.map((g) => [String(g.metadata.prefix), (g.metadata.tags as string[]).join(",") || "-", (g.metadata.authorization as string[]).join(",") || "-", where(g)]), ["prefix", "tags", "authorization", "location"])] : []),
        ].join("\n"), { routes: Object.fromEntries([...byRoute].map(([r, v]) => [r, [...v].sort()])), groups });
        break;
      }
      case "services":
      case "registrations": {
        const list = appQuery.registrations({ repositoryId: repoId(store), service: opts.service ?? args[0], lifetime: opts.lifetime });
        const shown = command === "services" ? list.filter((r) => r.registration.metadata.registrationKind !== "framework") : list;
        output(() => table(shown.map((r) => {
          const m = r.registration.metadata;
          const closed = (name: unknown, args: unknown) => (Array.isArray(args) && args.length ? String(name).replace(/<[^<>]*>$/, `<${args.join(", ")}>`) : String(name ?? ""));
          const impl = m.implementationType ? closed(m.implementationType, m.implementationTypeArguments) : m.factory ? `(factory ${m.factory})` : m.registrationKind === "framework" || m.registrationKind === "options" ? "-" : "(unresolved)";
          const flags = [m.keyed ? `key=${m.key}` : "", m.tryAdd ? "TryAdd" : "", m.enumerable ? "enumerable" : "", m.openGeneric ? "open-generic" : "", m.controlFlow !== "unconditional" ? String(m.controlFlow) : ""].filter(Boolean).join(" ");
          return [String(m.lifetime), m.serviceType ? closed(m.serviceType, m.serviceTypeArguments) : r.registration.name, impl, String(m.registrationKind), flags, r.applications.map((a) => a.name).join(",") || "-", where(r.registration)];
        }), ["lifetime", "service", "implementation", "kind", "flags", "applications", "location"]), shown);
        break;
      }
      case "middleware": {
        const pipelines = appQuery.middleware(repoId(store)).filter((p) => !opts.app || p.application.name.toLowerCase() === opts.app.toLowerCase());
        output(() => pipelines.map((p) => [
          `${p.application.name}`,
          ...p.pipeline.map(({ middleware: mw, relationship: r }) => {
            const m = mw.metadata;
            const flags = [m.controlFlow !== "unconditional" ? `${m.controlFlow}${m.condition ? ` (${m.condition})` : ""}` : "", m.branch ? `branch ${m.branch}` : "", r.evidence === "INFERRED" ? "attribution inferred" : ""].filter(Boolean).join("; ");
            return `  ${String(Number(r.metadata.order) + 1).padStart(2)}. ${mw.name}${flags ? `  [${flags}]` : ""}  ${where(mw)}  (in ${m.orderScope})`;
          }),
        ].join("\n")).join("\n\n") || "No middleware detected.", pipelines);
        break;
      }
      case "hosted-services": {
        const list = appQuery.hostedServices(repoId(store));
        output(() => (list.length ? table(list.map((h) => [h.hosted.qualifiedName ?? h.hosted.name, h.hosted.metadata.registered ? "registered" : "not registered", h.applications.map((a) => a.name).join(",") || "-", where(h.implementation)]), ["hosted service", "registration", "applications", "location"]) : "No hosted services detected."), list);
        break;
      }
      case "authorization": {
        const list = appQuery.authorization(repoId(store));
        output(() => (list.length ? table(list.map((a) => [a.metadata.name, String(a.metadata.metadata.requirement), a.metadata.metadata.policyDefined === null ? "-" : a.metadata.metadata.policyDefined ? "defined" : "not found", a.endpoints]), ["authorization", "kind", "policy definition", "endpoints"]) : "No authorization metadata detected."), list);
        break;
      }
      case "config": {
        const refsList = query.find({ kinds: ["ConfigurationReference"], repositoryId: repoId(store) });
        output(() => table(refsList.map((c) => {
          const users = query.incoming(c.id, ["REFERENCES_CONFIG"]);
          return [String(c.metadata.source), c.name, String(c.metadata.configurationKind), c.metadata.secretLikeName ? "secret-like name" : "", users.length];
        }), ["source", "key", "kind", "note", "references"]), refsList);
        break;
      }
      case "impact":
      case "blast-radius":
      case "dependencies":
      case "dependents":
      case "risk": {
        const graph = analysisGraph();
        let seeds: Entity[];
        let changes: { kind: string; subject: string; breaking: boolean }[] = [];
        let diffUsed: GraphDiff | null = null;
        if (command === "risk" && opts.diff) {
          diffUsed = resolveDiff();
          const current = graph.entities([...diffUsed.entities.added, ...diffUsed.entities.changed].map((e) => e.id));
          const removedIds = new Set(diffUsed.entities.removed.map((e) => e.id));
          const old = store.getGraphSnapshot(diffUsed.old.id)!.payload;
          const dependentsOfRemoved = graph.entities(old.relationships.filter((r) => removedIds.has(r[3]) && !removedIds.has(r[2])).map((r) => r[2]));
          seeds = [...new Map([...current, ...dependentsOfRemoved]).values()].filter((e) => !["File", "Parameter", "Repository"].includes(e.kind)).sort((a, b) => a.id.localeCompare(b.id));
          changes = diffUsed.architecture.map((c) => ({ kind: c.kind, subject: c.subject, breaking: c.breakingPotential }));
        } else {
          if (!args.length) throw new CliError(`${command} requires one or more entity references`);
          seeds = args.map((a) => target(a));
          if (opts.change) changes = seeds.map((s) => ({ kind: `${["ApiOperation", "Api"].includes(s.kind) ? "API" : s.kind === "Message" ? "MESSAGE" : "CODE"}_${opts.change!.toUpperCase()}`, subject: s.name, breaking: ["removed", "route", "method", "version", "request-field", "required-field", "parameter", "request-contract", "response-field", "response-contract"].includes(opts.change!) }));
        }
        const mode = command === "dependencies" ? "dependencies" : command === "dependents" ? "dependents" : "impact";
        const result = propagate(graph, seeds, impactOptions(mode));
        let score: Score | null = null;
        if (command === "blast-radius") score = blastRadius(result);
        if (command === "risk") score = changeRisk(result, changes, propagate(graph, seeds, { ...impactOptions("dependents"), maxDepth: 1 }).impacted.length);
        let enterpriseContext: ReturnType<typeof enterpriseRiskContext> | null = null;
        if (command === "risk") {
          const m = enterpriseModel();
          enterpriseContext = enterpriseRiskContext(m, seeds, result, teamImpact(m, graph, seeds, impactOptions(mode), result));
        }
        const data = { ...result, ...(score ? { score } : {}), ...(enterpriseContext ? { enterpriseContext } : {}), ...(diffUsed ? { diff: { old: diffUsed.old.id, new: diffUsed.new.id, architectureChanges: changes.length } } : {}) };
        await maybeExport(command, data, result.impacted.map(impactRow));
        output(() => [
          ...(diffUsed ? [`Changes from diff ${diffUsed.old.id} -> ${diffUsed.new.id}: ${changes.length} architecture changes (${changes.filter((c) => c.breaking).length} potentially breaking), ${seeds.length} changed entities used as seeds`] : []),
          impactSummary(result),
          ...(score ? ["", scoreText(command === "risk" ? "Change risk" : "Blast radius", score)] : []),
          ...(enterpriseContext ? ["", "Enterprise context (contributing evidence; not added to the score)", table(enterpriseContext.map((f) => [f.factor, String(f.value), f.explanation]), ["factor", "value", "explanation"]), ...enterpriseContext.filter((f) => f.evidence.length).map((f) => `  ${f.factor}: ${f.evidence.slice(0, 5).join("; ")}`)] : []),
        ].join("\n"), data);
        break;
      }
      case "paths": {
        if (args.length < 2) throw new CliError("paths requires <from> <to>");
        const from = target(args[0]);
        const to = target(args[1]);
        const direction = (opts.direction ?? "both") as "forward" | "reverse" | "both";
        if (!["forward", "reverse", "both"].includes(direction)) throw new CliError("--direction must be forward, reverse or both");
        const result = findPaths(analysisGraph(), from.id, to.id, { direction, types: types(), kinds: viaKinds(), maxDepth: depthOpt(8), maxNodes: intOpt(opts["max-nodes"], 20000), limit: intOpt(opts.all, 1) });
        await maybeExport("paths", result, result.paths.flatMap((p, i) => p.steps.map((s, j) => ({ path: i + 1, step: j + 1, from: s.from.qualifiedName ?? s.from.name, relationship: s.relationship.type, direction: s.relationship.direction, to: s.to.qualifiedName ?? s.to.name, evidence: s.relationship.evidence, scope: s.relationship.graphScope, crossRepository: s.relationship.crossRepository }))));
        output(() => (result.paths.length ? result.paths.map((p, i) => `Path ${i + 1} (${p.length} hops, repositories: ${p.repositories.map(repoName).join(", ") || "-"}, scopes: ${p.graphScopes.join(",") || "-"})\n${pathText(p)}`).join("\n\n") : `No path from ${label(from)} to ${label(to)} within ${depthOpt(8)} hops.`) + (result.truncated ? "\n(search truncated by --max-nodes)" : ""), result);
        break;
      }
      case "api-impact": {
        const op = target(args[0]);
        if (op.kind !== "ApiOperation") throw new CliError(`${label(op)} is not an ApiOperation`);
        if (opts.change && !API_CHANGE_KINDS.includes(opts.change)) throw new CliError(`--change must be one of ${API_CHANGE_KINDS.join(", ")}`);
        const r = apiImpact(analysisGraph(), op, opts.change ?? null, impactOptions("impact"));
        await maybeExport("api-impact", r, r.consumers.map((c) => ({ consumer: c.entity.qualifiedName ?? c.entity.name, repository: c.repository, scope: c.relationship.graphScope, evidence: c.relationship.evidence, applications: c.applications.map((a) => a.name).join(";"), deployments: c.deployments.join(";"), breakingPotential: c.breakingPotential })));
        output(() => [
          `API operation ${r.operation.qualifiedName}  [${repoName(r.operation.repositoryId)}]`,
          `  api ${r.api?.entity.qualifiedName ?? "-"}  provider ${r.provider?.entity.name ?? "-"}`,
          `  implemented by ${r.endpoints.map((e) => e.entity.qualifiedName ?? e.entity.name).join("; ") || "-"}  handler ${r.handlers.map((h) => h.entity.qualifiedName ?? h.entity.name).join("; ") || "-"}`,
          `  request ${r.requestContracts.map((c) => c.entity.qualifiedName ?? c.entity.name).join(", ") || "-"}  response ${r.responseContracts.map((c) => c.entity.qualifiedName ?? c.entity.name).join(", ") || "-"}`,
          ...(r.change ? [`  change ${r.change.kind}: ${r.change.breaking ? `potentially breaking for ${r.change.affects === "all" ? "all consumers" : `consumers using the ${r.change.affects}`}` : "additive"}`] : []),
          `Consumers (${r.consumers.length}) in ${r.consumerRepositories.join(", ") || "no analyzed repository"}`,
          ...r.consumers.slice(0, rowLimit()).map((c) => `  ${c.repository ?? "-"}: ${c.entity.qualifiedName ?? c.entity.name}  apps=${c.applications.map((a) => a.name).join(",") || "-"} deployments=${c.deployments.join(",") || "-"}  ${c.relationship.graphScope}/${c.relationship.evidence}${c.client ? ` client=${c.client.name}` : ""}${r.change ? ` breaking=${c.breakingPotential ?? "unknown"}` : ""}`),
          "",
          impactSummary(r.impact),
          "",
          scoreText("Blast radius", r.blastRadius),
        ].join("\n"), r);
        break;
      }
      case "message-impact": {
        const m = target(args[0]);
        if (!["Message", "SharedContract"].includes(m.kind)) throw new CliError(`${label(m)} is not a Message or SharedContract`);
        const r = messageImpact(analysisGraph(), m, impactOptions("impact"));
        const side = (l: typeof r.producerSide) => l.slice(0, rowLimit()).map((x) => `  ${x.repository ?? "-"}: ${x.entity.qualifiedName ?? x.entity.name} [${x.relationship.type}/${x.relationship.evidence}] apps=${x.applications.map((a) => a.name).join(",") || "-"}`);
        await maybeExport("message-impact", r, [...r.producerSide.map((x) => ({ side: "producer", entity: x.entity.qualifiedName, repository: x.repository, relationship: x.relationship.type })), ...r.consumerSide.map((x) => ({ side: "consumer", entity: x.entity.qualifiedName, repository: x.repository, relationship: x.relationship.type }))]);
        output(() => [
          `Message ${r.message.qualifiedName ?? r.message.name}  [${repoName(r.message.repositoryId)}]  repositories: ${r.repositories.join(", ") || "-"}`,
          ...(r.members.length ? [`Contract members: ${r.members.map((x) => `${x.repository}:${x.entity.qualifiedName}`).join(", ")}`] : []),
          `Producer side (${r.producerSide.length})`, ...side(r.producerSide),
          `Consumer side (${r.consumerSide.length})`, ...side(r.consumerSide),
          `Transports (${r.transports.length})`, ...r.transports.map((t) => `  ${t.transport.entity.qualifiedName} senders=${t.senders.length} delivers-to=${t.deliversTo.length}`),
          "", impactSummary(r.impact), "", scoreText("Blast radius", r.blastRadius),
        ].join("\n"), r);
        break;
      }
      case "service-impact": {
        const app = target(args[0]);
        if (app.kind !== "Application") throw new CliError(`${label(app)} is not an Application`);
        const r = serviceImpact(analysisGraph(), app, impactOptions("impact"));
        await maybeExport("service-impact", r, [...r.upstream.impacted.map((i) => ({ direction: "upstream", ...impactRow(i) })), ...r.downstream.impacted.map((i) => ({ direction: "downstream", ...impactRow(i) }))]);
        const list = (name: string, l: { entity: { qualifiedName: string | null; name: string }; repository: string | null; relationship: { type: string } }[]) => `${name} (${l.length})${l.length ? `: ${l.slice(0, rowLimit()).map((x) => `${x.entity.qualifiedName ?? x.entity.name}${x.repository && x.repository !== repoName(app.repositoryId) ? ` [${x.repository}]` : ""}`).join("; ")}` : ""}`;
        output(() => [
          `Service ${app.name}  [${repoName(app.repositoryId)}]`,
          `  ${list("APIs", r.apis)}  operations=${r.operations}`,
          `  ${list("API consumers", r.apiConsumers)}`,
          `  ${list("publishes", r.publishes)}`,
          `  ${list("consumes", r.consumes)}`,
          `  ${list("outgoing calls", r.outgoingCalls)}`,
          `  ${list("external systems", r.externalSystems)}`,
          `  ${list("configuration", r.configuration)}`,
          `  deployments (${r.deployments.length}): ${r.deployments.map((d) => `${d.workload.entity.qualifiedName} -> ${d.services.map((s) => s.entity.name).join(",") || "-"} -> ${d.ingresses.map((i) => i.entity.name).join(",") || "-"}${d.workload.relationship.graphScope === "meta" ? ` [${d.workload.repository}]` : ""}`).join("; ") || "-"}`,
          "", "Upstream (affected if this service changes)", impactSummary(r.upstream),
          "", "Downstream (what this service depends on)", impactSummary(r.downstream),
          "", scoreText("Blast radius", r.blastRadius),
        ].join("\n"), r);
        break;
      }
      case "repository-impact": {
        const entry = catalogRef(args[0]);
        const repoEntity = store.findEntities({ kinds: ["Repository"], repositoryId: entry.repositoryId })[0];
        if (!repoEntity) throw new CliError(`repository graph for ${entry.name} is not available`);
        const r = repositoryImpact(analysisGraph("all"), repoEntity, impactOptions("impact"));
        await maybeExport("repository-impact", r, r.impact.impacted.map(impactRow));
        const list = (name: string, l: { entity: { qualifiedName: string | null; name: string }; repository: string | null }[]) => `  ${name} (${l.length})${l.length ? `: ${l.slice(0, rowLimit()).map((x) => x.entity.name).join(", ")}` : ""}`;
        output(() => [
          `Repository ${entry.name}`,
          list("depends on", r.dependsOn), list("dependents", r.dependents), list("provided APIs", r.providedApis), list("consumed APIs", r.consumedApis),
          list("shared packages", r.sharedPackages), list("produced packages", r.producedPackages), list("shared contracts", r.sharedContracts), list("messages", r.messages),
          list("external systems", r.externalSystems), list("deployed by", r.deployedBy), list("deploys", r.deploys),
          `  infrastructure ${Object.entries(r.infrastructure).map(([k, n]) => `${k}=${n}`).join(" ")}`,
          "", impactSummary(r.impact), "", scoreText("Blast radius", r.blastRadius),
        ].join("\n"), r);
        break;
      }
      case "graph-snapshots": {
        if (opts.prune) {
          const all = store.listGraphSnapshots({ scope: "repository", repositoryId: opts.repo ? catalogRef(opts.repo).repositoryId : undefined });
          const latest = new Map<string, string>();
          for (const s of all) if (s.commit) latest.set(`${s.repositoryId}|${s.commit}`, s.id);
          const superseded = all.filter((s) => s.commit && latest.get(`${s.repositoryId}|${s.commit}`) !== s.id);
          store.deleteGraphSnapshots(superseded.map((s) => s.id));
          output(() => `Pruned ${superseded.length} repository snapshots superseded by a newer analysis of the same commit${superseded.length ? `: ${superseded.map((s) => `${repoName(s.repositoryId)}@${s.commit?.slice(0, 12)} ${s.id}`).join(", ")}` : ""}`, superseded);
          break;
        }
        const list = store.listGraphSnapshots({ scope: opts.meta ? "meta" : "repository", repositoryId: opts.repo ? catalogRef(opts.repo).repositoryId : undefined });
        output(() => table(list.map((s) => [s.id, s.scope, repoName(s.repositoryId), s.commit?.slice(0, 12) ?? "-", s.graphVersion.slice(0, 24), s.createdAt, s.entities, s.relationships]), ["snapshot", "scope", "repository", "commit", "graph version", "created", "entities", "relationships"]), list);
        break;
      }
      case "diff": {
        const d = resolveDiff();
        const limit = rowLimit();
        await maybeExport("diff", d, [
          ...d.entities.added.map((e) => ({ change: "entity-added", kind: e.kind, subject: e.qualifiedName ?? e.name, category: e.category })),
          ...d.entities.removed.map((e) => ({ change: "entity-removed", kind: e.kind, subject: e.qualifiedName ?? e.name, category: e.category })),
          ...d.entities.changed.map((e) => ({ change: "entity-changed", kind: e.kind, subject: e.qualifiedName ?? e.name, category: e.category, keys: (e.changedKeys ?? []).join(";") })),
          ...d.relationships.added.map((r) => ({ change: "relationship-added", kind: r.type, subject: `${r.source} -> ${r.target}` })),
          ...d.relationships.removed.map((r) => ({ change: "relationship-removed", kind: r.type, subject: `${r.source} -> ${r.target}` })),
          ...d.architecture.map((a) => ({ change: `architecture-${a.change}`, kind: a.kind, subject: a.subject, category: a.category, breakingPotential: a.breakingPotential, description: a.description })),
        ]);
        output(() => [
          `${d.graphScope} diff ${d.old.id} (${d.old.commit?.slice(0, 12) ?? d.old.graphVersion.slice(0, 12)}) -> ${d.new.id} (${d.new.commit?.slice(0, 12) ?? d.new.graphVersion.slice(0, 12)})${d.repositoryId ? `  repository ${repoName(d.repositoryId)}` : ""}`,
          `entities: +${d.entities.added.length} -${d.entities.removed.length} ~${d.entities.changed.length}   relationships: +${d.relationships.added.length} -${d.relationships.removed.length} ~${d.relationships.changed.length}`,
          table(Object.entries(d.byCategory).map(([k, v]) => [k, v.added, v.removed, v.changed]), ["category", "added", "removed", "changed"]),
          "",
          `Architecture changes (${d.architecture.length}${d.architecture.length > limit ? `, showing ${limit}; --limit N for more` : ""})`,
          ...d.architecture.slice(0, limit).map((a) => `  [${a.category}] ${a.kind}${a.breakingPotential ? " (potentially breaking)" : ""}: ${a.description}`),
        ].join("\n"), d);
        break;
      }
      case "cycles": {
        const kind = (args[0] ?? "project") as CycleKind;
        if (!CYCLE_KINDS.includes(kind)) throw new CliError(`cycle kind must be one of ${CYCLE_KINDS.join(", ")}`);
        if (kind === "relationship" && !types()) throw new CliError("relationship cycles require --type");
        const graph = analysisGraph(kind === "repository" ? "all" : undefined);
        const cycles = findCycleSet(graph, kind, opts.repo ? catalogRef(opts.repo).repositoryId : undefined, types());
        await maybeExport("cycles", cycles, cycles.flatMap((c, i) => c.path.steps.map((s, j) => ({ cycle: i + 1, step: j + 1, from: s.from.qualifiedName ?? s.from.name, relationship: s.relationship.type, to: s.to.qualifiedName ?? s.to.name, evidence: s.relationship.evidence, componentSize: c.componentSize }))));
        output(() => (cycles.length ? cycles.slice(0, rowLimit()).map((c, i) => `Cycle ${i + 1} (${c.path.length} hops; strongly connected component of ${c.componentSize})\n${pathText(c.path)}`).join("\n\n") : `No ${kind} cycles.`), cycles);
        break;
      }
      case "orphaned": {
        let list = findOrphans(analysisGraph(), opts.repo ? catalogRef(opts.repo).repositoryId : undefined);
        if (opts.label) list = list.filter((f) => f.label === opts.label!.toUpperCase());
        await maybeExport("orphaned", list, list.map((f) => ({ label: f.label, kind: f.entity.kind, entity: f.entity.qualifiedName ?? f.entity.name, repository: f.repository, location: f.entity.location, reason: f.reason })));
        const counts: Record<string, number> = {};
        for (const f of list) counts[`${f.label} ${f.entity.kind}`] = (counts[`${f.label} ${f.entity.kind}`] ?? 0) + 1;
        output(() => [
          table(Object.entries(counts).map(([k, n]) => [k, n]), ["finding", "count"]),
          "",
          table(list.slice(0, rowLimit()).map((f) => [f.label, f.entity.kind, f.entity.qualifiedName ?? f.entity.name, f.repository ?? "-", f.reason]), ["label", "kind", "entity", "repository", "reason"]),
          list.length > rowLimit() ? `(${list.length - rowLimit()} more; --limit N or --json)` : "",
        ].join("\n"), list);
        break;
      }
      case "validate-rules": {
        const p = policySet(false);
        output(() => [
          `${p.policies.length} policies, ${p.rules.length} rules, ${p.layers.size} layers, ${p.exceptions.length} exceptions (fingerprint ${p.fingerprint})`,
          ...p.errors.map((e) => `  ERROR   ${e.file}:${e.path} ${e.message}`),
          ...p.warnings.map((e) => `  WARNING ${e.file}:${e.path} ${e.message}`),
          ...p.overridden.map((o) => `  INFO    rule ${o.rule} from ${o.policy} is overridden by ${o.by}`),
          p.errors.length ? "INVALID" : "VALID",
        ].join("\n"), { valid: !p.errors.length, errors: p.errors, warnings: p.warnings, overridden: p.overridden, policies: p.policies.length, rules: p.rules.length });
        if (p.errors.length) process.exitCode = 2;
        break;
      }
      case "policies":
      case "policy": {
        const p = policySet();
        const list = command === "policy" ? p.policies.filter((x) => x.id === args[0]) : p.policies;
        if (command === "policy" && !list.length) throw new CliError(`no policy '${args[0]}'`);
        output(() => command === "policies"
          ? table(list.map((x) => [x.id, x.level, x.precedence, x.rules.length, x.layers.join(",") || "-", x.exceptions.length, x.includes.join(",") || "-", x.file]), ["policy", "level", "precedence", "rules", "layers", "exceptions", "includes", "file"])
          : list.map((x) => [`${x.id} (${x.name})  level ${x.level}  precedence ${x.precedence}  owner ${x.owner ?? "-"}  ${x.file}`, ...p.rules.filter((r) => r.policy === x.id).map((r) => `  ${r.id} [${r.severity}] ${r.mode} ${r.name}${r.enabled ? "" : " (disabled)"}`), ...x.layers.map((l) => `  layer ${l}: ${JSON.stringify(p.layers.get(l)!.selector)}`), ...x.exceptions.map((e) => `  exception ${e}`)].join("\n")).join("\n"), list);
        break;
      }
      case "rules": {
        const p = policySet();
        output(() => table(p.rules.map((r) => [r.id, r.policy, r.precedence, r.mode, r.severity, r.enabled ? "yes" : "no", r.relationships.join(",") || (r.require?.relationships.join(",") ?? "metadata"), r.match === "members" ? "members" : r.maxDepth > 1 ? `transitive<=${r.maxDepth}` : "direct", r.environments.join(",") || "all", r.name]), ["rule", "policy", "prec", "mode", "severity", "enabled", "relationships", "reach", "environments", "name"]), p.rules);
        break;
      }
      case "rule": {
        const p = policySet();
        const rule = p.rules.find((r) => r.id === args[0]);
        if (!rule) throw new CliError(`no rule '${args[0]}'`);
        opts.rule = rule.id;
        const result = runGovernance();
        output(() => [`${rule.id} ${rule.name}  [${rule.severity}] ${rule.mode}  policy ${rule.policy} (precedence ${rule.precedence})${rule.owner ? `  owner ${rule.owner}` : ""}`, rule.description ?? "", `  from ${JSON.stringify(rule.from)}`, `  to ${JSON.stringify(rule.to)}`, `  relationships ${rule.relationships.join(",") || "-"}  environments ${rule.environments.join(",") || "all"}`, "", snapshotText(result), `${result.rules[0]?.status}: ${result.violations.length} violations (${result.rules[0]?.evaluated} evaluated)`, ...result.violations.slice(0, rowLimit()).map(violationText)].filter(Boolean).join("\n"), { rule, result });
        break;
      }
      case "governance":
      case "violations": {
        const result = runGovernance();
        let list = result.violations;
        if (opts.severity) list = list.filter((v) => v.severity === opts.severity!.toUpperCase());
        if (opts.status) list = list.filter((v) => v.status === opts.status!.toUpperCase() || v.baseline === opts.status!.toUpperCase());
        if (opts.env) list = list.filter((v) => v.environment === opts.env!.toLowerCase());
        if (opts.entity) list = list.filter((v) => [v.source, v.target].some((e) => e && `${e.qualifiedName ?? ""} ${e.name} ${e.id}`.toLowerCase().includes(opts.entity!.toLowerCase())));
        await maybeExport(command, { ...result, violations: list }, list.map(violationRow));
        output(() => command === "governance"
          ? [
              `Governance ${result.summary.outcome}  (${result.summary.counted} counted violations; fail-on ${severityOpt(opts["fail-on"], "ERROR")}, warn-on ${severityOpt(opts["warn-on"], "WARNING")})`,
              snapshotText(result),
              result.baseline ? `baseline ${result.baseline.name} (${result.baseline.createdAt}): ${list.filter((v) => v.baseline === "NEW").length} new, ${list.filter((v) => v.baseline === "BASELINED").length} baselined` : "",
              table(result.rules.map((r) => [r.rule, r.severity, r.mode, r.status, r.evaluated, r.violations, r.excepted, r.name]), ["rule", "severity", "mode", "result", "evaluated", "violations", "excepted/overridden", "name"]),
              `by status: ${Object.entries(result.summary.byStatus).map(([k, n]) => `${k}=${n}`).join(" ") || "-"}   by severity: ${Object.entries(result.summary.bySeverity).map(([k, n]) => `${k}=${n}`).join(" ") || "-"}${result.conflicts.length ? `   policy conflicts: ${result.conflicts.length}` : ""}`,
              "",
              ...list.slice(0, rowLimit()).map(violationText),
              list.length > rowLimit() ? `(${list.length - rowLimit()} more; 'violations --limit N', --json or --out)` : "",
            ].filter(Boolean).join("\n")
          : list.length ? list.slice(0, rowLimit()).map(violationText).join("\n") + (list.length > rowLimit() ? `\n(${list.length - rowLimit()} more)` : "") : "No matching violations.", command === "governance" ? result : list);
        if (command === "governance") exitFor(result.summary.outcome);
        break;
      }
      case "exceptions": {
        const result = runGovernance();
        const list = result.exceptions.filter((e) => !opts.status || e.status === opts.status.toLowerCase());
        output(() => (list.length ? table(list.map((e) => [e.id, e.rule, e.status, e.matched, e.expires ?? "-", e.owner ?? "-", e.approvedBy ?? "-", e.reason]), ["exception", "rule", "status", "matched violations", "expires", "owner", "approved by", "reason"]) : "No exceptions."), list);
        break;
      }
      case "baseline": {
        const sub = args[0] ?? "list";
        if (sub === "list") {
          const list = store.listBaselines();
          output(() => table(list.map((b) => [b.name, b.createdAt]), ["baseline", "created"]), list);
        } else if (sub === "save") {
          if (!args[1]) throw new CliError("baseline save requires a name");
          const result = runGovernance({ baseline: undefined });
          const ids = result.violations.map((v) => v.id).sort();
          store.saveBaseline(args[1], { violations: ids, snapshots: result.snapshots, asOf: result.asOf, policyFingerprint: result.policyFingerprint, rules: result.rules.map((r) => `${r.rule}:${r.violations}`) });
          output(() => `Saved baseline ${args[1]} with ${ids.length} violations (${snapshotText(result)})`, { name: args[1], violations: ids.length });
        } else if (sub === "show") {
          const b = store.getBaseline(args[1] ?? "");
          if (!b) throw new CliError(`baseline not found: ${args[1]}`);
          output(() => JSON.stringify(b, null, 2), b);
        } else throw new CliError("baseline subcommand must be save, list or show");
        break;
      }
      case "governance-diff": {
        const repositorySnapshots = (ref: string | undefined) => {
          if (!ref) return undefined;
          if (!opts.repo) throw new CliError("--from/--to need --repo");
          return { [catalogRef(opts.repo).repositoryId]: ref };
        };
        const list = opts.repo ? store.listGraphSnapshots({ scope: "repository", repositoryId: catalogRef(opts.repo).repositoryId }) : [];
        const fromRef = opts.from ?? (opts.repo ? list[list.length - 2]?.id : undefined);
        const toRef = opts.to ?? (opts.repo ? list[list.length - 1]?.id : undefined);
        if (opts.repo && (!fromRef || !toRef)) throw new CliError(`need two snapshots for ${opts.repo}; analyze another commit or pass --from/--to`);
        const fromSnap = fromRef ? store.listGraphSnapshots({ scope: "repository" }).find((x) => x.id === fromRef || x.commit?.startsWith(fromRef) || x.graphVersion.startsWith(fromRef)) : null;
        const a = runGovernance({ repositorySnapshots: repositorySnapshots(fromRef), metaSnapshot: opts["meta-from"] ?? null, asOf: opts["as-of"] ? asOf() : (fromSnap?.createdAt.slice(0, 10) ?? asOf()) });
        const b = runGovernance({ repositorySnapshots: repositorySnapshots(toRef), metaSnapshot: opts["meta-to"] ?? null, asOf: asOf() });
        const d = governanceDiff(a, b);
        await maybeExport("governance-diff", d, [...d.newViolations.map((v) => ({ change: "new", ...violationRow(v) })), ...d.resolvedViolations.map((v) => ({ change: "resolved", ...violationRow(v) }))]);
        output(() => [
          `Governance diff  ${a.summary.outcome} -> ${b.summary.outcome}`,
          `  from ${snapshotText(a)}`,
          `  to   ${snapshotText(b)}`,
          `  new ${d.newViolations.length}  resolved ${d.resolvedViolations.length}  unchanged ${d.unchanged}  status changes ${d.statusChanges.length}  severity changes ${d.severityChanges.length}`,
          `  newly expired exceptions: ${d.newlyExpiredExceptions.join(", ") || "-"}  newly active exceptions: ${d.newlyActiveExceptions.join(", ") || "-"}`,
          ...(d.newViolations.length ? ["", "New violations (drift from declared architecture)", ...d.newViolations.slice(0, rowLimit()).map(violationText)] : []),
          ...(d.resolvedViolations.length ? ["", "Resolved violations", ...d.resolvedViolations.slice(0, rowLimit()).map(violationText)] : []),
          ...d.statusChanges.map((c) => `  status ${c.id} ${c.rule}: ${c.from} -> ${c.to}`),
        ].join("\n"), d);
        exitFor(d.newViolations.some((v) => v.status === "VIOLATION" && SEVERITIES.indexOf(v.severity) >= SEVERITIES.indexOf(severityOpt(opts["fail-on"], "ERROR"))) ? "FAIL" : d.newViolations.some((v) => v.status === "VIOLATION") ? "WARN" : "PASS");
        break;
      }
      case "validate-enterprise": {
        const cfg = enterpriseConfig(false);
        if (cfg.errors.length) {
          output(() => `Enterprise metadata ${cfg.file}: ${cfg.errors.length} errors\n${cfg.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`, cfg.errors);
          process.exitCode = 2;
          break;
        }
        output(() => `Enterprise metadata ${cfg.file ?? "(none)"} is valid: ${cfg.organizations.length} organizations, ${cfg.businessUnits.length} business units, ${cfg.teams.length} teams, ${cfg.ownership.rules.length} ownership rules, ${cfg.classification.rules.length} classification rules, ${cfg.criticality.length} criticality rules, ${cfg.exposure.length} exposure rules, ${cfg.boundaries.length} trust boundaries, ${cfg.approvedCrossings.length} approved crossings`, { file: cfg.file, fingerprint: cfg.fingerprint, teams: cfg.teams.length, rules: cfg.ownership.rules.length });
        break;
      }
      case "security":
      case "security-posture": {
        const m = enterpriseModel();
        const p = posture(m, opts.env);
        const findings = m.findings.filter((f) => !opts.env || f.environment === opts.env.toLowerCase() || f.environment === null);
        await maybeExport(command, { posture: p, ...(command === "security" ? { findings } : {}), snapshots: m.snapshots, enterprise: m.config }, Object.entries(p).flatMap(([section, v]) => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (x && typeof x === "object" ? Object.entries(x).map(([kk, n]) => ({ section, metric: `${k}.${kk}`, value: n })) : [{ section, metric: k, value: x }])) : [{ section, metric: section, value: v }])));
        const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${k}=${n}`).join(" ") || "-";
        output(() => [
          `Security posture${p.environment ? ` (environment ${p.environment})` : ""}  ${enterpriseHeader(m)}`,
          `  services            ${p.services.total}  exposure: ${kv(p.services.byExposure)}`,
          `  endpoints           ${p.endpoints.total}  exposure: ${kv(p.endpoints.byExposure)}`,
          `    protection        ${kv(p.endpoints.byProtection)}`,
          `    public endpoints  ${p.endpoints.public}  protection: ${kv(p.endpoints.publicByProtection)}`,
          `    observed authentication ${p.endpoints.withObservedAuthentication}  observed authorization ${p.endpoints.withObservedAuthorization}  unknown protection ${p.endpoints.unknownProtection}`,
          `  secret references   ${p.secrets.total}  providers: ${kv(p.secrets.byProvider)}  states: ${kv(p.secrets.byState)}  (values are never collected)`,
          `  resources           ${p.resources.total}  sensitive ${p.resources.sensitive}  types: ${kv(p.resources.byType)}  classification: ${kv(p.resources.byClassification)}`,
          `  external integrations ${p.externalIntegrations}`,
          `  trust-boundary crossings ${p.trustBoundaryCrossings.total} (not approved ${p.trustBoundaryCrossings.unapproved})  ${kv(p.trustBoundaryCrossings.byBoundary)}`,
          `  security flows      ${kv(p.securityFlows)}  (sensitive data flows from public entry points: ${p.sensitiveDataFlows})`,
          `  ownership           ${p.ownership.components} components  ${kv(p.ownership.byState)}`,
          `  findings            ${p.findings.total}  severity: ${kv(p.findings.bySeverity)}`,
          ...(command === "security" ? ["", `Findings by category: ${kv(p.findings.byCategory)}`, "", ...findings.slice(0, rowLimit()).map(findingText), findings.length > rowLimit() ? `(${findings.length - rowLimit()} more; 'security-findings --limit N', --json or --out)` : ""] : []),
          ...m.warnings.map((w) => `warning: ${w}`),
        ].filter((x) => x !== "").join("\n"), command === "security" ? { posture: p, findings, warnings: m.warnings, snapshots: m.snapshots, enterprise: m.config } : p);
        break;
      }
      case "security-findings": {
        const m = enterpriseModel();
        let list = m.findings;
        if (opts.severity) list = list.filter((f) => opts.severity!.toUpperCase().split(",").includes(f.severity));
        if (opts.category) list = list.filter((f) => opts.category!.toUpperCase().split(",").includes(f.category));
        if (opts.state) list = list.filter((f) => f.state === opts.state!.toUpperCase());
        if (opts.env) list = list.filter((f) => f.environment === opts.env!.toLowerCase());
        if (opts.owner) list = list.filter((f) => f.owners.includes(opts.owner!) || (opts.owner === "none" && !f.owners.length));
        if (opts.entity) list = list.filter((f) => [f.source, f.target].some((e) => e && `${e.qualifiedName ?? ""} ${e.name} ${e.id}`.toLowerCase().includes(opts.entity!.toLowerCase())));
        if (opts.repo) list = list.filter((f) => f.repository === catalogRef(opts.repo).name);
        await maybeExport(command, { findings: list, snapshots: m.snapshots, enterprise: m.config }, list.map(findingRow));
        output(() => (list.length ? [`${list.length} findings  ${enterpriseHeader(m)}`, ...list.slice(0, rowLimit()).map(findingText), list.length > rowLimit() ? `(${list.length - rowLimit()} more; --limit N, --json or --out)` : ""].filter(Boolean).join("\n") : "No matching security findings."), list);
        break;
      }
      case "security-endpoints": {
        const m = enterpriseModel();
        let list = m.endpoints;
        if (opts.exposure) list = list.filter((e) => e.exposure === opts.exposure!.toUpperCase());
        if (opts.protection) list = list.filter((e) => opts.protection!.toUpperCase().split(",").includes(e.protection));
        if (opts.app) list = list.filter((e) => e.service?.name.toLowerCase() === opts.app!.toLowerCase());
        if (opts.env) list = list.filter((e) => e.publicEnvironments.includes(opts.env!.toLowerCase()));
        if (opts.criticality) list = list.filter((e) => e.service && opts.criticality!.toUpperCase().split(",").includes(m.criticality.get(e.service.id)?.level ?? ""));
        if (opts.repo) list = list.filter((e) => e.endpoint.repository === catalogRef(opts.repo).name);
        const rows = list.map((e) => ({ id: e.endpoint.id, endpoint: `${e.method ?? ""} ${e.route ?? e.endpoint.name}`.trim(), service: e.service?.name ?? null, repository: e.endpoint.repository, exposure: e.exposure, publicEnvironments: e.publicEnvironments.map((x) => x ?? "(unscoped)").join(";"), protection: e.protection, authentication: e.authentication, policies: e.authorization.policies.join(";"), roles: e.authorization.roles.join(";"), schemes: e.authorization.schemes.join(";"), evidence: e.evidence.join(" | "), exposurePath: e.exposurePath.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}`).join(" | "), location: e.endpoint.location }));
        await maybeExport(command, { endpoints: list, snapshots: m.snapshots }, rows);
        output(() => (list.length ? [table(rows.slice(0, rowLimit()).map((r) => [r.exposure, r.protection, r.service ?? "-", r.endpoint, r.repository ?? "-", r.publicEnvironments || "-", r.policies || r.roles || "-"]), ["exposure", "protection", "service", "endpoint", "repository", "public in", "policies/roles"]), list.length > rowLimit() ? `(${list.length - rowLimit()} more; --limit N)` : "", `${list.length} endpoints; 'security-findings --entity <route>' or --json shows evidence and exposure path`].filter(Boolean).join("\n") : "No matching endpoints."), list);
        break;
      }
      case "secrets": {
        const m = enterpriseModel();
        let list = m.secrets;
        if (opts.state) list = list.filter((s) => s.state === opts.state!.toUpperCase());
        if (opts.source) list = list.filter((s) => s.provider === opts.source);
        if (opts.env) list = list.filter((s) => s.environments.includes(opts.env!.toLowerCase()));
        if (opts.repo) list = list.filter((s) => s.secret.repository === catalogRef(opts.repo).name);
        const rows = list.map((s) => ({ id: s.secret.id, name: s.name, kind: s.secret.kind, provider: s.provider, state: s.state, detection: s.detection, repository: s.secret.repository, source: s.source, environments: s.environments.join(";"), consumers: s.consumers.map((c) => `${c.entity.kind}:${c.entity.name}`).join(";"), services: [...new Set(s.consumers.flatMap((c) => c.services.map((x) => x.name)))].join(";"), valueStored: false }));
        await maybeExport(command, { secrets: list, snapshots: m.snapshots }, rows);
        output(() => (list.length ? [table(rows.slice(0, rowLimit()).map((r) => [r.provider, r.state, r.name, r.repository ?? "-", r.source ?? "-", r.environments || "-", r.services || r.consumers || "-"]), ["provider", "state", "secret", "repository", "source", "environment", "consumers"]), list.length > rowLimit() ? `(${list.length - rowLimit()} more; --limit N)` : "", "Secret values are never read into the graph, stored, or printed."].filter(Boolean).join("\n") : "No secret references detected."), list);
        break;
      }
      case "sensitive-resources": {
        const m = enterpriseModel();
        let list = opts["show-all"] ? m.resources : m.resources.filter((r) => r.sensitive);
        if (opts.classification) list = list.filter((r) => opts.classification!.toUpperCase().split(",").includes(r.classification ?? "UNCLASSIFIED"));
        if (opts.env) list = list.filter((r) => r.environments.includes(opts.env!.toLowerCase()));
        const rows = list.map((r) => {
          const o = ownerOf(m, r.resource.id).record;
          return { id: r.resource.id, resource: r.resource.name, type: r.resourceType, technology: r.technology, identity: r.identity, local: r.local, classification: r.classification ?? "UNCLASSIFIED", sensitive: r.sensitive, classificationSources: r.classificationSources.join(" | "), owners: o?.owners.map((x) => x.id).join(";") ?? "", ownership: o?.state ?? "UNOWNED", accessedBy: [...new Set(r.accessors.flatMap((a) => a.services.map((s) => s.name)))].join(";"), backing: r.backing.map((b) => `${b.workload.qualifiedName ?? b.workload.name}${b.image ? ` (${b.image})` : ""}`).join(";"), environments: r.environments.join(";"), boundary: m.zones.get(r.resource.id) ?? null };
        });
        await maybeExport(command, { resources: list, snapshots: m.snapshots }, rows);
        output(() => (list.length ? [table(rows.slice(0, rowLimit()).map((r) => [r.classification, r.type, r.resource, r.ownership + (r.owners ? ` ${r.owners}` : ""), r.accessedBy || "-", r.boundary ?? "-", r.classificationSources || "-"]), ["classification", "type", "resource", "ownership", "accessed by", "boundary", "classification evidence"]), opts["show-all"] ? "" : "(sensitive resources only; --show-all lists every detected resource)"].filter(Boolean).join("\n") : `No ${opts["show-all"] ? "" : "sensitive "}resources detected${opts["show-all"] ? "" : "; classify resources in enterprise metadata or use --show-all"}.`), list);
        break;
      }
      case "trust-boundaries":
      case "security-flows": {
        const m = enterpriseModel();
        if (command === "security-flows") {
          const rows = m.flows.map((f) => ({ id: f.id, kind: f.kind, entry: f.entry.name, target: f.target.name, classification: f.classification, services: f.services.map((s) => s.name).join(" -> "), entryProtection: Object.entries(f.entryProtection).map(([k, n]) => `${k}=${n}`).join(";"), crossings: f.crossings.join(";"), environments: f.environments.join(";"), path: f.path.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}`).join(" | ") }));
          await maybeExport(command, { flows: m.flows, snapshots: m.snapshots }, rows);
          output(() => (m.flows.length ? m.flows.slice(0, rowLimit()).map((f) => [`${f.kind}  public-internet -> ${f.entry.name} ${f.services.length > 1 ? `-> ${f.services.slice(1).map((s) => s.name).join(" -> ")} ` : ""}-> ${f.target.name} [${f.classification ?? "UNCLASSIFIED"}]  (${f.id})`, `    entry protection: ${Object.entries(f.entryProtection).map(([k, n]) => `${k}=${n}`).join(" ") || "no public endpoints"}  crossings: ${f.crossings.join(", ") || "-"}  environments: ${f.environments.join(",") || "-"}`, ...f.path.map((p, i) => `    ${"  ".repeat(Math.min(i, 6))}${p.from.kind} ${p.from.qualifiedName ?? p.from.name} -[${p.relationship.type}/${p.relationship.evidence}${p.relationship.scope === "enterprise" ? " derived" : ""}]-> ${p.to.kind} ${p.to.qualifiedName ?? p.to.name}${p.relationship.location ? `  @ ${p.relationship.location}` : ""}`)].join("\n")).join("\n") : "No security flows from public entry points to resources."), m.flows);
          break;
        }
        let crossings = m.crossings;
        if (opts.status === "unapproved") crossings = crossings.filter((c) => c.approved === false);
        const rows = crossings.map((c) => ({ id: c.id, dimension: c.dimension, from: c.from.name, fromKind: c.from.kind, to: c.to.name, toKind: c.to.kind, fromBoundary: c.fromBoundary, toBoundary: c.toBoundary, flow: c.flowKind, approved: c.approved === null ? "unreviewed" : String(c.approved), environments: c.environments.join(";"), path: c.path.map((p) => `${p.from.name} -[${p.relationship.type}]-> ${p.to.name}${p.relationship.location ? ` @ ${p.relationship.location}` : ""}`).join(" | ") }));
        const members = new Map<string, number>();
        for (const z of m.zones.values()) members.set(z, (members.get(z) ?? 0) + 1);
        await maybeExport(command, { crossings, zones: Object.fromEntries(members), snapshots: m.snapshots }, rows);
        output(() => [
          `Trust boundaries  ${enterpriseHeader(m)}`,
          table([["public-internet", "public", "(built-in entry point)"], ...enterpriseConfig().boundaries.map((b) => [b.id, b.kind, b.environments.length ? `environments ${b.environments.join(",")}` : `${members.get(b.id) ?? 0} members`])], ["boundary", "kind", "membership"]),
          "",
          `Crossings (${crossings.length})`,
          ...crossings.slice(0, rowLimit()).map((c) => `  [${c.approved === null ? "unreviewed" : c.approved ? "approved" : "NOT APPROVED"}] ${c.fromBoundary} -> ${c.toBoundary}: ${c.from.kind} ${c.from.name} -> ${c.to.kind} ${c.to.name} (${c.flowKind}${c.environments.length ? `, env ${c.environments.join(",")}` : ""})\n      ${c.path.map((p) => `${p.from.name} -[${p.relationship.type}${p.relationship.scope === "enterprise" ? " derived" : ""}]-> ${p.to.name}`).join(" | ") || "(declared exposure)"}`),
        ].join("\n"), { crossings, zones: Object.fromEntries(members) });
        break;
      }
      case "ownership":
      case "owners":
      case "unowned":
      case "ownership-conflicts": {
        const m = enterpriseModel();
        if (command === "ownership" && args[0]) {
          const e = modelEntity(m, args[0]);
          const { record, via } = ownerOf(m, e.id);
          output(() => record ? [
            `${record.component.kind} ${record.component.qualifiedName ?? record.component.name}  [${record.component.repository ?? "-"}]${via !== "component" ? `  (resolved via ${via})` : ""}`,
            `  ownership ${record.state}: ${record.owners.map((o) => `${o.id} (${o.kind}${o.businessUnit ? `, ${o.businessUnit}` : ""}${o.organization ? `, ${o.organization}` : ""})`).join(", ") || "-"}`,
            `  resolution: ${record.resolution}`,
            ...(record.maintainers.length ? [`  maintainers: ${record.maintainers.map((o) => o.id).join(", ")}`] : []),
            `  criticality ${m.criticality.get(record.component.id)?.level ?? "-"}  relationship ${record.relationship}`,
            "  evidence:",
            ...record.claims.map((c) => `    [${c.source}${c.inherited ? ", inherited" : ""}${c.definitive ? "" : ", ambiguous"}${c.role === "maintainer" ? ", maintainer" : ""}] ${c.owner || "(no owner)"}: ${c.evidence}`),
            ...(!record.claims.length ? ["    (no ownership evidence)"] : []),
          ].join("\n") : `${label(e as never)}: ${via}; ownership UNOWNED`, { record, via });
          break;
        }
        let list = m.ownership;
        if (command === "unowned") list = list.filter((o) => o.state === "UNOWNED" || o.state === "OWNER_UNKNOWN");
        if (command === "ownership-conflicts") list = list.filter((o) => o.state === "CONFLICT");
        if (command === "owners") list = list.filter((o) => o.owners.length);
        if (opts.category) list = list.filter((o) => opts.category!.toUpperCase().split(",").includes(o.category));
        else if (command !== "ownership-conflicts") list = list.filter((o) => !["API"].includes(o.category) || o.component.kind === "Api");
        if (opts.kind) list = list.filter((o) => opts.kind!.split(",").includes(o.component.kind));
        if (opts.owner) list = list.filter((o) => o.owners.some((x) => x.id === opts.owner));
        if (opts.criticality) list = list.filter((o) => opts.criticality!.toUpperCase().split(",").includes(m.criticality.get(o.component.id)?.level ?? ""));
        if (opts.repo) list = list.filter((o) => o.component.repository === catalogRef(opts.repo).name);
        const rows = list.map((o) => ({ id: o.component.id, kind: o.component.kind, component: o.component.qualifiedName ?? o.component.name, category: o.category, repository: o.component.repository, state: o.state, owners: o.owners.map((x) => x.id).join(";"), sources: [...new Set(o.claims.map((c) => `${c.source}${c.inherited ? "(inherited)" : ""}`))].join(";"), criticality: m.criticality.get(o.component.id)?.level ?? null, resolution: o.resolution, evidence: o.claims.map((c) => c.evidence).join(" | ") }));
        await maybeExport(command, { ownership: list, snapshots: m.snapshots, enterprise: m.config }, rows);
        if (command === "ownership") {
          const byCat = new Map<string, Record<string, number>>();
          for (const o of list) byCat.set(o.category, { ...(byCat.get(o.category) ?? {}), [o.state]: (byCat.get(o.category)?.[o.state] ?? 0) + 1 });
          output(() => [`Ownership  ${enterpriseHeader(m)}`, table([...byCat].sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => [c, s.OWNED ?? 0, s.CONFLICT ?? 0, s.OWNER_UNKNOWN ?? 0, s.UNOWNED ?? 0]), ["category", "OWNED", "CONFLICT", "OWNER_UNKNOWN", "UNOWNED"]), "", "(endpoint/operation rows are hidden unless --category API; 'ownership <component>' shows evidence; 'owners', 'unowned', 'ownership-conflicts', 'teams' list details)"].join("\n"), { summary: Object.fromEntries(byCat), records: list });
          break;
        }
        output(() => (list.length ? [table(rows.slice(0, rowLimit()).map((r) => [r.state, r.category, `${r.kind} ${r.component}`, r.repository ?? "-", r.owners || "-", r.criticality ?? "-", r.sources || "-"]), ["state", "category", "component", "repository", "owners", "criticality", "sources"]), list.length > rowLimit() ? `(${list.length - rowLimit()} more; --limit N, --category C, --json or --out)` : "", ...(command === "ownership-conflicts" ? list.slice(0, rowLimit()).map((o) => `  ${o.component.name}: ${o.resolution}\n${o.claims.map((c) => `      ${c.owner}: ${c.evidence}`).join("\n")}`) : [])].filter(Boolean).join("\n") : `No ${command === "unowned" ? "unowned components" : command === "ownership-conflicts" ? "ownership conflicts" : "owned components"} match.`), list);
        break;
      }
      case "teams": {
        const m = enterpriseModel();
        const deps = teamDependencies(m);
        if (args[0]) {
          const t = m.teams.find((x) => x.team.id === args[0] || x.team.name === args[0]);
          if (!t) throw new CliError(`no team or owner '${args[0]}' (declare teams in enterprise metadata; CODEOWNERS owners appear as principal:@handle)`);
          const owned = m.ownership.filter((o) => o.owners.some((x) => x.id === t.team.id));
          const dependsOn = deps.edges.filter((d) => d.from.id === t.team.id);
          const dependents = deps.edges.filter((d) => d.to.id === t.team.id);
          const data = { team: t.team, owns: t.owns, components: owned.map((o) => ({ ...o.component, category: o.category, state: o.state })), dependsOn, dependents };
          await maybeExport(command, data, owned.map((o) => ({ team: t.team.id, category: o.category, kind: o.component.kind, component: o.component.qualifiedName ?? o.component.name, repository: o.component.repository, state: o.state })));
          output(() => [
            `${t.team.kind === "team" ? "Team" : "Owner"} ${t.team.id}${t.team.name !== t.team.id ? ` (${t.team.name})` : ""}${t.team.businessUnit ? `  business unit ${t.team.businessUnit}` : ""}${t.team.organization ? `  organization ${t.team.organization}${t.team.externalOrganization ? " (external)" : ""}` : ""}`,
            `  owns: ${Object.entries(t.owns).map(([k, n]) => `${k}=${n}`).join(" ") || "-"}  maintains ${t.maintains}`,
            ...["REPOSITORY", "SERVICE", "MESSAGE", "CONTRACT", "RESOURCE", "INFRASTRUCTURE", "EXTERNAL_INTEGRATION", "SECRET", "PROJECT"].flatMap((c) => {
              const l = owned.filter((o) => o.category === c);
              return l.length ? [`  ${c} (${l.length}): ${l.slice(0, rowLimit()).map((o) => `${o.component.name}${o.state === "CONFLICT" ? " [CONFLICT]" : ""}`).join(", ")}`] : [];
            }),
            `  APIs: ${owned.filter((o) => o.component.kind === "Api").map((o) => o.component.name).join(", ") || "-"}  (${owned.filter((o) => o.category === "API").length} API elements incl. operations/endpoints)`,
            `Depends on teams (${dependsOn.length}):`,
            ...dependsOn.map((d) => `  -> ${d.to.id}${d.crossOrganization ? " [cross-organization]" : d.crossBusinessUnit ? " [cross-business-unit]" : ""}: ${d.dependencies.slice(0, 5).map((x) => `${x.from.name} -${x.kind}-> ${x.to.name}`).join("; ")}${d.dependencies.length > 5 ? ` (+${d.dependencies.length - 5})` : ""}`),
            `Teams depending on ${t.team.id} (${dependents.length}):`,
            ...dependents.map((d) => `  <- ${d.from.id}${d.crossOrganization ? " [cross-organization]" : d.crossBusinessUnit ? " [cross-business-unit]" : ""}: ${d.dependencies.slice(0, 5).map((x) => `${x.from.name} -${x.kind}-> ${x.to.name}`).join("; ")}${d.dependencies.length > 5 ? ` (+${d.dependencies.length - 5})` : ""}`),
          ].join("\n"), data);
          break;
        }
        await maybeExport(command, { teams: m.teams, dependencies: deps }, m.teams.map((t) => ({ team: t.team.id, kind: t.team.kind, businessUnit: t.team.businessUnit, organization: t.team.organization, ...t.owns, maintains: t.maintains })));
        output(() => [table(m.teams.map((t) => [t.team.id, t.team.kind, t.team.businessUnit ?? "-", t.team.organization ?? "-", Object.entries(t.owns).map(([k, n]) => `${k}=${n}`).join(" ") || "-", deps.edges.filter((d) => d.from.id === t.team.id).length, deps.edges.filter((d) => d.to.id === t.team.id).length]), ["team/owner", "kind", "business unit", "organization", "owns", "depends on", "depended on by"]), m.teams.length ? "" : "No teams: declare them in enterprise metadata (--enterprise) or add CODEOWNERS."].filter(Boolean).join("\n"), { teams: m.teams, dependencies: deps });
        break;
      }
      case "team-dependencies": {
        const m = enterpriseModel();
        const deps = teamDependencies(m);
        let edges = deps.edges;
        if (args[0]) edges = edges.filter((d) => (opts.reverse ? d.to.id : d.from.id) === args[0]);
        await maybeExport(command, { ...deps, edges }, edges.flatMap((d) => d.dependencies.map((x) => ({ fromTeam: d.from.id, toTeam: d.to.id, crossBusinessUnit: d.crossBusinessUnit, crossOrganization: d.crossOrganization, from: x.from.name, to: x.to.name, kind: x.kind, basis: x.basis, path: x.path }))));
        output(() => (edges.length ? [...edges.map((d) => `${d.from.id} -> ${d.to.id}${d.crossOrganization ? "  [cross-organization]" : d.crossBusinessUnit ? "  [cross-business-unit]" : ""}  (${d.dependencies.length})\n${d.dependencies.slice(0, rowLimit()).map((x) => `    ${x.from.kind} ${x.from.name} -${x.kind}-> ${x.to.kind} ${x.to.name}  via ${x.basis}`).join("\n")}`), `${deps.unattributed} dependencies have an unowned end and are not attributed to a team (see 'unowned')`].join("\n") : `No cross-team dependencies${args[0] ? ` for ${args[0]}` : ""}; ${deps.unattributed} dependencies have an unowned end.`), { ...deps, edges });
        break;
      }
      case "team-impact": {
        if (!args.length) throw new CliError("team-impact requires one or more entity references");
        const m = enterpriseModel();
        const seeds = args.map((a) => target(a));
        const r = teamImpact(m, analysisGraph(), seeds, impactOptions("impact"));
        await maybeExport(command, r, [...r.impactedTeams.flatMap((t) => t.components.map((c) => ({ team: t.team.id, crossTeam: t.crossTeam, crossOrganization: t.crossOrganization, category: c.category, component: c.component.qualifiedName ?? c.component.name, level: c.level, dependency: c.dependency, via: c.via, path: c.path }))), ...r.unownedImpacted.map((u) => ({ team: null, crossTeam: null, crossOrganization: null, category: null, component: u.component?.name ?? u.entity, level: u.level, dependency: u.ownership, via: u.entity, path: u.path }))]);
        output(() => [
          `Team impact of ${r.seeds.map((s) => `${s.entity.kind} ${s.entity.qualifiedName ?? s.entity.name}`).join(", ")}`,
          ...r.seeds.map((s) => `  owner: ${s.owners.map((o) => o.id).join(", ") || s.ownership}${s.resolvedVia !== "component" ? ` (via ${s.resolvedVia})` : ""}`),
          `  ${r.impact.total} impacted entities (${Object.entries(r.impact.byLevel).map(([k, n]) => `${k}=${n}`).join(" ")})${r.impact.truncated ? " TRUNCATED" : ""}; ${r.impactedTeams.length} impacted teams, ${r.impactedTeams.filter((t) => t.crossTeam).length} other than the owners; cross-organization: ${r.crossOrganizationTeams.join(", ") || "-"}`,
          ...r.impactedTeams.flatMap((t) => [
            `${t.crossTeam ? "IMPACTED TEAM" : "OWNING TEAM"} ${t.team.id}${t.crossOrganization ? " [other organization]" : ""}  ${Object.entries(t.byDependency).map(([k, n]) => `${k}=${n}`).join(" ")}`,
            ...t.components.slice(0, rowLimit()).map((c) => `    ${c.level} ${c.category} ${c.component.kind} ${c.component.qualifiedName ?? c.component.name}${c.component.location ? ` @ ${c.component.location}` : ""}  (${c.dependency}; via ${c.via})\n        ${c.path}`),
            ...(t.components.length > rowLimit() ? [`    (${t.components.length - rowLimit()} more; --limit N)`] : []),
          ]),
          ...(r.unownedImpacted.length ? [`Impacted components without a resolved owner (${r.unownedImpacted.length}):`, ...r.unownedImpacted.slice(0, rowLimit()).map((u) => `    ${u.level} ${u.component ? `${u.component.kind} ${u.component.name}` : u.entity} ${u.ownership}`)] : []),
        ].join("\n"), r);
        break;
      }
      case "security-impact": {
        const m = enterpriseModel();
        if (!args[0]) throw new CliError("security-impact requires a secret, resource, endpoint or service reference");
        const named = [...m.secrets.filter((s) => s.secret.id === args[0] || s.name === args[0]).map((s) => s.secret), ...m.resources.filter((r) => r.resource.id === args[0] || r.resource.name === args[0]).map((r) => r.resource)];
        if (named.length > 1) throw new CliError(`'${args[0]}' matches ${named.length} secrets/resources; use an id:\n${named.map((x) => `  ${x.id}  ${x.kind} ${x.qualifiedName ?? x.name}  [${x.repository ?? "-"}]${x.location ? ` @ ${x.location}` : ""}`).join("\n")}`);
        const ref = named.length ? named[0]!.id : target(args[0]).id;
        const r = securityImpact(m, analysisGraph(), ref, impactOptions("impact"));
        if (!r) throw new CliError(`'${args[0]}' is not a secret reference, resource, endpoint or service in the security graph`);
        await maybeExport(command, r, [...r.consumers.map((c) => ({ role: "consumer", entity: c.service.name, via: c.via, path: c.path })), ...(r.impact?.impacted ?? []).map((i) => ({ role: "impacted", ...impactRow(i) }))]);
        output(() => [
          `Security impact of ${r.component.kind} ${r.component.qualifiedName ?? r.component.name}  [${r.kind}${r.classification ? `, ${r.classification}` : ""}]  owners: ${r.owners.join(", ") || "none resolved"}`,
          `Direct consumers (${r.consumers.length}):`,
          ...r.consumers.slice(0, rowLimit()).map((c) => `  ${c.service.name} via ${c.via}\n      ${c.path || "-"}`),
          `Publicly exposed services in the blast radius: ${r.publicConsumers.join(", ") || "-"}`,
          ...(r.teams ? [`Teams: owners of consumers ${r.teams.owningTeams.join(", ") || "-"}; impacted teams ${r.teams.impactedTeams.map((t) => t.team.id).join(", ") || "-"}; unowned impacted components ${r.teams.unownedImpacted.length}`] : []),
          "",
          r.impact ? impactSummary(r.impact) : "No consuming service to propagate from.",
        ].join("\n"), r);
        break;
      }
      case "inventory": {
        const m = enterpriseModel();
        let rows = inventory(m);
        if (opts.category) rows = rows.filter((r) => opts.category!.toUpperCase().split(",").includes(r.category));
        if (opts.owner) rows = rows.filter((r) => r.owners.includes(opts.owner!));
        if (opts.criticality) rows = rows.filter((r) => opts.criticality!.toUpperCase().split(",").includes(r.criticality ?? ""));
        if (opts.env) rows = rows.filter((r) => r.environments.includes(opts.env!.toLowerCase()));
        if (opts.repo) rows = rows.filter((r) => r.repository === catalogRef(opts.repo).name);
        await maybeExport(command, { inventory: rows, snapshots: m.snapshots }, rows.map((r) => ({ category: r.category, id: r.component.id, kind: r.component.kind, component: r.component.qualifiedName ?? r.component.name, repository: r.repository, environments: r.environments.join(";"), owners: r.owners.join(";"), ownership: r.ownership, criticality: r.criticality, classification: r.classification, exposure: r.exposure, detail: r.detail })));
        const counts = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.category] = (acc[r.category] ?? 0) + 1), acc), {});
        output(() => [`Governance inventory  ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`, table(rows.slice(0, rowLimit()).map((r) => [r.category, `${r.component.kind} ${r.component.name}`, r.repository ?? "-", r.owners.join(",") || r.ownership, r.criticality ?? "-", r.classification ?? "-", r.detail]), ["category", "component", "repository", "owners", "criticality", "classification", "detail"]), rows.length > rowLimit() ? `(${rows.length - rowLimit()} more; --category C, --limit N, --json or --out)` : ""].filter(Boolean).join("\n"), rows);
        break;
      }
      case "governance-context": {
        if (!args[0]) throw new CliError("governance-context requires an entity reference");
        let model: EnterpriseModel | null = null;
        const policies = policySet();
        const result = runGovernance({}, (x) => (model = x));
        const m = model as EnterpriseModel | null;
        if (!m) throw new CliError("enterprise model unavailable");
        const e = modelEntity(m, args[0]);
        const ev = m.evaluator;
        const g = m.graph.entities.get(e.id)!;
        const { record, via } = ownerOf(m, e.id);
        const rules = policies.rules.map((rule) => {
          const roles = [ev.matchesLifted(g, rule.from) ? "source (from)" : null, rule.to && ev.matchesLifted(g, rule.to) ? "target (to)" : null, rule.universe && ev.matchesLifted(g, rule.universe) ? "universe" : null, rule.require?.to && ev.matches(g, rule.require.to) ? "required target" : null].filter(Boolean);
          return roles.length ? { rule: rule.id, name: rule.name, policy: rule.policy, severity: rule.severity, mode: rule.mode, enabled: rule.enabled, roles } : null;
        }).filter((x): x is NonNullable<typeof x> => !!x);
        const involves = (v: Violation) => v.source.id === e.id || v.target?.id === e.id || v.path.some((p) => p.from.id === e.id || p.to.id === e.id) || v.ownership?.component?.id === e.id;
        const violations = result.violations.filter(involves);
        const findings = m.findings.filter((f) => f.source.id === e.id || f.target?.id === e.id);
        const data = { entity: m.evaluator.summary(g), facts: m.graph.facts.get(e.id) ?? {}, ownership: record, resolvedVia: via, criticality: m.criticality.get(e.id) ?? null, boundary: m.zones.get(e.id) ?? null, rules, violations, findings, snapshots: result.snapshots, policyFingerprint: result.policyFingerprint, enterprise: m.config };
        await maybeExport(command, data, [...rules.map((r) => ({ type: "rule", id: r.rule, detail: `${r.mode} ${r.severity} as ${r.roles.join("/")}` })), ...violations.map((v) => ({ type: "violation", id: v.id, detail: `${v.rule} ${v.status} ${v.message}` })), ...findings.map((f) => ({ type: "security-finding", id: f.id, detail: `${f.severity} ${f.category} ${f.message}` }))]);
        output(() => [
          `${g.kind} ${g.qualifiedName ?? g.name}  [${m.graph.repositoryName(g.repositoryId) ?? "-"}]`,
          `  facts: ${Object.entries(data.facts).map(([k, v]) => `${k}=${v.join(",")}`).join("  ") || "-"}`,
          `  ownership: ${record ? `${record.state} ${record.owners.map((o) => o.id).join(", ") || ""}${via !== "component" ? ` (via ${via})` : ""} - ${record.resolution}` : "UNOWNED (no ownable container)"}`,
          `  criticality: ${data.criticality ? `${data.criticality.level} (${data.criticality.rules.join(", ")})` : "-"}  trust boundary: ${data.boundary ?? "-"}`,
          `Governance controls that apply (${rules.length}):`,
          ...rules.map((r) => `  ${r.rule} [${r.severity}] ${r.mode}${r.enabled ? "" : " (disabled)"} as ${r.roles.join(", ")} - ${r.name} (${r.policy})`),
          `Violations involving it (${violations.length}):`,
          ...violations.slice(0, rowLimit()).map(violationText),
          `Security findings (${findings.length}):`,
          ...findings.slice(0, rowLimit()).map(findingText),
        ].join("\n"), data);
        break;
      }
      case "security-diff":
      case "ownership-diff": {
        const { from, to, fromLabel, toLabel } = enterpriseDiffModels();
        if (command === "ownership-diff") {
          const d = ownershipDiff(from, to);
          let changes = d.changes;
          if (opts.category) changes = changes.filter((c) => opts.category!.toUpperCase().split(",").includes(to.ownership.find((o) => o.component.id === c.subject.id)?.category ?? from.ownership.find((o) => o.component.id === c.subject.id)?.category ?? ""));
          await maybeExport(command, { from: fromLabel, to: toLabel, ...d, changes }, changes.map(changeRow));
          output(() => [`Ownership diff  ${fromLabel} -> ${toLabel}`, `  ${Object.entries(d.summary).map(([k, n]) => `${k}=${n}`).join("  ") || "no ownership changes"}`, ...changes.slice(0, rowLimit()).map(changeText), changes.length > rowLimit() ? `(${changes.length - rowLimit()} more; --category C, --limit N, --json or --out)` : ""].filter(Boolean).join("\n"), { from: fromLabel, to: toLabel, ...d, changes });
          break;
        }
        const d = securityDiff(from, to);
        await maybeExport(command, { from: fromLabel, to: toLabel, ...d }, d.changes.map(changeRow));
        output(() => [
          `Security posture diff  ${fromLabel} -> ${toLabel}`,
          table(d.posture.map((p) => [p.metric, p.before, p.after, p.after - p.before > 0 ? `+${p.after - p.before}` : String(p.after - p.before)]), ["indicator", "before", "after", "delta"]),
          `Changes: ${Object.entries(d.summary).map(([k, n]) => `${k}=${n}`).join("  ") || "none"}`,
          ...d.changes.slice(0, rowLimit()).map(changeText),
          d.changes.length > rowLimit() ? `(${d.changes.length - rowLimit()} more; --limit N, --json or --out)` : "",
        ].filter(Boolean).join("\n"), { from: fromLabel, to: toLabel, ...d });
        break;
      }
      case "ownership-history": {
        if (!args[0]) throw new CliError("ownership-history requires a component reference");
        const repoEntry = opts.repo ? catalogRef(opts.repo) : null;
        const current = enterpriseModel();
        const e = modelEntity(current, args[0]);
        const repositoryId = repoEntry?.repositoryId ?? current.graph.entities.get(e.id)?.repositoryId;
        if (!repositoryId) throw new CliError("ownership-history needs --repo for components without a repository");
        const cfg = enterpriseConfig();
        const history = store.listGraphSnapshots({ scope: "repository", repositoryId }).map((s) => {
          const set = snapshotSet(store, { repositories: [repositoryId], repositorySnapshots: { [repositoryId]: s.id }, includeMeta: false });
          const m = buildEnterpriseModel(store, set, cfg);
          const r = m.ownership.find((o) => o.component.id === e.id);
          return { snapshot: s.id, commit: s.commit, createdAt: s.createdAt, present: !!m.graph.entities.get(e.id), state: r?.state ?? null, owners: r?.owners.map((o) => o.id) ?? [], evidence: r?.claims.map((c) => c.evidence) ?? [] };
        });
        const rows = history.map((h, i) => ({ ...h, change: i === 0 ? "first" : JSON.stringify([history[i - 1]!.state, history[i - 1]!.owners]) === JSON.stringify([h.state, h.owners]) ? "unchanged" : !history[i - 1]!.present ? "introduced" : !h.present ? "removed" : "changed" }));
        await maybeExport(command, { component: e.id, history: rows }, rows.map((r) => ({ ...r, owners: r.owners.join(";"), evidence: r.evidence.join(" | ") })));
        output(() => [`Ownership history of ${e.kind} ${e.qualifiedName ?? e.name} (${rows.length} snapshots)`, table(rows.map((r) => [r.snapshot, r.commit?.slice(0, 12) ?? "-", r.present ? (r.state ?? "-") : "(absent)", r.owners.join(",") || "-", r.change]), ["snapshot", "commit", "ownership", "owners", "change"]), ...rows.filter((r) => r.change !== "unchanged").map((r) => `  ${r.commit?.slice(0, 12) ?? r.snapshot}: ${r.evidence.join(" | ") || "(no ownership evidence)"}`)].join("\n"), rows);
        break;
      }
      case "register": {
        if (!args[0]) throw new CliError("register requires a path");
        const entry = registerRepository(store, args[0], !opts["no-semantic"]);
        output(() => `Registered ${entry.name} (${entry.repositoryId}) identity=${entry.identity} status=${entry.status}`, entry);
        break;
      }
      case "analyze-repo":
      case "analyze-all": {
        const entries = command === "analyze-all" ? store.listCatalog() : [catalogRef(args[0])];
        const results: { repository: string; status: string; commit: string | null; detail: string }[] = [];
        for (const entry of entries) {
          if (!entry.localPath || !existsSync(entry.localPath)) {
            results.push({ repository: entry.name, status: "UNAVAILABLE", commit: entry.analyzedCommit, detail: `path not available: ${entry.localPath ?? "-"}` });
            continue;
          }
          try {
            const { run } = await analyzeRepository(entry.localPath, store, defaultPlugins(), { semantic: entry.semantic }, log);
            results.push({ repository: entry.name, status: "READY", commit: run.commit, detail: `entities=${run.stats.entities} relationships=${run.stats.relationships} ${run.stats.durationMs}ms` });
          } catch (error) {
            results.push({ repository: entry.name, status: "FAILED", commit: null, detail: error instanceof Error ? error.message : String(error) });
          }
        }
        output(() => table(results.map((r) => [r.repository, r.status, r.commit?.slice(0, 12) ?? "-", r.detail]), ["repository", "status", "commit", "detail"]), results);
        break;
      }
      case "repositories": {
        const list = metaQuery.catalog();
        output(() => table(list.map((c) => [c.entry.name, c.status, c.entry.identity, c.entry.analyzedCommit?.slice(0, 12) ?? "-", c.entry.graphVersion?.slice(0, 12) ?? "-", c.entry.analyzedAt ?? "-", c.reason ?? ""]), ["repository", "status", "identity", "commit", "graph version", "analyzed at", "note"]), list);
        break;
      }
      case "repository": {
        const entry = catalogRef(args[0]);
        const status = metaQuery.repository(entry.repositoryId)!;
        const profile = metaQuery.profile(entry.repositoryId);
        const connections = metaQuery.connections(entry.repositoryId);
        output(() => [
          `${entry.name}  [${status.status}]${status.reason ? `  ${status.reason}` : ""}`,
          `  id ${entry.repositoryId}  identity ${entry.identity}`,
          `  url ${entry.url ?? "-"}  provider ${entry.provider ?? "-"}  organization ${entry.organization ?? "-"}  default branch ${entry.defaultBranch ?? "-"}`,
          `  analyzed ${entry.analyzedCommit ?? "-"} at ${entry.analyzedAt ?? "-"}  graph version ${entry.graphVersion ?? "-"}  semantic ${entry.semantic}`,
          `  path ${entry.localPath ?? "-"}  graph scope repository:${entry.repositoryId}`,
          `  roles ${profile.roles.join(", ")}  projects=${profile.projects} applications=${profile.applications} apis=${profile.apis} operations=${profile.operations} messages=${profile.messages} pipelines=${profile.pipelines} images=${profile.images} workloads=${profile.workloads} charts=${profile.charts}`,
          "",
          `Cross-repository connections (${connections.length})`,
          ...connections.map((c) => `  ${c.direction === "out" ? `-[${c.relationship.type}]->` : `<-[${c.relationship.type}]-`} ${c.other?.name ?? "?"}  ${metaRelLine(c.relationship)}`),
        ].join("\n"), { entry, status: status.status, reason: status.reason, profile, connections });
        break;
      }
      case "metagraph": {
        const sub = args[0] ?? "stats";
        if (sub === "build") {
          const { snapshot, excluded } = buildMetaGraph(store, log, opts.force);
          output(() => [
            `MetaGraph snapshot ${snapshot.id}`,
            ...snapshot.repositories.map((r) => `  ${r.name} @ ${r.commit?.slice(0, 12) ?? "-"} graph ${r.graphVersion?.slice(0, 12)} [${r.status}]`),
            ...excluded.map((e) => `  ${e.name} excluded [${e.status}] ${e.reason ?? ""}`),
            table(Object.entries(snapshot.categories).map(([k, v]) => [k, v.recomputed ? "recomputed" : "unchanged", v.relationships, v.unresolved, v.conflicts]), ["category", "state", "relationships", "unresolved", "conflicts"]),
          ].join("\n"), { snapshot, excluded });
        } else if (sub === "stats") {
          const st = metaQuery.stats();
          output(() => [
            `repositories=${st.repositories} snapshot=${st.snapshot?.id ?? "(none)"} unresolved=${st.unresolved} conflicts=${st.conflicts}`,
            table(Object.entries(st.relationshipsByType).map(([k, n]) => [k, n]), ["relationship", "count"]),
            table(Object.entries(st.relationshipsByEvidence).map(([k, n]) => [k, n]), ["evidence", "count"]),
            table(Object.entries(st.metaEntitiesByKind).map(([k, n]) => [k, n]), ["meta entity", "count"]),
            table(Object.entries(st.unresolvedByCategory).map(([k, n]) => [k, n]), ["unresolved category", "count"]),
          ].join("\n"), st);
        } else if (sub === "snapshots") {
          const list = store.listMetaSnapshots();
          output(() => list.map((s) => `${s.id}  ${s.createdAt}\n${s.repositories.map((r) => `  ${r.name} @ ${r.commit?.slice(0, 12) ?? "-"} graph ${r.graphVersion?.slice(0, 12)} [${r.status}]`).join("\n")}\n  resolvers ${Object.entries(s.resolverVersions).map(([k, v]) => `${k}@${v}`).join(" ")}  categories ${Object.entries(s.categories).map(([k, v]) => `${k}:${v.recomputed ? "recomputed" : "unchanged"}`).join(" ")}`).join("\n\n") || "No snapshots.", list);
        } else if (sub === "unresolved") {
          const list = store.findMetaUnresolved({ repositoryId: opts.repo ? catalogRef(opts.repo).repositoryId : undefined });
          const ents = metaQuery.entities(list.map((u) => u.sourceId));
          output(() => table(list.slice(0, intOpt(opts.limit, 200)).map((u) => [u.category, String(u.metadata.category), repoName(u.repositoryId), ents.get(u.sourceId)?.qualifiedName ?? ents.get(u.sourceId)?.name ?? u.sourceId, u.targetDisplay, u.reason]), ["resolver", "category", "repository", "source", "target", "reason"]), list);
        } else if (sub === "conflicts") {
          const list = store.findMetaConflicts({});
          output(() => list.map((c) => `[${c.severity}] ${c.kind}: ${c.description}`).join("\n") || "No cross-repository conflicts.", list);
        } else if (sub === "export") {
          const format = (opts.format ?? "json") as ExportFormat;
          if (!["json", "jsonl", "csv"].includes(format)) throw new CliError("--format must be json, jsonl, or csv");
          if (!opts.out) throw new CliError("--out is required");
          const counts = await exportMetaGraph(store, format, opts.out);
          output(() => `Exported MetaGraph ${format} to ${opts.out}: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`, counts);
        } else throw new CliError(`unknown metagraph subcommand '${sub}'`);
        break;
      }
      case "connections": {
        const repo = args[0] ? catalogRef(args[0]) : null;
        const list = metaQuery.connections(repo?.repositoryId);
        output(() => (list.length ? table(list.map((c) => [repoName(c.relationship.sourceRepositoryId), c.relationship.type, c.relationship.targetRepositoryId ? repoName(c.relationship.targetRepositoryId) : (c.other?.name ?? "?"), c.relationship.evidence, c.relationship.confidence, c.relationship.environment ?? "-", (c.relationship.metadata.evidenceKinds as string[]).join(", ")]), ["from", "relationship", "to", "evidence", "confidence", "environment", "evidence kinds"]) : "No cross-repository connections."), list);
        break;
      }
      case "providers":
      case "api-providers": {
        if (!args[0]) throw new CliError("providers requires an API name or \"VERB /path\"");
        const list = metaQuery.providers(args[0]);
        output(() => (list.length ? list.map((p) => `${p.subject.kind} ${p.subject.qualifiedName ?? p.subject.name}  provided by ${p.repository ?? "-"}${p.providedBy.length ? ` (${p.providedBy[0]!.evidence})` : ""}${p.endpoints.length ? `\n  implemented by ${p.endpoints.map((e) => `${e.qualifiedName ?? e.name} ${where(e)}`).join("; ")}` : ""}`).join("\n") : `No API or operation matches '${args[0]}'.`), list);
        break;
      }
      case "api-consumers": {
        if (!args[0]) throw new CliError("api-consumers requires an API name or \"VERB /path\"");
        const r = metaQuery.consumers(args[0]);
        output(() => [
          `Subjects: ${r.subjects.map((s) => `${s.qualifiedName ?? s.name} [${repoName(s.repositoryId)}]`).join(", ") || "none"}`,
          `Cross-repository consumers (${r.crossRepository.length})`,
          ...r.crossRepository.map((c) => `  ${repoName(c.relationship.sourceRepositoryId)}: ${c.consumer?.qualifiedName ?? c.consumer?.name ?? "?"} -[${c.relationship.type}]-> ${c.operation?.qualifiedName ?? c.operation?.name}  ${metaRelLine(c.relationship)}`),
          `Same-repository consumers (${r.sameRepository.length})`,
          ...r.sameRepository.map((c) => `  ${repoName(c.relationship.repositoryId)}: ${c.consumer?.qualifiedName ?? "?"} -> ${c.operation?.qualifiedName}  (${c.relationship.evidence})`),
        ].join("\n"), r);
        break;
      }
      case "message-publishers":
      case "message-consumers": {
        if (!args[0]) throw new CliError(`${command} requires a message name`);
        const r = metaQuery.messages(args[0]);
        const pub = command === "message-publishers";
        output(() => [
          ...r.contracts.map((c) => [
            `Shared contract ${c.contract.qualifiedName} (${c.contract.metadata.identityTier})  members: ${c.members.map((m) => `${repoName(m.relationship.targetRepositoryId)}:${m.message?.qualifiedName}`).join(", ")}`,
            ...(pub ? c.publishers : c.consumers).map((x) => `  ${pub ? "published" : "consumed"} by ${x.repository?.name ?? "?"}  ${metaRelLine(x.relationship)}`),
            ...(pub ? [] : c.handlers.map((h) => `    handler ${repoName(h.relationship.targetRepositoryId)}:${h.handler?.qualifiedName ?? h.handler?.name}`)),
            ...(c.transports.length ? [`  transports ${c.transports.map((t) => t.qualifiedName).join(", ")}`] : []),
          ].join("\n")),
          ...(r.unlinked.length ? ["Not linked across repositories:", ...r.unlinked.map((u) => `  ${u.repository}: ${u.message.qualifiedName}  ${pub ? `publishers=${u.publishers.length}` : `consumers=${u.consumers.length}`}${u.unresolved.length ? `  (${u.unresolved[0]!.reason})` : ""}`)] : []),
        ].join("\n") || `No message named '${args[0]}'.`, r);
        break;
      }
      case "shared-packages": {
        const list = metaQuery.sharedPackages(opts.package ?? args[0]);
        output(() => (list.length ? table(list.slice(0, intOpt(opts.limit, 100)).map((p) => [p.pkg?.name ?? "?", p.users.length, p.users.map((u) => `${repoName(u.sourceRepositoryId)}(${(u.metadata.versions as string[]).join("/") || "?"})`).join(", "), [...new Set(p.users.map((u) => String(u.metadata.classification)))].join(","), p.producers.map((x) => `${repoName(x.relationship.sourceRepositoryId)}:${x.project?.name}`).join(", ") || "-"]), ["package", "repos", "used by (versions)", "classification", "produced by"]) : "No packages shared between catalog repositories."), list);
        break;
      }
      case "external-systems": {
        const list = metaQuery.externalSystems(args[0]);
        output(() => (list.length ? table(list.map((x) => [x.system.kind, x.system.name, (x.system.metadata.systemKinds as string[] | undefined)?.join(",") ?? "-", x.repositories.join(", "), x.environments.join(",") || "-", x.sources.length]), ["kind", "system", "system kind", "repositories", "environments", "evidence facts"]) : "No external systems."), list);
        break;
      }
      case "metagraph-topology": {
        const entry = catalogRef(args[0]);
        const t = metaQuery.topology(entry.repositoryId, opts.reverse, intOpt(opts.depth, 3), opts.env);
        output(() => [
          `${entry.name} (${opts.reverse ? "upstream" : "downstream"})`,
          ...t.steps.map((s) => `${"  ".repeat(s.depth)}${repoName(s.repository)}  via ${s.via.type} from ${repoName(s.from)}  ${metaRelLine(s.via)}`),
          ...t.external.map((r) => `  external ${t.externalEntities.get(r.targetId)?.name ?? r.targetId} (${r.type})  ${metaRelLine(r)}`),
        ].join("\n"), t);
        break;
      }
      case "infrastructure": {
        const rows = infraQuery.statistics(repoId(store));
        output(() => `Infrastructure graph (static declarations; evidence DECLARED, not runtime state)\n${table(rows.map(([k, v]) => [k, v]), ["", "count"])}`, Object.fromEntries(rows.map(([k, v]) => [k.trim(), v])));
        break;
      }
      case "pipelines": {
        const list = infraQuery.pipelines(repoId(store));
        output(() => (list.length ? table(list.map((p) => [p.pipeline.qualifiedName ?? p.pipeline.name, (p.pipeline.metadata.triggers as string[]).join("; ") || "-", p.stages.length, p.artifacts.length, names(p.builds), p.deploys.length]), ["pipeline", "triggers", "stages", "artifacts", "builds", "deploys"]) : "No Azure Pipelines detected."), list);
        break;
      }
      case "pipeline": {
        const ref = args[0];
        if (!ref) throw new CliError("pipeline requires an id or file");
        const match = infraQuery.list(["Pipeline"], repoId(store)).filter((p) => p.id === ref || p.qualifiedName === ref || p.name === ref);
        if (match.length !== 1) throw new CliError(match.length ? `'${ref}' is ambiguous` : `no pipeline matches '${ref}'`);
        const d = infraQuery.pipeline(match[0]!.id)!;
        const m = d.pipeline.metadata;
        const jobLines = (j: NonNullable<typeof d>["jobs"][number], indent: string) => [
          `${indent}${j.job.metadata.deploymentJob ? "deployment" : "job"} ${j.job.name}${j.dependsOn.length ? `  dependsOn=${j.dependsOn.join(",")}` : ""}${j.environment.length ? `  environment=${j.environment.join(",")}` : ""}${j.job.metadata.pool ? `  pool=${j.job.metadata.pool}` : ""}${j.job.metadata.condition ? `  condition=${j.job.metadata.condition}` : ""}`,
          ...j.tasks.map((t) => `${indent}  - ${t.metadata.task ?? t.metadata.stepType}: ${t.name}  [${(t.metadata.taskKinds as string[]).join(",")}]  ${where(t)}`),
          ...(j.consumes.length ? [`${indent}  consumes: ${names(j.consumes)}`] : []),
          ...(j.deploys.length ? [`${indent}  deploys: ${names(j.deploys)}`] : []),
        ];
        output(() => [
          `Pipeline ${d.pipeline.qualifiedName}  (${where(d.pipeline)})`,
          `  triggers   ${(m.triggers as string[]).join("; ") || "-"}${m.manualOnly ? " (manual only)" : ""}`,
          `  variables  ${(m.variables as string[]).join(", ") || "-"}${(m.variableGroups as string[]).length ? `  groups: ${(m.variableGroups as string[]).join(", ")}` : ""}`,
          `  templates  ${(m.templates as string[]).join(", ") || "-"}`,
          ...d.stages.flatMap((s) => [`  stage ${s.stage.name}${s.dependsOn.length ? `  dependsOn=${s.dependsOn.join(",")}` : ""}`, ...s.jobs.flatMap((j) => jobLines(j, "    "))]),
          ...d.jobs.flatMap((j) => jobLines(j, "  ")),
          `  artifacts  ${names(d.artifacts)}`,
          `  builds     ${names(d.builds)}`,
          `  deploys    ${names(d.deploys)}`,
          `  secrets/config  ${d.variables.map((v) => `${v.kind === "SecretReference" ? "secret:" : ""}${v.name}`).join(", ") || "-"}`,
          ...(d.unresolved.length ? ["  unresolved", ...d.unresolved.map((u) => `    -[${u.type}]-> ? ${u.targetDisplay} (${u.reason})`)] : []),
        ].join("\n"), d);
        break;
      }
      case "artifacts": {
        const list = infraQuery.artifacts(repoId(store));
        output(() => (list.length ? table(list.map((a) => [a.artifact.name, String(a.artifact.metadata.artifactType), names(a.producers), names(a.contains), names([...a.packagedAs, ...a.packages]), names(a.deployments)]), ["artifact", "type", "produced by", "contains", "packaged as / packages", "deployed by jobs"]) : "No build artifacts detected."), list);
        break;
      }
      case "images": {
        const list = infraQuery.images(repoId(store));
        output(() => (list.length ? table(list.map((i) => [i.image.qualifiedName ?? i.image.name, i.image.external ? "base" : i.image.metadata.unnamed ? "unnamed" : i.image.metadata.parameterizedName ? "parameterized" : "declared", i.tags.join(",") || "-", names(i.builtBy), names(i.packages), i.image.external ? `${i.baseOf.length} stages` : names(i.deployments)]), ["image", "identity", "tags", "built by", "packages", "deployed by / base of"]) : "No container images detected."), list);
        break;
      }
      case "docker": {
        const list = infraQuery.dockerfiles(repoId(store));
        output(() => list.map((d) => [
          `${d.dockerfile.name}`,
          ...d.stages.map((s) => `  ${s.stage.metadata.final ? "*" : "-"} ${s.stage.name}  FROM ${s.stage.metadata.base}${s.dependsOn.length ? `  depends on ${s.dependsOn.join(", ")}` : ""}${(s.stage.metadata.dotnetCommands as string[]).length ? `  [${(s.stage.metadata.dotnetCommands as string[]).join("; ")}]` : ""}`),
          `  exposes ${(d.dockerfile.metadata.exposedPorts as string[]).join(",") || "-"}  entrypoint ${(d.dockerfile.metadata.entrypoint as string[]).join(" ") || "-"}  env ${d.environmentVariables.map((e) => e.name).join(",") || "-"}`,
          `  builds  ${names(d.images)}`,
          `  packages ${d.projects.map((p) => `${p.project.name} (${p.basis.join("; ")})`).join(", ") || "-"}`,
          ...d.unresolved.map((u) => `  unresolved -[${u.type}]-> ${u.targetDisplay} (${u.reason})`),
        ].join("\n")).join("\n\n") || "No Dockerfiles detected.", list);
        break;
      }
      case "helm": {
        const list = infraQuery.helm(repoId(store));
        output(() => list.map((c) => [
          `${c.chart.qualifiedName} ${c.chart.metadata.version ?? ""} (appVersion ${c.chart.metadata.appVersion ?? "-"})  ${where(c.chart)}`,
          ...c.releases.map((r) => `  release ${r.release.name}  values=${(r.release.metadata.valueFiles as string[]).join(",") || "-"}${r.environments.length ? `  environment=${r.environments.join(",")}` : ""}${r.deployedBy.length ? `  deployed by ${names(r.deployedBy)}` : ""}\n    image=${r.release.metadata.imageRepository ?? "-"}:${r.release.metadata.imageTag ?? "-"}  resources: ${r.resources.map((x) => `${x.metadata.resourceKind ?? x.kind}/${x.name}`).join(", ") || "-"}`),
        ].join("\n")).join("\n\n") || "No Helm charts detected.", list);
        break;
      }
      case "deployments": {
        const list = infraQuery.workloads(repoId(store)).filter((w) => !opts.app || w.applications.some((a) => a.name.toLowerCase() === opts.app!.toLowerCase()));
        output(() => (list.length ? table(list.map((w) => [w.workload.qualifiedName ?? w.workload.name, w.containers.flatMap((c) => c.images.map((i) => `${i.image.qualifiedName}${i.tag ? `:${i.tag}` : ""}`)).join(",") || "-", names(w.applications), names(w.services), w.environments.join(",") || "-", w.release?.name ?? "-", where(w.workload)]), ["workload", "images", "runs application", "services", "environment", "helm release", "location"]) : "No Kubernetes workloads detected."), list);
        break;
      }
      case "k8s-services": {
        const list = infraQuery.services(repoId(store));
        output(() => (list.length ? table(list.map((s) => [s.service.qualifiedName ?? s.service.name, String(s.service.metadata.serviceType), (s.service.metadata.ports as string[]).join(","), (s.service.metadata.selector as string[]).join(",") || "-", names(s.workloads), names(s.ingresses), s.unresolved.map((u) => u.reason).join("; ")]), ["service", "type", "ports", "selector", "routes to", "ingress", "unresolved"]) : "No Kubernetes services detected."), list);
        break;
      }
      case "ingress": {
        const list = infraQuery.ingresses(repoId(store));
        output(() => (list.length ? table(list.map((i) => [i.ingress.qualifiedName ?? i.ingress.name, String(i.ingress.metadata.ingressClass ?? "-"), (i.ingress.metadata.routes as string[]).join("; "), names(i.services.map((s) => s.service)), names(i.tlsSecrets), i.unresolved.map((u) => u.targetDisplay).join(",")]), ["ingress", "class", "routes", "services", "tls secrets", "unresolved backends"]) : "No ingresses detected."), list);
        break;
      }
      case "configuration": {
        const list = infraQuery.configuration({ repositoryId: repoId(store), kind: args[0], role: opts.role, source: opts.source });
        output(() => (list.length ? table(list.map((c) => [c.entity.kind, c.entity.qualifiedName ?? c.entity.name, String(c.entity.metadata.source ?? "-"), c.entity.kind === "SecretReference" ? "(secret reference, value not stored)" : `${c.entity.metadata.valueKind ?? "-"}${c.entity.metadata.value ? ` ${c.entity.metadata.value}` : ""}${Array.isArray(c.entity.metadata.hosts) && c.entity.metadata.hosts.length ? ` hosts=${c.entity.metadata.hosts.join(",")}` : ""}`, String(c.entity.metadata.role ?? "-"), c.environments.join(",") || String(c.entity.metadata.environment ?? "-"), names(c.supplies)]), ["kind", "configuration", "source", "value", "role", "environment", "supplies code key"]) : "No configuration detected."), list);
        break;
      }
      case "environments": {
        const list = infraQuery.environments(repoId(store));
        output(() => (list.length ? table(list.map((e) => [e.environment.name, (e.environment.metadata.basis as string[]).join(","), Object.entries(e.byKind).map(([k, n]) => `${k}=${n}`).join(" ")]), ["environment", "evidence", "declared resources"]) : "No environments declared."), list);
        break;
      }
      case "topology": {
        const list = infraQuery.topology({ repositoryId: repoId(store), application: opts.app ?? args[0] });
        output(() => (list.length ? list.map((t) => [
          `${t.application ? `Application ${t.application.name}` : "(no application link)"}${t.pipelines.length ? `  <- built by ${names(t.pipelines)}` : ""}`,
          `  -> image    ${t.image ? t.image.qualifiedName : "-"}`,
          `  -> workload ${t.workload ? `${t.workload.qualifiedName}  ${where(t.workload)}` : "-"}${t.environment.length ? `  [${t.environment.join(",")}]` : ""}`,
          `  -> service  ${names(t.services)}`,
          `  -> ingress  ${names(t.ingresses)}`,
        ].join("\n")).join("\n") + "\n(declared topology from static files; not observed runtime state)" : "No topology could be established."), list);
        break;
      }
      case "unresolved-infrastructure": {
        const list = infraQuery.unresolved(repoId(store));
        const ents = new Map(query.find({ ids: list.map((u) => u.sourceId) }).map((e) => [e.id, e]));
        output(() => table(list.map((u) => [u.type, u.targetDisplay, ents.get(u.sourceId)?.qualifiedName ?? u.sourceId, String(u.metadata.category ?? ""), u.reason, u.provenance[0]?.location ? `${u.provenance[0].location.file}:${u.provenance[0].location.startLine}` : ""]), ["type", "target", "source", "category", "reason", "location"]), list);
        break;
      }
      case "unresolved": {
        const list = store.findUnresolved({ repositoryId: repoId(store), limit: intOpt(opts.limit, 100) });
        const ents = new Map(query.find({ ids: list.map((u) => u.sourceId) }).map((e) => [e.id, e]));
        output(() => table(list.map((u) => [u.type, u.targetDisplay, ents.get(u.sourceId)?.qualifiedName ?? u.sourceId, u.reason, u.provenance[0]?.location ? `${u.provenance[0].location.file}:${u.provenance[0].location.startLine}` : ""]), ["type", "target", "source", "reason", "location"]), list);
        break;
      }
      case "diagnostics": {
        const list = store.findDiagnostics({ repositoryId: repoId(store), limit: intOpt(opts.limit, 200) });
        output(() => table(list.map((d) => [d.severity, d.category, d.plugin, d.code, d.file ?? "", d.message]), ["severity", "category", "plugin", "code", "file", "message"]), list);
        break;
      }
      case "conflicts": {
        const list = store.findConflicts({ repositoryId: repoId(store) });
        output(() => (list.length ? list.map((c) => `[${c.severity}/${c.status}] ${c.kind}: ${c.description}\n  facts: ${c.factIds.join(", ")}`).join("\n") : "No conflicts."), list);
        break;
      }
      case "provenance": {
        if (!args[0]) throw new CliError("provenance requires an entity, relationship, or unresolved id");
        const report = query.provenance(args[0]) ?? query.provenance(one(query, args[0], store).id);
        if (!report) throw new CliError(`nothing found for ${args[0]}`);
        output(() => [
          `${report.subjectType} ${args[0]}`,
          report.temporal ? `  first seen ${report.temporal.firstSeenCommit ?? "-"} (run ${report.temporal.firstSeenRun}), last seen ${report.temporal.lastSeenCommit ?? "-"} (run ${report.temporal.lastSeenRun})` : "",
          ...report.provenance.map((p) => `  - ${p.plugin}/${p.extractor} via ${p.mechanism}${p.resolver ? ` resolver=${p.resolver}` : ""} @ ${p.location ? `${p.location.file}:${p.location.startLine}:${p.location.startColumn}` : "-"}  repo=${p.repositoryId ?? "-"} commit=${p.commit?.slice(0, 12) ?? "-"} v${p.analysisVersion}`),
        ].filter(Boolean).join("\n"), report);
        break;
      }
      case "shared": {
        const shared = query.sharedAcrossRepositories();
        const repoNames = new Map(store.listRepositories().map((r) => [r.id, r.name]));
        output(() => (shared.length ? table(shared.map((s) => [label(s.entity), s.repositories.map((id) => repoNames.get(id) ?? id).join(", ")]), ["entity", "repositories"]) : "No entities are shared across repositories yet."), shared);
        break;
      }
      case "export": {
        const format = (opts.format ?? "json") as ExportFormat;
        if (!["json", "jsonl", "csv"].includes(format)) throw new CliError("--format must be json, jsonl, or csv");
        if (!opts.out) throw new CliError("--out is required");
        const counts = await exportGraph(store, format, opts.out, repoId(store));
        output(() => `Exported ${format} to ${opts.out}: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`, counts);
        break;
      }
      case "backup": {
        if (!opts.out) throw new CliError("--out is required");
        store.backup(opts.out);
        output(() => `Backup written to ${opts.out} (consistent single-file copy of the local graph; no network, no vendor).`, { out: opts.out });
        break;
      }
      case "restore": {
        const from = opts.from;
        if (!from) throw new CliError("--from <backup> is required");
        if (!existsSync(from)) throw new CliError(`backup not found: ${from}`);
        const target = opts.db ?? process.env.VOGOBAN_DB ?? ".vogoban/graph.db";
        if (target.startsWith("postgres")) throw new CliError("restore targets a local sqlite store; set --db to a file path");
        const check = new SqliteGraphStore(from);
        check.stats();
        check.close();
        store.close();
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
        copyFileSync(from, target);
        output(() => `Restored ${target} from ${from}. Graph, MetaGraph, analysis and local MCP use the restored store immediately.`, { target, from });
        return;
      }
      case "sync": {
        const path = args[0] ?? ".";
        const syncMode = opts.from || opts.to || opts.base || opts.head ? "commit-range" : opts.staged ? "staged" : opts.since ? "since" : "working-tree";
        const result = await syncRepository(path, store, defaultPlugins(), {
          mode: syncMode,
          sinceCommit: opts.since ?? null,
          fromCommit: opts.from ?? opts.base ?? null,
          toCommit: opts.to ?? opts.head ?? null,
          forceFull: opts.full,
          semantic: !opts["no-semantic"],
          lockDir: join(dbDir, "locks"),
        }, log);
        let metaError: string | null = null;
        if (opts.meta && result.status === "SUCCESS") {
          try {
            const { snapshot } = buildMetaGraph(store, log, false);
            log.info("sync.metagraph", { id: snapshot.id });
          } catch (error) {
            metaError = error instanceof Error ? error.message : String(error);
          }
        }
        const payload = { ...result, metaGraph: opts.meta ? (metaError ? { status: "FAILED", error: metaError } : { status: "OK" }) : undefined };
        if (!opts.quiet || opts.json) output(() => [renderSync(result), result.degradedPlugins.length ? `  WARNING degraded graph: plugin(s) failed: ${result.degradedPlugins.join(", ")}` : null, metaError ? `  MetaGraph update FAILED (previous MetaGraph snapshot preserved): ${metaError}` : null].filter(Boolean).join("\n"), payload);
        if (result.status === "FAILED" || metaError) process.exitCode = 3;
        else if (result.degradedPlugins.length) process.exitCode = 4;
        else if (opts["strict-incremental"] && result.fallbackReason) {
          process.exitCode = 5;
          if (!opts.json) console.error(`strict incremental: the incremental request ran as a full rebuild (${result.fallbackCode}); exit 5`);
        }
        break;
      }
      case "sync-status": {
        const path = args[0] ?? ".";
        const s = syncStatus(path, store, defaultPlugins());
        output(() => [
          `${s.repository}: ${s.state}`,
          `  analyzed commit  ${s.analyzedCommit?.slice(0, 12) ?? "(never)"}`,
          `  working commit   ${s.workingCommit?.slice(0, 12) ?? "(no git)"}${s.dirty ? " (dirty)" : ""}`,
          `  up to date       ${s.upToDate ? "yes" : "no"}  ·  changed files ${s.changedFiles}`,
          `  last sync        ${s.lastSyncAt ? `${s.lastSyncAt} (${s.lastSyncMode}, ${s.lastSyncStatus})` : "(none)"}`,
          s.fullRebuildRequired ? `  full rebuild     required — ${s.fullRebuildReason}` : null,
          s.fallbackReason ? `  last fallback    ${s.fallbackReason}` : null,
        ].filter(Boolean).join("\n"), s);
        if (s.state === "FAILED") process.exitCode = 3;
        break;
      }
      case "sync-changes": {
        const path = args[0] ?? ".";
        const root = repositoryRoot(path);
        const cfg = loadRepoConfig(root);
        const repo = discoverRepository(path, cfg.repository);
        const cat = store.getCatalog(repo.id);
        const chMode = opts.from || opts.to ? "commit-range" : opts.staged ? "staged" : opts.since ? "since" : "working-tree";
        const built = changeSetFromGit({ repositoryId: repo.id, repositoryIdentity: repo.identity, root, mode: chMode, baseCommit: opts.since ?? cat?.analyzedCommit ?? "HEAD", fromCommit: opts.from, toCommit: opts.to });
        if ("error" in built) throw new CliError(built.error);
        const cs = built.changeSet;
        const sum = summarizeChangeSet(cs);
        output(() => [
          `${repo.name}: ${sum.total} change(s) [${cs.source}] ${cs.previousCommit?.slice(0, 12) ?? "?"} -> ${cs.currentCommit?.slice(0, 12) ?? "working tree"}${cs.dirty ? " (dirty)" : ""}`,
          `  +${sum.added} ~${sum.modified} -${sum.deleted} renamed ${sum.renamed}  ·  categories: ${Object.entries(sum.byCategory).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
          ...cs.changes.slice(0, rowLimit()).map((c) => `  ${c.status.padEnd(8)} ${c.category.padEnd(14)} ${c.previousPath ? `${c.previousPath} -> ` : ""}${c.path}`),
          cs.changes.length > rowLimit() ? `  (${cs.changes.length - rowLimit()} more; --limit N or --json)` : null,
        ].filter(Boolean).join("\n"), { changeSet: cs, summary: sum });
        break;
      }
      case "sync-history": {
        const path = args[0] ?? ".";
        const repo = discoverRepository(path, loadRepoConfig(repositoryRoot(path)).repository);
        const history = syncHistory(store, repo.id).slice(-rowLimit()).reverse();
        output(() => history.length ? table(history.map((h) => [h.timestamp, h.mode, h.status, h.currentCommit?.slice(0, 12) ?? "-", String(h.metrics.changedFiles), String(h.metrics.durationMs), h.fallbackReason ?? ""]), ["timestamp", "mode", "status", "commit", "files", "ms", "fallback"]) : "No sync history.", history);
        break;
      }
      case "hooks": {
        const sub = args[0];
        const path = args[1] ?? ".";
        const command = process.env.VOGOBAN_BIN ?? "vogoban";
        if (sub === "install") {
          const mode = (opts["hook-mode"] ?? "notify") as HookMode;
          if (!["notify", "background", "sync"].includes(mode)) throw new CliError("--hook-mode must be notify, background, or sync");
          const results = installHooks(path, command, mode, opts.force, opts.db ? resolve(opts.db) : null);
          output(() => [`Git hooks (${mode}) using command '${command}':`, ...results.map((r) => `  ${r.hook}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`)].join("\n"), results);
        } else if (sub === "uninstall") {
          const results = uninstallHooks(path);
          output(() => ["Removed vogoban Git hooks:", ...results.map((r) => `  ${r.hook}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`)].join("\n"), results);
        } else if (sub === "status" || !sub) {
          const results = hookStatus(path);
          output(() => ["Git hook status:", ...results.map((r) => `  ${r.hook}: ${r.installed ? `installed (${r.mode})` : "not installed"}`)].join("\n"), results);
        } else throw new CliError("hooks subcommand must be install, uninstall, or status");
        break;
      }
      default:
        throw new CliError(`unknown command '${command}'\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  if (error instanceof CliError || error instanceof AnalysisError || error instanceof SyncUsageError) {
    if (opts.json) console.log(JSON.stringify({ error: error.message.split("\n")[0], category: error instanceof AnalysisError ? error.category : "cli", details: error instanceof CliError ? (error.payload ?? null) : null }, null, 2));
    else console.error(error.message);
    process.exit(2);
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    console.error(`path not found: ${(error as NodeJS.ErrnoException).path ?? "(unknown)"}`);
    process.exit(2);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (opts.json) console.log(JSON.stringify({ error: message.split("\n")[0], category: "internal", details: null }, null, 2));
  console.error(process.env.VOGOBAN_DEBUG === "1" && error instanceof Error ? (error.stack ?? message) : message);
  process.exit(1);
});
