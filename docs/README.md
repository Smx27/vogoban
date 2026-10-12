# Vogoban

**Software architecture intelligence for real repositories.**

Vogoban reads a repository (C#/.NET, TypeScript/JavaScript, Angular, React, Azure Functions and SDKs, Bicep, ARM, Terraform, Aspire, Docker, Helm, Kubernetes, Azure Pipelines) and builds a graph of its architecture in which every connection carries evidence: which file and line it came from, which analyzer found it, and how strong the proof is. You query that graph from the command line, through AI assistants over MCP, or through the multi-tenant platform.

```text
React route /orders/new
  → NewOrderPage → createOrder()          (TypeScript compiler)
  → POST /api/orders → OrdersController   (route match, then Roslyn)
  → OrderSubmitted → Service Bus topic    (Roslyn + Azure SDK)
  → Function ProcessOrder → Cosmos DB     (Functions trigger, SDK)
  → infra/modules/data.bicep              (IaC declaration)
```

It is static analysis: nothing in your repository is executed, nothing is deployed, no cloud account is contacted, and no telemetry is sent. When a connection cannot be proven, Vogoban records it as **unresolved** with a reason instead of guessing.

## Start here

- [What is Vogoban?](getting-started.md#what-is-vogoban)
- [Installation](installation.md)
- [Five-minute quickstart](quickstart.md)
- [First repository analysis](getting-started.md)

## Learn Vogoban

- [Concepts](concepts.md): entities, relationships, evidence, unresolved references
- [RepositoryGraph](architecture/repository-graph.md)
- [MetaGraph](features/metagraph.md)
- [Evidence and provenance](architecture/evidence-provenance.md)
- [Incremental analysis](features/incremental-analysis.md)

## Features

| Area | Guide |
|---|---|
| .NET (Roslyn, ASP.NET Core, DI, configuration) | [.NET](features/dotnet.md) |
| TypeScript and JavaScript | [TypeScript/JavaScript](features/typescript-javascript.md) |
| Frontend → backend linking | [Frontend intelligence](features/frontend.md) |
| Angular | [Angular](features/angular.md) |
| React, React Router, Next.js routes | [React](features/react.md) |
| Azure Functions, SDKs, resources | [Azure](features/azure.md) · [Azure end-to-end tutorial](features/azure-end-to-end.md) |
| Bicep, ARM, Terraform, Aspire, Docker, Helm, Kubernetes, pipelines | [Infrastructure](features/infrastructure.md) |
| OpenAPI, endpoints, HTTP clients | [API contracts](features/api-contracts.md) |
| MediatR, MassTransit, NServiceBus, Service Bus, RabbitMQ, Kafka | [Messaging](features/messaging.md) |
| "What does this change affect?" | [Impact analysis](features/impact-analysis.md) |
| Architecture rules as code | [Governance](features/governance.md) |
| Exposure, secrets, ownership, trust boundaries | [Security](features/security.md) |
| Graph-backed questions and answers | [AI](features/ai.md) |
| Model Context Protocol server | [MCP](features/mcp.md) |

## Command reference

[CLI overview](cli/overview.md) lists every command. The most used: [analyze](cli/analyze.md), [graph inspection](cli/graph.md), [search](cli/search.md), [impact](cli/impact.md), [sync](cli/sync.md), [diff](cli/diff.md), [Azure](cli/azure.md), [MetaGraph](cli/metagraph.md).

## Advanced

- [CI integration](advanced/ci.md)
- [Enterprise platform](advanced/enterprise.md) and [operations runbook](advanced/runbook.md)
- [Trust modes](advanced/trust-modes.md)
- [Analyzing real repositories and `vogoban.json`](advanced/repository-analysis.md)
- [Backups and restore](advanced/backup-restore.md)
- [Privacy and data boundaries](advanced/privacy.md)
- [Troubleshooting](advanced/troubleshooting.md)

## Architecture

- [System architecture](architecture/overview.md)
- [Analysis pipeline](architecture/analysis-pipeline.md)
- [Identity](architecture/identity.md)
- [Analyzers](architecture/analyzers.md) · [frontend engine](architecture/frontend-engine.md) · [Azure engine](architecture/azure-engine.md)
- [Graph storage: RepositoryGraph](architecture/repository-graph.md) · [MetaGraph](architecture/metagraph.md)
- [Incremental engine](architecture/incremental-engine.md)
- [Security model](architecture/security-model.md)
- [Platform](architecture/platform.md) · [AI and MCP](architecture/ai-mcp.md)
- [Repository structure](architecture/repository-structure.md)

## Contributing

- [Development setup, build and tests](advanced/development.md)
- [Contributing: adding analyzers, entities, relationships and commands](advanced/contributing.md)

## Reference material

- [Documentation coverage audit](coverage.md): every user-facing capability mapped to its page
- [Release reports](release/README.md): historical release-gate and readiness audits
