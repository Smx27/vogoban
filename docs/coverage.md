# Documentation coverage audit (0.18.0)

This audit maps every user-facing capability of Vogoban 0.18.0 to the pages that document it. It was produced by inspecting the implementation (`src/cli/main.ts`, `src/platform/cli.ts`, the analyzers under `src/`, `test/`) and running each documented command against real repositories. Only capabilities that exist in 0.18.0 are listed.

## How the documentation was verified

- **Commands.** Every `vogoban …` line in a code block is checked mechanically against the real command `case` labels and `parseArgs` options of the CLI (command name, subcommand and every flag). The same check fails any development invocation (running the CLI or the Roslyn analyzer from source) outside [development](advanced/development.md) and [contributing](advanced/contributing.md), and verifies every relative link and `#anchor`.
- **Output.** Output shown in the documentation comes from real runs of the installed CLI (installed with `bun install -g ./vogoban-0.18.0-src.tar.gz`) against the bundled sample repositories (`test/azure/fixtures/contoso-*`, with `dotnet restore`), the test fixtures, and small purpose-built repositories. Output is trimmed with `…`; ids, commits and timings differ per machine.
- **Installation.** The global Bun install and the container image (`docker build`, `docker run … analyze`) were both executed.

## Capability map

| Capability | Feature guide | Command reference | Internals |
|---|---|---|---|
| Installation (Bun global install, container image) | [installation](installation.md) | [overview](cli/overview.md) | — |
| First analysis, reading the summary | [getting started](getting-started.md), [quickstart](quickstart.md) | [analyze](cli/analyze.md) | [analysis pipeline](architecture/analysis-pipeline.md) |
| RepositoryGraph, entities, relationships, evidence, unresolved | [concepts](concepts.md) | [graph](cli/graph.md), [diagnostics](cli/diagnostics.md) | [repository graph](architecture/repository-graph.md), [evidence](architecture/evidence-provenance.md) |
| Search and inspection (`find`, `show`, `deps`, `callers`, `path`, …) | [quickstart](quickstart.md) | [search](cli/search.md), [graph](cli/graph.md) | — |
| .NET: Roslyn, MSBuild evaluation, projects, types, calls, inheritance, target frameworks | [.NET](features/dotnet.md) | [graph](cli/graph.md) | [analyzers](architecture/analyzers.md), [identity](architecture/identity.md) |
| ASP.NET Core endpoints, DI, middleware, hosted services, authorization, configuration | [.NET](features/dotnet.md) | [application](cli/application.md) | [analyzers](architecture/analyzers.md) |
| TypeScript / JavaScript (syntax, compiler semantics, module resolution) | [TypeScript/JavaScript](features/typescript-javascript.md) | [frontend](cli/frontend.md) | [frontend engine](architecture/frontend-engine.md) |
| Angular (components, DI, templates, routes, guards, interceptors, lazy loading) | [Angular](features/angular.md), [frontend](features/frontend.md) | [frontend](cli/frontend.md) | [frontend engine](architecture/frontend-engine.md) |
| React, React Router, Next.js file-system routes | [React](features/react.md), [frontend](features/frontend.md) | [frontend](cli/frontend.md) | [frontend engine](architecture/frontend-engine.md) |
| HTTP calls, static URL evaluation, frontend → backend chains | [frontend](features/frontend.md), [API contracts](features/api-contracts.md) | [frontend](cli/frontend.md), [contracts](cli/contracts.md) | [frontend engine](architecture/frontend-engine.md) |
| API contracts: OpenAPI 3.x, code-first operations, HTTP clients, unresolved URLs | [API contracts](features/api-contracts.md) | [contracts](cli/contracts.md) | [analyzers](architecture/analyzers.md) |
| Messaging: MediatR, MassTransit, NServiceBus, Azure Service Bus, RabbitMQ.Client, Confluent.Kafka, `vogoban.json` abstractions | [messaging](features/messaging.md) | [contracts](cli/contracts.md) | [analyzers](architecture/analyzers.md) |
| Azure Functions (HTTP, timer, Service Bus, Event Hubs, Event Grid, Blob, Queue, Cosmos DB, Durable; isolated, in-process, `function.json`, Node v4) | [Azure](features/azure.md) | [Azure](cli/azure.md) | [Azure engine](architecture/azure-engine.md) |
| Azure SDK (.NET and TS/JS): Service Bus, Event Hubs, Event Grid, Storage, Cosmos DB, Key Vault, Azure Identity credentials | [Azure](features/azure.md) | [Azure](cli/azure.md) | [Azure engine](architecture/azure-engine.md) |
| Azure IaC: Bicep (+ modules, AVM), ARM, Terraform, `.bicepparam`/`.tfvars`, `azure.yaml`, .NET Aspire | [Azure](features/azure.md), [infrastructure](features/infrastructure.md) | [Azure](cli/azure.md) | [Azure engine](architecture/azure-engine.md) |
| Azure hosting, identity and role assignments, networking, observability (Application Insights, Log Analytics), APIM | [Azure](features/azure.md) | [Azure](cli/azure.md) | [Azure engine](architecture/azure-engine.md) |
| Code → SDK → resource → IaC flows | [Azure end-to-end](features/azure-end-to-end.md) | [Azure](cli/azure.md) (`azure flow`) | [Azure engine](architecture/azure-engine.md) |
| Docker, docker-compose, Azure Pipelines, Helm, Kubernetes, appsettings, environments, topology | [infrastructure](features/infrastructure.md) | [infrastructure](cli/infrastructure.md) | [analyzers](architecture/analyzers.md) |
| MetaGraph: catalog, cross-repository relationships, identity, unresolved links | [MetaGraph](features/metagraph.md) | [MetaGraph](cli/metagraph.md) | [MetaGraph](architecture/metagraph.md), [identity](architecture/identity.md) |
| Impact, blast radius, paths, API/message/service/repository impact, risk, cycles, orphans | [impact analysis](features/impact-analysis.md) | [impact](cli/impact.md) | [overview](architecture/overview.md) |
| Graph snapshots, diff, change intelligence | [incremental analysis](features/incremental-analysis.md) | [diff](cli/diff.md) | [incremental engine](architecture/incremental-engine.md) |
| Incremental synchronization (`graph sync/status/changes/history`) | [incremental analysis](features/incremental-analysis.md) | [sync](cli/sync.md) | [incremental engine](architecture/incremental-engine.md) |
| Git hooks | [incremental analysis](features/incremental-analysis.md) | [hooks](cli/hooks.md) | [incremental engine](architecture/incremental-engine.md) |
| CI usage (`--base/--head`, `--strict-incremental`, governance exit codes, PR checks) | [CI](advanced/ci.md) | [sync](cli/sync.md), [governance](cli/governance.md) | — |
| Governance: policies, rules, layers, exceptions, baselines, governance diff | [governance](features/governance.md) | [governance](cli/governance.md) | — |
| Security posture, findings, endpoint exposure, secrets, sensitive resources, trust boundaries | [security](features/security.md) | [security](cli/security.md) | [security model](architecture/security-model.md) |
| Ownership: CODEOWNERS, enterprise metadata, teams, team impact | [governance](features/governance.md), [security](features/security.md) | [security](cli/security.md) | — |
| Trust modes (`--untrusted`, `--trust-repository`, worker sandbox modes) | [trust modes](advanced/trust-modes.md) | [overview](cli/overview.md), [analyze](cli/analyze.md) | [security model](architecture/security-model.md) |
| Privacy, offline mode, data boundaries | [privacy](advanced/privacy.md) | [diagnostics](cli/diagnostics.md) (`privacy`) | [security model](architecture/security-model.md) |
| AI: `ask`, `explain`, plans, tools, providers, audit | [AI](features/ai.md) | [AI](cli/ai.md) | [AI and MCP](architecture/ai-mcp.md) |
| MCP over stdio and HTTP | [MCP](features/mcp.md) | [AI](cli/ai.md) (`mcp`) | [AI and MCP](architecture/ai-mcp.md) |
| Export, backup, restore (SQLite; PostgreSQL platform) | [backup and restore](advanced/backup-restore.md) | [backup-restore](cli/backup-restore.md) | — |
| Enterprise platform: PostgreSQL, tenants, repositories, environments, OIDC, RBAC, jobs/workers, API, web app | [enterprise](advanced/enterprise.md), [runbook](advanced/runbook.md) | [platform](cli/platform.md) | [platform](architecture/platform.md) |
| `vogoban.json` repository configuration, large repositories | [repository analysis](advanced/repository-analysis.md) | [analyze](cli/analyze.md) | [analysis pipeline](architecture/analysis-pipeline.md) |
| Troubleshooting | [troubleshooting](advanced/troubleshooting.md) | — | — |
| Repository layout, development, tests, extending Vogoban | [development](advanced/development.md), [contributing](advanced/contributing.md) | — | [repository structure](architecture/repository-structure.md), [analyzers](architecture/analyzers.md) |

Every command in `vogoban --help` and `vogoban platform help` appears in the command index of the [CLI overview](cli/overview.md) with a link to the page that documents it.

## Not supported in 0.18.0 (stated, not advertised)

The documentation states these as limitations and does not describe them as features: Vue, Svelte, Redux/NgRx store semantics and GraphQL clients; types from external npm packages (`node_modules` is never read); runtime-built URLs passed through wrapper functions; endpoints registered through reflection; Azure management-plane operations through `ArmClient`; runtime state of any kind (deployments, live Azure resources, traffic). Windows is not a supported platform.

## Product defects found while documenting

These were found by running 0.18.0 while writing the documentation. They are documented as the product behaves today; none was changed in this phase.

| Area | Behaviour in 0.18.0 | Where documented |
|---|---|---|
| `vogoban diagnostics` | An alias of `privacy`. The analysis-diagnostics listing that `--help` and the `analyze` degraded-graph warning point to is unreachable. Use `stats` (counts) or `export` (every diagnostic). | [diagnostics](cli/diagnostics.md) |
| Platform worker from a global Bun install | Analysis jobs fail inside the namespace jail with `Cannot find package 'yaml'` because the jail binds only the package directory while Bun installs dependencies beside it. Run the platform from the container image. | [enterprise](advanced/enterprise.md), [troubleshooting](advanced/troubleshooting.md) |
| Product messages | `--help` (platform line), `privacy` (MCP line) and `platform help` show the from-source development invocation instead of `vogoban`, or the old `docs/platform.md` path. | [CLI overview](cli/overview.md) |
| Store inside the repository | Without `.vogoban/` in `.gitignore`, the store files count as working-tree changes (`CHANGES_DETECTED`). | [getting started](getting-started.md) |
| Queries without a store | Running a query where no store exists creates an empty `./.vogoban/graph.db` and prints empty results with exit 0. | [CLI overview](cli/overview.md) |
| `graph-snapshots --prune` | Can delete the snapshot of the current graph version when a later sync returns to an earlier version. | [diff](cli/diff.md) |
| `restore --from <empty file>` | Succeeds and replaces the store with an empty one. | [backup-restore](cli/backup-restore.md) |
| Name resolution | Exact-name resolution considers only the first 50 substring matches; some names need `--kind` (for example `project X --kind Project`). A same-named MetaGraph entity can take precedence over `--kind`. | [CLI overview](cli/overview.md) |
| Other output issues | `projects` prints `[?, undefined]` for npm projects; `middleware` prints Angular interceptors with `NaN`/`undefined`; `--lifetime` is case-sensitive; `baseline list` shows internal rows; some summaries repeat repository names. | the respective command pages |
