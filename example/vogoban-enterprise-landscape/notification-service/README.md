# notification-service

The `vg-notification-service` deployment unit: a hosted .NET worker with an HTTP surface that turns
notification requests and order events into stored notification dispatch payloads.

## Why it exists

`orders-service` announces order traffic on the `vg-order-events` topic and pushes notification work
onto the `vg-notification-requests` queue. This repository is the notification domain's consumer of
both. It is where the landscape's *notification* domain meets the *customer* domain: before a
dispatch is stored, the customer's notification preference is fetched from `customer-service` over
HTTP, so the notification service has no opinion about preferences and no local copy of them.

It listens on port `5183` and answers `GET /health`, because the Kubernetes Deployment that runs it
is fronted by a Service whose readiness and liveness probes need a listener that really responds.

## What it consumes and produces

| Direction | Entity | Contract |
|---|---|---|
| consumes | queue `vg-notification-requests` on `vg-enterprise-servicebus` | `notifications/notification-requested` |
| consumes | topic `vg-order-events`, subscription `vg-notifications` | `orders/order-created` |
| publishes | blob container `vg-notification-payloads` on `vgentstorage` | stored `NotificationDispatchDto` JSON |
| calls | `customer-service` → `GET /api/customers/{id}/preferences` | `NotificationPreferenceDto` |
| serves | `GET /api/notifications/dispatches/{id}` | stored `NotificationDispatchDto`, or 404 |

Both Service Bus entities are consumed by a real `ServiceBusProcessor` over
`ServiceBusClient.CreateProcessor` with `AutoCompleteMessages = false`; a message is completed only
after the dispatch payload is stored. Every payload is validated against the JSON Schema published by
`enterprise-contracts` before it is acted on.

## Cross-repository references

| Reference | Carrier |
|---|---|
| `enterprise-contracts` — C# contracts, event records and topology constants | `src/Notification.Service/Notification.Service.csproj` (`ProjectReference`) |
| `enterprise-contracts` — JSON Schemas under `contracts/` | `Infrastructure/Contracts/ContractSchemaValidator.cs`, `appsettings.json` → `Contracts:SchemaRoot` |
| `customer-service` — notification preferences over HTTP | `Clients/CustomerPreferenceClient.cs`, `appsettings.json` → `Services:Customers:BaseUrl` |
| `infrastructure` — the Kubernetes Deployment whose probes need this listener | `src/Notification.Service/Program.cs`, `Properties/launchSettings.json` (port 5183) |

## Logical Azure resources referenced

Namespace `vg-enterprise-servicebus` (`vg-enterprise-servicebus.servicebus.windows.net`), topic
`vg-order-events`, subscription `vg-notifications`, queue `vg-notification-requests`, storage account
`vgentstorage` (blob container `vg-notification-payloads`), Key Vault `vg-enterprise-kv`
(`vg-servicebus-connection`, `vg-storage-connection`) and the user-assigned managed identity
`vg-enterprise-identity`. Each name is spelled out in `appsettings.json` and defaults from
`VgEnterpriseTopology` in the code, so the same logical resource appears twice inside this
repository.

## Build and run

The .NET SDK is not on `PATH`:

```bash
export PATH="$HOME/.capy/work/dotnet:$PATH"
dotnet build                              # from this repository root
```

Run it from the repository root, because `Contracts:SchemaRoot` is relative to the working
directory — the project pins `RunWorkingDirectory` to the repository root so `dotnet run` resolves
`../enterprise-contracts/contracts` to the sibling contracts repository:

```bash
dotnet run --project src/Notification.Service
curl -s http://localhost:5183/health                        # 200 Healthy
curl -s http://localhost:5183/swagger/v1/swagger.json       # OpenAPI document
```

Nothing here needs Azure, Docker or Kubernetes to build or boot: the Azure clients are created
lazily, the Key Vault-backed configuration provider is off unless `Azure:KeyVault:Enabled` is set,
and a Service Bus processor that cannot reach its namespace logs the failure and leaves the host
(and `/health`) running.

`openapi/notification-service.openapi.yaml` is the published contract of the HTTP surface above,
generated from the running service so it cannot describe a route that does not exist.
