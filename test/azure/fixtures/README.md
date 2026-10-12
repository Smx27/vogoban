# Enterprise Azure fixtures

Used only for capabilities no suitable public repository combines in one place (see docs/azure.md, Verification):

- `contoso-orders`: React (Vite) frontend, ASP.NET Core API publishing to Service Bus and Event Grid, isolated .NET Functions
  (Service Bus, HTTP, Cosmos DB change feed, Event Grid, timer; Cosmos SDK repository), Node v4 Functions (`@azure/functions`,
  `@azure/service-bus`), Bicep (modules, Service Bus, Event Hubs, Cosmos DB, Key Vault, Event Grid, APIM, Function App,
  App Service, Static Web App, identity, role assignments, App Insights), `azure.yaml`, Aspire AppHost.
- `contoso-fulfillment`: isolated .NET Functions consuming `orders` from contoso-orders and publishing `shipments`.
- `contoso-platform-infra`: Terraform (azurerm) declaring the shared Service Bus topic `shipments`, a subscription on the
  `orders` topic of contoso-orders, and Cosmos DB through a local module.

The .NET projects need `dotnet restore` before analysis for full semantic resolution. Register all three repositories and
run `vogoban metagraph build` for the cross-repository relationships.
- `identity/*`: minimal repositories for resource identity (`test/azure/identity.test.ts`, `terraform-identity.test.ts`,
  `metagraph-azure.test.ts`): Terraform and Bicep declaring queue `orders` in two namespaces (`sb-alpha`, `sb-beta`),
  full Terraform parent chains (Cosmos account/database/container, Event Hubs namespace/hub/consumer group, storage,
  Key Vault secret), empty-named declarations, and `function.json` apps whose Service Bus namespace is known
  (`local.settings.json` `__fullyQualifiedNamespace`), on another namespace, or unknown. Analyzed from temporary copies
  so each directory is its own repository.
