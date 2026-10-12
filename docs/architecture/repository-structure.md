# Repository structure

This page maps the Vogoban 0.18.0 source tree to the architecture described in this section. Every directory listed
exists in the repository; responsibilities are taken from the code in it.

## Top level

| Path | Responsibility |
| --- | --- |
| `src/` | The TypeScript implementation (Bun runtime): CLI, analysis pipeline, analyzers, graph store, MetaGraph, AI/MCP, platform. |
| `semantic/Vogoban.Roslyn/` | The .NET semantic analyzer process used for C# (Roslyn and MSBuild evaluation). |
| `test/` | Test suites run with `bun test` (`bunfig.toml` sets a 180 s per-test budget because integration suites spawn the CLI and the Roslyn analyzer). |
| `policies/packs/` | Bundled governance policy packs (`clean-architecture.yaml`). |
| `deploy/` | Platform deployment examples: `docker-compose.yml` (services `postgres`, `api`, `worker`) and `platform.example.yaml`. |
| `Dockerfile` | Platform image: Bun on Debian with the .NET SDKs, building the Roslyn analyzer at image build time. |
| `docs/` | Documentation (this site). |
| `package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml` | Package metadata, dependencies (including OpenTelemetry), TypeScript and test configuration. |

## `src/`

| Directory | Responsibility | Architecture page |
| --- | --- | --- |
| `cli/` | `main.ts` command-line entry point and option parsing; `format.ts` and `ai-format.ts` text output. | [Overview](overview.md) |
| `pipeline/` | Analysis orchestration: `discovery.ts` (repository boundary, file discovery, size limits), `config.ts`, `analyze.ts` (runs analyzers, resolvers and graph build). | [Analysis pipeline](analysis-pipeline.md) |
| `plugins/` | Analyzer and resolver plugin contracts (`types.ts`) and the registry (`registry.ts`). | [Analyzers](analyzers.md) |
| `graph/` | Graph model (`model.ts`: entity kinds, relationship types, evidence levels), stable identity (`identity.ts`) and the graph builder (`builder.ts`). | [Repository graph](repository-graph.md), [Identity](identity.md) |
| `store/` | `GraphStore` interface (`store.ts`) and its SQLite implementation (`sqlite.ts`): graphs, snapshots, catalog, baselines, fact cache. | [Repository graph](repository-graph.md) |
| `dotnet/` | .NET analysis: project and MSBuild discovery (`projects.ts`, `msbuild.ts`), syntax facts (`csharp-syntax.ts`, `syntax-graph.ts`), the Roslyn backend client (`roslyn.ts`) and semantic graph (`semantic-facts.ts`, `semantic-graph.ts`). | [Analyzers](analyzers.md) |
| `dotnet/frameworks/` | .NET framework analyzers: applications, configuration, dependency injection, HTTP clients. | [Analyzers](analyzers.md) |
| `dotnet/frameworks/aspnetcore/` | ASP.NET Core controllers, minimal APIs, endpoints, binding, response types, authorization, middleware. | [Analyzers](analyzers.md) |
| `dotnet/frameworks/messaging/` | Messaging libraries: Azure Service Bus, MassTransit, NServiceBus, MediatR, Kafka, RabbitMQ and configured transports. | [Analyzers](analyzers.md) |
| `frontend/` | TypeScript/JavaScript program model, React and Angular analyzers, HTTP call extraction, module and workspace resolution. | [Frontend engine](frontend-engine.md) |
| `contracts/` | Routes, HTTP calls, OpenAPI, API resolution and message resolution. | [Analyzers](analyzers.md) |
| `azure/` | Azure Functions (C#, TypeScript), SDK clients, Aspire, resource catalog, value resolution, infrastructure resolver. | [Azure engine](azure-engine.md) |
| `azure/iac/` | Symbolic IaC evaluation: Bicep, ARM, Terraform (`azurerm`), shared model and evaluator. | [Azure engine](azure-engine.md) |
| `infrastructure/` | Dockerfile, Kubernetes, Helm, App Configuration and CI pipeline (including Azure Pipelines) analyzers and resolvers. | [Analyzers](analyzers.md) |
| `ownership/` | CODEOWNERS analyzer. | [Analyzers](analyzers.md) |
| `incremental/` | Git change sets, sync planning, incremental sync, graph status and optional git hooks. | [Incremental engine](incremental-engine.md) |
| `metagraph/` | Cross-repository MetaGraph build and resolvers (APIs, messages, packages, Azure, infrastructure, external systems). | [MetaGraph](metagraph.md) |
| `analysis/` | Graph algorithms over stored graphs: traversal, impact, risk scoring, structure and cycles, diffs, views, impact categories. | [Overview](overview.md) |
| `query/` | Query services behind the CLI and tools (graph, application, contract, frontend, Azure, infrastructure, MetaGraph). | [Overview](overview.md) |
| `governance/` | Policy loading (`policy.ts`), governance graph view (`graph.ts`) and rule evaluation (`evaluate.ts`). | [Overview](overview.md) |
| `enterprise/` | Enterprise model (teams, systems, environments), configuration, team impact and enterprise governance. | [Overview](overview.md) |
| `export/` | `export.ts`: graph and MetaGraph export as JSON, JSONL or CSV. | [Repository graph](repository-graph.md) |
| `ai/` | AI assistant and MCP server: read-only access, tools, planning, context, answer validation, providers. | [AI and MCP](ai-mcp.md) |
| `platform/` | Multi-tenant platform: HTTP server and API, authentication, RBAC, jobs, worker and sandbox, platform store, reports, audit, telemetry, platform CLI (`cli.ts`). | [Platform](platform.md), [Security model](security-model.md) |
| `platform/web/` | The platform web UI (`index.html`, `app.ts`, `app.css`). | [Platform](platform.md) |
| `log.ts` | Structured logger used across the codebase. | |

## `semantic/Vogoban.Roslyn/`

A .NET console project (`Vogoban.Roslyn.csproj`) that the TypeScript side starts as a separate process and talks to
over a JSON protocol (`Protocol.cs`). `Program.cs` is the entry point; `MsBuildEvaluation.cs` evaluates projects
without running builds; `ProjectAnalyzer.cs` extracts semantic facts; `References.cs` and `Assets.cs` resolve
references and restore assets; `FrameworkMerge.cs` merges multi-targeted results; `RepositoryFiles.cs` keeps reads
inside the repository; `Redaction.cs` and `SecretArguments.cs` keep secrets out of output and process arguments. See
[Analyzers](analyzers.md) and [Security model](security-model.md).

## `test/`

| Directory | Contents |
| --- | --- |
| `test/ai/` | Adversarial prompt-injection, budget, SSRF and Azure tool tests for the AI layer. |
| `test/azure/` | Azure identity, Functions (Node), SDK initializer, MetaGraph and IaC evaluation tests; `iac/` holds Bicep, ARM and Terraform tests. |
| `test/azure/fixtures/` | Enterprise Azure fixture repositories (`contoso-orders`, `contoso-fulfillment`, `contoso-platform-infra`, plus `cosmos-initializers`, `identity`, `node-functions`), described in its `README.md`. |
| `test/azure/harness/` | Verification harness scripts (`azure_verify.py`, `azure_incr.py`, `azure_security.sh`). |
| `test/frontend/` | Lazy-route tests and their `fixtures/lazy-routes`. |
| `test/incremental/` | Git failure handling in incremental sync. |
| `test/platform/` | API hardening, CLI hygiene, client IP, return-to and MCP-over-HTTP tests. |
| `test/security/` | Repository boundary and secret tests (`fixtures/boundary-secrets`) and worker jail tests. |

## `docs/`

| Path | Contents |
| --- | --- |
| `docs/architecture/` | This section. |
| `docs/features/` | Feature guides per capability. |
| `docs/cli/` | Command reference. |
| `docs/advanced/` | Operations, CI, enterprise, trust modes, troubleshooting, backup and restore. |
| `docs/release/` | Release gate reports and release readiness. |
| `docs/*.md` | Getting started, installation, quickstart, concepts, and the subsystem documents (`azure.md`, `frontend.md`, `incremental-sync.md`, `platform.md`, `privacy.md`, `runbook.md`). |

## Related

- [Overview](overview.md)
- [Analysis pipeline](analysis-pipeline.md)
