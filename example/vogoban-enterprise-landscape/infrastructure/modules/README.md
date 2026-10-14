# modules

Index of the two module trees in this repository. They are not shared with each other: Bicep
modules are consumed by `bicep/main.bicep`, Terraform modules by `terraform/main.tf`.

| Tree | Modules |
|---|---|
| `bicep/modules/` | `servicebus.bicep` (namespace, topic, two subscriptions, two queues), `cosmos.bicep` (account, database, three containers), `storage.bicep` (account, blob service, two containers), `keyvault.bicep` (vault, three secrets), `identity.bicep` (user-assigned identity, five role assignments), `observability.bicep` (Log Analytics, Application Insights), `functionapp.bicep` (App Service plan, Linux function app), `containerapps.bicep` (managed environment, four container apps) |
| `terraform/modules/` | `servicebus`, `cosmos`, `storage`, `keyvault`, `identity`, `functionapp` — resource-level counterparts of the Bicep modules above |

Each Terraform module is a directory holding `main.tf`, `variables.tf` and `outputs.tf`.
