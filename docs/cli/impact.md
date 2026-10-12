# Impact and architecture analysis commands

These commands answer "what does this change touch?" from the stored graph: change impact, blast-radius and change-risk scores, dependency closures, explanation paths, API/message/service/repository impact, cycles and unreferenced structures. They are deterministic: the same graph and options always give the same result.

Static analysis never proves runtime behaviour. A result says which entities are connected through relationships Vogoban extracted from source, configuration and infrastructure files. It does not prove a call happens in production, and an empty result is not proof that nothing depends on an entity. For the concepts behind levels, categories and scores, see [Impact analysis](../features/impact-analysis.md).

The examples run against the `contoso-orders` demo store from inside the repository (`./.vogoban/graph.db`) unless they say otherwise. Entity ids (`e_…`) are derived from repository identity, so yours will differ.

## Shared options

Every command on this page accepts these options.

| Option | Default | Meaning |
| --- | --- | --- |
| `--scope repository\|meta\|all` | `all` | Traverse repository graphs only, MetaGraph relationships only, or both. `repository-impact` and `cycles repository` always use `all`. |
| `--repo <repo>` | all | Restrict the traversal to one catalog repository (id, identity or name). Also narrows entity-name resolution. |
| `--env <name>` | all | Ignore relationships declared for other environments. |
| `--depth <n>` | 6 for `impact`, 3 otherwise; 8 for `paths` | Maximum propagation hops. Must be 1–12. |
| `--max-nodes <n>` | 2000 (`paths`: 20000) | Stop expanding after this many nodes. Truncated results say `TRUNCATED`. |
| `--limit <n>` | 40 | Rows shown in the human view. `--json` and `--out` always contain every row. |
| `--kind <K,...>` | none | Restrict entity-reference resolution to these kinds. It applies to every reference in the command. |
| `--out <file> --format json\|jsonl\|csv` | `json` | Also write the full result to a file (one row per impacted entity, path step, consumer, ...). The human view is still printed. |
| `--json` | off | Print the whole result as JSON on stdout. |

Entity references accept an id, a symbol key, a qualified name or a name. The commands first look for a MetaGraph entity or catalog repository with that exact name, then fall back to the repository graphs. If a name matches several entities the command prints the candidates and exits 2 (see [Entity references](overview.md#entity-references)).

### Reading the impact table

`impact`, `blast-radius`, `dependencies`, `dependents`, `risk` and the impact sections of the other commands print the same summary:

```text
impact of Message Contoso.Orders.Contracts.OrderSubmitted
  28 entities  levels: DIRECT=3 INDIRECT=7 POTENTIAL=18  categories: API=2 CODE=12 INFRASTRUCTURE=3 MESSAGE=4 SERVICE=7
  repositories: contoso-orders(28)  unresolved at boundary: 1  conflicts: 0
  graph: contoso-orders@ccaffed6/a021d2d5 READY
```

| Field | Meaning |
| --- | --- |
| `levels` | `DIRECT` (one confirmed hop), `INDIRECT` (two or more confirmed hops), `TRANSITIVE` (reached through the dependency closure), `POTENTIAL` (reached only through inferred, interface-dispatch or contract-level edges). |
| `categories` | What kind of thing is impacted: `CODE`, `API`, `MESSAGE`, `SERVICE`, `INFRASTRUCTURE`, `PROJECT`, `REPOSITORY`, `CONTRACT`, `CONFIGURATION`, `EXTERNAL_SYSTEM`. |
| `repositories` | Impacted entities per repository (`meta` for MetaGraph entities). |
| `unresolved at boundary` | Unresolved references on impacted entities. Impact may continue past them in reality; the graph cannot follow. |
| `graph` | Each repository's analyzed commit / graph version and catalog status, so you know which state the answer describes. A `STALE` repository adds a `warning:` line. |

Table columns: `level`, `category`, `entity`, `repository` (`external` for package/framework types), `because` (the last relationship on the explanation path, in words) and `path`, where `<-` means "reached against the relationship direction" and `*` marks a hop that crosses a repository boundary. `vogoban paths <seed> <entity>` explains any row in full.

## impact

### What it does

Propagates a change from one or more seed entities through the graph and lists every impacted entity with its level, category and explanation path. Seeds are expanded to their contained elements (a type includes its members), which the header reports as `+N contained elements in change scope`.

### Usage

```bash
vogoban impact <entity...> [--kind K] [--depth N] [--scope S] [--env E] [--out F --format json|jsonl|csv]
```

### Example

```bash
vogoban impact OrderSubmitted --kind Message --limit 8
```

### Output

```text
impact of Message Contoso.Orders.Contracts.OrderSubmitted
  28 entities  levels: DIRECT=3 INDIRECT=7 POTENTIAL=18  categories: API=2 CODE=12 INFRASTRUCTURE=3 MESSAGE=4 SERVICE=7
  repositories: contoso-orders(28)  unresolved at boundary: 1  conflicts: 0
  graph: contoso-orders@ccaffed6/a021d2d5 READY
level      category  entity                                                                            repository      because                       path (* crosses repository)
---------  --------  --------------------------------------------------------------------------------  --------------  ----------------------------  ---------------------------
DIRECT     CODE      Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Colle  contoso-orders  publishes                     <-PUBLISHES
DIRECT     CODE      Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contr  contoso-orders  consumed by                   ->CONSUMED_BY
DIRECT     MESSAGE   Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin  contoso-orders  carries                       <-CARRIES
POTENTIAL  CODE      Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, System.Coll  contoso-orders  dispatched through interface  <-PUBLISHES ->IMPLEMENTS
INDIRECT   CODE      Type Contoso.Orders.Api.Services.OrderService                                     contoso-orders  contains changed element      <-PUBLISHES <-DECLARES
…
  (20 more; --limit N, --json or --out for all; 'paths <seed> <entity>' explains any row)
```

The publisher, the consuming Function and the Service Bus subscription are direct; the interface method is only `POTENTIAL` because it is reached through interface dispatch.

With `--out`, the full row set is written and a confirmation goes to stderr:

```bash
vogoban impact OrderSubmitted --kind Message --out impact.csv --format csv
```

```text
exported impact (25 rows) to impact.csv
```

The CSV columns are `level,category,kind,entity,id,repository,depth,confirmed,crossRepository,reason,path`.

### Useful options

- `--depth N` stops propagation earlier (default 6 for `impact`).
- `--scope repository` ignores MetaGraph (cross-repository) relationships.
- Several seeds can be given at once: `vogoban impact e_1 e_2`.

### Common mistakes

- Using a bare name that matches several kinds. `OrderSubmitted` is both a `Message` and a `Type`; add `--kind Message` or use the id.
- In a multi-repository store, a MetaGraph entity with the same name wins over `--kind`: `OrderSubmitted --kind Message` resolves to the `SharedContract` when a MetaGraph exists. Use the repository entity's id if you want one repository's message.
- Reading `POTENTIAL` rows as confirmed. They are possible effects, not proven ones.

## blast-radius

### What it does

Runs the same propagation as `impact` and adds a structural exposure score from 0 to 100 with its contributing factors. The score measures graph reach; it is not a probability of failure.

### Usage

```bash
vogoban blast-radius <entity...> [--kind K] [impact options]
```

### Example

```bash
vogoban blast-radius OrderSubmitted --kind Message --limit 5
```

### Output

```text
impact of Message Contoso.Orders.Contracts.OrderSubmitted
  28 entities  levels: DIRECT=3 INDIRECT=7 POTENTIAL=18  categories: API=2 CODE=12 INFRASTRUCTURE=3 MESSAGE=4 SERVICE=7
…
Blast radius: 43.9 (HIGH) - structural change exposure derived from graph reach; not a probability of failure
factor                       value  points  explanation
---------------------------  -----  ------  ----------------------------------------------------------------------------
direct                       3      8/10    entities directly dependent on the change
indirect+transitive          7      9/10    entities reached through two or more confirmed hops
potential                    18     4.2/5   entities reached only through inferred, dispatch or contract-level edges
repositories                 0      0/15    other repositories reached
services                     4      9.3/10  applications affected
api-operations               2      4.8/10  API operations or APIs affected
external-consumers           0      0/10    consumers in other repositories reached through API or message relationships
deployments                  0      0/10    workloads, services, ingresses or releases affected
cross-repository-boundaries  0      0/10    distinct relationships crossing a repository boundary
contract-boundaries          4      4.6/5   API/message/contract entities propagating the impact
infrastructure-boundaries    3      4/5     infrastructure or deployment entities in the impact set
```

The band (`LOW`, `MODERATE`, `HIGH`, `CRITICAL`) follows the score. Each factor shows its value, the points it contributed and its maximum.

### Useful options

Same as `impact`. `--json` adds a `score` object with `score`, `band`, `meaning` and `factors`.

### Common mistakes

- Comparing scores computed with different `--depth`, `--scope` or `--env`. The score depends on the traversal limits.

## dependencies and dependents

### What it does

`dependencies` lists what an entity depends on (forward closure); `dependents` lists what depends on it (reverse closure). Both use the impact table with levels.

### Usage

```bash
vogoban dependencies <entity> [--depth N] [--kind K]
vogoban dependents <entity> [--depth N] [--kind K]
```

### Example

```bash
vogoban dependents Contoso.Orders.Api.Services.OrderService --limit 10
```

### Output

```text
dependents of Type Contoso.Orders.Api.Services.OrderService
  7 entities  levels: DIRECT=3 INDIRECT=3 POTENTIAL=1  categories: CODE=4 INFRASTRUCTURE=1 SERVICE=2
  repositories: contoso-orders(7)  unresolved at boundary: 0  conflicts: 0
  graph: contoso-orders@ccaffed6/a021d2d5 READY
level      category        entity                                                                            repository      because                     path (* crosses repository)
---------  --------------  --------------------------------------------------------------------------------  --------------  --------------------------  ----------------------------------------
DIRECT     CODE            Method <top-level-statements-entry-point>                                         contoso-orders  uses type                   <-USES_TYPE
DIRECT     CODE            Type Contoso.Orders.Api.Services.IOrderService                                    contoso-orders  resolves to                 <-RESOLVES_TO
DIRECT     SERVICE         ServiceRegistration Contoso.Orders.Api.Services.IOrderService@src/Contoso.Orders  contoso-orders  resolves to                 <-RESOLVES_TO
INDIRECT   CODE            Type Contoso.Orders.Api.Controllers.OrdersController                              contoso-orders  injects                     <-RESOLVES_TO <-INJECTS
INDIRECT   CODE            Method Contoso.Orders.Api.Controllers.OrdersController.OrdersController(Contoso.  contoso-orders  uses type                   <-RESOLVES_TO <-USES_TYPE
INDIRECT   SERVICE         Application Contoso.Orders.Api (aspnetcore)                                       contoso-orders  implemented by              <-USES_TYPE <-IMPLEMENTED_BY
POTENTIAL  INFRASTRUCTURE  AzureResource Microsoft.Web/sites:app-contoso-orders-api                          contoso-orders  hosted on (hosting target)  <-USES_TYPE <-IMPLEMENTED_BY ->HOSTED_ON
```

The controller depends on `OrderService` through the DI registration (`RESOLVES_TO`) and constructor injection (`INJECTS`).

`dependencies` of the same type lists the SDK and framework types it uses, with `external` in the repository column:

```text
dependencies of Type Contoso.Orders.Api.Services.OrderService
  9 entities  levels: DIRECT=8 INDIRECT=1  categories: CODE=9
…
DIRECT    CODE      Type Azure.Messaging.EventGrid.EventGridPublisherClient  external        injects     ->INJECTS
DIRECT    CODE      Type Azure.Messaging.ServiceBus.ServiceBusClient         external        uses type   ->USES_TYPE
DIRECT    CODE      Type Contoso.Orders.Api.Services.IOrderService           contoso-orders  implements  ->IMPLEMENTS
…
```

### Useful options

- `--depth N` (default 3).
- For a quick one-hop list without levels, the inspection command `deps <entity> [--reverse]` is lighter (see [graph.md](graph.md)).

### Common mistakes

- Expecting `dependents` to include runtime callers that the graph cannot see (reflection, configuration-driven dispatch, HTTP calls to unresolved URLs).

## paths

### What it does

Finds the shortest relationship path (or several) between two entities, across repository graphs and the MetaGraph, with the source location of each hop.

### Usage

```bash
vogoban paths <from> <to> [--all N] [--direction forward|reverse|both] [--type T,...] [--via-kind K,...] [--depth N]
```

### Example

```bash
vogoban paths e_6db0957813aeb95bf36d4fbe e_7f3bddb8e95711f7485818f7
```

The ids are the `POST /api/orders` endpoint and the `ProcessOrder` Azure Function (found with `vogoban find`).

### Output

```text
Path 1 (4 hops, repositories: contoso-orders, scopes: repository)
  Endpoint Contoso.Orders.Api:POST /api/orders [contoso-orders]
    -[IMPLEMENTED_BY]-> Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)  (src/Contoso.Orders.Api/Controllers/OrdersController.cs:16)
      -[USES_TYPE]-> Type System.Threading.CancellationToken  (src/Contoso.Orders.Api/Controllers/OrdersController.cs:16)
        <-[USES_TYPE]- Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)  (src/Contoso.Orders.Functions/OrderFunctions.cs:18)
          <-[IMPLEMENTED_BY]- AzureFunction Contoso.Orders.Functions:ProcessOrder  (src/Contoso.Orders.Functions/OrderFunctions.cs:16)
```

The default direction `both` follows edges either way, so the shortest path here goes through a shared framework type. That is a real connection in the graph but not a meaningful flow. Restrict the search to see the architecture path:

```bash
vogoban paths e_6db0957813aeb95bf36d4fbe e_7f3bddb8e95711f7485818f7 --all 2 --direction forward
```

```text
No path from Endpoint Contoso.Orders.Api:POST /api/orders to AzureFunction Contoso.Orders.Functions:ProcessOrder within 8 hops.
```

Forward-only fails because the flow passes through an interface implementation (`<-[IMPLEMENTS]-`) and a message consumer, which are reverse hops. For "what happens next" flows across Azure messaging, `vogoban azure flow` follows the relationships with the right semantics (see [azure.md](azure.md)).

In the step lines, `-[T]->` is a hop along a relationship and `<-[T]-` a hop against it. `@meta` marks a MetaGraph relationship, `?` an inferred or heuristic one, `env=` an environment-scoped one, and `<crosses into R>` a repository boundary.

### Useful options

- `--all N` returns up to N shortest paths (default 1).
- `--type CALLS,PUBLISHES` only follows those relationship types.
- `--via-kind Method,Message` only passes through those entity kinds.
- `--depth N` (default 8, max 12).

### Common mistakes

- Passing `--kind` when the two ends have different kinds. `--kind` applies to both references, so `vogoban paths /orders/new ProcessOrder --kind FrontendRoute` fails with `no entity matches 'ProcessOrder'`. Use ids instead.
- Treating the shortest path as the most important one. Use `--direction`, `--type` and `--via-kind` to remove incidental paths through shared types.

## api-impact

### What it does

Shows an API operation's contract, implementing endpoint and handler, request/response contracts, every consumer (same repository and cross-repository), and the impact and blast radius of changing it. With `--change` it says whether that kind of change is potentially breaking for each consumer.

### Usage

```bash
vogoban api-impact <operation> [--change K] [--kind ApiOperation] [impact options]
```

`--change` is one of `removed`, `route`, `method`, `version`, `request-field`, `required-field`, `parameter`, `request-contract`, `response-field`, `response-contract`, `additive-field`. All except `additive-field` are treated as potentially breaking.

### Example

```bash
vogoban api-impact "POST /api/orders" --kind ApiOperation --change required-field --limit 5
```

### Output

```text
API operation Contoso.Orders.Api:POST /api/orders  [contoso-orders]
  api Contoso.Orders.Api (code-first)  provider Contoso.Orders.Api
  implemented by Contoso.Orders.Api:POST /api/orders  handler Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)
  request Contoso.Orders.Api.Controllers.CreateOrderRequest  response -
  change required-field: potentially breaking for consumers using the request
Consumers (1) in contoso-orders
  contoso-orders: web/src/api/orders.ts:createOrder  apps=contoso-orders-web deployments=-  repository/INFERRED breaking=unknown

impact of ApiOperation Contoso.Orders.Api:POST /api/orders
  16 entities  levels: DIRECT=1 INDIRECT=1 POTENTIAL=14  categories: API=1 CODE=7 INFRASTRUCTURE=3 PROJECT=1 REPOSITORY=1 SERVICE=3
…
Blast radius: 27.4 (MODERATE) - structural change exposure derived from graph reach; not a probability of failure
…
```

The React `createOrder` function is the only consumer; its link is `INFERRED` (matched from the HTTP call's URL), and `breaking=unknown` because Vogoban does not know which request fields the client sends.

### Useful options

`--change K`, plus the shared options.

### Common mistakes

- `"POST /api/orders"` matches both the `ApiOperation` and the `Endpoint`. The command exits 2 with both candidates; add `--kind ApiOperation`.
- Passing an `Endpoint` id. The command requires an `ApiOperation` and exits 2 otherwise.

## message-impact

### What it does

Shows a message's producer side, consumer side, transports and (for a MetaGraph `SharedContract`) its member messages in each repository, followed by the impact and blast radius.

### Usage

```bash
vogoban message-impact <message|shared contract> [--kind Message] [impact options]
```

### Example

```bash
vogoban message-impact OrderSubmitted --kind Message --limit 4
```

### Output

```text
Message Contoso.Orders.Contracts.OrderSubmitted  [contoso-orders]  repositories: contoso-orders
Producer side (1)
  contoso-orders: Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Collections.Generic.IReadOnlyList<Contoso.Orders.Contracts.OrderLine>, System.Threading.CancellationToken) [PUBLISHES/COMPILER_RESOLVED] apps=Contoso.Orders.Api
Consumer side (1)
  contoso-orders: Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken) [CONSUMED_BY/COMPILER_RESOLVED] apps=Contoso.Orders.Functions
Transports (1)
  azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing senders=0 delivers-to=1

impact of Message Contoso.Orders.Contracts.OrderSubmitted
…
```

### Useful options

The shared options. In a multi-repository store, pass the `SharedContract` (or let the name resolve to it) to see producers and consumers in every repository.

### Common mistakes

- Passing a type or method. The command requires a `Message` or `SharedContract` and exits 2 otherwise.

## service-impact

### What it does

Summarises one application: its APIs, API consumers, published and consumed messages, outgoing HTTP calls, external systems, configuration and deployments; then the upstream impact (what is affected if the service changes), the downstream dependencies, and a blast radius.

### Usage

```bash
vogoban service-impact <application> [--kind Application] [impact options]
```

### Example

```bash
vogoban service-impact Contoso.Orders.Api --kind Application --limit 4
```

### Output

```text
Service Contoso.Orders.Api  [contoso-orders]
  APIs (1): Contoso.Orders.Api (code-first)  operations=1
  API consumers (1): web/src/api/orders.ts:createOrder
  publishes (1): Contoso.Orders.Contracts.OrderSubmitted
  consumes (0)
  outgoing calls (0)
  external systems (0)
  configuration (2): configuration:EventGrid:Endpoint; configuration:messaging
  deployments (0): -

Upstream (affected if this service changes)
impact of Application Contoso.Orders.Api (aspnetcore) (+5 contained elements in change scope)
  17 entities  levels: DIRECT=2 INDIRECT=1 POTENTIAL=13 TRANSITIVE=1  categories: API=1 CODE=8 INFRASTRUCTURE=4 PROJECT=1 REPOSITORY=1 SERVICE=2
…
Downstream (what this service depends on)
dependencies of Application Contoso.Orders.Api (aspnetcore)
  200 entities  levels: DIRECT=4 INDIRECT=62 POTENTIAL=39 TRANSITIVE=95  categories: CODE=55 CONFIGURATION=2 EXTERNAL_SYSTEM=1 INFRASTRUCTURE=9 MESSAGE=5 PROJECT=126 SERVICE=2
…
Blast radius: 28.5 (MODERATE) - structural change exposure derived from graph reach; not a probability of failure
…
```

`deployments (0)` means no Kubernetes/Helm workload is declared; Azure hosting appears in the impact rows (`hosted on (hosting target)`).

### Useful options

The shared options.

### Common mistakes

- `Contoso.Orders.Api` is also an assembly and a namespace. Without `--kind Application` the command exits 2 and lists the candidates.

## repository-impact

### What it does

Cross-repository impact of a whole catalog repository over the MetaGraph: repositories it depends on and that depend on it, provided and consumed APIs, shared packages and contracts, messages, external systems, deployments, and an impact/blast-radius over the combined graph. It needs a store with several registered repositories and a built MetaGraph (see [metagraph.md](metagraph.md)).

### Usage

```bash
vogoban repository-impact <repo> [impact options]
```

### Example

```bash
vogoban repository-impact contoso-orders --limit 6 --db meta/graph.db
```

`meta/graph.db` is a store with `contoso-orders`, `contoso-fulfillment` and `contoso-platform-infra` registered, analyzed and a MetaGraph built. Repositories without a Git remote get a `local:<path>` identity, which is why the path appears in the output.

### Output

```text
Repository contoso-orders
  depends on (0)
  dependents (4): contoso-fulfillment, contoso-fulfillment, contoso-fulfillment, contoso-fulfillment
  provided APIs (3): notifications API, Contoso.Orders.Api API, Contoso.Orders.Functions API
  consumed APIs (0)
  shared packages (6): Microsoft.Azure.Functions.Worker.Sdk, Microsoft.Azure.Functions.Worker, Microsoft.Azure.Cosmos, Azure.Identity, Microsoft.Azure.Functions.Worker.Extensions.ServiceBus, Newtonsoft.Json
  produced packages (0)
  shared contracts (1): contoso-fulfillment
  messages (2): OrderSubmitted, OrderSubmitted
  external systems (1): cosmos-contoso-orders.documents.azure.com
  deployed by (0)
  deploys (0)
  infrastructure Pipeline=0 Dockerfile=0 ContainerImage=0 HelmChart=0 Deployment=0 KubernetesService=0 KubernetesIngress=0

impact of Repository local:/home/user/.capy/work/demo/contoso-orders (+8 contained elements in change scope)
  41 entities  levels: DIRECT=4 INDIRECT=5 POTENTIAL=32  categories: API=1 CODE=15 CONTRACT=3 INFRASTRUCTURE=8 MESSAGE=8 REPOSITORY=1 SERVICE=5
  repositories: contoso-orders(27), contoso-fulfillment(10), contoso-platform-infra(1)  unresolved at boundary: 1  conflicts: 0
  graph: contoso-fulfillment@1de8ed1b/86f3260a READY, contoso-platform-infra@71a45f03/277cd288 READY, contoso-orders@ccaffed6/a021d2d5 READY  meta=snap_126908bc7645dadecd391eda
level      category        entity                                                                            repository      because                     path (* crosses repository)
…
POTENTIAL  CONTRACT        SharedContract Contoso.Orders.Contracts.OrderSubmitted                            meta            member of shared contract   <-CONTAINS
…
Blast radius: 74.1 (CRITICAL) - structural change exposure derived from graph reach; not a probability of failure
…
repositories                 2      15/15   other repositories reached
…
external-consumers           8      10/10   consumers in other repositories reached through API or message relationships
…
```

`dependents` repeats `contoso-fulfillment` once per cross-repository relationship (contract consumption, infrastructure dependency, ...).

### Useful options

The shared options. `--scope` is ignored: the command always uses repository graphs and the MetaGraph.

### Common mistakes

- Passing an entity instead of a catalog repository. The argument is a repository id, identity or name.
- Running it on a single-repository store. It works, but there is no cross-repository information to show.

## risk

### What it does

Computes a deterministic change-risk score for one or more entities, or for every entity changed between two graph snapshots (`--diff`). It adds factors for contract changes, breaking change kinds, public exposure, centrality, depth and uncertainty on top of the blast-radius factors, and prints enterprise context (exposure, sensitive resources, criticality, ownership gaps, cross-team propagation, trust boundaries) that is reported but not added to the score.

### Usage

```bash
vogoban risk <entity...> [--change K] [impact options]
vogoban risk --diff [--repo R | --meta] [--from S --to S] [impact options]
```

`--change` takes the same kinds as `api-impact`. `--diff` uses the latest two snapshots unless `--from`/`--to` are given; see [diff.md](diff.md#risk---diff) for an example.

### Example

```bash
vogoban risk "POST /api/orders" --kind ApiOperation --change route --limit 3
```

### Output

```text
impact of ApiOperation Contoso.Orders.Api:POST /api/orders
  16 entities  levels: DIRECT=1 INDIRECT=1 POTENTIAL=14  categories: API=1 CODE=7 INFRASTRUCTURE=3 PROJECT=1 REPOSITORY=1 SERVICE=3
…
Change risk: 51.3 (HIGH) - deterministic structural engineering risk; not a probability of production failure
factor                       value  points  explanation
---------------------------  -----  ------  --------------------------------------------------------------------------------
direct                       1      4/10    entities directly dependent on the change
…
contract-change              2      7.9/10  changed entities that are API, message or contract boundaries
breaking-change-kinds        1      5/15    change kinds that can break consumers (removed/renamed operations, changed metho
public-exposure              0      0/5     ingress routes or cross-repository API operations in the impact set
centrality                   3      6/10    direct dependents of the changed entities
dependency-depth             5      5/5     deepest propagation hop
uncertainty                  0      0/0     0 unresolved relationships at the impact boundary; 88% of impacted entities are

Enterprise context (contributing evidence; not added to the score)
factor                          value        explanation
------------------------------  -----------  --------------------------------------------------------------------------------
PUBLIC_EXPOSURE                 2            2 affected services are publicly exposed
SENSITIVE_RESOURCES             0            no affected service accesses a classified sensitive resource
CRITICALITY                     UNSPECIFIED  no configured criticality applies
OWNERSHIP_GAPS                  8            8 affected components have no resolved owner
…
```

Enterprise context uses `./vogoban-enterprise.yaml` (or `--enterprise`) when present; without it, ownership and criticality are reported as unknown. See [security.md](security.md).

### Useful options

- `--change K` tells the score which kind of change you plan.
- `--enterprise <file|none>` and `--policy <file|dir>` feed the enterprise context.

### Common mistakes

- Treating the score as a probability. It ranks structural exposure.
- Running `risk --diff` when the repository has only one snapshot. It exits 2 with `need two repository snapshots … (found 1)`.

## cycles

### What it does

Finds dependency cycles and prints each one as a full path with the size of its strongly connected component.

### Usage

```bash
vogoban cycles [project|repository|service|relationship] [--type T,...] [--repo R]
```

The default kind is `project` (project references). `repository` uses MetaGraph repository relationships, `service` uses application-level dependencies, and `relationship` finds cycles over the relationship types you pass with `--type` (required).

### Example

```bash
vogoban cycles project
vogoban cycles relationship --type CALLS --repo contoso-orders
```

### Output

```text
No project cycles.
```

When cycles exist, each is printed as `Cycle N (H hops; strongly connected component of S)` followed by the path in the same format as `paths`.

### Useful options

`--repo R` restricts to one repository; `--out`/`--format` export one row per cycle step.

### Common mistakes

- `vogoban cycles relationship` without `--type` exits 2 with `relationship cycles require --type`.

## orphaned

### What it does

Lists structures with no observed consumer or reference, labelled `NO_OBSERVED_CONSUMER`, `UNREFERENCED`, `UNREACHABLE` or `ORPHANED`, with the reason for each.

### Usage

```bash
vogoban orphaned [--repo R] [--label L]
```

### Example

```bash
vogoban orphaned --limit 8
```

### Output

```text
finding                            count
---------------------------------  -----
NO_OBSERVED_CONSUMER Application   2
NO_OBSERVED_CONSUMER ApiOperation  1
UNREFERENCED Project               1

label                 kind          entity                                                    repository      reason
--------------------  ------------  --------------------------------------------------------  --------------  --------------------------------------------------------------------------------
NO_OBSERVED_CONSUMER  Application   notifications (azure-functions)                           contoso-orders  application is neither run by a declared workload nor called by any analyzed cli
NO_OBSERVED_CONSUMER  ApiOperation  notifications:GET /api/health                             contoso-orders  no HTTP client call in any analyzed repository resolves to this operation; clien
NO_OBSERVED_CONSUMER  Application   react:web                                                 contoso-orders  application is neither run by a declared workload nor called by any analyzed cli
UNREFERENCED          Project       src/Contoso.Orders.AppHost/Contoso.Orders.AppHost.csproj  contoso-orders  project reference to Contoso.Orders.Api has no observed compiler-resolved usage
```

### Useful options

`--label NO_OBSERVED_CONSUMER` filters one label (case-insensitive); `--limit`, `--json`, `--out`.

### Common mistakes

- Deleting code because it is listed here. "No observed consumer" means no consumer in the analyzed repositories: health endpoints are called by load balancers, and public APIs by clients Vogoban has not analyzed.

## Related

- [Impact analysis feature guide](../features/impact-analysis.md)
- [diff.md](diff.md) for snapshot comparison and `risk --diff`
- [metagraph.md](metagraph.md) for building the multi-repository store
- [graph.md](graph.md) for `deps`, `path` and other inspection commands
