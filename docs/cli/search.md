# Searching the graph

`vogoban find` searches entities by name or qualified name. This page documents `find` and gives tested recipes for the questions people ask most: where are the Azure Functions, which Service Bus topics and queues exist, what does an API operation look like, who calls a method, where is Cosmos DB used. There is no `graph search` command; `find` is the search command.

Examples run inside the `contoso-orders` demo repository. Your ids will differ.

## Search, traversal and impact

Three different kinds of command answer three different questions:

| Question | Command family | Examples |
| --- | --- | --- |
| "Which entities are called X / are of kind K?" | **Search**: matches entity names, returns a flat list | `find`, and the list views `endpoints`, `operations`, `azure functions`, `messages` |
| "How is this entity connected?" | **Relationship traversal**: follows stored relationships from one entity, a fixed number of hops | `show`, `deps`, `callers`, `callees`, `references`, `path`, `azure flow`, `frontend-chain` |
| "What is affected if this changes?" | **Impact analysis**: transitive propagation with levels, categories and explanation paths, across repositories | `impact`, `dependents`, `paths`, `api-impact`, `message-impact` |

A normal workflow is: `find` to get the entity id, `show` or `callers` to inspect it, `impact` when you plan a change. Impact analysis is documented in [impact.md](impact.md).

## find

### What it does

Returns entities whose name or qualified name contains the search text (case-insensitive substring match), optionally restricted to some entity kinds.

### Usage

```bash
vogoban find <text> [--kind K[,K...]] [--repo <repo>] [--limit N] [--json]
```

### Example

```bash
vogoban find Order --kind Type
```

### Output

```text
id                          entity                                                          location
--------------------------  --------------------------------------------------------------  -------------------------------------------------------------
e_8fb805dc3fd59e0396c444d4  Type:Record Contoso.Orders.Api.Controllers.CreateOrderRequest   src/Contoso.Orders.Api/Controllers/OrdersController.cs:8
e_f6132e8c075a75c91ced2dc0  Type:Class Contoso.Orders.Api.Controllers.OrdersController      src/Contoso.Orders.Api/Controllers/OrdersController.cs:13
e_9f9f5dfe4ad20619b379fac1  Type:Interface Contoso.Orders.Api.Services.IOrderService        src/Contoso.Orders.Api/Services/OrderService.cs:8
e_ecc5728e9c08860af51f6d2f  Type:Class Contoso.Orders.Api.Services.OrderService             src/Contoso.Orders.Api/Services/OrderService.cs:13
…
e_42468005d694cb7131c446b2  Type:interface web/src/api/orders.ts:CreateOrder                web/src/api/orders.ts:2
e_1067a3cd0f5e6109a94ca8dc  Type:interface web/src/api/orders.ts:OrderLine                  web/src/api/orders.ts:1
```

The `entity` column is `Kind[:subkind] qualified-name`. The `id` column is what you pass to other commands when a name is ambiguous. C# and TypeScript types appear side by side; TypeScript symbols are qualified by file (`web/src/api/orders.ts:OrderLine`).

### Useful options

| Option | Effect |
| --- | --- |
| `--kind K,...` | Entity kinds to include. Kinds are case-sensitive (`Method`, not `method`). Common kinds: `Type`, `Method`, `Property`, `Project`, `Package`, `File`, `Application`, `Endpoint`, `Api`, `ApiOperation`, `Message`, `Topic`, `Queue`, `Database`, `AzureFunction`, `AzureResource`, `FrontendRoute`, `Pipeline`, `ContainerImage`, `HelmRelease`, `Deployment`, `SecretReference`. `vogoban stats` lists the kinds present in your store. |
| `--repo R` | Search one repository of a multi-repository store |
| `--limit N` | Maximum rows (default 50; results beyond it are silently dropped) |
| `--json` | Full entity records, including metadata |

### Common mistakes

- `find` needs text: `vogoban find "" --kind AzureFunction` fails with `find requires search text`. Use a fragment every name shares (often the namespace or project name), or a dedicated list command such as `azure functions`.
- `*`, `%` and `_` are literal characters, not wildcards.
- Without `--kind`, method searches are flooded by parameters: every parameter's qualified name contains its method's name. `vogoban find SubmitAsync` returns two methods and six parameters.
- An unknown kind fails fast: `vogoban find order --kind Foo` prints `unknown entity kind(s): Foo` and exits 2.

## Recipes

### Find all Azure Functions

```bash
vogoban find Order --kind AzureFunction
```

```text
id                          entity                                                  location
--------------------------  ------------------------------------------------------  -------------------------------------------------
e_b49e063f121b62522a6947fb  AzureFunction Contoso.Orders.Functions:GetOrderStatus   src/Contoso.Orders.Functions/OrderFunctions.cs:22
e_317eba2c5b2ef110eee93ce4  AzureFunction Contoso.Orders.Functions:NightlyCleanup   src/Contoso.Orders.Functions/OrderFunctions.cs:40
e_99a181ed4b039212a61131ad  AzureFunction Contoso.Orders.Functions:OnOrderAudit     src/Contoso.Orders.Functions/OrderFunctions.cs:37
e_d41faef61596617400c06703  AzureFunction Contoso.Orders.Functions:OrderChangeFeed  src/Contoso.Orders.Functions/OrderFunctions.cs:33
e_7f3bddb8e95711f7485818f7  AzureFunction Contoso.Orders.Functions:ProcessOrder     src/Contoso.Orders.Functions/OrderFunctions.cs:18
```

The Function's qualified name is `<function app>:<function name>`, so searching for the app name (`Orders`) finds every Function in it. For **all** Functions with their triggers, bindings, auth level and hosting, use the dedicated view, which also includes Node.js Functions:

```bash
vogoban azure functions
```

See [azure.md](azure.md#azure-functions).

### Find Service Bus topics and queues

Service Bus, Event Hubs and Event Grid entities that code uses are `Topic` and `Queue` entities; subscriptions are `Queue` entities named `…/topic/subscription`:

```bash
vogoban find orders --kind Queue,Topic
```

```text
id                          entity                                                                            location
--------------------------  --------------------------------------------------------------------------------  --------
e_4d6ba494eb2bd9568b8297c5  Queue azure-service-bus:service-bus-entity:sb-contoso-orders/notifications-sent
e_59b9c5fef4e9584104bbaee6  Queue azure-service-bus:service-bus-entity:sb-contoso-orders/orders
e_2093d8f341d562f4fd179f1a  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin…
e_26f01cd31dcd600493895e4e  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifi…
e_3eb876ad202a22761f5629d3  Topic azure-event-grid:event-grid-topic:egt-contoso-orders-audit
e_f4f374f3758fa949fab628ef  Topic azure-event-hubs:event-hub:evhns-contoso-orders/order-telemetry
```

The prefix names the broker (`azure-service-bus`, `azure-event-hubs`, `azure-event-grid`; RabbitMQ, Kafka and other brokers have their own). To see who publishes to and consumes from each one, and which IaC resource declares it:

```bash
vogoban azure messaging
```

```text
azure-service-bus sb-contoso-orders/orders  [exact]
  publishers:    PUBLISHES_TO Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)
  receivers:     -
  subscriptions: SUBSCRIBES_TO Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifications; SUBSCRIBES_TO Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing
  consumers:     -
  messages:      -
  declared by:   DECLARED_BY AzureResource aspire:orders; DECLARED_BY AzureResource Microsoft.ServiceBus/namespaces/topics:sb-contoso-orders/orders
…
```

The declared IaC resources (namespaces, topics, subscriptions in Bicep, ARM, Terraform or Aspire) are listed by `vogoban azure resources --kind service-bus`. For message contracts (the payload types) use [`messages`](contracts.md#messages-and-message).

### Find an API operation

List operations, filtered by method or path fragment:

```bash
vogoban operations --method GET
```

```text
method  path                     version  source           implementation  api                       id
------  -----------------------  -------  ---------------  --------------  ------------------------  --------------------------
GET     /api/health              -        aspnetcore-code  implemented     notifications             e_a19d8be0940ec42007b88284
GET     /api/orders/{id}/status  -        aspnetcore-code  implemented     Contoso.Orders.Functions  e_09bf67d2f537b2c222fc6497
```

Then open one by `"VERB /path"` (quote it, it contains a space):

```bash
vogoban operation "POST /api/orders"
```

```text
Contoso.Orders.Api:POST /api/orders  [aspnetcore-code]
  id              e_9b03142b199ff5a0543f224b
  location        src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
  operationId     -   version -   implementation implemented
  parameters      request:body?:Contoso.Orders.Api.Controllers.CreateOrderRequest
  security        required
  request         Type:Record Contoso.Orders.Api.Controllers.CreateOrderRequest
  responses       -
  implemented by  POST /api/orders (src/Contoso.Orders.Api/Controllers/OrdersController.cs:16)
  called by       web/src/api/orders.ts:createOrder [INFERRED]
```

`find` works too (`vogoban find order --kind ApiOperation`), but `operations` filters on the HTTP method and path fields. See [contracts.md](contracts.md#operations-and-operation).

### Find the callers of a method

```bash
vogoban callers Contoso.Orders.Api.Services.OrderService.SubmitAsync --kind Method --dispatch
```

```text
Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)  src/Contoso.Orders.Api/Services/OrderService.cs:24
  [CALLS/COMPILER_RESOLVED] Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)  src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
(1 callers)
```

Always add `--kind Method`. If the name is still ambiguous (an interface method and its implementation), use the namespace-qualified name or the id from `vogoban find SubmitAsync --kind Method`. `--dispatch` includes callers that go through the interface; `--depth 3` walks three levels up. For frontend and cross-repository callers (HTTP calls, message publishers), use `vogoban impact <method> --kind Method` or `azure flow --upstream`.

### Find Cosmos DB resources

Declared Cosmos DB resources (Bicep, ARM, Terraform, Aspire):

```bash
vogoban azure resources --kind cosmos-db
```

```text
type                                                           name                                   name state           declared in  state     code refs  location
-------------------------------------------------------------  -------------------------------------  -------------------  -----------  --------  ---------  ---------------------------------------
Microsoft.DocumentDB/databaseAccounts                          cosmos                                 aspire-logical-name  aspire       DECLARED  0          src/Contoso.Orders.AppHost/AppHost.cs:5
Microsoft.DocumentDB/databaseAccounts                          cosmos-contoso-orders                  exact                bicep        DECLARED  0          infra/modules/data.bicep:4
Microsoft.DocumentDB/databaseAccounts/sqlDatabases             cosmos-contoso-orders/ordersdb         exact                bicep        DECLARED  0          infra/modules/data.bicep:16
…
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers  cosmos-contoso-orders/ordersdb/orders  exact                bicep        DECLARED  1          infra/modules/data.bicep:22
```

`code refs` counts code-side resources that resolve to the declaration. The code side (the container the code actually reads and writes, through `CosmosClient` or Functions bindings) is a `Database` entity:

```bash
vogoban find order --kind Database
```

```text
id                          entity                                                                 location
--------------------------  ---------------------------------------------------------------------  --------
e_0f02f58d59967847a7bbbb93  Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders
```

Use its id with `show` or `azure flow --upstream` to see every Function and method that reads or writes it.

### Find by Azure service, IaC type or entity kind

`azure resources --kind` takes an Azure service name (`cosmos-db`, `service-bus`, `event-hubs`, `event-grid`, `key-vault`, `storage`, `functions`, `app-service`, `api-management`, `monitor`, `identity`, ...), a resource kind, or a full ARM type (case-insensitive):

```bash
vogoban azure resources --kind microsoft.eventhub/namespaces/eventhubs
```

```text
type                                     name                                  name state  declared in  state     code refs  location
---------------------------------------  ------------------------------------  ----------  -----------  --------  ---------  --------------------------------
Microsoft.EventHub/namespaces/eventhubs  evhns-contoso-orders/order-telemetry  exact       bicep        DECLARED  1          infra/modules/messaging.bicep:33
```

`find --kind AzureResource` searches the same resources by name instead:

```bash
vogoban find Cosmos --kind AzureResource
```

### Search across repositories

In a store with several repositories, `find` searches all of them; add `--repo` to narrow:

```bash
vogoban --db meta/graph.db find Order --kind AzureFunction --repo contoso-fulfillment
```

```text
id                          entity                                                    location
--------------------------  --------------------------------------------------------  ------------------------------------------------------------
e_eb02d1608c7ee2a10c587383  AzureFunction Contoso.Fulfillment.Functions:FulfillOrder  src/Contoso.Fulfillment.Functions/FulfillmentFunctions.cs:10
```

For cross-repository questions (who consumes this API or message in another repository), use the MetaGraph commands in [metagraph.md](metagraph.md).

## Common mistakes

- **Mixing up kinds.** `azure resources --kind` takes Azure service names; `find --kind` and every other `--kind` take entity kinds. `vogoban azure flow ProcessOrder --kind cosmos-db` fails with `unknown entity kind(s): cosmos-db`.
- **Expecting a search to follow relationships.** `find Order` does not return the queue an order is sent to. Find the entity, then traverse with `show`, `azure flow` or `impact`.
- **Truncated results.** `find` returns at most 50 rows unless you pass `--limit`.

## Related

- [overview.md](overview.md#entity-references): how references and ambiguity work
- [graph.md](graph.md): `show`, `deps`, `callers`, `path`
- [impact.md](impact.md): impact analysis and multi-path search
- [azure.md](azure.md), [contracts.md](contracts.md)
