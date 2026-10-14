# customer-service

ASP.NET Core service that owns the customer records of the VG enterprise landscape. It is the
second backend in the request chain (`platform-gateway` → `customer-service` → `orders-service`) and
the service `notification-service` calls before it dispatches.

| | |
|---|---|
| Repository | `customer-service` |
| Project | `src/Customers.Api` |
| Assembly | `Customers.Api` |
| Namespace root | `Vg.Enterprise.Customers` |
| Deployment unit | `vg-customers-api` |
| Local port | 5182 |

## What it does

- **Owns** `vg-customers`, the `vg-enterprise` database container with partition key `/id`. Customer
  records are written to and read from Cosmos DB through `Repositories/CosmosCustomerRepository.cs`.
- **Publishes** `GET /api/customers`, `GET /api/customers/{id}`, `POST /api/customers`, and the
  minimal `GET /api/customers/{id}/summary`. The contract it answers with is the shared
  `CustomerDto` / `CreateCustomerRequest` from `enterprise-contracts`.
- **Serves** `GET /api/customers/{id}/preferences` with the shared `NotificationPreferenceDto`,
  which is the endpoint `notification-service` reads.
- **Consumes** `GET /api/orders` on `orders-service` to answer `GET /api/customers/{id}/orders`. It
  holds no order data; the reply is the shared `CustomerOrderSummaryDto`.
- **Publishes and consumes no events.** There is no Service Bus client and no schema validator in
  this repository.

## Cross-repository references

| Reference | Carried by |
|---|---|
| `enterprise-contracts` contract library (DTOs and `VgEnterpriseTopology`) | `src/Customers.Api/Customers.Api.csproj` — `ProjectReference` to `../../../enterprise-contracts/dotnet/Enterprise.Contracts/Enterprise.Contracts.csproj` |
| `CustomerDto`, `CreateCustomerRequest`, `CustomerOrderSummaryDto` | `Services/CustomerService.cs`, `Repositories/CosmosCustomerRepository.cs`, `Controllers/CustomersController.cs` |
| `OrderDto` returned by `orders-service` | `Clients/OrderSummaryClient.cs` |
| `orders-service` over HTTP at `Services:Orders:BaseUrl` | `Clients/OrderSummaryClient.cs` (typed `HttpClient`), registered in `Infrastructure/ServiceCollectionExtensions.cs`, configured in `appsettings.json` |
| Published HTTP contract for `platform-gateway` and any consumer | `openapi/customers.openapi.yaml` |

## Logical resources referenced

`vg-enterprise-cosmos` (Cosmos account), `vg-enterprise` (database), `vg-customers` (container,
partition key `/id`), `vg-cosmos-connection` (Key Vault secret), `vg-enterprise-kv` (Key Vault vault),
`vg-enterprise-identity` (user-assigned managed identity), `vg-customers-api` (deployment unit).

## Configuration

`appsettings.json` carries the `Azure` sections this service binds (`Cosmos`, `KeyVault`,
`Identity`), the `Contracts` block, the `ConnectionStrings:Cosmos` Key Vault secret reference, and
`Services:Orders:BaseUrl`. Every bound options class lives in `Infrastructure/` and defaults from
`VgEnterpriseTopology`, so the same logical resource name appears both in code and in configuration.
The Key Vault provider only loads when `Azure:KeyVault:Enabled` is `true`, and it is best effort: a
vault that cannot be reached logs and does not stop the host.

## Build and run

```bash
export PATH="$HOME/.capy/work/dotnet:$PATH"
dotnet build                                   # 0 warnings, 0 errors
dotnet run --project src/Customers.Api         # http://localhost:5182
```

Swagger UI is at `/swagger`, the document at `/swagger/v1/swagger.json`, and the checked-in
`openapi/customers.openapi.yaml` is generated from that running document. Azure is never contacted
during a build: the Cosmos client, the Key Vault configuration provider and the credential are all
created lazily, so the host boots without credentials and fails only on a request that needs them.
Running `GET /api/customers/{id}/orders` requires `orders-service` on `Services:Orders:BaseUrl`.
