# orders-service

The order domain of the VG enterprise landscape. `Orders.Api` owns the order document, stores it in
the Cosmos DB orders container and publishes every lifecycle change onto the Service Bus order events
topic. It is the only writer of `vg-orders` and the only publisher of `vg-order-events`.

- Assembly `Orders.Api`, root namespace `Vg.Enterprise.Orders`, project `src/Orders.Api`
- Port `5181`, deployment unit `vg-orders-api`

## What it publishes and consumes

| Direction | Resource | Detail |
|---|---|---|
| writes / reads | Cosmos DB `vg-orders` in `vg-enterprise`, partition key `/customerId` | `CosmosOrderRepository` through `ICosmosContainerFactory` |
| publishes | Service Bus topic `vg-order-events` on `vg-enterprise-servicebus.servicebus.windows.net` | `orders/order-created`, `orders/order-updated`, `orders/order-cancelled` through `IOrderEventPublisher` |
| reads at runtime | `../enterprise-contracts/contracts/orders/*.schema.json` | every published payload is validated against the matching schema before it is sent |
| exposes | HTTP on `http://localhost:5181` | `openapi/orders.openapi.yaml` |

Consumers of the topic, declared in `enterprise-contracts/asyncapi/vg-order-events.asyncapi.yaml`:
subscription `vg-order-processor` (owned by `order-processing`) and subscription `vg-notifications`
(owned by `notification-service`). Consumers of this HTTP surface: `customer-service` over its typed
`HttpClient` base URL, and `platform-gateway`, whose `scripts/verify-downstream-contracts.mjs` reads
`../orders-service/openapi/orders.openapi.yaml` and fails if a path it calls is missing.

## Cross-repository references

| Reference | Carried by |
|---|---|
| `ProjectReference` to `../../../enterprise-contracts/dotnet/Enterprise.Contracts/Enterprise.Contracts.csproj` | `src/Orders.Api/Orders.Api.csproj` |
| Contract ids `orders/order-created`, `orders/order-updated`, `orders/order-cancelled` | `src/Orders.Api/Messaging/ServiceBusOrderEventPublisher.cs`, through `VgEnterpriseTopology.ContractIds` |
| Shared JSON Schemas, loaded at runtime under `Contracts:SchemaRoot` | `src/Orders.Api/Contracts/ContractSchemaValidator.cs` |
| Resource identity (`vg-enterprise-cosmos`, `vg-orders`, `vg-enterprise`, `vg-enterprise-servicebus`, `vg-order-events`, `vg-enterprise-kv`, `vg-enterprise-identity`) | `src/Orders.Api/appsettings.json`, defaulted from `VgEnterpriseTopology` in `src/Orders.Api/Infrastructure/*Options.cs` |
| OpenAPI document read by `platform-gateway` | `openapi/orders.openapi.yaml` |
| Ownership metadata | `catalog-info.yaml` |

`Contracts:SchemaRoot` defaults to `../enterprise-contracts/contracts`, so it resolves across the
repository boundary whenever the service runs with this repository's root as its working directory.
The project file sets `RunWorkingDirectory` to `$(MSBuildProjectDirectory)/../../` for that reason:
`dotnet run` would otherwise start the process in the project directory, where the frozen relative
path reaches `orders-service/src/enterprise-contracts/contracts` instead. The resolved directory is
logged at startup, so which schema root a running instance actually uses is never a guess.

## Build and run

```bash
export PATH="$HOME/.capy/work/dotnet:$PATH"

# from this repository's root
dotnet build

# boot on http://localhost:5181
dotnet run --project src/Orders.Api

# the published route surface
curl -s http://localhost:5181/swagger/v1/swagger.json | head
```

The service needs no Azure subscription to build or boot: the token credential, the Cosmos client,
the Service Bus client and the Key Vault client are all created lazily and nothing connects until a
request is issued. `Azure:KeyVault:Enabled` is `false` by default, and a deployment turns it on to
read the settings named by the `ConnectionStrings` block out of `vg-enterprise-kv`.

## HTTP surface

| Method | Route | Effect |
|---|---|---|
| `GET` | `/api/Orders` | lists the orders in `vg-orders` |
| `GET` | `/api/Orders/{id}` | one order, `404` when it does not exist |
| `POST` | `/api/Orders` | creates an order and publishes `orders/order-created` |
| `PUT` | `/api/Orders/{id}` | replaces the lines of an order and publishes `orders/order-updated` |
| `DELETE` | `/api/Orders/{id}` | cancels an order and publishes `orders/order-cancelled` |
| `POST` | `/api/Orders/{id}/cancel` | cancels an order as an explicit command; the route `platform-gateway`'s `OrdersClient.CancelAsync` posts to |
| `GET` | `/api/orders/{id}/summary` | minimal-API condensed view of one order |

`openapi/orders.openapi.yaml` is generated from a running instance through
`/swagger/v1/swagger.json`, so it cannot describe a route the service does not serve.
