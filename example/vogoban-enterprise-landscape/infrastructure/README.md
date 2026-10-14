# infrastructure

Platform repository for the `vg-enterprise` landscape. It holds no application code: it declares
every runtime Azure resource once, in Bicep and in Terraform, and owns the platform-wide Kubernetes
manifests. Its purpose in this landscape is that infrastructure and runtime agree on the same
logical resource names, so a resource referenced from a service's configuration, from a Kubernetes
ConfigMap and from a Bicep module resolves to one identity.

## Layout

| Path | Contents |
|---|---|
| `bicep/main.bicep` | Resource-group scoped deployment composing the eight modules below |
| `bicep/modules/` | `servicebus.bicep`, `cosmos.bicep`, `storage.bicep`, `keyvault.bicep`, `identity.bicep`, `observability.bicep`, `functionapp.bicep`, `containerapps.bicep` |
| `bicep/parameters/dev.bicepparam` | Parameter file for the resources above |
| `terraform/` | `versions.tf`, `providers.tf`, `variables.tf`, `locals.tf`, `main.tf`, `outputs.tf` |
| `terraform/modules/` | `servicebus`, `cosmos`, `storage`, `functionapp`, `keyvault`, `identity` |
| `k8s/` | Namespace, ConfigMap, Secret, ServiceAccount, `keda/`, `deployments/`, `services/` |
| `environments/` | `dev`, `staging`, `prod`, each with a Bicep parameter file and a Terraform variable file |
| `modules/` | Index of the two module trees |

## Logical resource names

These names are identical in Bicep, in Terraform, and in the Kubernetes manifests. Bicep builds
derived names from `resourceId()`, module outputs and parameters, Terraform from resource attribute
references, so the literals below appear once per toolchain and everything else is derived.

| Logical resource | Name | Where |
|---|---|---|
| Service Bus namespace | `vg-enterprise-servicebus` | `bicep/main.bicep`, `terraform/variables.tf` |
| Topic | `vg-order-events` | `bicep/main.bicep`, `terraform/variables.tf` |
| Subscription | `vg-order-processor` | `bicep/main.bicep`, `terraform/variables.tf` |
| Subscription | `vg-notifications` | `bicep/main.bicep`, `terraform/variables.tf` |
| Queue | `vg-notification-requests` | Bicep, Terraform, `k8s/configmap.yaml`, `k8s/keda/notifications-scaledobject.yaml` |
| Queue | `vg-report-jobs` | Bicep, Terraform, `k8s/configmap.yaml` |
| Cosmos DB account | `vg-enterprise-cosmos` | Bicep, Terraform, `k8s/configmap.yaml` |
| Cosmos DB database | `vg-enterprise` | Bicep, Terraform, `k8s/configmap.yaml` |
| Cosmos DB containers | `vg-orders`, `vg-customers`, `vg-reports` | Bicep, Terraform, `k8s/configmap.yaml` |
| Storage account | `vgentstorage` | Bicep, Terraform, `k8s/configmap.yaml` |
| Blob containers | `vg-notification-payloads`, `vg-report-artifacts` | Bicep, Terraform, `k8s/configmap.yaml` |
| Key Vault | `vg-enterprise-kv` | Bicep, Terraform, `k8s/configmap.yaml`, `k8s/secret.yaml` |
| Secrets | `vg-servicebus-connection`, `vg-cosmos-connection`, `vg-storage-connection` | Bicep, Terraform, `k8s/secret.yaml` |
| Managed identity | `vg-enterprise-identity` | Bicep, Terraform, `k8s/serviceaccount.yaml` |
| Container Apps environment | `vg-enterprise-aca-env` | `bicep/modules/containerapps.bicep`, `terraform/variables.tf` |
| App Service plan | `vg-enterprise-plan` | `bicep/modules/functionapp.bicep`, `terraform/variables.tf` |
| Function app | `vg-order-processor-function` | `bicep/modules/functionapp.bicep`, `terraform/variables.tf` |
| Log Analytics | `vg-enterprise-logs` | `bicep/modules/observability.bicep`, `terraform/main.tf` |
| Application Insights | `vg-enterprise-appinsights` | `bicep/modules/observability.bicep`, `terraform/main.tf` |
| Resource group | `rg-vg-enterprise` | `terraform/variables.tf` |
| Kubernetes namespace | `vg-enterprise` | `k8s/namespace.yaml` |
| Deployment units | `vg-platform-gateway`, `vg-orders-api`, `vg-customers-api`, `vg-notification-service` | Bicep container apps, Terraform container apps, `k8s/deployments/`, `k8s/services/` |

## Cross-repository references

This repository does not link the `enterprise-contracts` assembly or npm package; the link it
carries is by name, and it is intentional.

- **Deployment units it names, owned elsewhere.** `vg-platform-gateway` (`platform-gateway`),
  `vg-orders-api` (`orders-service`), `vg-customers-api` (`customer-service`),
  `vg-notification-service` (`notification-service`) and `vg-order-processor-function`
  (`order-processing`) are declared here as Container Apps, an App Service plan plus function app,
  and Kubernetes Deployments and Services. `vg-reporting-worker` is deliberately absent from
  `k8s/` — its manifests belong to the `reporting-platform` repository.
- **Azure settings it publishes, consumed by the runtime repositories.**
  `bicep/modules/functionapp.bicep`, `bicep/modules/containerapps.bicep`,
  `terraform/modules/functionapp/main.tf`, `terraform/main.tf` and `k8s/configmap.yaml` all use the
  double-underscore form of the frozen `Azure` configuration block
  (`Azure__ServiceBus__FullyQualifiedNamespace`, `Azure__Cosmos__AccountEndpoint`,
  `Azure__Storage__BlobServiceUri`, `Azure__KeyVault__VaultUri`,
  `Azure__Identity__ManagedIdentityClientId`, plus the container and queue names). Those keys are
  bound by the options classes of `orders-service`, `customer-service`, `notification-service`,
  `order-processing` and `platform-gateway`, and by the `Contracts:SchemaRoot` leaf they read next
  to them.
- **Key Vault references, consumed by the runtime repositories.** `bicep/modules/functionapp.bicep`
  and `terraform/modules/functionapp/main.tf` emit `ConnectionStrings__ServiceBus`,
  `ConnectionStrings__Cosmos` and `ConnectionStrings__Storage` in the
  `@Microsoft.KeyVault(SecretUri=https://vg-enterprise-kv.vault.azure.net/secrets/<name>/)` form,
  built from the vault URI output of the Key Vault module; `k8s/secret.yaml` carries the same three
  references in the Secret `vg-enterprise-connections`.
- **Messaging topology, consumed by the runtime repositories.**
  `terraform/modules/servicebus/main.tf` and `bicep/modules/servicebus.bicep` are the infrastructure
  counterpart of `enterprise-contracts/asyncapi/vg-order-events.asyncapi.yaml`: topic
  `vg-order-events`, subscriptions `vg-order-processor` and `vg-notifications`, queues
  `vg-notification-requests` and `vg-report-jobs`.
- **KEDA scaling.** `k8s/keda/notifications-scaledobject.yaml` scales the `vg-notification-service`
  Deployment on the `vg-notification-requests` queue, using the `TriggerAuthentication`
  `vg-enterprise-servicebus-auth` (`k8s/keda/trigger-authentication.yaml`) whose
  `podIdentity.identityId` is the client id of `vg-enterprise-identity`. The same
  `azure-servicebus` rule is expressed for Container Apps in `bicep/modules/containerapps.bicep`
  and `terraform/main.tf`.
- **Identity chain.** `k8s/serviceaccount.yaml` defines the `vg-enterprise-identity` ServiceAccount
  with the `azure.workload.identity/client-id` annotation; every Deployment runs as it and sets
  `AZURE_CLIENT_ID` to the same placeholder, which is what the `azure-workload` KEDA provider and
  the Azure SDK `ManagedIdentityCredential` resolve against.

## Placeholders

No real subscription, tenant or resource-group id appears anywhere. Subscription and tenant ids are
`00000000-0000-0000-0000-000000000000`, the resource group is `rg-vg-enterprise`, the Key Vault
secrets hold clearly fake placeholder connection strings, and the container registry
`vgentacr.azurecr.io` is a placeholder. Terraform deliberately applies **no random suffix** to any
name: the runtime repositories reference these resources by name, so the names must be stable across
environments and across applies.

## Build and validate

Nothing here needs Azure, Docker or a Kubernetes cluster to check.

```bash
# Bicep: every module, main.bicep and the parameter files
for f in bicep/main.bicep bicep/modules/*.bicep; do bicep build "$f" --stdout > /dev/null; done
bicep build-params bicep/parameters/dev.bicepparam --stdout > /dev/null
for f in environments/*/*.bicepparam; do bicep build-params "$f" --stdout > /dev/null; done

# Terraform
cd terraform && terraform init -backend=false -input=false && terraform validate \
  && terraform fmt -check -recursive

# Kubernetes, including the KEDA CRDs
kubeconform -strict -summary -ignore-missing-schemas \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  k8s/
```

`Infrastructure.sln` is intentionally empty: this repository has no .NET project, and
`dotnet build Infrastructure.sln` from the repository root succeeds as part of the shared
repository shell.

## Deploying

```bash
az deployment group create --resource-group rg-vg-enterprise \
  --template-file bicep/main.bicep --parameters bicep/parameters/dev.bicepparam

cd terraform && terraform apply -var-file ../environments/dev/dev.tfvars

kubectl apply -f k8s/
```

`bicep/main.bicep` targets an existing resource group; `terraform/main.tf` creates
`rg-vg-enterprise` itself. `bicep/parameters/dev.bicepparam` and `environments/<env>/<env>.tfvars`
change only sizing, the environment label and the image tag — never a resource name.
