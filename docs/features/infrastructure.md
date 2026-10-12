# Infrastructure: containers, pipelines, Helm and Kubernetes

Vogoban reads infrastructure definitions from the repository (Dockerfiles, docker-compose files, Azure Pipelines YAML, Helm charts, Kubernetes manifests and `appsettings*.json`) and links them to the .NET applications they build and deploy. The result is a declared topology: application → container image → workload → Kubernetes service → ingress, with the pipeline that builds it.

**This is static analysis of files.** Vogoban does not build images, run pipelines, render charts with Helm, contact a cluster or a registry, deploy anything, or run `terraform plan`/`apply` or `az` commands. Everything on this page has evidence `DECLARED`: it describes what the files say, not what is running.

## Why it matters

Code-level impact stops at the application boundary unless the graph knows how the application ships. With infrastructure in the graph you can answer "which deployment runs this project?", "which pipeline builds this image?", "which ingress exposes this API?" and "which secrets does this workload reference?", and `impact`, `service-impact`, `security` and governance rules can use those links.

## What Vogoban detects

| Source | Files | What is extracted |
| --- | --- | --- |
| Dockerfiles | `Dockerfile`, `Dockerfile.*`, `*.dockerfile` | `Dockerfile`, `DockerStage` per stage (`FROM`, multi-stage `COPY --from`), base images (`BASED_ON`), `ARG` defaults, `EXPOSE`, `ENTRYPOINT`/`CMD`, `ENV`, `USER`; `dotnet publish <project>` mapped through `COPY` to the project (`PACKAGES`); the entrypoint assembly (`dotnet X.dll`) |
| docker-compose | `docker-compose*.yml`, `compose*.yml` | services with `build` (context, dockerfile) and `image`; links the built image to the Dockerfile; `${VAR:-default}` defaults applied, other variables kept as parameters |
| Azure Pipelines | `azure-pipelines*.yml`, `.azure-pipelines*.yml`, YAML under `pipelines/`, other YAML files that start a line with `stages:`, `jobs:`, `steps:` or `extends:`, plus globs from `infrastructure.pipelines` in `vogoban.json` | `Pipeline`, `PipelineStage`, `PipelineJob` (including deployment jobs and their `environment`), `PipelineTask`; triggers, variables, local templates (`template:`, `extends:` with parameter defaults), `dependsOn`; recognized tasks: `DotNetCoreCLI`, `NuGetCommand`, `Docker`, `DockerCompose`, `PublishBuildArtifacts`, `PublishPipelineArtifact`, `DownloadBuildArtifacts`, `DownloadPipelineArtifact`, `CopyFiles`, `ArchiveFiles`, `HelmDeploy`, `HelmInstaller`, `KubernetesManifest`, `Kubernetes`, `AzureWebApp`, `AzureRmWebAppDeployment`, `AzureFunctionApp`, `VSTest`, `VSBuild`, `UseDotNet`; commands inside `script`, `Bash`, `PowerShell`, `CmdLine` and `AzureCLI` steps (for example `docker build`, `dotnet publish`, `helm upgrade`) |
| Helm | `Chart.yaml`, `values*.yaml`, `templates/` | `HelmChart`; one `HelmRelease` profile per values file (`values.yaml` alone, `values.yaml` + each overlay) and per pipeline `HelmDeploy` task that targets the chart (with its release name, namespace, values files and environment); templates rendered by a built-in evaluator into Kubernetes resources |
| Kubernetes | YAML manifests anywhere in the repository, recognized by top-level `apiVersion:` and `kind:` lines | `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`, `Pod` → `Deployment` entities with containers and images (`RUNS_IMAGE`); `Service` (`KubernetesService`), `Ingress` (`KubernetesIngress`), `ConfigMap` (keys as `Configuration`), `Secret` (`SecretReference`, never values), `ServiceAccount`, `Namespace`, `HorizontalPodAutoscaler`; container `env`, `envFrom`, `secretKeyRef`, `configMapKeyRef` |
| appsettings | `appsettings.json`, `appsettings.<Environment>.json` under a .NET project | `Configuration` / `SecretReference` for keys that code references, connection strings, URLs and secret-like keys; `appsettings.<Environment>.json` assigns an `Environment` |

### How things are linked

- **Image → application.** A Dockerfile packages a project when `dotnet publish <project>` is mapped through `COPY` to the build context (resolved through docker-compose or pipeline build contexts), or when the entrypoint is `dotnet <Assembly>.dll`. Images built by a pipeline task are linked to their Dockerfile.
- **Workload → application.** A workload runs an application only when its image is produced from that application, or its command/entrypoint names the application's assembly (`dotnet Shop.Worker.dll`). Never by name similarity.
- **Service → workload.** A Kubernetes service routes to workloads only through its label selector, within the same namespace and deployment scope (`ROUTES_TO`, `EXPOSES_SERVICE`). An ingress routes to a service in the same scope.
- **Environments** come from pipeline deployment jobs (`environment: prod`), from `appsettings.<Environment>.json`, and from `infrastructure.environments` in `vogoban.json` (`{ "prod": ["k8s/prod/**"] }`), which assigns files by glob.

### Helm template evaluator

The evaluator renders Go templates without Helm: `{{ .Values.x }}`, `.Release.Name` / `.Release.Namespace` (from the release profile), `.Chart`, `if`/`else`, `with`, `range`, `define`/`include`/`template`, variables, and common Sprig functions (`default`, `required`, `quote`, `upper`, `lower`, `trim`, `trunc`, `replace`, `printf`, `toYaml`, `indent`/`nindent`, `eq`/`ne`/`lt`/`gt`, `and`/`or`/`not`, `empty`, `hasKey`, `get`, `dict`, `list`, `join`, `splitList`, `keys`, ...). Values it cannot know stay visible as `${helm:...}` placeholders: a release without a name renders `{{ .Release.Name }}-api` as `${helm:.Release.Name}-api`. Functions that depend on runtime or randomness (`lookup`, `tpl`, `randAlphaNum`, `uuidv4`, `now`, `genCA`, `b64enc`, `sha256sum`, `fromYaml`, `semverCompare`, ...) and `.Capabilities` and `.Files` always produce placeholders. A template the evaluator cannot parse is a `helm-template-unsupported` diagnostic.

`infrastructure.helmValues` in `vogoban.json` adds shared values files to every release profile.

## Example

The example repository builds `Shop.Api` with a Dockerfile, pushes it from Azure Pipelines and deploys it with a Helm chart; the worker is deployed with a plain manifest.

```dockerfile
# src/Shop.Api/Dockerfile
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

```yaml
# docker-compose.yml
services:
  shop-api:
    build:
      context: .
      dockerfile: src/Shop.Api/Dockerfile
    image: contosoacr.azurecr.io/shop-api:dev
```

```yaml
# azure-pipelines.yml (excerpt)
stages:
  - stage: Build
    jobs:
      - job: BuildImage
        steps:
          - task: Docker@2
            inputs:
              command: buildAndPush
              containerRegistry: $(containerRegistry)
              repository: $(imageRepository)
              dockerfile: src/Shop.Api/Dockerfile
              tags: $(Build.BuildId)
  - stage: DeployProd
    dependsOn: Build
    jobs:
      - deployment: DeployShop
        environment: prod
        strategy:
          runOnce:
            deploy:
              steps:
                - task: HelmDeploy@0
                  inputs:
                    command: upgrade
                    chartPath: deploy/helm/shop
                    releaseName: shop
                    namespace: shop
                    valueFile: deploy/helm/shop/values-prod.yaml
```

```yaml
# deploy/helm/shop/templates/deployment.yaml (excerpt)
metadata:
  name: {{ .Release.Name }}-api
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          env:
            - name: SHOP_REGION
              value: westeurope
            - name: ConnectionStrings__Inventory
              valueFrom:
                secretKeyRef:
                  name: shop-secrets
                  key: inventory-url
```

```yaml
# deploy/helm/shop/templates/ingress.yaml (excerpt)
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
…
{{- end }}
```

`values.yaml` sets `image.repository: contosoacr.azurecr.io/shop-api`, `tag: latest` and `ingress.enabled: false`; `values-prod.yaml` sets `replicaCount: 3` and `ingress.enabled: true`. `k8s/prod/worker.yaml` declares a `shop-worker` Deployment running `dotnet Shop.Worker.dll` and a ConfigMap, and `vogoban.json` maps `k8s/prod/**` to the `prod` environment.

What Vogoban extracts:

- The Dockerfile's two stages, its base images, and `PACKAGES` → `Shop.Api` (through the compose build context and the `Shop.Api.dll` entrypoint).
- The pipeline with two stages, the image built by `Docker@2`, the published `chart` artifact, and a `HelmDeploy` deployment to the `prod` environment.
- Three Helm release profiles: `shop (default)` (no ingress, because `ingress.enabled` is false), `shop (values-prod.yaml)` (no release name, so names contain `${helm:.Release.Name}`), and `shop` from the pipeline task (release name `shop`, namespace `shop`, environment `prod`).
- For each profile, the rendered Deployment, Service (selector `app=shop-api` → Deployment) and, where enabled, Ingress (`shop.contoso.com/api` → Service).
- `Deployment/shop/shop-worker` runs `Shop.Worker` (entrypoint assembly), in `prod`.
- `ConnectionStrings__Inventory` as a secret reference to `Secret/shop-secrets` (value not stored).

```bash
vogoban docker
vogoban pipeline azure-pipelines.yml
vogoban helm
vogoban deployments
vogoban topology --app Shop.Api
```

```text
src/Shop.Api/Dockerfile
  - build  FROM mcr.microsoft.com/dotnet/sdk:9.0  [dotnet publish src/Shop.Api/Shop.Api.csproj -o /app/publish]
  * final  FROM mcr.microsoft.com/dotnet/aspnet:9.0  depends on build (COPY --from)
  exposes -  entrypoint dotnet Shop.Api.dll  env -
  builds  $(serviceConnection:$(containerRegistry))/shop-api, contosoacr.azurecr.io/shop-api
  packages Shop.Api (dotnet publish src/Shop.Api/Shop.Api.csproj via COPY mapping (compose:docker-compose.yml#shop-api); entrypoint assembly Shop.Api.dll)

Pipeline azure-pipelines.yml  (azure-pipelines.yml:1)
  triggers   ci:enabled branches=main; pr:default
  variables  imageRepository, containerRegistry
  templates  -
  stage Build
    job BuildImage  pool=vmImage:ubuntu-latest
      - DotNetCoreCLI@2: DotNetCoreCLI@2  [dotnet-test]  azure-pipelines.yml:16
      - Docker@2: Docker@2  [docker-build,docker-push]  azure-pipelines.yml:20
      - PublishPipelineArtifact@1: PublishPipelineArtifact@1  [artifact-publish]  azure-pipelines.yml:28
  stage DeployProd  dependsOn=Build
    deployment DeployShop  environment=prod
      - HelmDeploy@0: HelmDeploy@0  [helm-deploy]  azure-pipelines.yml:41
      consumes: azure-pipelines.yml:chart
      deploys: deploy/helm/shop/shop#shop via azure-pipelines.yml
  artifacts  azure-pipelines.yml:chart, azure-pipelines.yml:image:$(serviceConnection:$(containerRegistry))/shop-api
  builds     $(serviceConnection:$(containerRegistry))/shop-api
  deploys    deploy/helm/shop/shop#shop via azure-pipelines.yml
  secrets/config  containerRegistry, imageRepository

deploy/helm/shop/shop 0.1.0 (appVersion 1.0.0)  deploy/helm/shop/Chart.yaml:1
  release shop (values-prod.yaml)  values=deploy/helm/shop/values.yaml,deploy/helm/shop/values-prod.yaml
    image=contosoacr.azurecr.io/shop-api:latest  resources: Service/${helm:.Release.Name}-api, Ingress/${helm:.Release.Name}-ingress, Deployment/${helm:.Release.Name}-api
  release shop  values=deploy/helm/shop/values.yaml,deploy/helm/shop/values-prod.yaml  environment=prod  deployed by azure-pipelines.yml#DeployProd/DeployShop, azure-pipelines.yml
    image=contosoacr.azurecr.io/shop-api:latest  resources: Deployment/shop-api, Service/shop-api, Ingress/shop-ingress
  release shop (default)  values=deploy/helm/shop/values.yaml
    image=contosoacr.azurecr.io/shop-api:latest  resources: Deployment/${helm:.Release.Name}-api, Service/${helm:.Release.Name}-api

workload                                                       images                                   runs application            services                                                    environment  helm release             location
-------------------------------------------------------------  ---------------------------------------  --------------------------  ----------------------------------------------------------  -----------  -----------------------  --------------------------------------------
Deployment/shop/shop-worker                                    contosoacr.azurecr.io/shop-worker:1.4.2  Shop.Worker (generic-host)  -                                                           prod         -                        k8s/prod/worker.yaml:2
shop (default)::Deployment/${helm:.Release.Name}-api           contosoacr.azurecr.io/shop-api:latest    Shop.Api (aspnetcore)       shop (default)::Service/${helm:.Release.Name}-api           -            shop (default)           deploy/helm/shop/templates/deployment.yaml:2
shop (values-prod.yaml)::Deployment/${helm:.Release.Name}-api  contosoacr.azurecr.io/shop-api:latest    Shop.Api (aspnetcore)       shop (values-prod.yaml)::Service/${helm:.Release.Name}-api  -            shop (values-prod.yaml)  deploy/helm/shop/templates/deployment.yaml:2
shop::Deployment/shop-api                                      contosoacr.azurecr.io/shop-api:latest    Shop.Api (aspnetcore)       shop::Service/shop-api                                      prod         shop                     deploy/helm/shop/templates/deployment.yaml:2

Application Shop.Api  <- built by azure-pipelines.yml
  -> image    contosoacr.azurecr.io/shop-api
  -> workload shop (default)::Deployment/${helm:.Release.Name}-api  deploy/helm/shop/templates/deployment.yaml:2
  -> service  shop (default)::Service/${helm:.Release.Name}-api
  -> ingress  -
…
Application Shop.Api  <- built by azure-pipelines.yml
  -> image    contosoacr.azurecr.io/shop-api
  -> workload shop::Deployment/shop-api  deploy/helm/shop/templates/deployment.yaml:2  [prod]
  -> service  shop::Service/shop-api
  -> ingress  shop::Ingress/shop-ingress
Application Shop.Api  <- built by azure-pipelines.yml
  -> image    $(serviceConnection:$(containerRegistry))/shop-api
  -> workload -
  -> service  -
  -> ingress  -
(declared topology from static files; not observed runtime state)
```

How to read it:

- Each Helm release profile is its own deployment scope, so the same template appears once per profile (`shop (default)::…`, `shop::…`). Only the pipeline profile has a release name and an environment.
- The pipeline's `Docker@2` task pushes `$(serviceConnection:$(containerRegistry))/shop-api`: the registry comes from a service connection that is not in the repository, so that image stays parameterized and is not matched to `contosoacr.azurecr.io/shop-api`, which the chart deploys. The chart deploys the tag `latest` from `values.yaml`, not `$(Build.BuildId)`. Vogoban reports exactly what the files declare; it does not assume the two are the same image.

Configuration and secrets across all sources:

```bash
vogoban configuration
vogoban k8s-services
vogoban ingress
vogoban environments
```

```text
kind                 configuration                                                          source                       value                                                                             role         environment  supplies code key
-------------------  ---------------------------------------------------------------------  ---------------------------  --------------------------------------------------------------------------------  -----------  -----------  ---------------------------------------
Configuration        ConfigMap/shop-worker-config:RabbitMq__Host                            configmap                    url amqp://rabbitmq.shop.svc.cluster.local hosts=rabbitmq.shop.svc.cluster.local  service-url  prod         -
Configuration        src/Shop.Api/appsettings.json:ConnectionStrings:Inventory              appsettings                  url http://inventory hosts=inventory                                              database     -            -
Configuration        src/Shop.Api/appsettings.json:PriceSync:IntervalSeconds                appsettings                  literal 300                                                                       -            -            configuration:PriceSync:IntervalSeconds
…
EnvironmentVariable  Deployment/shop-api/api:ConnectionStrings__Inventory                   secretKeyRef                 secret-reference                                                                  -            prod         -
EnvironmentVariable  Deployment/shop-api/api:SHOP_REGION                                    helm-rendered-literal        literal westeurope                                                                -            prod         environment:SHOP_REGION
…
SecretReference      Secret/shop-secrets                                                    kubernetes-secret-reference  (secret reference, value not stored)                                              -            -            -
…

service                                                     type       ports     selector      routes to                                                      ingress                                                         unresolved
----------------------------------------------------------  ---------  --------  ------------  -------------------------------------------------------------  --------------------------------------------------------------  ----------
shop (default)::Service/${helm:.Release.Name}-api           ClusterIP  80->8080  app=shop-api  shop (default)::Deployment/${helm:.Release.Name}-api           -
shop (values-prod.yaml)::Service/${helm:.Release.Name}-api  ClusterIP  80->8080  app=shop-api  shop (values-prod.yaml)::Deployment/${helm:.Release.Name}-api  shop (values-prod.yaml)::Ingress/${helm:.Release.Name}-ingress
shop::Service/shop-api                                      ClusterIP  80->8080  app=shop-api  shop::Deployment/shop-api                                      shop::Ingress/shop-ingress

ingress                                                         class  routes                                                services                                                    tls secrets  unresolved backends
--------------------------------------------------------------  -----  ----------------------------------------------------  ----------------------------------------------------------  -----------  -------------------
shop (values-prod.yaml)::Ingress/${helm:.Release.Name}-ingress  -      shop.contoso.com/api -> ${helm:.Release.Name}-api:80  shop (values-prod.yaml)::Service/${helm:.Release.Name}-api  -
shop::Ingress/shop-ingress                                      -      shop.contoso.com/api -> shop-api:80                   shop::Service/shop-api                                      -

environment  evidence                         declared resources
-----------  -------------------------------  --------------------------------------------------------------------------------
prod         pipeline-deployment-environment  HelmRelease=1 KubernetesConfigMap=1 KubernetesIngress=1 KubernetesService=1 Depl
```

The `supplies code key` column links a configuration entry to the `ConfigurationReference` that code reads: the `SHOP_REGION` container variable supplies `Environment.GetEnvironmentVariable("SHOP_REGION")`, and `PriceSync:IntervalSeconds` in `appsettings.json` supplies `configuration.GetValue<int>("PriceSync:IntervalSeconds")` (`SUPPLIES_CONFIG`, `STRUCTURALLY_RESOLVED`). Plain literal values are shown only for non-secret keys; secret values are never stored. All infrastructure commands and options are in the [infrastructure CLI reference](../cli/infrastructure.md).

## Azure infrastructure as code

Azure IaC is handled by the Azure plugins and lives in the same graph:

- **Bicep** (with modules, parameters and Azure Verified Modules evaluated symbolically), **ARM** JSON templates and **Terraform** (`azurerm` resources) produce `AzureResource` entities, `CREATES`, `USES_MODULE`, `DEPENDS_ON_RESOURCE`, identities, role assignments, networking and observability links.
- **.NET Aspire** AppHost resources and `azure.yaml` hosting declarations are read from code and YAML.
- Code-side clients, Functions triggers and bindings are linked to declared resources only through explicit names, settings and connection references (`DECLARED_BY`).

```bash
vogoban azure infrastructure
vogoban azure resources --kind service-bus
```

As with everything on this page, nothing is deployed or planned, and no Azure subscription is contacted; Vogoban never runs `az`, `azd`, `bicep` or `terraform`. Details are in [Azure](azure.md) and [Azure end to end](azure-end-to-end.md).

## Limitations

- Everything is declared state. Running replicas, actual image tags, applied Helm values, cluster defaults, admission controllers and the result of `terraform apply` are unknown.
- Only Azure Pipelines YAML is parsed as a pipeline. GitHub Actions workflows (files with `on:`/`runs-on:`), GitLab CI, Jenkins and classic (UI-defined) Azure pipelines are not. Templates from other repository resources are recorded as unresolved templates.
- Pipeline variables, service connections and variable groups defined outside the repository stay parameters (`$(...)`), so images built by a pipeline often do not match images referenced by charts or manifests.
- The Helm evaluator covers the common template language and Sprig functions listed above; anything depending on cluster state, randomness or files outside the chart stays a `${helm:...}` placeholder. Subcharts under a chart's `charts/` directory are not rendered, and chart dependencies are never fetched.
- Kubernetes kinds other than those listed (CRDs such as Argo CD `Application`, Istio, KEDA `ScaledObject`) are not modelled. Kustomize overlays are not evaluated; their resource files are read as plain manifests.
- Services route to workloads only by label selectors in the same namespace and deployment scope; workloads link to applications only through image or entrypoint-assembly evidence. A missing link is reported as an unresolved relationship (`selector-unmatched`, `ingress-backend-unresolved`, `configmap-unresolved`, `service-account-unresolved`, ...), visible with `vogoban unresolved-infrastructure`.
- `appsettings*.json` keys are kept only when code references the exact key, the value is a URL or connection string, or the key name looks secret. A section bound as a whole (`GetSection("Catalog")`) does not keep its individual keys.
- Secret values are never stored, from any source. A secret reference proves only that a workload names the secret.

## Related

- [Azure](azure.md), [Azure end to end](azure-end-to-end.md)
- [.NET](dotnet.md) (applications and configuration references)
- [Infrastructure CLI](../cli/infrastructure.md), [Azure CLI](../cli/azure.md)
- [Security](security.md), [Impact analysis](impact-analysis.md)
