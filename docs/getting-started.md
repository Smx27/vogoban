# Getting started

This page takes you from nothing to a first analyzed repository and shows how to read the result. It assumes no prior knowledge of Vogoban.

## What is Vogoban?

Vogoban reads a software repository and builds an **evidence-backed graph of its architecture**: the projects, classes and methods in the code, the HTTP APIs it exposes and calls, the messages it publishes and consumes, the Azure resources and other infrastructure it declares, and how all of these connect.

A *graph* here simply means a set of things (called **entities**: a class, an API operation, a Service Bus topic, a frontend route) and the connections between them (called **relationships**: *calls*, *implements*, *publishes to*, *is declared by*). Every relationship records **why** Vogoban believes it exists (its *evidence*) and **where** that came from (file, line, analyzer, commit).

What makes this useful:

- You can ask questions across languages and layers: "which React page ends up writing to this Cosmos DB container?"
- You can ask what a change may affect before you make it ("impact analysis").
- The answers are traceable. If Vogoban cannot prove a connection from the source, it records the connection as **unresolved** instead of guessing.

Vogoban is static analysis: it reads files. It never runs your code, never deploys anything, never contacts Azure or any other cloud service, and sends no telemetry.

## 1. Install

Follow [Installation](installation.md). In short:

```bash
bun install -g ./vogoban-0.18.0-src.tar.gz
export PATH="$HOME/.bun/bin:$PATH"
vogoban --version
```

For C# repositories, also install the .NET SDK 8 or later and run `dotnet restore` in the repository you want to analyze.

## 2. Prepare the repository

Vogoban writes its graph to `./.vogoban/graph.db` in the **directory you run it from**. If that is your repository, tell Git to ignore the store (and .NET build output), otherwise Vogoban's own change detection sees those files as uncommitted changes:

```bash
cd my-project
printf '.vogoban/\nbin/\nobj/\n' >> .gitignore
```

Alternatively keep the store elsewhere with `--db ~/graphs/my-project.db` or `export VOGOBAN_DB=~/graphs/my-project.db`.

## 3. Run the first analysis

```bash
vogoban analyze .
```

What happens during analysis:

1. **Discovery** lists the repository's files (Git-aware), skips build output and dependency folders such as `bin`, `obj`, `node_modules` and `dist`, and never follows symbolic links.
2. **Language analyzers** parse the code: Roslyn for C# (when the .NET SDK is present), the TypeScript compiler for TypeScript and JavaScript, Tree-sitter for syntax.
3. **Framework and platform analyzers** recognize ASP.NET Core endpoints, dependency injection, Angular and React routes and components, HTTP calls, messaging libraries, Azure Functions and SDK clients, Bicep/ARM/Terraform/Aspire, Dockerfiles, Helm, Kubernetes and Azure Pipelines.
4. **Resolvers** connect the pieces: a `fetch("/api/orders")` call to the API operation it targets, a `ServiceBusSender` to the queue it sends to, that queue to the Bicep resource that declares it.
5. The result is written to the store in a single transaction, with a new **graph version**.

Progress is logged to stderr. When it finishes, Vogoban prints a summary. This is the summary for the bundled `contoso-orders` sample (trimmed):

```text
Analyzed contoso-orders @ ccaffed660b7 in 3114 ms
                               count
-----------------------------  -----
Projects                       6
Files                          33
Types                          19
Methods                        33
Calls                          65
…
Unresolved References          1
Compilation Diagnostics        0
evidence: COMPILER_RESOLVED=675 DECLARED=140 EXACT=272 INFERRED=5 STRUCTURALLY_RESOLVED=59
unresolved: dynamic-transport-name=1

application graph                   count
----------------------------------  -----
Applications                        4
Endpoints                           3
…
```

How to read it:

- The first table counts code entities (projects, types, methods) and code relationships (calls, type references, inheritance).
- `evidence:` shows how the relationships were established. `COMPILER_RESOLVED` came from the compiler; `INFERRED` means a weaker, documented rule was used. See [Concepts](concepts.md#evidence).
- `unresolved:` lists connections Vogoban saw but could not prove, grouped by reason. Here one Service Bus send goes through a sender whose queue name could not be determined statically.
- The *application*, *contract* and *infrastructure* tables count higher-level architecture: applications, endpoints, API operations, messages, pipelines, containers.

The first run of a C# repository takes longer because Vogoban builds its Roslyn analyzer once. Later runs reuse per-file and per-project caches, so re-analyzing an unchanged repository is fast.

## 4. Look at the result

Check that the graph matches the checkout:

```bash
vogoban graph status
```

```text
contoso-orders: UP_TO_DATE
  analyzed commit  ccaffed660b7
  working commit   ccaffed660b7
  up to date       yes  ·  changed files 0
  last sync        (none)
```

Find something by name and look at it:

```bash
vogoban find OrderService --kind Type
vogoban show Contoso.Orders.Api.Services.OrderService
```

`show` prints the entity's identity and location, followed by every outgoing and incoming relationship with its evidence and source line:

```text
Type:Class Contoso.Orders.Api.Services.OrderService
  id         e_ecc5728e9c08860af51f6d2f
  symbol     Contoso.Orders.Api::T:Contoso.Orders.Api.Services.OrderService
  …
Outgoing (13)
  -[IMPLEMENTS]-> Type:Interface Contoso.Orders.Api.Services.IOrderService  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:13)
  …
Incoming (6)
  <-[RESOLVES_TO]- ServiceRegistration Contoso.Orders.Api.Services.IOrderService@src/Contoso.Orders.Api/Program.cs:9:1-9:58  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Program.cs:9)
  …
```

Entity ids (`e_…`) are derived from the repository's identity, so yours will differ. You can always refer to an entity by its qualified name or plain name instead; when a name matches several entities Vogoban lists them and asks you to pick one with `--kind` or an id.

Useful views for a first look:

| Question | Command |
|---|---|
| How big is the graph, by kind? | `vogoban stats` |
| Which HTTP endpoints exist? | `vogoban endpoints` |
| Which frontend routes and HTTP calls exist? | `vogoban frontend` |
| Which Azure Functions and resources exist? | `vogoban azure` |
| What could not be resolved, and why? | `vogoban unresolved` |

## 5. Keep the graph current

After you change code, you do not need to re-analyze everything:

```bash
vogoban graph sync
```

Vogoban detects what changed since the last analysis, recomputes only the affected part of the graph and records a new graph version. The result is verified to equal a full re-analysis. See [Incremental analysis](features/incremental-analysis.md).

## Where to go next

- [Five-minute quickstart](quickstart.md): search, impact analysis and export on the sample.
- [Concepts](concepts.md): RepositoryGraph, entities, evidence, unresolved references.
- [CLI overview](cli/overview.md): every command.
- [Azure end-to-end tutorial](features/azure-end-to-end.md): trace React → API → Service Bus → Function → Cosmos DB → Bicep.
