# enterprise-contracts

The shared contract hub of the VG enterprise landscape. Every other repository in the landscape
depends on this one, and it is the single source of truth for two things: the shape of the data that
crosses a repository boundary, and the identity of the Azure resources that data crosses.

## What it publishes

| Artifact | Path | Consumed by |
|---|---|---|
| C# DTO, event and topology library | `dotnet/Enterprise.Contracts/` | every runtime .NET repository, through a `ProjectReference` |
| npm package `@vg/enterprise-contracts` | `typescript/` | every portal, through a `"file:../enterprise-contracts/typescript"` dependency |
| JSON Schemas, one per contract | `contracts/` | runtime schema validation in orders-service, notification-service, order-processing and reporting-platform |
| AsyncAPI 2.6 document over the messaging topology | `asyncapi/vg-order-events.asyncapi.yaml` | human readers and any AsyncAPI-aware tooling |

`VgEnterpriseTopology` holds every logical resource name as a `const string`. The runtime
repositories default their options from those constants **and** spell the same names out in their own
`appsettings.json`; the TypeScript package exposes the same names to the portals. The repetition
across independent repositories is deliberate — it is the evidence a cross-repository resolver needs
to federate one logical Azure resource that several repositories reference.

## Layout

```
dotnet/Enterprise.Contracts/     C# DTOs, events, VgEnterpriseTopology
typescript/                      npm package @vg/enterprise-contracts
contracts/orders/                order-dto, create-order-request, order-created, order-updated, order-cancelled
contracts/customers/             customer-dto, create-customer-request, notification-preference, customer-order-summary
contracts/notifications/         notification-requested, notification-dispatch
contracts/reporting/             report-requested, report-dto
asyncapi/                        vg-order-events.asyncapi.yaml
tests/Enterprise.Contracts.Tests/
```

## The tests are the contract guarantee

`dotnet test` proves two things that would otherwise rot silently:

1. **`ContractSchemaTests`** serializes a real instance of every C# contract record with the same
   serializer the services use and validates it against the published JSON Schema. A property rename,
   a type change or a missing `required` entry fails the build. It also asserts that every
   `ContractIds` constant resolves to a schema file that exists.
2. **`TopologyConsistencyTests`** reads the TypeScript package, the AsyncAPI document and the sibling
   `../infrastructure` repository as text and asserts that every Service Bus, Cosmos and Storage name
   appears in each. A rename cannot land in one representation without failing here.

The second group is what makes this repository a hub rather than a library: it is an executable
assertion that four independent artifacts still agree about the same Azure resources.

## Build and test

```bash
dotnet build
dotnet test tests/Enterprise.Contracts.Tests/Enterprise.Contracts.Tests.csproj
```

No Azure, no credentials and no sibling repository other than `../infrastructure` is needed, and
`../infrastructure` is only read by the topology consistency tests.

## Related repositories

`orders-service`, `customer-service`, `notification-service`, `order-processing`, `reporting-platform`,
`platform-gateway` and all three portals depend on this repository. See the landscape
[`../README.md`](../README.md) for the full topology.
