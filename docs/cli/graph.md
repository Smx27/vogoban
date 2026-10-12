# Repository graph commands

These commands inspect the code graph of analyzed repositories: which repositories are in the store, what was found, and how a type, method or project relates to the rest of the code. They read the store only. Searching by name is covered in [search.md](search.md); change impact in [impact.md](impact.md).

The examples run inside the `contoso-orders` demo repository after `vogoban analyze .` (an ASP.NET Core API, isolated .NET Azure Functions, a React frontend and Bicep). Multi-repository examples use `--db meta/graph.db`, a store holding `contoso-orders`, `contoso-fulfillment` and `contoso-platform-infra`. Your entity ids and paths will differ.

## repos

### What it does

Lists every repository in the store with its id, branch, analyzed commit and root path.

### Usage

```bash
vogoban repos [--db <path>] [--json]
```

### Example

```bash
vogoban --db meta/graph.db repos
```

### Output

```text
id                          name                    branch  commit        root
--------------------------  ----------------------  ------  ------------  -------------------------------------------------
e_389096883d2ba5827c3b8db3  contoso-fulfillment     main    1de8ed1b819b  /home/user/.capy/work/demo/contoso-fulfillment
e_9a2cfe3a9823cb05539c79e5  contoso-orders          main    ccaffed660b7  /home/user/.capy/work/demo/contoso-orders
e_47009aea1249976e15074ce8  contoso-platform-infra  main    71a45f03cfbd  /home/user/.capy/work/demo/contoso-platform-infra
```

`commit` is the commit of the last analysis, shortened to 12 characters.

### Useful options

`--json` returns the full repository records (remote URL, dirty flag, full commit).

### Common mistakes

An empty table usually means you are not using the store you analyzed into: check the current directory or `--db`. Two rows with the same name and different roots mean the same code was analyzed from two paths without a Git remote (identity falls back to the local path; see [analyze.md](analyze.md#repository-identity)).

## repo

### What it does

Shows one repository's root, remote, branch, commit and its most recent analysis runs.

### Usage

```bash
vogoban repo [repo] [--json]
```

`repo` is an id, identity or name. It may be omitted when the store holds exactly one repository.

### Example

```bash
vogoban repo
```

### Output

```text
contoso-orders (e_9a2cfe3a9823cb05539c79e5)
  root    /home/user/.capy/work/demo/contoso-orders
  remote  -
  branch  main
  commit  ccaffed660b7f947a60737e24447c6ace2a90559
  runs:
    2026-10-11T16:54:43.378Z  ccaffed660b7  entities=553 rels=1151 3114ms
```

`(dirty)` after the commit means the working tree had uncommitted changes when it was analyzed. Up to 10 runs are listed, newest first.

### Common mistakes

In a multi-repository store `vogoban repo` without an argument fails with `specify a repository (multiple in store)` (exit 2). Pass the name: `vogoban repo contoso-fulfillment`.

## stats

### What it does

Prints every count the store has for a repository (or all repositories): the code summary, the application, contract and infrastructure graphs, entities by kind, relationships by type, evidence levels, unresolved categories and analysis diagnostics.

### Usage

```bash
vogoban stats [--repo <repo>] [--json]
```

### Example

```bash
vogoban stats
```

### Output

Trimmed; the first four tables are the same as the [`analyze`](analyze.md#output) summary:

```text
Summary
                               count
-----------------------------  -----
Projects                       6
…
Entities
kind                    count
----------------------  -----
Api                     3
ApiOperation            3
Application             4
…
AzureFunction           7
AzureResource           34
…
Type                    19
(external)              263

Relationships
type                    count
----------------------  -----
ACCEPTS_PARAMETER       44
…
CALLS                   65
CALLS_ENDPOINT          2
…
TRIGGERS                6
…

Evidence
level                  count
---------------------  -----
COMPILER_RESOLVED      675
DECLARED               140
EXACT                  272
INFERRED               5
STRUCTURALLY_RESOLVED  59

Unresolved
category                count
----------------------  -----
dynamic-transport-name  1

Diagnostics
category  count
--------  -----

files=33 unresolved=1 diagnostics=0 conflicts=0
```

`(external)` counts entities outside the repository (framework types, NuGet and npm packages). The `Diagnostics` table counts analysis diagnostics by category; it is empty when analysis reported none. See [diagnostics.md](diagnostics.md).

### Useful options

`--repo` restricts the counts to one repository in a multi-repository store; without it the counts cover all repositories. `--json` returns `entitiesByKind`, `relationshipsByType`, `relationshipsByEvidence`, `unresolvedByCategory`, `diagnosticsByCategory` and totals.

### Common mistakes

Comparing counts between a trusted and an `--untrusted` or `--no-semantic` analysis: those modes legitimately produce fewer facts.

## show

### What it does

Prints one entity's identity (id, symbol key, repository, project, assembly, location, metadata) and **all** its incoming and outgoing relationships, plus unresolved references that start from it.

### Usage

```bash
vogoban show <entity> [--kind K] [--type T,...] [--limit N] [--json]
```

### Example

```bash
vogoban show OrderService --kind Type
```

### Output

```text
Type:Class Contoso.Orders.Api.Services.OrderService
  id         e_ecc5728e9c08860af51f6d2f
  symbol     Contoso.Orders.Api::T:Contoso.Orders.Api.Services.OrderService
  repository e_9a2cfe3a9823cb05539c79e5
  project    Project src/Contoso.Orders.Api/Contoso.Orders.Api.csproj
  assembly   Contoso.Orders.Api
  location   src/Contoso.Orders.Api/Services/OrderService.cs:13
  metadata   {"symbolKind":"Class","signature":"Contoso.Orders.Api.Services.OrderService","accessibility":"Public","modifiers":["sealed"],…}

Outgoing (13)
  -[DECLARES]-> Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:24)
  -[DECLARES]-> Field Contoso.Orders.Api.Services.OrderService._sender  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:15)
  -[IMPLEMENTS]-> Type:Interface Contoso.Orders.Api.Services.IOrderService  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:13)
  -[INJECTS]-> Type:Class Azure.Messaging.EventGrid.EventGridPublisherClient [external]  (STRUCTURALLY_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:18)
  -[USES_TYPE]-> Type:Class Azure.Messaging.EventGrid.EventGridPublisherClient [external]  (COMPILER_RESOLVED, x2 @ src/Contoso.Orders.Api/Services/OrderService.cs:16)
  …

Incoming (6)
  <-[ASSEMBLY_CONTAINS]- Assembly Contoso.Orders.Api  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:13)
  <-[CONTAINS]- Namespace Contoso.Orders.Api.Services  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:13)
  <-[RESOLVES_TO]- ServiceRegistration Contoso.Orders.Api.Services.IOrderService@src/Contoso.Orders.Api/Program.cs:9:1-9:58  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Program.cs:9)
  <-[RESOLVES_TO]- Type:Interface Contoso.Orders.Api.Services.IOrderService  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Program.cs:9)
  <-[USES_TYPE]- Method <top-level-statements-entry-point>  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Program.cs:9)
  …
```

Each relationship line is `-[TYPE]-> target (EVIDENCE[, xN] @ first location)`. `xN` means the same fact was observed N times. The `RESOLVES_TO` lines show that dependency injection maps `IOrderService` to this class (registered in `Program.cs` line 9).

### Useful options

| Option | Effect |
| --- | --- |
| `--kind K` | Disambiguate the reference (`Type`, `Method`, `Endpoint`, `AzureFunction`, ...) |
| `--type T,...` | Only these relationship types, e.g. `--type CALLS,USES_TYPE` |
| `--limit N` | Maximum lines per direction (default 200) |
| `--json` | `{ entity, outgoing, incoming, unresolved, related }` with full provenance |

### Common mistakes

`vogoban show OrderService` happens to work here because only one entity has that exact name. Methods almost never do (`SubmitAsync` matches the interface method and the implementation), so use `--kind` or an id. See [Entity references](overview.md#entity-references).

## deps

### What it does

Walks outgoing relationships from an entity (what it depends on) or, with `--reverse`, incoming ones (what depends on it), as a tree.

### Usage

```bash
vogoban deps <entity> [--reverse] [--depth N] [--type T,...] [--kind K] [--json]
```

### Example

```bash
vogoban deps Contoso.Orders.Api.Services.OrderService --depth 2
```

### Output

```text
Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
  [IMPLEMENTS/COMPILER_RESOLVED] Type:Interface Contoso.Orders.Api.Services.IOrderService  src/Contoso.Orders.Api/Services/OrderService.cs:8
  [INJECTS/STRUCTURALLY_RESOLVED] Type:Class Azure.Messaging.EventGrid.EventGridPublisherClient [external]
  [USES_TYPE/COMPILER_RESOLVED] Type:Record Contoso.Orders.Contracts.OrderLine  src/Contoso.Orders.Contracts/OrderSubmitted.cs:3
  [USES_TYPE/COMPILER_RESOLVED] Type:Class Azure.Messaging.ServiceBus.ServiceBusSender [external]
  …
    [IMPLEMENTS/COMPILER_RESOLVED] Type:Interface System.IEquatable<T> [external]
(9 dependencies)
```

Indentation is depth. Each node appears once; the line shows the relationship and evidence through which it was reached.

```bash
vogoban deps OrderService --kind Type --reverse
```

```text
Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
  [USES_TYPE/COMPILER_RESOLVED] Method <top-level-statements-entry-point>  src/Contoso.Orders.Api/Program.cs:1
(1 dependents)
```

### Useful options

`--depth N` (default 1), `--type` to follow only some relationship types (for example `--type PROJECT_REFERENCES`), `--reverse` for dependents.

### Common mistakes

`deps --reverse` on a class does not list callers of its methods; those point at the methods. Use `callers` on the method, or [`impact`](impact.md) for transitive change impact across members, contracts and repositories.

## callers and callees

### What it does

`callers` lists methods that call a method (`CALLS` relationships pointing at it). `callees` lists the methods it calls. Both walk `--depth` levels.

`callers --dispatch` also includes callers of the members this method implements or overrides. That is how you find code that calls an implementation through its interface.

### Usage

```bash
vogoban callers <method> [--dispatch] [--depth N] [--kind Method] [--json]
vogoban callees <method> [--depth N] [--kind Method] [--json]
```

### Example

```bash
vogoban callers Contoso.Orders.Api.Services.OrderService.SubmitAsync --kind Method --dispatch
```

### Output

```text
Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Collections.Generic.IReadOnlyList<Contoso.Orders.Contracts.OrderLine>, System.Threading.CancellationToken)  src/Contoso.Orders.Api/Services/OrderService.cs:24
  [CALLS/COMPILER_RESOLVED] Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)  src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
(1 callers)
```

The controller calls `IOrderService.SubmitAsync`; `--dispatch` attributes that call to the implementation.

```bash
vogoban callees ProcessOrder --kind Method
```

```text
Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)  src/Contoso.Orders.Functions/OrderFunctions.cs:18
  [CALLS/COMPILER_RESOLVED] Method Contoso.Orders.Functions.OrderProcessor.ProcessAsync(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)  src/Contoso.Orders.Functions/OrderFunctions.cs:8
(1 callees)
```

### Useful options

`--kind Method` is almost always needed: an Azure Function named `ProcessOrder` and its method `ProcessOrder` share the name, and every parameter of a method contains the method's name.

### Common mistakes

- `vogoban callers SubmitAsync --kind Method` is still ambiguous when an interface and its implementation both declare `SubmitAsync`. Use the qualified name (`…OrderService.SubmitAsync`) or the id.
- `OrderService.SubmitAsync` is a substring of `IOrderService.SubmitAsync`, so it matches both. Use the full namespace-qualified name.
- Calls are compiler-resolved only with semantic analysis. After `--no-semantic` both commands return nothing.

## implementations and inheritance

### What it does

`implementations` lists implementing types, derived types and overriding members of a type or member. For interfaces it also shows the implementations registered with dependency injection. `inheritance` prints ancestors (base types and interfaces) and descendants.

### Usage

```bash
vogoban implementations <type|member> [--kind K] [--json]
vogoban inheritance <type|member> [--kind K] [--json]
```

### Example

```bash
vogoban implementations IOrderService --kind Type
```

### Output

```text
Type:Interface Contoso.Orders.Api.Services.IOrderService  src/Contoso.Orders.Api/Services/OrderService.cs:8
  [IMPLEMENTS/COMPILER_RESOLVED] Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
(1 implementations/derivations)

Registered via dependency injection
  -> Type:Class Contoso.Orders.Api.Services.OrderService  (scoped, COMPILER_RESOLVED) @ src/Contoso.Orders.Api/Program.cs:9
```

```bash
vogoban inheritance OrderService --kind Type
```

```text
Ancestors
Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
  [IMPLEMENTS/COMPILER_RESOLVED] Type:Interface Contoso.Orders.Api.Services.IOrderService  src/Contoso.Orders.Api/Services/OrderService.cs:8

Descendants
Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
```

An empty list under the root line means none were found.

### Common mistakes

DI registrations are static: a registration inside a branch or a factory is shown with its control flow in [`services`](application.md#services-and-registrations), but which one wins at runtime is not decided.

## references

### What it does

Lists every resolved fact that points at an entity (type uses, member uses, implementations, calls, ...) with up to three source locations each.

### Usage

```bash
vogoban references <entity> [--type T,...] [--limit N] [--kind K] [--json]
```

### Example

```bash
vogoban references IOrderService --kind Type
```

### Output

```text
Type:Interface Contoso.Orders.Api.Services.IOrderService  (3 referencing facts)
  USES_TYPE        Method <top-level-statements-entry-point>  src/Contoso.Orders.Api/Program.cs:9
  USES_TYPE        Method:Constructor Contoso.Orders.Api.Controllers.OrdersController.OrdersController(Contoso.Orders.Api.Services.IOrderService)  src/Contoso.Orders.Api/Controllers/OrdersController.cs:13
  IMPLEMENTS       Type:Class Contoso.Orders.Api.Services.OrderService  src/Contoso.Orders.Api/Services/OrderService.cs:13
```

`(+N)` after the locations means more occurrences exist; `--json` has all of them.

### Useful options

`--type USES_TYPE` (or any type list) to narrow; `--limit` (default 200).

## path

### What it does

Finds the shortest relationship path between two entities. It first follows relationships forward (or backward with `--reverse`); if no such path exists it searches in both directions.

### Usage

```bash
vogoban path <from> <to> [--depth N] [--type T,...] [--reverse] [--kind K] [--json]
```

### Example

```bash
vogoban path OrdersController OrderService --kind Type
```

### Output

```text
Type:Class Contoso.Orders.Api.Controllers.OrdersController
  -[INJECTS/STRUCTURALLY_RESOLVED]-> Type:Interface Contoso.Orders.Api.Services.IOrderService
  -[RESOLVES_TO/COMPILER_RESOLVED]-> Type:Class Contoso.Orders.Api.Services.OrderService
```

`-[T]->` is followed in its own direction, `<-[T]-` against it. `no path from … to …` (exit 2) means none exists within `--depth` (default 8).

### Common mistakes

`--kind` applies to both ends. When they are different kinds (a component and a database), use ids. For several alternative paths, cross-repository paths and direction control, use [`paths`](impact.md).

## projects

### What it does

Prints the project reference graph of one repository: each project with target frameworks, output type, number of dependents and its project references, then any reference cycles. npm packages are listed as projects too.

### Usage

```bash
vogoban projects [--repo <repo>] [--json]
```

### Example

```bash
vogoban projects
```

### Output

```text
contoso-notifications  [?, undefined]  dependents=0
    -> (no project references)
Contoso.Orders.Api  [net10.0, Exe, web]  dependents=1
    -> Contoso.Orders.Contracts
Contoso.Orders.AppHost  [net10.0, Exe]  dependents=0
    -> Contoso.Orders.Api
Contoso.Orders.Contracts  [net10.0, Library]  dependents=2
    -> (no project references)
Contoso.Orders.Functions  [net10.0, Exe]  dependents=0
    -> Contoso.Orders.Contracts
contoso-orders-web  [?, undefined]  dependents=0
    -> (no project references)

No project reference cycles.
```

`[?, undefined]` is printed for npm packages, which have no target framework or output type.

### Common mistakes

In a store with several repositories, `projects` needs `--repo` (otherwise `specify --repo`, exit 2).

## project

### What it does

Shows one .NET project: assembly and output type, target frameworks, the reference packs used for the semantic model, compiler error and warning counts, contents, project references in both directions, direct packages and referenced assemblies.

### Usage

```bash
vogoban project <project> [--kind Project] [--json]
```

### Example

```bash
vogoban project Contoso.Orders.Api --kind Project
```

### Output

```text
Contoso.Orders.Api  (src/Contoso.Orders.Api/Contoso.Orders.Api.csproj)
  assembly          Contoso.Orders.Api  [Exe]
  target frameworks net10.0
  semantic context  net10.0: Microsoft.NETCore.App.Ref/10.0.12/net10.0, Microsoft.AspNetCore.App.Ref/10.0.12/net10.0
  compilation       errors=0 warnings=24
  contents          5 namespaces, 5 types, 3 source files
  project refs      Contoso.Orders.Contracts
  referenced by     Contoso.Orders.AppHost
  packages          Azure.Identity@1.13.2, Azure.Messaging.EventGrid@4.28.0, Aspire.Azure.Messaging.ServiceBus@9.1.0
  assemblies used   Azure.Messaging.EventGrid(package), Microsoft.AspNetCore(framework), …
```

`semantic context  not analyzed` means Roslyn did not build this project (for example after `--no-semantic`). `errors` greater than 0 usually means a missing `dotnet restore`.

### Common mistakes

`vogoban project Contoso.Orders.Api` without `--kind Project` is ambiguous (the assembly and the namespace have the same name). The `.csproj` path is ambiguous too (the `File` and the `Project` entity share it). Add `--kind Project`.

## shared

### What it does

Lists entities (mostly external types and packages) that are referenced from more than one repository in the store. Useful in a multi-repository store to see shared dependencies.

### Usage

```bash
vogoban shared [--json]
```

### Example

```bash
vogoban --db meta/graph.db shared
```

### Output

```text
entity                                                                            repositories
--------------------------------------------------------------------------------  -----------------------------------
Type:Class Azure.Identity.DefaultAzureCredential [external]                       contoso-fulfillment, contoso-orders
Type:Class Microsoft.Azure.Cosmos.CosmosClient [external]                         contoso-fulfillment, contoso-orders
Package nuget:Azure.Messaging.ServiceBus [external]                               contoso-fulfillment, contoso-orders
…
```

In a single-repository store it prints `No entities are shared across repositories yet.`

### Common mistakes

`shared` is about shared *code entities*. For packages with classification use `shared-packages`, and for contracts and messages that connect repositories use the MetaGraph commands in [metagraph.md](metagraph.md).

## Related

- [search.md](search.md): finding entities
- [impact.md](impact.md): transitive impact and multi-path search
- [dotnet.md](../features/dotnet.md): what the .NET analysis extracts
- [repository-graph.md](../architecture/repository-graph.md)
