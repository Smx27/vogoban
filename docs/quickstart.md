# Five-minute quickstart

A copy-paste tour of Vogoban on the sample application that ships in the source package. You will analyze a small but realistic system (a React frontend, an ASP.NET Core API, Service Bus, Azure Functions, Cosmos DB and Bicep), then search it, trace a request through it, run an impact analysis and export the graph.

Every output below comes from a real run of Vogoban 0.18.0. Ids, commit hashes and timings on your machine will differ.

## 0. Install and verify

```bash
bun install -g ./vogoban-0.18.0-src.tar.gz
export PATH="$HOME/.bun/bin:$PATH"
vogoban --version
```

```text
0.18.0
```

For the C# parts of the sample you also need the .NET SDK 8+ (`dotnet --list-sdks`). Without it the tour still works, with fewer compiler-resolved relationships. See [Installation](installation.md).

## 1. Get the sample

The sample lives in the source package under `test/azure/fixtures/contoso-orders`. Copy it out and make it a Git repository, because Vogoban records commits and detects changes through Git:

```bash
tar xzf vogoban-0.18.0-src.tar.gz            # unpacks into ./v
cp -r v/test/azure/fixtures/contoso-orders ./contoso-orders
cd contoso-orders
printf '.vogoban/\nbin/\nobj/\n' > .gitignore
git init -q && git add -A && git commit -qm "sample"
```

Restore the .NET projects so Roslyn can resolve NuGet types (skip this if you have no .NET SDK):

```bash
for p in $(find . -name '*.csproj'); do dotnet restore "$p"; done
```

## 2. Analyze

```bash
vogoban analyze .
```

Progress lines go to stderr; the summary goes to stdout:

```text
Analyzed contoso-orders @ ccaffed660b7 in 3114 ms
                               count
-----------------------------  -----
Projects                       6
…
Unresolved References          1
evidence: COMPILER_RESOLVED=675 DECLARED=140 EXACT=272 INFERRED=5 STRUCTURALLY_RESOLVED=59
unresolved: dynamic-transport-name=1
…
```

The graph is now in `./.vogoban/graph.db`. [Getting started](getting-started.md#3-run-the-first-analysis) explains each part of this summary.

## 3. Check the graph state

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

`UP_TO_DATE` means the graph describes exactly the checked-out commit. After you edit files it says `CHANGES_DETECTED`, and `vogoban graph sync` brings it up to date.

## 4. Search

Find entities by name. `--kind` narrows the search to one entity kind:

```bash
vogoban find OrderService --kind Type
```

```text
id                          entity                                                    location
--------------------------  --------------------------------------------------------  --------------------------------------------------
e_9f9f5dfe4ad20619b379fac1  Type:Interface Contoso.Orders.Api.Services.IOrderService  src/Contoso.Orders.Api/Services/OrderService.cs:8
e_ecc5728e9c08860af51f6d2f  Type:Class Contoso.Orders.Api.Services.OrderService       src/Contoso.Orders.Api/Services/OrderService.cs:13
```

List what the system exposes and runs:

```bash
vogoban endpoints
```

```text
verb  route                    auth       handler                                                                           id
----  -----------------------  ---------  --------------------------------------------------------------------------------  --------------------------
GET   /api/health              required   health                                                                            e_ea3bd97f8561f7644fc89bd9
POST  /api/orders              required   Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Contro  e_6db0957813aeb95bf36d4fbe
GET   /api/orders/{id}/status  anonymous  Contoso.Orders.Functions.OrderFunctions.GetOrderStatus(Microsoft.Azure.Functions  e_6378ac9f15cc90e2fc1aa0cb
```

```bash
vogoban azure functions
```

```text
function                                  trigger     trigger source                                                                    …
----------------------------------------  ----------  --------------------------------------------------------------------------------
contoso-notifications:NotifyCustomer      serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifi  …
Contoso.Orders.Functions:GetOrderStatus   http        Endpoint Contoso.Orders.Functions:GET /api/orders/{id}/status (COMPILER_RESOLVED  …
Contoso.Orders.Functions:ProcessOrder     serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin  …
…
```

More search recipes (callers of a method, Service Bus topics, Cosmos resources) are in [Search](cli/search.md).

## 5. Trace a request through the system

Start at the React route `/orders/new` and follow stored relationships down to the Bicep declaration of the Cosmos DB container it eventually writes to. First find the container's declaration:

```bash
vogoban find ordersdb/orders
```

```text
id                          entity                                                                            location
--------------------------  --------------------------------------------------------------------------------  ---------------------------
e_132f2e9a02dfdf4c3d3b0a4c  AzureResource Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosm  infra/modules/data.bicep:22
e_0f02f58d59967847a7bbbb93  Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders
```

Then ask for the flow from the route to that resource (use the `AzureResource` id from your own output):

```bash
vogoban azure flow /orders/new --kind FrontendRoute --to e_132f2e9a02dfdf4c3d3b0a4c
```

```text
FrontendRoute contoso-orders-web:/orders/new  downstream: 35 reachable entities

    FrontendRoute contoso-orders-web:/orders/new
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      -[CALLS/COMPILER_RESOLVED]-> Method:function web/src/api/orders.ts:createOrder
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Contoso.Orders.Api:POST /api/orders
      -[IMPLEMENTED_BY/EXACT]-> Endpoint Contoso.Orders.Api:POST /api/orders
      -[IMPLEMENTED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Controllers.OrdersController.Create(…)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(…)
      <-[IMPLEMENTS/COMPILER_RESOLVED]- Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(…)
      -[PUBLISHES/COMPILER_RESOLVED]-> Message Contoso.Orders.Contracts.OrderSubmitted
      -[CONSUMED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(…)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderProcessor.ProcessAsync(…)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.Data.IOrderRepository.SaveAsync(…)
      <-[IMPLEMENTS/COMPILER_RESOLVED]- Method Contoso.Orders.Functions.Data.CosmosOrderRepository.SaveAsync(…)
      -[WRITES_TO/COMPILER_RESOLVED]-> Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders
      -[DECLARED_BY/STRUCTURALLY_RESOLVED]-> AzureResource Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosmos-contoso-orders/ordersdb/orders
```

Each line is one stored relationship: its type, its evidence level, and the entity it leads to. Read it top to bottom: the route renders `NewOrderPage`, which calls `createOrder`, whose `fetch` targets the `POST /api/orders` operation, implemented by `OrdersController.Create`, which publishes `OrderSubmitted`; the Function `ProcessOrder` consumes it and saves through a repository that writes to the Cosmos container declared in `infra/modules/data.bicep`.

The one `INFERRED` hop is the frontend-to-backend link: it is a match of HTTP method and route, which is weaker than a compiler fact, and Vogoban labels it as such. The [Azure end-to-end tutorial](features/azure-end-to-end.md) walks through every hop.

## 6. Run an impact analysis

"If I change the `OrderSubmitted` message, what may be affected?" `OrderSubmitted` is both a C# record and a message contract, so pick the message with `--kind`:

```bash
vogoban impact OrderSubmitted --kind Message --limit 8
```

```text
impact of Message Contoso.Orders.Contracts.OrderSubmitted
  28 entities  levels: DIRECT=3 INDIRECT=7 POTENTIAL=18  categories: API=2 CODE=12 INFRASTRUCTURE=3 MESSAGE=4 SERVICE=7
  repositories: contoso-orders(28)  unresolved at boundary: 1  conflicts: 0
  graph: contoso-orders@ccaffed6/a021d2d5 READY
level      category        entity                                                                            repository      because                       path (* crosses repository)
---------  --------------  --------------------------------------------------------------------------------  --------------  ----------------------------  ---------------------------
DIRECT     CODE            Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Colle  contoso-orders  publishes                     <-PUBLISHES
DIRECT     CODE            Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contr  contoso-orders  consumed by                   ->CONSUMED_BY
DIRECT     MESSAGE         Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin  contoso-orders  carries                       <-CARRIES
POTENTIAL  CODE            Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, System.Coll  contoso-orders  dispatched through interface  <-PUBLISHES ->IMPLEMENTS
…
  (20 more; --limit N, --json or --out for all; 'paths <seed> <entity>' explains any row)
```

- **level**: `DIRECT` entities touch the message directly; `INDIRECT` are reached through confirmed hops; `POTENTIAL` are reached only through weaker links such as interface dispatch or an inferred HTTP match.
- **because** and **path** explain each row. Nothing appears here that is not backed by a stored relationship.

See [Impact analysis](features/impact-analysis.md) for levels, scores and API change kinds.

## 7. Export

Write the whole graph to an open format for other tools:

```bash
vogoban export --format json --out graph.json
```

```text
Exported json to graph.json: repositories=1 entities=553 relationships=1151 unresolved=1 diagnostics=0 conflicts=0
```

`jsonl` and `csv` are also available. Every command also accepts `--json` for machine-readable output.

## What you have seen

| Step | Command | Learn more |
|---|---|---|
| Analyze | `vogoban analyze .` | [analyze](cli/analyze.md) |
| Graph state | `vogoban graph status` | [sync and status](cli/sync.md) |
| Search | `vogoban find`, `endpoints`, `azure functions` | [search](cli/search.md) |
| Trace | `vogoban azure flow` | [Azure CLI](cli/azure.md) |
| Impact | `vogoban impact` | [impact CLI](cli/impact.md) |
| Export | `vogoban export` | [export, backup and restore](cli/backup-restore.md) |

Next: [Concepts](concepts.md) explains the model behind these outputs, and the [CLI overview](cli/overview.md) lists every command.
