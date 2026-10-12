# Vogoban

A .NET-first code and architecture graph engine. Vogoban analyzes a repository into a persistent, provenance-aware graph (projects, assemblies, namespaces, types, members, calls, endpoints, DI registrations, messages), including TypeScript/JavaScript frontends (Angular, React, Next.js) linked to the .NET APIs they call, and is structured so multiple repositories can live side by side as independent RepositoryGraphs inside one MetaGraph store.

## Requirements

- Linux x86_64 (or the container image). Windows is not a supported or validated platform; use the container image or WSL2.
- Bun ≥ 1.3 (validated with 1.3.14)
- No Node.js, npm or `node_modules` of the analyzed repository is needed for TypeScript/JavaScript analysis (the TypeScript compiler ships with Vogoban).
- .NET SDK 8+ for Roslyn semantic analysis (`dotnet` on `PATH`, `~/.dotnet/dotnet`, or `VOGOBAN_DOTNET`). Without it Vogoban falls back to Tree-sitter declarations and records a `semantic-unavailable` diagnostic.

The Roslyn analyzer in `semantic/Vogoban.Roslyn` is built automatically on first use and rebuilt when its sources change. It evaluates each project with the SDK's MSBuild (per target framework) to get the real compile items, global usings, defines, package references and assets file, then compiles every target framework with Roslyn and merges the results. If MSBuild evaluation fails it falls back to Vogoban's static project parsing and records a `project-evaluation-failed` diagnostic (`VOGOBAN_MSBUILD_EVALUATION=0` forces the fallback).

## Documentation

Full documentation lives in [docs/](docs/README.md): [installation](docs/installation.md), [getting started](docs/getting-started.md), the [five-minute quickstart](docs/quickstart.md), [concepts](docs/concepts.md), the [CLI reference](docs/cli/overview.md), feature guides, operations and the [architecture](docs/architecture/overview.md). Contributors start at [development](docs/advanced/development.md).

## Install

```sh
bun install -g ./vogoban-0.18.0-src.tar.gz   # not published to npm; see docs/installation.md
export PATH="$HOME/.bun/bin:$PATH"
vogoban --version
```

## Usage

```sh
vogoban analyze /path/to/repo          # writes ./.vogoban/graph.db
vogoban stats
vogoban projects                         # project graph + cycle detection
vogoban project Orders.Api               # frameworks, assembly, references, packages, compilation state
vogoban find OrderService --kind Type
vogoban show "MyApp.Services.OrderService"
vogoban callers "MyApp.Services.OrderService.Submit(MyApp.Order)" --depth 2 --dispatch
vogoban callees "MyApp.CheckoutService.Checkout()"
vogoban implementations IOrderService
vogoban inheritance "MyApp.Services.OrderService"
vogoban references "MyApp.Domain.Order"
vogoban deps Core --kind Project --reverse --depth 3   # blast radius
vogoban path <from> <to>
vogoban applications                     # ASP.NET Core / generic-host apps and detection signals
vogoban endpoints --method POST --auth none-declared
vogoban endpoint "GET /api/orders/{id}"   # handler, binding sources, request/response, authorization
vogoban routes | services | registrations | middleware | hosted-services | authorization | config
vogoban apis | operations --source openapi | openapi | http-clients
vogoban operation "GET /orders/{id}"     # contract, implementations, callers, schemas
vogoban messages | message OrderSubmitted | publishers | consumers | transports
vogoban contract-provenance <id> | unresolved-contracts
vogoban infrastructure | pipelines | pipeline <file> | artifacts | images | docker | helm
vogoban deployments | k8s-services | ingress | configuration --role service-url | environments
vogoban topology --app Orders.Api         # application -> image -> workload -> service -> ingress
vogoban frontend | components --role hook | frontend-routes
vogoban frontend-chain "/todo" --kind FrontendRoute   # route -> component -> client -> API operation -> endpoint -> handler
vogoban azure functions | triggers | resources | messaging | infrastructure
vogoban azure flow "/orders/new" --kind FrontendRoute   # route -> API -> Service Bus -> Function -> Cosmos DB -> Bicep
vogoban unresolved | conflicts                     # analysis diagnostics: stats / export (diagnostics is an alias of privacy)
vogoban provenance <entity-or-relationship-id>
vogoban shared                           # entities referenced by more than one repository
vogoban export --format json|jsonl|csv --out graph.json
```

Every command accepts `--json` for stable machine-readable output and `--db` to choose the store. Entity references can be an id, a symbol key, a qualified name, or a name (ambiguous names list candidates).

For full semantic resolution of NuGet types, restore the target repository first (`dotnet restore`); Vogoban reads `obj/project.assets.json` for package compile references. Unrestored packages surface as unresolved references, never as guessed edges.

## Model

- **Entities** carry a deterministic id derived from a canonical key (repository identity, project path, Roslyn documentation-comment id + assembly), kind, layer, repository/project/assembly, symbol key, location, and provenance.
- **Relationships** use the canonical vocabulary in `src/graph/model.ts`, with an evidence level (`EXACT`, `COMPILER_RESOLVED`, `DECLARED`, `STRUCTURALLY_RESOLVED`, `INFERRED`, …), occurrence count, and up to 50 source locations of provenance.
- **Unresolved references** keep the caller, location, target display text, resolver, reason, the compiler diagnostic at that location, and a category (`missing-package`, `missing-assembly`, `missing-project`, `conditional-compilation`, `generated-dependency-unavailable`, `dependent-on-unresolved-type`, `overload-resolution`, `inaccessible`, `unknown-symbol`, `compilation-failure`, `analyzer-limitation`) instead of inventing a target.
- **Target frameworks**: multi-targeting projects are compiled once per framework against the matching reference pack (SDK packs, NuGet-cached targeting packs, `Microsoft.NETFramework.ReferenceAssemblies`, `NETStandard.Library`). Facts present in only some frameworks carry `targetFrameworks`; symbols inside `#if` regions carry `conditions`. Approximate reference packs are reported as diagnostics.
- **Symbol keys** are `<assembly>::<Roslyn documentation id>`. Framework (reference-pack) symbols use `@framework::<id>` so the same BCL type is one node across target frameworks and repositories; package and project symbols keep their assembly name.
- **Diagnostics** separate discovery, parser (Tree-sitter), semantic (Roslyn), framework, and resolver failures. **Conflicts** (e.g. duplicate endpoint routes) are recorded, not overwritten.
- External symbols (framework/NuGet) are global entities without a repository, so the same symbol referenced from two repositories is one node; repository facts keep their originating repository.
- Entities and relationships record first/last seen commit and run. Syntax facts are cached per file hash and Roslyn facts per project input hash, so unchanged repositories re-analyze from cache.

## Application graph

Framework plugins run over the Roslyn facts (never over syntax or storage) and add:

- **Application** entities for projects with an ASP.NET Core / generic-host / Blazor WebAssembly builder call, linked to the project (`DEFINES_APPLICATION`) and entry points (`IMPLEMENTED_BY`). Registrations, endpoints and middleware are attributed to an application when their registering method is reachable from its entry point through compiler-resolved calls; otherwise attribution falls back to the same project or a referencing application with `INFERRED` evidence. Test projects are not applications.
- **Endpoint** entities from attribute-routed and conventionally routed controllers (inherited routes, actions and authorization included) and minimal APIs (`Map*`, `MapMethods`, nested `MapGroup` prefixes, fluent metadata, method-group/lambda/local-function handlers). Each endpoint has `IMPLEMENTED_BY`/`ROUTES_TO` its handler method, parameter binding sources, `ACCEPTS_REQUEST`/`PRODUCES_RESPONSE` payload types (via the resolver chain in `response-types.ts`), and `REQUIRES_AUTHORIZATION`/`ALLOWS_ANONYMOUS` links to **AuthorizationMetadata**. Non-constant routes and unresolvable handlers become unresolved references.
- **ServiceRegistration** entities for every DI registration (generic, `typeof`, open generic, factory, instance, keyed, `TryAdd*`, `ServiceDescriptor`, typed `HttpClient`, `DbContext`, options, framework `Add*` calls) with lifetime, key and control-flow context as metadata, `REGISTERS` the service type and `RESOLVES_TO` the implementation; the service type also `RESOLVES_TO` each registered implementation. Multiple registrations are all kept and reported as conflicts.
- **HostedService**, ordered **Middleware** (`USES_MIDDLEWARE` with source order, `PRECEDES` only between unconditional registrations in the same method), **RouteGroup** and **ConfigurationReference** (configuration keys and environment variable names, never values).

## Contract graph

- **OpenAPI 3.x** (JSON/YAML) documents are found by name or by structural sniffing (`"openapi": "3…"`), parsed with local and relative-file `$ref` resolution, and stored as `ContractDocument` → `Api` → `ApiOperation` / `ApiSchema` entities with deterministic identity (API title + version + method + normalized path; component schemas by name, inline schemas by JSON pointer). Malformed, Swagger 2.0 and unresolved/external `$ref`s are diagnostics or unresolved references; the same operation defined differently in two documents is a conflict.
- **Code-first APIs**: every ASP.NET endpoint also yields an `ApiOperation` (per application and API version from `HasApiVersion`/`[ApiVersion]`/path segment). OpenAPI operations link `IMPLEMENTED_BY` endpoints by method + normalized route (+ operationId and version when present); unmatched operations stay `implementationStatus: unresolved`.
- **HTTP clients**: named, typed and Refit clients with base addresses (literal or configuration key, `USES_BASE_URL`), and static calls on `HttpClient`/JSON extensions/Refit attributes (URL templates resolved through locals, readonly fields and interpolation). Calls to dotted hosts become `CALLS_EXTERNAL_API`; relative/service-discovery calls link `CALLS_ENDPOINT` to local operations only when method + route (or route template) match a single provider (`INFERRED`); everything else is an unresolved reference with a category.
- **Messaging**: `Message` contracts keep C# semantic identity, fields and namespace version; transports (`Topic`/`Queue`, broker + kind + name) are separate. Plugins: MediatR (in-process `HANDLED_BY`), MassTransit, NServiceBus, Azure Service Bus, RabbitMQ.Client, Confluent.Kafka (external `PUBLISHES`/`SENDS_TO`/`CARRIES`/`CONSUMED_BY`/`ROUTES_TO`). Publishes typed as a base or abstract type are unresolved, not guessed. Same-named contracts carried by one transport with different fields are reported as conflicts.
- **Explicit configuration** (`vogoban.json` at the repository root) can add OpenAPI paths and describe custom messaging abstractions (publisher methods, handler interfaces, subscription methods, transport); facts from it carry `DECLARED` evidence.

## Frontend graph (TypeScript / JavaScript, Angular, React)

TypeScript and JavaScript go into the same RepositoryGraph as C#. Tree-sitter provides syntax facts, the TypeScript compiler API (restricted to repository files, never `node_modules`) is authoritative for semantics, and Angular and React are framework plugins over a shared frontend layer: npm packages and workspaces, tsconfig chains, module resolution, frontend applications, components, hooks, services, contexts, DI, templates, routes (`FrontendRoute`), guards, interceptors and lazy loading. `fetch`, axios and Angular `HttpClient` calls, generated NSwag clients included, get their URLs evaluated statically and go through the same API resolver as .NET clients. So a component reaches `ApiOperation` → ASP.NET Core endpoint → handler through stored relationships with evidence. Nothing from the repository is executed, `.env` secret values are never stored, and unresolvable URLs stay unresolved references. `frontend`, `components`, `frontend-routes` and `frontend-chain` are the frontend-specific commands. Impact, paths, ownership, governance, diff and the MetaGraph work on frontend entities unchanged. See [docs/features/frontend.md](docs/features/frontend.md) for what is extracted, the security boundaries, the verification results and the limitations.

## Azure graph

Azure Functions (isolated, in-process, `function.json`, Node v4), their triggers, bindings and Durable relationships, Azure SDK usage in .NET and TypeScript/JavaScript, Bicep / ARM / Terraform declarations (with symbolic evaluation of modules, parameters and Azure Verified Modules), .NET Aspire AppHost resources, `azure.yaml` hosting, identities, role assignments, Key Vault, networking, observability and APIM all go into the same RepositoryGraph. A resolver links code to the declared resources only through explicit names, settings, connection references and symbolic references, never name similarity, so chains such as frontend route → API → Service Bus → Function → Cosmos DB → Bicep resource → Function App are stored relationships with evidence, and the MetaGraph connects publishers, consumers and declarations across repositories. **This is static repository analysis: no Azure subscription is contacted, nothing is deployed or executed, and no secret value is stored.** `azure [summary|functions|triggers|resources|messaging|infrastructure|flow]` are thin views; every other command (impact, paths, security, governance, MCP) works on Azure entities. See [docs/features/azure.md](docs/features/azure.md).

## Infrastructure graph

Static, declared-only analysis (evidence `DECLARED`; nothing is executed or contacted): Dockerfiles (stages, base images, `dotnet publish` mapped through `COPY` to projects), docker-compose build/image declarations, Azure Pipelines (triggers, variables, local templates, stages/jobs/tasks, Docker/.NET/artifact/Helm/Kubernetes tasks), Helm charts rendered by a built-in template evaluator (unknown values stay `${helm:...}` placeholders), Kubernetes manifests, and appsettings files. Services route to workloads only through label selectors within one namespace and deployment scope; applications are linked to workloads only through image or entrypoint-assembly evidence. Secret values are never stored. Optional `vogoban.json` keys: `infrastructure.pipelines` (extra pipeline globs), `infrastructure.helmValues` (shared values files), `infrastructure.environments` (`{ "prod": ["k8s/prod/**"] }`).

## MetaGraph

`register <path>`, `analyze-repo <repo>` / `analyze-all` and `metagraph build` turn independently analyzed RepositoryGraphs into a MetaGraph. Repository facts stay in their repository scope; cross-repository relationships, `SharedContract`, `ExternalSystem` and `Database` identities live in separate MetaGraph tables with source/target repository, commit, graph version, evidence kinds, environment and both sides' provenance. Resolvers (packages, messages, deployments/images, APIs and service URLs, external systems) run over candidate indexes and are recomputed only when a resolver version or one repository's relevant facts change. Every build records a snapshot of the repository graph versions it used; route-only or name-only matches are kept as unresolved, never linked. `repositories` reports READY/STALE/UNAVAILABLE/FAILED by comparing the analyzed commit with the checkout. `vogoban.json` may pin `repository.id`/`repository.name`.

## Impact & architecture analysis

`impact`, `blast-radius`, `dependencies`/`dependents`, `paths`, `api-impact`, `message-impact`, `service-impact`, `repository-impact`, `risk`, `diff`, `cycles` and `orphaned` run deterministic traversals over the repository graphs and the MetaGraph (`--scope`, `--env`, `--depth`, `--max-nodes`). Propagation follows per-relationship semantics (`src/analysis/semantics.ts`); every impacted entity carries a level (DIRECT/INDIRECT/TRANSITIVE/POTENTIAL), a category and the explanation path with evidence, scope and provenance. Each analysis and each MetaGraph build stores a compact graph snapshot used by `diff` and `risk --diff`. Scores describe structural exposure, not failure probability. Results export with `--out <file> --format json|jsonl|csv`.

## Architecture governance

Architecture rules are YAML policy files (`--policy <file|dir>`, `$VOGOBAN_POLICIES`, default `./vogoban-policies`). A policy has `policy`, `level` (organization < domain < repository < environment, or explicit `precedence`), optional `include` of rule packs (see `policies/packs/clean-architecture.yaml`), configurable `layers`, `rules`, `overrides` and `exceptions`. Rules are `forbidden`, `allowed` (exclusive allow-list, or a permit with `exclusive: false`) or `required`; selectors match entity kind, id, name/qualified-name/namespace globs, repository, project, application, layer, environment, technology, tags and metadata. `match: members` evaluates a project, application or repository through the relationships of its members; `transitive`/`maxDepth` follows paths. Rules are evaluated against stored graph snapshots, so `governance --repo R --at S`, `baseline save`, `--baseline` (NEW vs BASELINED) and `governance-diff` compare declared intent across versions. Violation ids are deterministic; exceptions classify violations as EXCEPTED until they expire or are revoked and never hide them. `governance` exits 0 (PASS), 3 (WARN) or 4 (FAIL) based on `--fail-on`/`--warn-on`.

## Security, ownership & enterprise governance

`security`, `security-posture`, `security-findings`, `security-endpoints`, `secrets`, `sensitive-resources`, `trust-boundaries`, `security-flows`, `ownership`, `owners`, `unowned`, `ownership-conflicts`, `ownership-history`, `teams`, `team-dependencies`, `team-impact`, `security-impact`, `inventory`, `governance-context`, `security-diff` and `ownership-diff` evaluate the same stored graph snapshots as governance (`--repo R --at S`, `--from/--to`), so every result names its snapshots and is reproducible.

- Exposure is PUBLIC (ingress, LoadBalancer/NodePort service, or an `exposure` rule), INTERNAL (cluster-internal services only; gateway routing is not modeled) or UNKNOWN (no deployment evidence). Endpoint protection is NO_OBSERVED_AUTH, EXPLICITLY_ANONYMOUS, AUTH_PRESENT_AUTHZ_UNKNOWN, AUTHZ_PRESENT or UNKNOWN from endpoint-level authorization metadata and OpenAPI security; application-wide middleware is reported as context only.
- Secret references (appsettings, pipeline variables, Kubernetes Secrets and secret references, secret-named literals, credentials embedded in connection strings) record name, provider, state, source location, environment and consumers. Values are never read into the graph, stored, exported or printed; Roslyn argument values with secret-like parameter names and secret-like command-line flags are redacted before caching or persistence. `graph-snapshots --prune` removes snapshots superseded by a newer analysis of the same commit.
- Resources (data stores identified by connection-string hosts or data-store container images, external systems, transports, secret stores) are classified only by configured rules or the secret-store convention. Trust-boundary crossings, public-entry security flows and findings keep the full graph path; relationships derived by host-name matching are marked `derived`.
- Ownership comes from CODEOWNERS (parsed during analysis into `OwnershipRule` entities, last match wins, handles mapped to teams only when declared) and from explicit enterprise metadata. Inheritance applies only to rules with `inherit: true`; disagreeing sources are kept as CONFLICT unless `ownership.precedence` decides; ambiguous CODEOWNERS coverage of a project is OWNER_UNKNOWN; components without evidence are UNOWNED.
- Enterprise metadata (`--enterprise <file|none>`, `$VOGOBAN_ENTERPRISE`, default `./vogoban-enterprise.yaml`; validate with `validate-enterprise`) declares organizations, business units, teams (with CODEOWNERS handles), ownership rules, classification rules (`PUBLIC`..`HIGHLY_SENSITIVE`, `sensitiveFrom`), criticality rules (`LOW`..`CRITICAL`), exposure rules, environment stages (`production`/`development`), trust boundaries, approved crossings, approved secret providers and finding severity overrides. Selectors use the governance selector syntax.
- Governance sees the same facts: selectors accept `exposure`, `protection`, `ownership`, `owner`, `criticality`, `classification` and `boundary`; entity metadata carries those facts plus `environments`, `secretProvider` and `secretState`; derived `OWNS_*`, `MAINTAINS_REPOSITORY`, `EXPOSES_PUBLIC_ENDPOINT`, `ACCESSES_SENSITIVE_RESOURCE`, `USES_DATABASE` and `CROSSES_TRUST_BOUNDARY` relationships can be required or forbidden. Every violation reports its owning component, owners, repository and organizational boundaries, or UNOWNED.
- `risk` adds enterprise context (public exposure, sensitive resources, criticality, ownership gaps, cross-team and cross-organization propagation, trust-boundary crossings) as evidence without changing the score.

Findings are structural statements ("public endpoint without observed authentication metadata"), not vulnerability claims; severities come from built-in deterministic conditions or `findings.severity` overrides, with separate production severities.

## AI intelligence, Graph RAG & MCP

The AI layer is a read-only interface over the deterministic graph; it never creates entities, relationships, owners or rules. Every question runs: intent and entity resolution → structured query plan → plan validation → deterministic graph tools → evidence → (optionally) one LLM explanation.

```sh
vogoban ask "What depends on Catalog.API?" --repo eshoponcontainers
vogoban ask "What breaks if I change GET /api/orders?" --plan --evidence
vogoban ask "Who owns it?" --session review            # follow-ups resolve "it" to the previous entity (by id)
vogoban explain service Ordering.API --repo eshop
vogoban explain dependency Ordering.API Ordering.Infrastructure
vogoban ai-plan "Which public endpoints lack observed authorization?"
vogoban ai-tools | ai-tool get_owners '{"entity":"Ordering.API","repository":"eshop"}'
vogoban ai-audit [record]                               # question -> plan -> tools -> evidence -> answer
vogoban mcp --repo eshop --env production               # MCP server on stdio, scoped
```

- **Graph tools** (`src/ai/tools.ts`, listed by `ai-tools`) wrap the existing engines: entity resolution, dependencies/dependents and impact (Phase 7 propagation, API/message/service/repository impact, blast radius), paths, API providers/consumers and message publishers/consumers (MetaGraph), repository topology, declared deployments, ownership, endpoint exposure/protection, security findings, governance violations with rule definitions, data flows, external systems, snapshot comparison and architecture diffs, and deterministic service/repository summaries. Inputs have strict bounded schemas (unknown arguments are rejected); outputs are structured and carry evidence items with entity ids, relationship ids, evidence level, path, repository, environment, snapshot, provenance and location, each classified FACT, INFERENCE or UNKNOWN.
- **Query plans** are deterministic (intent rules + entity resolution against the graph). Ambiguous names return candidates and ask for clarification; unknown names are reported, never guessed. `--llm-plan` (or `planner: llm`) lets the model propose a plan for questions the rules cannot map; every plan is validated (known read-only tool, schema, depth/result limits, repository/environment scope, snapshot existence) before execution.
- **Answers**: list-style questions (owners, consumers, dependents, exposure, deployments, …) are answered from the tool result without an LLM call. Explanations (`explain`, impact, governance, temporal, paths) send one request with a bounded, deduplicated, prioritized evidence set inside a delimited data block; repository text is treated as data. Model claims must cite evidence ids: unsupported claims are rejected, confirmations backed only by inferred evidence are downgraded, citations to non-existent evidence are removed. Provider failures, timeouts or malformed output fall back to the deterministic result. Answers report Confirmed/Inferred/Unknown/No evidence/Ambiguous/Conflicting claims, unknowns, and truncation of bounded retrieval.
- **Scope and limits**: `--repo R[,R]`, `--env`, `--scope`, `--at` restrict every tool (out-of-scope entities are refused, out-of-scope results withheld); `--depth`, `--limit`, `--max-nodes`, `--max-evidence` and `contextTokens` bound retrieval and context.
- **Provider configuration** (`--ai-config`, `$VOGOBAN_AI` or `./vogoban-ai.yaml`; overrides `$VOGOBAN_AI_PROVIDER`, `_MODEL`, `_ENDPOINT`, `_API_KEY_ENV`): `provider` (`none`, `openai-compatible` for OpenAI or local servers, `azure-openai`, `anthropic`), `model`, `endpoint`, `apiKeyEnv` (name of the environment variable holding the key; raw keys are rejected and never printed), `apiVersion`, `temperature`, `maxOutputTokens`, `contextTokens`, `timeoutMs`, `retries`, `planner`, `audit`, `aliases` (name → entity id). Without a provider everything except LLM explanations works.
- **Audit**: each answer appends a record to `ai-audit.jsonl` next to the store (question, scope, graph versions, plan, tools, evidence references, model, answer; no prompt context, no credentials). Sessions (`--session`) store questions and the entity ids they resolved to, never answers.
- **MCP** (`mcp`): JSON-RPC over stdio exposing the same tools (all annotated read-only), resources (`vogoban://catalog`, `vogoban://governance`, `vogoban://security/posture`, `vogoban://repository/{name}`, `vogoban://service/{id}`, `api`, `message`, `deployment`, `ownership`, `security`, `governance` templates) and prompts (architecture review, impact analysis, service investigation, API dependency analysis, governance review, security architecture review). The server process runs with the scope given on its command line; stdio means the client's process boundary is the access boundary.
- The AI layer receives a store wrapper that throws on every mutating `GraphStore` method.

## Enterprise platform

`vogoban platform serve|worker|migrate|config|tenant|token|audit` runs Vogoban as a multi-tenant product:

- **Identity and access.** OIDC login plus API tokens. Tenants (organizations), teams and business units, and RBAC with built-in and custom roles bound at tenant, team, repository or environment scope.
- **Repositories and jobs.** Registration through GitHub, GitLab, Azure DevOps or generic git, with signed webhooks. Durable, idempotent and cancellable background jobs: analysis, MetaGraph, governance, security, pull-request checks, exports and retention.
- **Graph lifecycle.** Graph versions record their analyzer and configuration provenance.
- **Interfaces.** A versioned REST API with an OpenAPI document, a web application (explorer, impact, governance, security, ownership, history, assistant, administration), and MCP over HTTP. AI and MCP are bound to the caller's permissions, and AI has budgets.
- **Operations.** An append-only audit log, OpenTelemetry traces, Prometheus metrics, health checks, PostgreSQL migrations and a container image.

See [docs/advanced/enterprise.md](docs/advanced/enterprise.md) for configuration, security, operations and recovery, and [docs/architecture/platform.md](docs/architecture/platform.md) for the architecture. `deploy/` contains a reference Compose deployment and configuration file.

## Layout

```
src/graph       canonical model, deterministic identity, ingestion builder
src/store       GraphStore interface + SQLite implementation
src/query       traversal, paths, dependency/caller queries, cycles, cross-repository view
src/pipeline    repository/file discovery and the plugin pipeline
src/plugins     plugin contracts (workspace, language, semantic, framework, contract, infrastructure, resolver)
src/frontend    TS/JS: Tree-sitter syntax, npm/tsconfig workspace, module resolver, TypeScript compiler semantics, HTTP calls + URL evaluation, Angular and React plugins
src/dotnet      MSBuild project graph, Tree-sitter C# plugin, Roslyn boundary, semantic normalization
src/dotnet/frameworks  application detection + attribution, dependency injection (registrations, hosted services), configuration references
src/dotnet/frameworks/aspnetcore  controllers, minimal APIs, route groups, binding sources, response-type resolvers, authorization, middleware
src/contracts   OpenAPI parser/plugin, route normalization, API and message resolvers
src/infrastructure  Docker, Azure Pipelines, Helm, Kubernetes and appsettings parsers/plugins, infrastructure resolver
src/azure       Azure: Functions, SDK (.NET and TS/JS), Aspire, Bicep/ARM/Terraform parsers (src/azure/iac) and symbolic evaluator, resource catalog, code ↔ infrastructure resolver
src/governance  policy loading/validation, snapshot-backed rule evaluation, exceptions, baselines, governance diff
src/enterprise  enterprise metadata, security/ownership model, governance enrichment, team/security impact, security and ownership diffs
src/ownership   CODEOWNERS plugin
policies/packs  reusable rule packs
src/analysis    traversal, paths, impact propagation, scoring, snapshot diff, cycles, orphan analysis
src/metagraph   repository catalog, cross-repository resolvers, MetaGraph build and snapshots
src/export      JSON / JSONL / CSV export (repository graphs and MetaGraph)
src/ai          AI layer: provider abstraction, graph tools, query planning/validation, context builder, answers, MCP server
src/platform    enterprise platform: config, database + migrations, platform store, OIDC/tokens, RBAC, tenant graph access, jobs + workers, providers/webhooks, reports, audit, telemetry, HTTP API, web app (src/platform/web)
src/cli         CLI
semantic/Vogoban.Roslyn  .NET process that compiles each project with Roslyn and streams semantic facts as JSONL
```

New languages, frameworks, contract formats, or infrastructure parsers are added as plugins in `src/plugins/registry.ts`; they emit facts through the graph builder and never touch storage directly.
