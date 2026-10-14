# order-processing

The `vg-order-processor-function` deployment unit: an Azure Functions isolated worker (v4) that
subscribes to order events and projects them into Cosmos DB. Assembly `OrderProcessing.Function`,
root namespace `Vg.Enterprise.OrderProcessing`, project `src/OrderProcessing.Function`.

## What it does

`OrderProcessorFunction` is triggered by the `vg-order-processor` subscription on the
`vg-order-events` topic of the `vg-enterprise-servicebus` namespace (connection from the
`ServiceBusConnection` application setting). For every `orders/order-created` message it:

1. deserializes the body into `OrderCreatedEvent`,
2. validates it against the `orders/order-created` JSON Schema,
3. upserts an `OrderDto` with `OrderStatus.Processing` into the `vg-orders` container
   (partition key `/customerId`) of the `vg-enterprise` database on the `vg-enterprise-cosmos`
   account.

It consumes one contract and publishes none.

## Cross-repository references

| Reference | Carried by |
|---|---|
| Project reference to the contract library `../../enterprise-contracts/dotnet/Enterprise.Contracts/Enterprise.Contracts.csproj` | `src/OrderProcessing.Function/OrderProcessing.Function.csproj` |
| Topic `vg-order-events` and subscription `vg-order-processor` as compile-time `ServiceBusTrigger` arguments | `src/OrderProcessing.Function/Functions/OrderProcessorFunction.cs` (`VgEnterpriseTopology.ServiceBus.OrderEventsTopic` / `.OrderProcessorSubscription`) |
| Contract id `orders/order-created` and container `vg-orders` read from the same constants | `src/OrderProcessing.Function/Functions/OrderProcessorFunction.cs`, `src/OrderProcessing.Function/Infrastructure/CosmosOptions.cs` |
| Runtime schema validation against `../enterprise-contracts/contracts` via `Contracts:SchemaRoot` (loaded path and contract id logged at startup) | `src/OrderProcessing.Function/Contracts/ContractSchemaValidator.cs` |
| Secret `vg-servicebus-connection` in vault `vg-enterprise-kv` | `src/OrderProcessing.Function/local.settings.json`, `ServiceBusConnection` |
| Secret `vg-cosmos-connection` in vault `vg-enterprise-kv` | `src/OrderProcessing.Function/appsettings.json`, `ConnectionStrings:Cosmos` |
| Ownership metadata `vg-order-processor-function`, owner `commerce-platform`, domain `commerce` | `catalog-info.yaml` |

## Layout

```
src/OrderProcessing.Function/
  Program.cs                              host builder: Functions worker defaults, Key Vault, services
  Functions/OrderProcessorFunction.cs     the Service Bus trigger and the order projection
  Contracts/ContractSchemaValidator.cs    runtime JSON Schema validation of consumed events
  Infrastructure/                         options, token credential, Cosmos container factory
  host.json  appsettings.json  local.settings.json
```

`local.settings.json` is committed and holds placeholders only; it is what `func start` reads
locally, and `appsettings.json` is the same configuration for the deployed worker.

## Build

The .NET SDK is not on `PATH` in this workspace:

```
export PATH="$HOME/.capy/work/dotnet:$PATH"
dotnet build OrderProcessing.Function.sln
```

## Run

The function needs the Azure Functions Core Tools (v4) and a reachable Service Bus namespace; the
`host.json` `extensions.serviceBus` block governs concurrency and lock renewal.

```
export PATH="$HOME/.capy/work/dotnet:$PATH"
cd src/OrderProcessing.Function
func start
```

## Configuration keys read

| Key | Read by |
|---|---|
| `Azure:Cosmos:AccountEndpoint`, `Azure:Cosmos:DatabaseName`, `Azure:Cosmos:OrdersContainer` | `Infrastructure/CosmosOptions.cs`, consumed by the Cosmos container factory |
| `Azure:KeyVault:Enabled`, `Azure:KeyVault:VaultUri` | `Infrastructure/KeyVaultOptions.cs`, consumed by `Program.cs` when it adds the Key Vault configuration source |
| `Azure:Identity:ManagedIdentityClientId` | `Infrastructure/IdentityOptions.cs`, consumed when the token credential is created |
| `Contracts:SchemaRoot` | `Contracts/ContractSchemaValidator.cs` |
| `ServiceBusConnection` | the `ServiceBusTrigger` binding on `OrderProcessorFunction.Run` |
