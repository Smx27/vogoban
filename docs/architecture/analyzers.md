# Analyzers

Vogoban has many analyzers and one graph. Each analyzer understands one language, framework or file format and writes
entities and relationships into the same `GraphBuilder`, with the same identity, evidence and provenance model. There is
no .NET graph, frontend graph or Azure graph; a frontend HTTP call, an ASP.NET Core endpoint and a Bicep resource are
nodes of one RepositoryGraph and can be traversed in one path. This page lists every registered analyzer and its
contract.

## The plugin contract

`src/plugins/types.ts` defines two plugin shapes:

```ts
export interface AnalysisPlugin {
  readonly id: string;
  readonly version: string;
  readonly category: Exclude<PluginCategory, "language">;
  run(ctx: AnalysisContext): Promise<void>;
}

export interface LanguagePlugin<TFacts = unknown> {
  readonly id: string;
  readonly version: string;
  readonly category: "language";
  readonly language: string;
  readonly extensions: readonly string[];
  readonly syntaxArtifact: ArtifactKey<Map<string, TFacts>>;
  init(): Promise<void>;
  parse(path: string, source: string): ParseResult<TFacts>;
}
```

`AnalysisContext` gives a plugin the repository record, the admitted files and skipped files, the shared `GraphBuilder`,
the typed `ArtifactStore`, the `FactCache`, a logger, options (`semantic`), the parsed `vogoban.json`, a
`provenance()` factory and `readText()` (repository-relative, inside the root). A language plugin only parses; the
pipeline handles caching and diagnostics for it (`runLanguagePlugin` in `src/pipeline/analyze.ts`).

Responsibilities every analyzer shares:

- Read only discovered repository files, through `ctx.files` and `ctx.readText`.
- Build keys with the shared key builders (`src/graph/identity.ts` and the family helpers) so that identical facts from
  different analyzers merge into one entity.
- Choose an evidence level that matches what was proven, and attach provenance.
- Record an unresolved reference with a reason and category instead of guessing a target.
- Never store secret values (shared redaction in `src/infrastructure/common.ts`, mirrored in the Roslyn analyzer).
- Bump `version` (or embed an analyzer source hash) when output changes, so cached facts and incremental plans stay
  valid.

## Categories and order

`PLUGIN_CATEGORIES` = `workspace`, `language`, `semantic`, `framework`, `contract`, `infrastructure`, `resolver`. The
pipeline runs plugins grouped by category in that order, keeping registry order inside a category
([analysis-pipeline.md](analysis-pipeline.md#plugin-execution-order)).

## Every registered plugin

The table follows `defaultPlugins()` in `src/plugins/registry.ts`. Versions are those recorded in a 0.18.0 run; `+hash`
suffixes are analyzer source hashes and vary between builds.

| Plugin id | Category | Source | Inputs | Main outputs |
|---|---|---|---|---|
| `dotnet.msbuild` | workspace | `src/dotnet/projects.ts`, `msbuild.ts` | `.sln/.slnx/.slnf`, `*.csproj` and other project files, `Directory.*.props/targets`, central package versions, `project.assets.json` | `Solution`, `Project`, `Package` entities; `PROJECT_CONTAINS`, `PROJECT_REFERENCES`, `PACKAGE_DEPENDS_ON`; `DotnetProject` artifacts |
| `frontend.workspace` | workspace | `src/frontend/workspace.ts` | `package.json`, tsconfig/jsconfig chains, `angular.json`, workspace manifests, `.env*` | npm `Project`s, frontend `Application`s with signals, `.env` `Configuration`/`SecretReference` |
| `csharp.tree-sitter` | language | `src/dotnet/csharp-syntax.ts` | `*.cs` | C# syntax facts (declarations, usings, attributes) |
| `typescript.tree-sitter` | language | `src/frontend/syntax.ts` | TS/JS files | Declarations, exports, imports, re-exports, `require`, dynamic `import()`, module references |
| `dotnet.roslyn` | semantic | `src/dotnet/roslyn.ts`, `semantic-graph.ts`, `semantic/Vogoban.Roslyn` | `DotnetProject`s, C# files, restored packages | `Namespace`, `Type`, `Method`, `Property`, `Field`, `Event`, `Parameter`, `Assembly`; `CALLS`, `CONSTRUCTS`, `USES_TYPE`, `IMPLEMENTS`, `INHERITS`, `OVERRIDES`, ... (`COMPILER_RESOLVED`); semantic facts for framework plugins |
| `frontend.modules` | semantic | `src/frontend/modules.ts`, `resolve.ts` | syntax facts, workspace | `IMPORTS`, `TYPE_IMPORTS`, `DYNAMIC_IMPORTS`, `REQUIRES`, `RE_EXPORTS`, `REFERENCES_MODULE`; external npm `Package`s; `unresolved-module` |
| `typescript.semantic` | semantic | `src/frontend/semantic.ts`, `program.ts` | npm projects, module graph | TS/JS declarations; `CALLS`, `CONSTRUCTS`, `USES_TYPE`, `REFERENCES`, `INHERITS`, `IMPLEMENTS`, `EXTENDS`, `OVERRIDES` (`COMPILER_RESOLVED`) |
| `dotnet.applications` | framework | `src/dotnet/frameworks/applications.ts` | semantic facts | `Application` (ASP.NET Core, generic host, Functions) with detection signals; `DEFINES_APPLICATION` |
| `dotnet.dependency-injection` | framework | `src/dotnet/frameworks/dependency-injection.ts` | semantic invocations | `ServiceRegistration`, `HostedService`; `REGISTERS`, `REGISTERS_SERVICE`, `RESOLVES_TO`, `INJECTS`, `HOSTS`; `multiple-service-registrations` conflicts |
| `dotnet.aspnetcore` | framework | `src/dotnet/frameworks/aspnetcore/*` | semantic facts | `Endpoint`, `RouteGroup`, `Middleware`, `AuthorizationMetadata`; controllers, minimal APIs, binding, response types, middleware order, authorization |
| `dotnet.configuration` | framework | `src/dotnet/frameworks/configuration.ts` | semantic invocations | `ConfigurationReference` + `REFERENCES_CONFIG` for `IConfiguration`, options and environment variables |
| `azure.functions` | framework | `src/azure/functions.ts` | Roslyn attributes, `host.json`, `local.settings*.json`, `function.json` | `AzureFunction`, HTTP `Endpoint`s, triggers, bindings, Durable edges, settings |
| `azure.sdk` | framework | `src/azure/sdk.ts` | Roslyn invocations, creations, assignments, DI | Azure SDK client usage, `AUTHENTICATES_WITH`, EF Core SQL connections |
| `azure.aspire` | framework | `src/azure/aspire.ts` | Aspire AppHost invocations | Aspire `AzureResource`s, `CONNECTS_TO`, `DEPLOYED_TO`, role assignments |
| `azure.typescript` | framework | `src/azure/typescript.ts` | TS programs of packages using `@azure/*` | Node v4 Functions, JS/TS Azure SDK usage |
| `dotnet.http-clients` | framework | `src/dotnet/frameworks/http-clients.ts` | semantic facts, configuration | `HttpClient` (named, typed, Refit), base addresses, `HttpCallFact`s |
| `frontend.http` | framework | `src/frontend/http.ts` | TS programs | `fetch`/axios/Angular `HttpClient` calls with statically evaluated URLs (`HttpCallFact`s) |
| `frontend.angular` | framework | `src/frontend/angular.ts` | TS programs, templates | Components, directives, pipes, modules, services; `INJECTS`, `RENDERS`, `FrontendRoute`, `LOADS_COMPONENT`, `GUARDED_BY`, interceptors |
| `frontend.react` | framework | `src/frontend/react.ts` | TS programs | Components, hooks, contexts; `RENDERS`, `USES_HOOK`, `PROVIDES_CONTEXT`, `CONSUMES_CONTEXT`, React Router and Next.js `FrontendRoute`s |
| `dotnet.messaging.mediatr` | framework | `src/dotnet/frameworks/messaging/mediatr.ts` | semantic facts | In-process `Message`s, `PUBLISHES`, `HANDLED_BY` |
| `dotnet.messaging.masstransit` | framework | `…/masstransit.ts` | semantic facts | Messages, consumers, transports |
| `dotnet.messaging.nservicebus` | framework | `…/nservicebus.ts` | semantic facts | Messages, handlers, transports |
| `dotnet.messaging.azure-service-bus` | framework | `…/azure-service-bus.ts` | semantic facts | Service Bus senders/processors, `Queue`/`Topic` transports, `SENDS_TO`, `RECEIVES_FROM` |
| `dotnet.messaging.rabbitmq` | framework | `…/rabbitmq.ts` | semantic facts | Exchanges, queues, publishers, consumers |
| `dotnet.messaging.kafka` | framework | `…/kafka.ts` | semantic facts | Topics, producers, consumers |
| `dotnet.messaging.configured` | framework | `…/configured.ts` | `vogoban.json` `messaging` abstractions | Messages and transports for in-house messaging wrappers declared in configuration (`DECLARED`) |
| `contracts.openapi` | contract | `src/contracts/openapi-plugin.ts`, `openapi.ts` | OpenAPI 2/3 documents | `ContractDocument`, `Api`, `ApiOperation`, `ApiSchema`; `$ref` unresolved; operation/schema conflicts |
| `infrastructure.docker` | infrastructure | `src/infrastructure/docker-plugin.ts`, `dockerfile.ts` | Dockerfiles, Compose files | `Dockerfile`, `DockerStage`, `ContainerImage`; `BASED_ON`, `DEPENDS_ON_STAGE` |
| `infrastructure.azure-pipelines` | infrastructure | `src/infrastructure/pipeline-plugin.ts`, `azure-pipelines.ts`, `pipeline-tasks.ts` | Azure Pipelines YAML and templates | `Pipeline`, `PipelineStage`, `PipelineJob`, `PipelineTask`, `Artifact`; `BUILDS`, `DEPLOYS`, `TRIGGERS` |
| `infrastructure.helm` | infrastructure | `src/infrastructure/helm-plugin.ts`, `helm-template.ts` | `Chart.yaml`, values, templates | `HelmChart`, `HelmRelease`, statically rendered manifests |
| `infrastructure.kubernetes` | infrastructure | `src/infrastructure/kubernetes-plugin.ts` | Kubernetes manifests | `Deployment`, `KubernetesService`, `KubernetesIngress`, `KubernetesConfigMap`, `ServiceAccount`, `Container`, environment variables |
| `infrastructure.app-configuration` | infrastructure | `src/infrastructure/app-configuration-plugin.ts` | `appsettings*.json` | `Configuration` and `SecretReference` entries per key and environment, linked to referencing code |
| `azure.infrastructure` | infrastructure | `src/azure/infrastructure.ts`, `src/azure/iac/*` | Bicep, `.bicepparam`, ARM, Terraform, `.tfvars`, `azure.yaml` | Declared `AzureResource`s, `CREATES`, `CONTAINS_RESOURCE`, `USES_MODULE`, hosting, identity, roles, networking, observability |
| `contracts.api-resolver` | resolver | `src/contracts/api-resolver.ts` | endpoints, OpenAPI operations, `HttpCallFact`s | Code-first `Api`/`ApiOperation`; `IMPLEMENTED_BY`, `CALLS_ENDPOINT`, `CALLS_EXTERNAL_API`; `dynamic-url`, `no-matching-operation`, `unimplemented-operation` |
| `contracts.message-resolver` | resolver | `src/contracts/message-resolver.ts` | messages and transports from all messaging plugins | Equivalent-definition annotations; `conflicting-message-schema` conflicts |
| `infrastructure.resolver` | resolver | `src/infrastructure/resolver.ts` | infrastructure and application facts | Application ↔ image ↔ workload ↔ service ↔ ingress links, configuration supply, infrastructure conflicts and unresolved references |
| `azure.resolver` | resolver | `src/azure/resolver.ts` | all Azure facts | Logical data-plane resources, triggers and bindings, `DECLARED_BY`, `HOSTED_ON`, `SUPPLIES_CONFIG`, APIM → `ApiOperation` |
| `ownership.codeowners` | workspace | `src/ownership/codeowners-plugin.ts` | `CODEOWNERS` (root, `.github/`, `docs/`, `.gitlab/`) | `OwnershipRule` entities |

`ownership.codeowners` is registered last but has category `workspace`, so it runs in the first group (third, after
`frontend.workspace`).

## Families

### .NET

`dotnet.msbuild` reads project structure statically. `dotnet.roslyn` compiles every C# project with Roslyn in a
separate .NET process (`semantic/Vogoban.Roslyn`, JSONL protocol, see
[analysis-pipeline.md](analysis-pipeline.md#net-roslyn)) and emits the code graph. Framework plugins
(`src/dotnet/frameworks`) read the semantic facts through a shared index (`shared.ts`) and add the application,
API, DI, configuration, HTTP and messaging layers. Without an SDK the syntax graph (`src/dotnet/syntax-graph.ts`)
keeps declarations, and the rules of framework plugins that read semantic facts are skipped (configuration-file based facts such as `function.json` Functions are still produced).

### TypeScript and JavaScript

`frontend.workspace` → `typescript.tree-sitter` → `frontend.modules` → `typescript.semantic`, then `frontend.http`,
`frontend.angular` and `frontend.react` over the same programs. Details: [frontend-engine.md](frontend-engine.md).

### Azure and IaC

`azure.functions`, `azure.sdk`, `azure.aspire` and `azure.typescript` extract code-side facts; `azure.infrastructure`
parses and evaluates IaC; `azure.resolver` links them. Details: [azure-engine.md](azure-engine.md).

### Contracts

`contracts.openapi` reads contract documents; `contracts.api-resolver` creates code-first APIs from endpoints and
links HTTP calls from both .NET and frontend code to operations with one rule set, which is what connects a React
component to an ASP.NET Core controller.

### Infrastructure

Docker, Azure Pipelines, Helm, Kubernetes and `appsettings` analyzers record declared deployment state;
`infrastructure.resolver` links it to applications. Nothing is built, rendered by Helm, or applied to a cluster.

### Ownership

`ownership.codeowners` records `OwnershipRule`s. Enterprise ownership (teams, classification, criticality) comes
from `vogoban-enterprise.yaml` and is applied at query time by `src/enterprise`, not stored as analysis facts.

## Multiple analyzers, one graph

Analyzers cooperate through identity, not through a central coordinator:

- `azure.resolver` and the `dotnet.messaging.*` plugins build Service Bus queues and topics with the same key
  (`transport|<repo>|azure-service-bus|<kind>|<name>`, `azureKeys.transport` in `src/azure/catalog.ts`), so a topic
  seen by both is one entity with provenance from both. In the demo, the .NET trigger, the Node v4 Function and the SDK
  publisher all contribute to the one topic entity `sb-contoso-orders/orders`.
- `azure.functions` turns an HTTP-triggered Function into an `Endpoint`, so `contracts.api-resolver` creates its
  `ApiOperation` and frontend calls resolve to it exactly as they resolve to ASP.NET Core endpoints.
- `GraphBuilder.relate()` merges duplicate relationships and keeps the strongest evidence, so two analyzers proving the
  same edge strengthen it instead of duplicating it.

## Adding an analyzer

Implement `AnalysisPlugin` (or `LanguagePlugin`), choose the category by what the plugin depends on, register it in
`defaultPlugins()`, reuse the key builders, and give it a version. A new plugin id or version changes the run's
plugin versions, which makes the next `graph sync` a full rebuild (`plugin_versions_changed`). Contributor workflow:
[contributing.md](../advanced/contributing.md).

## Related

- [Analysis pipeline](analysis-pipeline.md)
- [RepositoryGraph](repository-graph.md)
- [Coverage](../coverage.md)
