# Vogoban Architecture & Repository Analysis Report

## 1. Executive Summary

**Vogoban** is a .NET-first, provenance-aware code and architecture graph engine. It parses, compiles, and statically analyzes modern multi-language repositories (.NET / C#, TypeScript / JavaScript, React, Angular, Next.js, Azure Functions / SDKs, IaC including Bicep, ARM, and Terraform, Docker, Helm, Kubernetes, and Azure Pipelines) into an evidence-backed architecture graph.

Key philosophy:
- **Zero Invention**: Static analysis never guesses relationships. When a link cannot be proven deterministically from code or declarations, it is stored as an **unresolved reference** with an explicit reason category rather than guessing an edge.
- **Evidence & Provenance**: Every entity and relationship maintains an evidence level (`EXACT`, `COMPILER_RESOLVED`, `DECLARED`, `STRUCTURALLY_RESOLVED`, `INFERRED`, `HEURISTIC`, `UNKNOWN`) and source location provenance (analyzer, file, line, commit, run).
- **Safe & Local**: Static repository analysis only. Source code is never executed, external cloud subscriptions are not contacted, and secrets are strictly redacted before storage.

---

## 2. System Architecture & Pipeline

```
Repository Files (Git / directory)
  ├── 1. Discovery (src/pipeline/discovery.ts)
  │      Filters files, checks file size limits, respects .gitignore, hashes file contents.
  ├── 2. Fact Extraction (src/plugins/registry.ts)
  │      - .NET: Tree-sitter syntax + Roslyn compiler process (semantic/Vogoban.Roslyn)
  │      - TS/JS: Tree-sitter + TypeScript Compiler API (isolated to repo files)
  │      - Frameworks: ASP.NET Core, DI, Angular, React, Azure Functions/SDK
  │      - Contracts: OpenAPI 3.x, code-first endpoints, messaging (MediatR, MassTransit, NServiceBus, Kafka, etc.)
  │      - Infrastructure: Bicep, ARM, Terraform, Docker, Helm, K8s, Azure Pipelines
  │      - Ownership: CODEOWNERS
  ├── 3. Graph Construction (src/graph/builder.ts)
  │      Generates deterministic entity IDs (`e_` + SHA-256 hash of canonical keys).
  ├── 4. Resolvers (src/contracts, src/infrastructure, src/azure)
  │      Links frontend fetch/HTTP calls to API endpoints, SDK calls to cloud resources, etc.
  └── 5. RepositoryGraph Storage (src/store/sqlite.ts)
         Stores entities, relationships, unresolved refs, diagnostics, and snapshots in SQLite (`.vogoban/graph.db`).
```

Above the RepositoryGraph:
- **Incremental Engine (`src/incremental`)**: Detects working tree or commit changes and incrementally reconciles facts while ensuring results are identical to clean rebuilds.
- **MetaGraph (`src/metagraph`)**: Stitches multiple RepositoryGraphs together inside a single catalog to track cross-repository messaging, API consumers/providers, and shared contracts.
- **Analysis & Governance (`src/analysis`, `src/governance`, `src/enterprise`)**: Traversal, blast-radius calculation, risk scoring, architectural rule verification (`vogoban-policies`), and enterprise security/ownership posture.
- **AI & MCP (`src/ai`)**: Read-only Graph RAG providing deterministic tool-based query execution and strict MCP integration without state mutation.
- **Enterprise Platform (`src/platform`)**: Multi-tenant platform with OIDC, RBAC, background job workers, PostgreSQL state store, and web UI.

---

## 3. Data Model

### Entities (`src/graph/model.ts`)
Deterministic identity based on repository identity, project path, Roslyn documentation comment ID / symbol key, and kind.
- **Code**: `Project`, `Assembly`, `Namespace`, `File`, `Type`, `Method`, `Property`, `Field`, `Parameter`.
- **Application**: `Application`, `Endpoint`, `ApiOperation`, `Api`, `ServiceRegistration`, `Middleware`, `HostedService`.
- **Messaging**: `Message`, `Topic`, `Queue`.
- **Cloud / Azure**: `AzureFunction`, `AzureResource`, `Database`, `Storage`.
- **Frontend**: `FrontendRoute`, `Component`, `Hook`, `Service`.
- **Infrastructure**: `Pipeline`, `ContainerImage`, `Deployment`, `KubernetesService`, `HelmChart`.

### Relationships & Evidence
Directed and typed relationships (e.g. `CALLS`, `IMPLEMENTS`, `INJECTS`, `ROUTES_TO`, `CALLS_ENDPOINT`, `PUBLISHES`, `CONSUMED_BY`, `WRITES_TO`, `DECLARED_BY`).
Evidence levels:
1. `EXACT`: Verifiable structural facts (e.g. project contains file).
2. `COMPILER_RESOLVED`: Proven by Roslyn or TypeScript compiler.
3. `DECLARED`: Stated in configuration or IaC files.
4. `STRUCTURALLY_RESOLVED`: Matched via explicit identifiers or parameter bindings.
5. `INFERRED`: Documented weaker matching (e.g. HTTP method + route template match).

### Unresolved References
Captures calls or dependencies that could not be statically verified (e.g. dynamic URLs, non-literal connection strings, unrestored NuGet packages) along with diagnostic categories.

---

## 4. CLI Capabilities & Key Commands

- **Setup & Analysis**:
  - `vogoban init .` - Interactive setup wizard.
  - `vogoban configure .` - Adjust local analyzer and workspace settings.
  - `vogoban analyze .` - Full analysis of the repository.
  - `vogoban graph sync` - Incremental synchronization.
  - `vogoban stats` - Overview of entities, relationships, evidence, and diagnostics.
- **Inspection & Traversal**:
  - `vogoban find <text> [--kind K]` - Find entities by name or symbol.
  - `vogoban show <entity>` - Detailed view of identity and relationships.
  - `vogoban callers / callees <method>` - Call graph traversal.
  - `vogoban path <from> <to>` - Shortest relationship path between entities.
  - `vogoban impact <entity>` - Architectural blast-radius and change-impact analysis.
- **Frontend & Azure Chains**:
  - `vogoban frontend-chain <route>` - Traces from frontend route to backend API and handler.
  - `vogoban azure flow <entity>` - Traces full flow (e.g. Frontend Route → API → Service Bus → Function → Cosmos DB → Bicep).
- **Governance & Security**:
  - `vogoban governance` - Evaluate policy rules (exit code 0/3/4).
  - `vogoban security-posture` / `vogoban security-findings` - Exposure and security checks.
- **AI & Integrations**:
  - `vogoban ask <question>` - Graph RAG query answering citing exact evidence IDs.
  - `vogoban mcp` - Stdio-based Model Context Protocol server.

---

## 5. Directory Structure

```
src/
├── ai/             # AI provider abstractions, query planner, MCP server
├── analysis/       # Traversal, impact analysis, blast-radius, cycles
├── azure/          # Azure Functions, SDK analyzers, Bicep/ARM/Terraform IaC
├── cli/            # CLI commands, argument parsing, interactive prompts
├── contracts/      # OpenAPI 3.x parser, API & message resolvers
├── dotnet/         # MSBuild project graph, C# Tree-sitter, Roslyn integration
├── enterprise/     # Enterprise metadata, ownership, security models
├── frontend/       # TS/JS Tree-sitter, TS compiler semantics, Angular & React
├── governance/     # Architectural policies, rule evaluation, baselines
├── graph/          # Canonical model, identity hashing, graph builder
├── incremental/    # Incremental sync, Git change detection
├── infrastructure/ # Docker, Helm, Kubernetes, Azure Pipelines parsers
├── local/          # Local workspace config, interactive wizard, web viewer
├── metagraph/      # Cross-repository catalog and resolvers
├── ownership/      # CODEOWNERS parser
├── pipeline/       # File discovery, analyzer registry, execution pipeline
├── platform/       # Multi-tenant API server, workers, auth, database
├── query/          # Query engines for CLI views
└── store/          # Synchronous GraphStore interface and SQLite implementation
semantic/           # Roslyn .NET analyzer process (Vogoban.Roslyn)
test/               # Unit, integration, security, and harness tests
docs/               # Comprehensive technical documentation
```
