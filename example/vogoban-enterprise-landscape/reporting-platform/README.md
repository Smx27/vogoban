# reporting-platform

The report job worker of the VG enterprise landscape: a .NET 8 hosted service (`Reporting.Worker`,
root namespace `Vg.Enterprise.Reporting`) that consumes report jobs from Service Bus, writes report
artifacts to Blob Storage and report records to Cosmos DB — and that also exposes the reporting HTTP
API the operations portal calls.

## Why it is a worker *and* an API

The deployment is scaled by KEDA on the depth of `vg-report-jobs`, which is the classic worker shape.
The same process also serves `GET /api/reports`, `GET /api/reports/{id}` and
`POST /api/reports/requests`, so the `operations-portal → reporting-platform` edge is a real HTTP
call rather than a declared one, and so the Kubernetes Service, the readiness probe and the liveness
probe have a listener to address instead of just a queue consumer with no port.

`platform-gateway` reaches the API at `Services:Reports:BaseUrl = http://localhost:5184`; the
deployment serves it on port `8080` (`ASPNETCORE_HTTP_PORTS=8080`) inside the `vg-enterprise`
namespace.

## Layout

| Path | Purpose |
|---|---|
| `src/Reporting.Worker/Program.cs` | Composition: options, Azure clients, health checks, hosted services, routing |
| `src/Reporting.Worker/Controllers/ReportsController.cs` | `GET /api/reports` and `POST /api/reports/requests` |
| `src/Reporting.Worker/Endpoints/ReportEndpoints.cs` | minimal `GET /api/reports/{id:guid}` |
| `src/Reporting.Worker/Consumers/ServiceBusReportJobConsumer.cs` | `BackgroundService` over a `ServiceBusProcessor` on `vg-report-jobs` |
| `src/Reporting.Worker/Startup/ReportStorageInitializer.cs` | best-effort, five-second-bounded container provisioning |
| `src/Reporting.Worker/Infrastructure/` | options classes, `ICosmosContainerFactory` / `IMessagePublisher` / `IStorageClient` and their Azure implementations, DI registration |
| `src/Reporting.Worker/Contracts/ContractSchemaValidator.cs` | runtime validation of published and consumed events against the enterprise-contracts JSON Schemas |
| `k8s/` | Deployment, Service, ConfigMap and the KEDA ScaledObject |
| `openapi/reporting-platform.openapi.yaml` | OpenAPI document generated from the running service |

## What it consumes and publishes

* **Consumes** `vg-report-jobs` (queue, `vg-enterprise-servicebus`) — `ReportRequestedEvent`
  (`reporting/report-requested`), validated against the shared schema before the job is processed.
* **Publishes** `ReportRequestedEvent` to that same queue when a report request arrives over HTTP.
* **Writes** `ReportDto` into the `vg-reports` container (`vg-enterprise` database, partition key
  `/reportType`) and a text artifact into the `vg-report-artifacts` container of `vgentstorage`.

## Cross-repository references

| Reference | File that carries it |
|---|---|
| `ProjectReference` to `enterprise-contracts` (`dotnet/Enterprise.Contracts`) | `src/Reporting.Worker/Reporting.Worker.csproj` |
| `ContractSchemaOptions.SchemaRoot = ../enterprise-contracts/contracts` — the schemas are read across the repository boundary at runtime and the resolved path is logged at startup | `src/Reporting.Worker/appsettings.json`, `k8s/configmap.yaml`, `src/Reporting.Worker/Contracts/ContractSchemaValidator.cs` |
| Service Bus namespace `vg-enterprise-servicebus` and queue `vg-report-jobs` | `appsettings.json`, `k8s/configmap.yaml`, `k8s/keda/reporting-scaledobject.yaml`, `ServiceBusOptions.cs` |
| Cosmos account `vg-enterprise-cosmos`, database `vg-enterprise`, container `vg-reports` | `appsettings.json`, `k8s/configmap.yaml`, `CosmosOptions.cs` |
| Storage account `vgentstorage`, container `vg-report-artifacts` | `appsettings.json`, `k8s/configmap.yaml`, `StorageOptions.cs` |
| Key Vault `vg-enterprise-kv` and secrets `vg-servicebus-connection`, `vg-cosmos-connection`, `vg-storage-connection` | `appsettings.json` (`ConnectionStrings`, reported at startup by `KeyVaultSecretReference`), `k8s/configmap.yaml` |
| Identity `vg-enterprise-identity` (placeholder client id) | `appsettings.json`, `k8s/deployment.yaml` (`AZURE_CLIENT_ID`), `IdentityOptions.cs` |
| Secret `vg-enterprise-connections` (platform-wide, defined outside this repository) | `k8s/deployment.yaml` (`envFrom`) |
| `TriggerAuthentication` `vg-enterprise-servicebus-auth` (defined by the `infrastructure` repository) | `k8s/keda/reporting-scaledobject.yaml` (`authenticationRef`) |
| Deployment unit `vg-reporting-worker`, namespace `vg-enterprise`, image `vogobanplaceholder.azurecr.io/vg-reporting-worker:placeholder` | `k8s/deployment.yaml`, `k8s/service.yaml`, `catalog-info.yaml` |

Dependencies: `enterprise-contracts` (C# contract library and JSON Schemas). The operations portal
consumes this repository's HTTP API; `platform-gateway` routes to it on port 5184 locally.

## Build and run

The .NET SDK is not on `PATH` in this landscape:

```bash
export PATH="$HOME/.capy/work/dotnet:$PATH"
cd reporting-platform
dotnet build Reporting.Worker.sln          # no Azure, Docker or Kubernetes required
dotnet run --project src/Reporting.Worker  # http://localhost:5184
```

`dotnet run` starts the service on port 5184 with the `Reporting.Worker` launch profile. The project
sets `RunWorkingDirectory` to the repository root so the frozen relative
`Contracts:SchemaRoot` value `../enterprise-contracts/contracts` reaches the sibling
`enterprise-contracts` repository, and the host pins its content root to the application directory
so `appsettings.json` is read regardless of the working directory. In Kubernetes the same key is
supplied by the ConfigMap.

Health and the API surface:

```bash
curl -i http://localhost:5184/health                      # 200 "Healthy"
curl -s http://localhost:5184/api/reports                 # report records from vg-reports
curl -s http://localhost:5184/swagger/v1/swagger.json     # OpenAPI document
curl -s -X POST http://localhost:5184/api/reports/requests \
  -H 'Content-Type: application/json' \
  -d '{"reportType":"usage-daily","requestedBy":"operations-portal"}'
```

Without Azure reachable the process still starts: Azure clients are built lazily from a
`TokenCredential`, `ReportStorageInitializer` provisions the Cosmos and blob containers best effort
inside a five-second bound and logs a warning when it cannot, and `/health` answers 200. Report
reads and writes, and queue consumption, fail while Azure is unreachable, which is expected. A
startup with neither Cosmos nor Service Bus configured is verified in this repository's build.

## Kubernetes

```bash
kubeconform -strict -summary -ignore-missing-schemas -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  k8s/
```

`k8s/deployment.yaml` deploys `vg-reporting-worker` with the ConfigMap and the platform Secret
`vg-enterprise-connections` as `envFrom`, exposes port `8080` named `http`, and probes `/health`
with both the readiness and the liveness probe. `k8s/service.yaml` publishes that named port as a
ClusterIP Service. `k8s/keda/reporting-scaledobject.yaml` scales the Deployment between 0 and 10
replicas on the `vg-report-jobs` queue using the `vg-enterprise-servicebus-auth` trigger
authentication.
