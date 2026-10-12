# Vogoban

<p align="center">
  <strong>.NET-first enterprise code & architecture graph engine</strong>
</p>

<p align="center">
  <a href="https://github.com/Smx27/vogoban/actions"><img src="https://img.shields.io/github/actions/workflow/status/Smx27/vogoban/ci.yml?branch=master&logo=github" alt="Build Status"></a>
  <a href="https://github.com/Smx27/vogoban/releases"><img src="https://img.shields.io/github/v/release/Smx27/vogoban?logo=github" alt="Latest Release"></a>
  <a href="https://github.com/Smx27/vogoban/blob/master/LICENSE"><img src="https://img.shields.io/github/license/Smx27/vogoban" alt="License"></a>
  <a href="https://github.com/Smx27/vogoban/stargazers"><img src="https://img.shields.io/github/stars/Smx27/vogoban?style=social" alt="Stars"></a>
  <br>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Runtime-Bun-%23000000?logo=bun" alt="Bun Runtime"></a>
  <a href="https://dotnet.microsoft.com"><img src="https://img.shields.io/badge/.NET-8%2B-512BD4?logo=dotnet" alt=".NET 8+"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0%2B-3178C6?logo=typescript" alt="TypeScript"></a>
  <a href="https://github.com/dotnet/roslyn"><img src="https://img.shields.io/badge/Roslyn-Semantic%20Analysis-512BD4" alt="Roslyn"></a>
  <a href="https://tree-sitter.github.io/tree-sitter/"><img src="https://img.shields.io/badge/Tree--sitter-Syntax%20Parsing-8FCE00" alt="Tree-sitter"></a>
</p>

---

Vogoban analyzes repositories into **persistent, provenance-aware graphs** covering projects, assemblies, namespaces, types, members, calls, endpoints, DI registrations, messages, and cross-repository dependencies.

## ✨ Capabilities

| Domain | Features |
|--------|----------|
| **Languages** | C# (Roslyn + Tree-sitter), TypeScript/JavaScript (TS Compiler API + Tree-sitter) |
| **Frameworks** | ASP.NET Core (Controllers, Minimal APIs, Middleware, DI, Hosted Services), Angular, React, Next.js |
| **Contracts** | OpenAPI 3.x, HTTP Clients (named/typed/Refit), Messaging (MediatR, MassTransit, NServiceBus, Kafka, RabbitMQ, Azure Service Bus) |
| **Cloud & Infra** | Azure Functions, Bicep/ARM/Terraform, Docker, Kubernetes, Helm, Azure Pipelines, .NET Aspire |
| **Analysis** | Impact/blast-radius, dependency cycles, architecture governance (policy-as-code), security posture, ownership (CODEOWNERS), trust boundaries |
| **AI & MCP** | Graph RAG with deterministic tools, query planning, MCP server (stdio/HTTP), audit logging |
| **Platform** | Multi-tenant REST API, web UI, OIDC/RBAC, background jobs, PostgreSQL, OpenTelemetry |

---

## 🚀 Quickstart

```bash
# Install (requires Bun ≥ 1.3, .NET SDK 8+)
bun install -g ./vogoban-0.18.0-src.tar.gz
export PATH="$HOME/.bun/bin:$PATH"

# Analyze a repository
vogoban analyze /path/to/your/repo

# Explore the graph
vogoban projects                    # Project graph + cycle detection
vogoban endpoints --method POST     # All POST endpoints
vogoban callers "MyApp.Services.OrderService.Submit" --depth 2
vogoban impact "MyApp.Core.Order"   # Blast radius analysis
vogoban governance                  # Architecture policy validation
```

---

## 📦 Installation

| Method | Command |
|--------|---------|
| **Global (tarball)** | `bun install -g ./vogoban-0.18.0-src.tar.gz` |
| **Docker** | `docker run --rm -v $(pwd):/src ghcr.io/smx27/vogoban:latest analyze /src` |
| **From source** | `git clone https://github.com/Smx27/vogoban && cd vogoban && bun install && bun run build` |

> **Requirements**: Linux x86_64 (or container/WSL2), Bun ≥ 1.3, .NET SDK 8+ for full semantic analysis

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Vogoban CLI                               │
├─────────────────────────────────────────────────────────────────┤
│  analyze │ stats │ projects │ find │ show │ callers │ callees  │
│  implementations │ inheritance │ references │ deps │ path       │
│  applications │ endpoints │ routes │ services │ registrations  │
│  messages │ contracts │ frontend │ azure │ infrastructure      │
│  impact │ blast-radius │ governance │ security │ ownership     │
│  ask │ explain │ ai-plan │ mcp │ platform                      │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Repository   │    │  Repository   │    │  Repository   │
│   Graph (DB)  │    │   Graph (DB)  │    │   Graph (DB)  │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                  ┌─────────────────────┐
                  │      MetaGraph      │
                  │  (Cross-repo links) │
                  └─────────────────────┘
```

**Key principles**:
- **Deterministic identity** — Entities keyed by canonical symbol keys (assembly::doc-id), framework types globally deduplicated
- **Provenance on everything** — Every fact carries evidence level (`EXACT`, `COMPILER_RESOLVED`, `DECLARED`, `INFERRED`…), source locations, commit/run timestamps
- **Unresolved ≠ guessed** — Missing references recorded with category (`missing-package`, `overload-resolution`, `inaccessible`…) never invented
- **Incremental by default** — Syntax cached by file hash, Roslyn facts by project input hash; unchanged repos re-analyze from cache
- **Plugin architecture** — Languages, frameworks, contracts, infra all added via `src/plugins/registry.ts`

---

## 📚 Documentation

| Section | Description |
|---------|-------------|
| [Installation](docs/installation.md) | Detailed install, Docker, CI integration |
| [Getting Started](docs/getting-started.md) | First analysis walkthrough |
| [Quickstart (5 min)](docs/quickstart.md) | Minimal end-to-end example |
| [Concepts](docs/concepts.md) | Graph model, identity, evidence, MetaGraph |
| [CLI Reference](docs/cli/overview.md) | All 60+ commands with examples |
| [Architecture](docs/architecture/overview.md) | Pipeline, analyzers, incremental engine, AI/MCP |
| [Features](docs/features/) | Deep dives: .NET, Frontend, Azure, Contracts, Governance, Security, Impact, AI |
| [Development](docs/advanced/development.md) | Contributing, testing, adding plugins |

---

## 🎯 Example Use Cases

```bash
# Architecture governance (policy-as-code YAML)
vogoban governance --policy ./policies --fail-on error

# Security posture — public endpoints without auth
vogoban security-endpoints --protection NO_OBSERVED_AUTH --exposure PUBLIC

# Ownership — who owns this service?
vogoban ownership Ordering.API

# Cross-repo impact — what breaks if I change this API?
vogoban api-impact "GET /api/orders/{id}" --scope metagraph

# AI-assisted exploration
vogoban ask "What depends on Catalog.API?" --repo eshoponcontainers
vogoban explain service Ordering.API --repo eshop

# MCP server for IDE integration
vogoban mcp --repo myapp --env production
```

---

## 🤝 Contributing

See [Development Guide](docs/advanced/development.md) for:
- Running tests (`bun test`)
- Type checking (`bun run typecheck`)
- Building Roslyn analyzer (`bun run build:roslyn`)
- Adding new plugins/languages/frameworks
- Code style and PR process

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built with ❤️ for .NET and TypeScript engineers who need to understand large codebases.</sub>
</p>