# Azure commands

`vogoban azure` shows the Azure architecture found in a repository: Azure Functions and their triggers and bindings, Azure resources declared in Bicep, ARM, Terraform and .NET Aspire, the messaging topology (Service Bus, Event Hubs, Event Grid, Storage queues), hosting, identities and role assignments, and the flow of a request or event through all of it. Everything comes from static analysis of the repository. Vogoban **never contacts Azure**; it does not read deployed state, and "declared" always means "written in a file".

Examples run inside the `contoso-orders` demo repository: an ASP.NET Core API that sends `OrderSubmitted` to a Service Bus topic and publishes an Event Grid event, isolated .NET Functions (Service Bus, HTTP, timer, Event Grid and Cosmos DB change-feed triggers) writing to Cosmos DB, Node.js v4 Functions, Bicep with modules, `azure.yaml` and an Aspire AppHost. Your ids will differ.

## Usage

```bash
vogoban azure [summary]
vogoban azure functions
vogoban azure triggers
vogoban azure resources [--kind K]
vogoban azure messaging
vogoban azure infrastructure
vogoban azure flow <entity> [--upstream] [--to E] [--exclude TYPES] [--depth N] [--limit N]
```

All views accept `--repo <repo>` in a multi-repository store and `--json`. An unknown view fails with `unknown azure view '<name>' (summary | functions | triggers | resources | messaging | infrastructure | flow)` and exit 2.

## azure summary

### What it does

Counts Functions by trigger type, declared resources by Azure service and by declaring language, code-side data and messaging resources, and unresolved Azure references by category. `vogoban azure` without a view is the same.

### Example

```bash
vogoban azure
```

### Output

```text
                                    count
----------------------------------  -----
Azure Functions                     7
  cosmosDB                          1
  eventGrid                         1
  http                              2
  serviceBus                        2
  timer                             1
Declared Azure resources            34
  api-management                    3
  app-service                       3
  authorization                     2
  cosmos-db                         7
  …
  service-bus                       6
  static-web-apps                   1
  storage                           1
  declared in bicep                 26
  declared in arm                   0
  declared in terraform             0
  declared in aspire                6
Code-side data/messaging resources  7
Unresolved Azure references         0
```

"Code-side resources" are the queues, topics and databases the code uses (from SDK clients and Function bindings). They are linked to declared resources when the names match.

## azure functions

### What it does

Lists every Azure Function (isolated and in-process .NET, Node.js v4 programming model, and `function.json` Functions in any language) with trigger type, trigger source, bindings and durable relationships, authorization level, the Function App it is hosted on, and location.

### Example

```bash
vogoban azure functions
```

### Output

```text
function                                  trigger     trigger source                                                                    bindings / durable                                                                auth       hosted on            location
----------------------------------------  ----------  --------------------------------------------------------------------------------  --------------------------------------------------------------------------------  ---------  -------------------  -------------------------------------------------
contoso-notifications:Health              http        Endpoint contoso-notifications:GET /api/health (COMPILER_RESOLVED)                -                                                                                 function   -                    notifications/src/functions/notify.ts:18
contoso-notifications:NotifyCustomer      serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifi…  -                                                                                 -          -                    notifications/src/functions/notify.ts:17
Contoso.Orders.Functions:GetOrderStatus   http        Endpoint Contoso.Orders.Functions:GET /api/orders/{id}/status (COMPILER_RESOLVED…  READS_FROM Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders  anonymous  func-contoso-orders  src/Contoso.Orders.Functions/OrderFunctions.cs:22
Contoso.Orders.Functions:NightlyCleanup   timer       AzureResource NightlyCleanup:timer (COMPILER_RESOLVED)                            -                                                                                 -          func-contoso-orders  src/Contoso.Orders.Functions/OrderFunctions.cs:40
Contoso.Orders.Functions:OnOrderAudit     eventGrid   AzureResource Microsoft.EventGrid/topics/eventSubscriptions:egt-contoso-orders-a…  -                                                                                 -          func-contoso-orders  src/Contoso.Orders.Functions/OrderFunctions.cs:37
Contoso.Orders.Functions:OrderChangeFeed  cosmosDB    Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders (COMPILER_…  PUBLISHES_TO Topic azure-event-hubs:event-hub:evhns-contoso-orders/order-telemet…  -          func-contoso-orders  src/Contoso.Orders.Functions/OrderFunctions.cs:33
Contoso.Orders.Functions:ProcessOrder     serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin…  -                                                                                 -          func-contoso-orders  src/Contoso.Orders.Functions/OrderFunctions.cs:18
```

| Column | Meaning |
| --- | --- |
| `function` | `<function app or package>:<function name>` |
| `trigger` | Trigger type: `http`, `timer`, `serviceBus`, `eventHub`, `eventGrid`, `blob`, `queue`, `cosmosDB`, durable triggers |
| `trigger source` | The entity that triggers it: an HTTP endpoint, a queue or subscription, an Event Grid subscription resource, a Cosmos DB container, a timer schedule; with evidence |
| `bindings / durable` | Input and output bindings and data access found in the Function's code (`READS_FROM`, `WRITES_TO`, `PUBLISHES_TO`), and durable orchestration relationships |
| `auth` | HTTP authorization level (`anonymous`, `function`, `admin`); `-` for non-HTTP triggers |
| `hosted on` | The Function App resource from IaC (`azd` service tags or project-to-resource rules); `-` when no hosting declaration links it |

### Common mistakes

The Function `ProcessOrder` and its C# method `ProcessOrder` have the same name. In other commands use `--kind AzureFunction` or `--kind Method` to choose.

## azure triggers

### What it does

One row per trigger: trigger type, source, relationship type (`TRIGGERS`, or `CHANGE_FEED` for Cosmos DB), Function, evidence and location. A Function whose trigger source cannot be determined gets a row with source `-` and evidence `UNKNOWN`.

### Example

```bash
vogoban azure triggers
```

### Output

```text
trigger     source                                                                            relationship  function                                  evidence               location
----------  --------------------------------------------------------------------------------  ------------  ----------------------------------------  ---------------------  -------------------------------------------------
http        Endpoint contoso-notifications:GET /api/health                                    TRIGGERS      contoso-notifications:Health              COMPILER_RESOLVED      notifications/src/functions/notify.ts:18
serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifi…  TRIGGERS      contoso-notifications:NotifyCustomer      COMPILER_RESOLVED      notifications/src/functions/notify.ts:17
…
eventGrid   AzureResource Microsoft.EventGrid/topics/eventSubscriptions:egt-contoso-orders-a…  TRIGGERS      Contoso.Orders.Functions:OnOrderAudit     STRUCTURALLY_RESOLVED  src/Contoso.Orders.Functions/OrderFunctions.cs:37
cosmosDB    Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders             CHANGE_FEED   Contoso.Orders.Functions:OrderChangeFeed  COMPILER_RESOLVED      src/Contoso.Orders.Functions/OrderFunctions.cs:33
serviceBus  Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billin…  TRIGGERS      Contoso.Orders.Functions:ProcessOrder     COMPILER_RESOLVED      src/Contoso.Orders.Functions/OrderFunctions.cs:18
```

An Event Grid trigger is linked to the event subscription that targets the Function App in IaC, so its evidence is `STRUCTURALLY_RESOLVED`. Event Grid subscriptions created by scripts or in the portal cannot be linked.

## azure resources

### What it does

Lists declared Azure resources: ARM type, resolved name, how the name was resolved, the declaring language, declared state, how many code-side resources point at it, and location.

### Usage

```bash
vogoban azure resources [--kind K]
```

`--kind` here is **not** an entity kind. It matches a resource's Azure service (`cosmos-db`, `service-bus`, `event-hubs`, `event-grid`, `key-vault`, `storage`, `functions`, `app-service`, `api-management`, `monitor`, `identity`, `sql`, `redis`, `container-apps`, `aks`, `network`, ...), its resource kind, or its ARM type (case-insensitive).

### Example

```bash
vogoban azure resources --kind cosmos-db
```

### Output

```text
type                                                           name                                   name state           declared in  state     code refs  location
-------------------------------------------------------------  -------------------------------------  -------------------  -----------  --------  ---------  ---------------------------------------
Microsoft.DocumentDB/databaseAccounts                          cosmos                                 aspire-logical-name  aspire       DECLARED  0          src/Contoso.Orders.AppHost/AppHost.cs:5
Microsoft.DocumentDB/databaseAccounts                          cosmos-contoso-orders                  exact                bicep        DECLARED  0          infra/modules/data.bicep:4
Microsoft.DocumentDB/databaseAccounts/sqlDatabases             cosmos-contoso-orders/ordersdb         exact                bicep        DECLARED  0          infra/modules/data.bicep:16
Microsoft.DocumentDB/databaseAccounts/sqlDatabases             ordersdb                               exact                aspire       DECLARED  0          src/Contoso.Orders.AppHost/AppHost.cs:6
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers  cosmos-contoso-orders/ordersdb/leases  exact                bicep        DECLARED  0          infra/modules/data.bicep:33
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers  cosmos-contoso-orders/ordersdb/orders  exact                bicep        DECLARED  1          infra/modules/data.bicep:22
Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers  orderdocs                              exact                aspire       DECLARED  0          src/Contoso.Orders.AppHost/AppHost.cs:6
```

| Column | Meaning |
| --- | --- |
| `name state` | `exact` (literal or fully evaluated parameter default), `aspire-logical-name` (the Aspire resource name, not the Azure name), `unresolved` (computed at deployment, e.g. `guid(...)`, `uniqueString(...)`), or partial states |
| `declared in` | `bicep`, `arm`, `terraform`, `aspire`, or `code` (for timer schedules and similar) |
| `state` | `DECLARED` (created by this IaC) or `REFERENCED` (an `existing` resource / Terraform data source declared elsewhere) |
| `code refs` | Code-side resources resolved to this declaration |

In a multi-repository store the same resource can appear twice: `DECLARED` by the repository that creates it and `REFERENCED` by one that uses it.

### Common mistakes

- Using an entity kind: `--kind AzureResource` matches nothing here. To search resources by name use `vogoban find <text> --kind AzureResource`.
- Bicep parameter defaults, parameter files and `azd` `${VAR=default}` defaults are taken as the deployed values. A deployment can override them.

## azure messaging

### What it does

For every Azure broker entity (Service Bus queue, topic and subscription, Event Hub, Event Grid topic, Storage queue) lists publishers, receivers, subscriptions, consumers, carried message contracts and the IaC resources that declare it. The name resolution state is in brackets.

### Example

```bash
vogoban azure messaging
```

### Output

```text
azure-event-grid egt-contoso-orders-audit  [exact]
  publishers:    PUBLISHES_EVENT Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)
  receivers:     -
  subscriptions: -
  consumers:     -
  messages:      -
  declared by:   DECLARED_BY AzureResource Microsoft.EventGrid/topics:egt-contoso-orders-audit

…

azure-service-bus sb-contoso-orders/orders  [exact]
  publishers:    PUBLISHES_TO Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)
  receivers:     -
  subscriptions: SUBSCRIBES_TO Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/notifications; SUBSCRIBES_TO Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing
  consumers:     -
  messages:      -
  declared by:   DECLARED_BY AzureResource aspire:orders; DECLARED_BY AzureResource Microsoft.ServiceBus/namespaces/topics:sb-contoso-orders/orders

azure-service-bus sb-contoso-orders/orders/billing  [exact]
  publishers:    -
  receivers:     -
  subscriptions: -
  consumers:     ROUTES_TO Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken); TRIGGERS AzureFunction Contoso.Orders.Functions:ProcessOrder
  messages:      CARRIES Message Contoso.Orders.Contracts.OrderSubmitted
  declared by:   DECLARED_BY AzureResource Microsoft.ServiceBus/namespaces/topics/subscriptions:sb-contoso-orders/orders/billing
…
```

Read it as: the API publishes to topic `orders`; the topic has subscriptions `billing` and `notifications`; `billing` triggers `ProcessOrder`, which receives `OrderSubmitted`. The topic is declared in Bicep and in the Aspire AppHost. A broker entity with `declared by: -` is used in code but not declared in this repository's IaC.

## azure infrastructure

### What it does

Three tables: IaC files with the number of resources each creates, existing resources it references, and modules it calls; hosting relationships (application or Function to App Service, Function App, Static Web App, plan); and resource-to-resource relationships (role assignments, managed identities, diagnostics and Application Insights, API Management routes, Event Grid subscriptions).

### Example

```bash
vogoban azure infrastructure
```

### Output

```text
IaC files
file                            creates  references existing  modules
------------------------------  -------  -------------------  --------------------------------------------------------------------------------
infra/main.bicep                10       0                    infra/modules/data.bicep, infra/modules/apps.bicep, infra/modules/monitoring.bic…
infra/modules/apps.bicep        5        0                    -
…

Hosting
application                                               relationship  resource                                                      evidence  rule
--------------------------------------------------------  ------------  ------------------------------------------------------------  --------  ------------------------------------------------
AzureFunction Contoso.Orders.Functions:GetOrderStatus     HOSTED_ON     AzureResource Microsoft.Web/sites:func-contoso-orders         DECLARED  function app project hosted on resource
Application Contoso.Orders.Api (aspnetcore)               HOSTED_ON     AzureResource Microsoft.Web/sites:app-contoso-orders-api      DECLARED  azd service name = resource tag azd-service-name
Application react:web                                     HOSTED_ON     AzureResource Microsoft.Web/staticSites:stapp-contoso-orders  DECLARED  azd service name = resource tag azd-service-name
…

Resource relationships
resource                                                                          relationship       target                                                                            evidence               detail
--------------------------------------------------------------------------------  -----------------  --------------------------------------------------------------------------------  ---------------------  -------------------------------------
AzureResource Microsoft.ManagedIdentity/userAssignedIdentities:id-contoso-orders  HAS_ROLE_ON        AzureResource Microsoft.KeyVault/vaults:kv-contoso-orders                         DECLARED               Owner
AzureResource Microsoft.ManagedIdentity/userAssignedIdentities:id-contoso-orders  HAS_ROLE_ON        AzureResource Microsoft.EventGrid/topics:egt-contoso-orders-audit                 DECLARED               EventGrid Data Sender
AzureResource Microsoft.Web/sites:app-contoso-orders-api                          OBSERVED_BY        AzureResource Microsoft.Insights/components:appi-contoso-orders                   DECLARED               APPLICATIONINSIGHTS_CONNECTION_STRING
AzureResource Microsoft.ApiManagement/service/apis/operations:apim-contoso-order…  ROUTES_TRAFFIC_TO  ApiOperation Contoso.Orders.Api:POST /api/orders                                  STRUCTURALLY_RESOLVED
AzureResource Microsoft.Web/sites:func-contoso-orders                             USES_IDENTITY      AzureResource Microsoft.ManagedIdentity/userAssignedIdentities:id-contoso-orders  DECLARED               user-assigned
…
```

`rule` explains how hosting was linked (for example the `azd-service-name` tag matching a service in `azure.yaml`). `detail` holds the role name, identity type or setting that established the relationship.

## azure flow

### What it does

Follows stored relationships from one entity and prints every path. **Downstream** (default) answers "what happens next when this request or event enters here": the handler, the services it calls, the data it writes, the events that triggers. **Upstream** (`--upstream`) answers "what reaches this": publishers, API operations, frontend calls, components and routes. MetaGraph relationships between repositories are followed too.

### Usage

```bash
vogoban azure flow <entity> [--upstream] [--to <entity id>] [--exclude TYPE,...] [--depth N] [--limit N] [--kind K]
```

### Example

```bash
vogoban azure flow ProcessOrder --kind AzureFunction --exclude HOSTED_ON,DECLARED_BY --limit 3
```

### Output

```text
AzureFunction Contoso.Orders.Functions:ProcessOrder  downstream: 8 reachable entities

    AzureFunction Contoso.Orders.Functions:ProcessOrder
      -[IMPLEMENTED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderProcessor.ProcessAsync(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.Data.IOrderRepository.SaveAsync(Contoso.Orders.Functions.Data.OrderDocument, System.Threading.CancellationToken)
      <-[IMPLEMENTS/COMPILER_RESOLVED]- Method Contoso.Orders.Functions.Data.CosmosOrderRepository.SaveAsync(Contoso.Orders.Functions.Data.OrderDocument, System.Threading.CancellationToken)
      -[WRITES_TO/COMPILER_RESOLVED]-> Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders
    …
      -[CHANGE_FEED/COMPILER_RESOLVED]-> AzureFunction Contoso.Orders.Functions:OrderChangeFeed
      -[PUBLISHES_TO/COMPILER_RESOLVED]-> Topic azure-event-hubs:event-hub:evhns-contoso-orders/order-telemetry
```

The Service Bus message is handled by `ProcessOrder`, which calls the processor, which saves through `IOrderRepository` (dispatched to `CosmosOrderRepository`) into the Cosmos `orders` container; the change feed then triggers `OrderChangeFeed`, which publishes to Event Hubs. `<-[IMPLEMENTS]-` is a hop taken against the relationship direction (interface to implementation).

Upstream from the same Function reaches the frontend route that starts the business flow:

```bash
vogoban azure flow ProcessOrder --kind AzureFunction --upstream
```

```text
AzureFunction Contoso.Orders.Functions:ProcessOrder  upstream: 19 reachable entities
…
    AzureFunction Contoso.Orders.Functions:ProcessOrder
      <-[TRIGGERS/COMPILER_RESOLVED]- Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing
      <-[SUBSCRIBES_TO/COMPILER_RESOLVED]- Queue azure-service-bus:service-bus-entity:sb-contoso-orders/orders
      <-[PUBLISHES_TO/COMPILER_RESOLVED]- Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)
      -[IMPLEMENTS/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, …)
      <-[CALLS/COMPILER_RESOLVED]- Method Contoso.Orders.Api.Controllers.OrdersController.Create(…)
      <-[IMPLEMENTED_BY/COMPILER_RESOLVED]- Endpoint Contoso.Orders.Api:POST /api/orders
      <-[IMPLEMENTED_BY/EXACT]- ApiOperation Contoso.Orders.Api:POST /api/orders
      <-[CALLS_ENDPOINT/INFERRED]- Method:function web/src/api/orders.ts:createOrder
      <-[CALLS/COMPILER_RESOLVED]- Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      <-[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]- FrontendRoute contoso-orders-web:/orders/new
      <-[EXPOSES_ROUTE/DECLARED]- Application react:web
```

`--to` keeps only paths that end at one entity:

```bash
vogoban azure flow ProcessOrder --kind AzureFunction --to e_0f02f58d59967847a7bbbb93
```

```text
AzureFunction Contoso.Orders.Functions:ProcessOrder  downstream: 12 reachable entities

    AzureFunction Contoso.Orders.Functions:ProcessOrder
      -[IMPLEMENTED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(…)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.OrderProcessor.ProcessAsync(…)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Functions.Data.IOrderRepository.SaveAsync(…)
      <-[IMPLEMENTS/COMPILER_RESOLVED]- Method Contoso.Orders.Functions.Data.CosmosOrderRepository.SaveAsync(…)
      -[WRITES_TO/COMPILER_RESOLVED]-> Database azure:cosmos-container:cosmos-contoso-orders/ordersdb/orders
```

### Useful options

| Option | Effect |
| --- | --- |
| `--upstream` | Walk towards what reaches the entity |
| `--to <id>` | Only paths ending at this entity |
| `--exclude T,...` | Relationship types not to follow, e.g. `HOSTED_ON,DECLARED_BY` to hide hosting and IaC declarations |
| `--depth N` | Maximum hops (default 14) |
| `--limit N` | Maximum paths printed (default 40); the header still counts every reachable entity |
| `--json` | `{ root, direction, truncated, paths: [{ target, hops }] }` |

The traversal stops at 4000 visited entities and prints `(truncated)` in the header.

### Common mistakes

- `--kind` applies to the start entity **and** `--to`. `vogoban azure flow ProcessOrder --kind AzureFunction --to <database name>` fails with `no entity matches …` because the database is not an `AzureFunction`. Pass `--to` as an id (from `vogoban find order --kind Database`).
- `--kind cosmos-db` is an `azure resources` filter, not an entity kind: `azure flow … --kind cosmos-db` fails with `unknown entity kind(s): cosmos-db`.
- Flow is not impact. It lists reachable paths; it does not classify how strongly each entity is affected. For change impact use [`impact`](impact.md).

## Limitations

- Runtime values are unknown: names computed by code, `uniqueString`, random or naming providers and unset `azd` environment values stay partial or unresolved.
- Exposure and security facts are declarations. App Service access restrictions, Front Door/WAF rules, NSG evaluation, Entra ID app registrations and RBAC inheritance are not modelled.
- SDK clients passed through method parameters, collections, `Lazy<T>`, reflection or service locators beyond `GetRequiredService<T>()` are not traced.
- A code-side resource whose namespace or account is not statically known stays partial and is never linked to a declaration.
- JS/TS SDK types are not loaded from `node_modules`; Python, Java and PowerShell Functions are found only through `function.json`.
- ARM linked templates and Bicep registry modules (other than the supported AVM resource modules) are opaque. Terraform `count`/`for_each` instances are one resource with `loop: true`.
- Event Grid subscriptions created outside IaC cannot be linked to their Functions.

Details and the model: [azure.md](../features/azure.md) and [azure-end-to-end.md](../features/azure-end-to-end.md).

## Related

- [search.md](search.md#find-service-bus-topics-and-queues): search recipes for Azure entities
- [infrastructure.md](infrastructure.md): pipelines, containers, Helm and Kubernetes
- [impact.md](impact.md), [metagraph.md](metagraph.md)
- [azure-engine.md](../architecture/azure-engine.md)
