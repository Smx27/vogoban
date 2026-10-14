# platform-gateway

The HTTP orchestration hub of the VG enterprise landscape. It is the single HTTP entry point the
portals talk to; every request it receives is forwarded to a downstream service over HTTP, and it
owns no data store, no queue and no Azure client of any kind.

- Assembly `PlatformGateway.Api`, root namespace `Vg.Enterprise.PlatformGateway`
- Project `src/PlatformGateway.Api`, local port 5180
- Deployment unit `vg-platform-gateway`

## Why it exists

The admin, customer and operations portals must not know the topology of the backend estate. They
call the gateway, the gateway calls `orders-service`, `customer-service` and `reporting-platform`
through typed `HttpClient`s whose base addresses come from configuration, and nothing else leaves
this process. Because the gateway has no Azure dependency by design, it carries no `Azure`
configuration section, references no Azure SDK package and never touches Service Bus or Cosmos DB
itself — the services that own those resources do that.

## Route surface

| Method | Path | Forwarded to |
|---|---|---|
| GET | `/api/Orders` | `orders-service` `GET /api/orders` |
| GET | `/api/Orders/{id}` | `orders-service` `GET /api/orders/{id}` |
| POST | `/api/Orders/{id}/cancel` | `orders-service` `POST /api/orders/{id}/cancel` |
| POST | `/api/orders` (minimal API) | `orders-service` `POST /api/orders` |
| GET | `/api/Customers` | `customer-service` `GET /api/customers` |
| GET | `/api/Customers/{id}` | `customer-service` `GET /api/customers/{id}` |
| GET | `/api/Customers/{id}/orders` | `customer-service` `GET /api/customers/{id}/orders` |
| GET | `/api/Reports` | `reporting-platform` `GET /api/reports` |
| POST | `/api/Reports/requests` | `reporting-platform` `POST /api/reports/requests` |
| GET | `/api/gateway/info` (minimal API) | none — reports the configured downstream services |

The controller routes are declared with `[Route("api/[controller]")]`, so the published document
spells them `/api/Orders`, `/api/Customers` and `/api/Reports`; ASP.NET Core route matching is
case-insensitive, so the lowercase forms used by the clients resolve to the same actions.

## Configuration

`appsettings.json` and `appsettings.Development.json` carry one section, `Services`, which is the
whole of this repository's outbound topology:

```json
{
  "Services": {
    "Orders": { "BaseUrl": "http://localhost:5181" },
    "Customers": { "BaseUrl": "http://localhost:5182" },
    "Reports": { "BaseUrl": "http://localhost:5184" }
  }
}
```

`Infrastructure/DownstreamServicesOptions.cs` binds that section and every one of its keys is read:
the three typed `HttpClient` registrations take their base address from it, and `GET
/api/gateway/info` returns the same names and URLs.

## Cross-repository references

| Relationship | Carrier |
|---|---|
| Depends on the shared contract library (`enterprise-contracts`) | `src/PlatformGateway.Api/PlatformGateway.Api.csproj` — `ProjectReference` to `../../../enterprise-contracts/dotnet/Enterprise.Contracts/Enterprise.Contracts.csproj` |
| Order DTOs and requests (`orders-service`) | `Clients/IOrdersClient.cs`, `Clients/OrdersClient.cs`, `Controllers/OrdersController.cs`, `Endpoints/GatewayEndpoints.cs` |
| Customer DTOs and the order summary (`customer-service`) | `Clients/ICustomersClient.cs`, `Clients/CustomersClient.cs`, `Controllers/CustomersController.cs` |
| Report DTO and the report request (`reporting-platform`) | `Clients/IReportsClient.cs`, `Clients/ReportsClient.cs`, `Controllers/ReportsController.cs` |
| Downstream base addresses (`orders-service`, `customer-service`, `reporting-platform`) | `appsettings.json`, `appsettings.Development.json`, `Infrastructure/DownstreamServicesOptions.cs` |
| Deployment unit identity `vg-platform-gateway` | `catalog-info.yaml`, and `VgEnterpriseTopology.DeploymentUnits.PlatformGateway` in `Endpoints/GatewayEndpoints.cs` |
| Published contract for the portals | `openapi/platform-gateway.openapi.yaml` |
| Verification that the downstream routes still exist in `orders-service` and `customer-service` | `scripts/verify-downstream-contracts.mjs` |

## Build and run

The .NET SDK is not on `PATH`:

```bash
export PATH="$HOME/.capy/work/dotnet:$PATH"; export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
cd platform-gateway
dotnet build PlatformGateway.sln
cd src/PlatformGateway.Api && dotnet run --urls http://localhost:5180
```

Swagger UI is at `/swagger`, the generated document at `/swagger/v1/swagger.json`. The checked-in
`openapi/platform-gateway.openapi.yaml` was generated from that running document, so it cannot
describe a route the service does not serve.

## Verifying the downstream contracts

```bash
npm run verify:contracts
```

The dependency-free Node script reads `../orders-service/openapi/orders.openapi.yaml` and
`../customer-service/openapi/customers.openapi.yaml`, extracts the path keys from each document and
prints `ok` or `MISSING` for every path this gateway's clients call, exiting non-zero on a miss. The
reporting edge is checked too when `reporting-platform` publishes a document at
`../reporting-platform/openapi/reporting-platform.openapi.yaml` (or `reports.openapi.yaml`); until
then that group is skipped with a note instead of failing.
