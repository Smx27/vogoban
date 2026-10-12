# Infrastructure commands

These commands show the delivery and runtime topology declared in a repository: Azure Pipelines (stages, jobs, tasks, artifacts), Dockerfiles and container images, Helm charts and releases, Kubernetes workloads, services and ingresses, configuration and secret references, environments, and the end-to-end topology from .NET application to image to workload to ingress. Everything is **declared state** read from files; nothing is read from a cluster, registry or Azure DevOps. Azure IaC (Bicep, ARM, Terraform) is covered by [azure.md](azure.md).

## The example repository

The examples use `contoso-shipping`, a small service repository with:

- `src/Contoso.Shipping.Api` (ASP.NET Core minimal API),
- `Dockerfile` (multi-stage: `sdk` build stage, `aspnet` final stage),
- `azure-pipelines.yml` (stage `Build`: `Docker@2` build-and-push and `PublishPipelineArtifact@1` of the chart; stage `DeployProd`: deployment job to environment `prod` with `HelmDeploy@0` upgrade using `values-prod.yaml`),
- `charts/shipping` (Helm chart with `values.yaml`, `values-prod.yaml`, and Deployment, Service and Ingress templates; the Deployment reads a connection string from a Kubernetes secret).

```yaml
# azure-pipelines.yml (excerpt)
- task: Docker@2
  displayName: Build and push shipping image
  inputs:
    command: buildAndPush
    repository: $(imageRepository)
    containerRegistry: $(containerRegistry)
    Dockerfile: Dockerfile
- task: HelmDeploy@0
  displayName: Helm upgrade shipping
  inputs:
    command: upgrade
    chartType: FilePath
    chartPath: charts/shipping
    releaseName: shipping
    valueFile: charts/shipping/values-prod.yaml
```

It was analyzed with `vogoban analyze .`. Your ids will differ.

## infrastructure

### What it does

Prints the infrastructure graph statistics, the same table as the last part of the `analyze` summary.

### Usage

```bash
vogoban infrastructure [--repo <repo>] [--json]
```

### Example

```bash
vogoban infrastructure
```

### Output

```text
Infrastructure graph (static declarations; evidence DECLARED, not runtime state)
                                         count
---------------------------------------  -----
Pipelines                                1
Pipeline Stages                          2
Jobs                                     2
Tasks                                    4
Artifacts                                2
Container Images                         2
  Base Images                            2
Dockerfiles                              1
Docker Stages                            2
Helm Charts                              1
Helm Releases                            3
Helm Resources                           9
Kubernetes Workloads                     3
  Deployments                            3
Kubernetes Services                      3
Ingresses                                3
…
Secret References                        3
Containers                               3
Environment Variables                    4
Configuration Entries                    2
Environments                             1
Infrastructure Conflicts                 0
Unresolved Infrastructure Relationships  0
```

One chart produces three releases (see [helm](#helm)), which is why workloads, services and ingresses are counted three times.

## pipelines and pipeline

### What it does

`pipelines` lists Azure Pipelines with triggers, stage and artifact counts, the images they build and how many deployments they run. `pipeline` prints one pipeline as a tree: triggers, variables and variable groups, templates, stages, jobs (with `dependsOn`, environment, pool, condition), recognized tasks, artifacts consumed and deployments.

### Usage

```bash
vogoban pipelines [--repo <repo>] [--json]
vogoban pipeline <id | file | name> [--json]
```

### Example

```bash
vogoban pipeline azure-pipelines.yml
```

### Output

```text
Pipeline azure-pipelines.yml  (azure-pipelines.yml:1)
  triggers   ci:enabled branches=main; pr:default
  variables  imageRepository, containerRegistry
  templates  -
  stage Build
    job BuildImage  pool=vmImage:ubuntu-latest
      - Docker@2: Build and push shipping image  [docker-build,docker-push]  azure-pipelines.yml:16
      - PublishPipelineArtifact@1: Publish chart  [artifact-publish]  azure-pipelines.yml:25
  stage DeployProd  dependsOn=Build
    deployment DeployShipping  environment=prod
      - DownloadPipelineArtifact@2: DownloadPipelineArtifact@2  [artifact-download]  azure-pipelines.yml:40
      - HelmDeploy@0: Helm upgrade shipping  [helm-deploy]  azure-pipelines.yml:43
      consumes: azure-pipelines.yml:shipping-chart
      deploys: charts/shipping/shipping#shipping via azure-pipelines.yml
  artifacts  azure-pipelines.yml:shipping-chart, azure-pipelines.yml:image:$(serviceConnection:$(containerRegistry))/contoso/shipping-api
  builds     $(serviceConnection:$(containerRegistry))/contoso/shipping-api
  deploys    charts/shipping/shipping#shipping via azure-pipelines.yml
  secrets/config  imageRepository, containerRegistry
```

The brackets after each task are what Vogoban recognized it as (`docker-build`, `artifact-publish`, `helm-deploy`, `kubernetes-deploy`, `dotnet-publish`, ...). Recognized tasks include `DotNetCoreCLI`, `NuGetCommand`, `Docker`, `DockerCompose`, `PublishBuildArtifacts`, `PublishPipelineArtifact`, `DownloadBuildArtifacts`, `DownloadPipelineArtifact`, `CopyFiles`, `ArchiveFiles`, `HelmDeploy`, `KubernetesManifest`, `Kubernetes`, `AzureWebApp`, `AzureRmWebAppDeployment`, `AzureFunctionApp`, `VSBuild`, `VSTest`, and `dotnet`/`docker`/`helm`/`kubectl` commands inside `script`, `Bash`, `PowerShell`, `CmdLine` and `AzureCLI` steps. Other tasks are listed as `task:<Name>`.

`$(serviceConnection:$(containerRegistry))` is how an image name that depends on a service connection is shown: the registry host is only known inside Azure DevOps.

### Common mistakes

- `pipeline` matches the id, the file path or the name exactly. A file in a subdirectory needs its repository-relative path (`build/azure-pipelines.yml`).
- Only Azure Pipelines YAML is modelled. GitHub Actions workflows are discovered but not analyzed. Templates from another repository resource, templates whose path is an expression, and templates nested too deeply are reported as unresolved.

## artifacts

### What it does

Lists build artifacts (pipeline artifacts, build artifacts, NuGet packages, container images) with the pipeline that produces them, their contents, what they are packaged as, and the deployment jobs that consume them.

### Example

```bash
vogoban artifacts
```

### Output

```text
artifact                                                        type               produced by          contains  packaged as / packages                                          deployed by jobs
--------------------------------------------------------------  -----------------  -------------------  --------  --------------------------------------------------------------  ---------------------------------------------------------
$(serviceConnection:$(containerRegistry))/contoso/shipping-api  container-image    azure-pipelines.yml  -         $(serviceConnection:$(containerRegistry))/contoso/shipping-api  -
shipping-chart                                                  pipeline-artifact  azure-pipelines.yml  -         -                                                               charts/shipping/shipping#shipping via azure-pipelines.yml
```

## images

### What it does

Lists container images with their identity (`declared`, `parameterized`, `unnamed`, or `base` for `FROM` images), tags, what builds them (Dockerfile, pipeline), the .NET applications and projects they package, and the workloads that deploy them (for base images: how many Docker stages use them).

### Example

```bash
vogoban images
```

### Output

```text
image                                                           identity       tags              built by                         packages                                                                          deployed by / base of
--------------------------------------------------------------  -------------  ----------------  -------------------------------  --------------------------------------------------------------------------------  ------------------------------------------------
$(serviceConnection:$(containerRegistry))/contoso/shipping-api  parameterized  $(Build.BuildId)  Dockerfile, azure-pipelines.yml  Contoso.Shipping.Api (aspnetcore), src/Contoso.Shipping.Api/Contoso.Shipping.Api…  -
contoso/shipping-api                                            declared       1.2.0,latest      -                                -                                                                                 shipping (default)::Deployment/${helm:.Release.N…
mcr.microsoft.com/dotnet/aspnet                                 base           10.0              -                                -                                                                                 1 stages
mcr.microsoft.com/dotnet/sdk                                    base           10.0              -                                -                                                                                 1 stages
```

The pipeline builds `$(serviceConnection:…)/contoso/shipping-api` and the Helm chart deploys `contoso/shipping-api`. Vogoban does not assume these are the same image, because the registry prefix is unknown statically; the two rows stay separate. That is also why [`topology`](#topology) shows the application and the workloads in separate chains here.

## docker

### What it does

Prints each Dockerfile with its stages (`*` marks the final stage), base images, stage dependencies (`COPY --from`), `dotnet` commands, exposed ports, entrypoint, environment variables, the images it builds and the .NET projects it packages, with the evidence for that mapping.

### Example

```bash
vogoban docker
```

### Output

```text
Dockerfile
  - build  FROM mcr.microsoft.com/dotnet/sdk:10.0  [dotnet publish Contoso.Shipping.Api/Contoso.Shipping.Api.csproj -o /app]
  * final  FROM mcr.microsoft.com/dotnet/aspnet:10.0  depends on build (COPY --from)
  exposes 8080  entrypoint dotnet Contoso.Shipping.Api.dll  env ASPNETCORE_URLS
  builds  $(serviceConnection:$(containerRegistry))/contoso/shipping-api
  packages Contoso.Shipping.Api (dotnet publish Contoso.Shipping.Api/Contoso.Shipping.Api.csproj via COPY mapping (pipeline:azure-pipelines.yml:16); entrypoint assembly Contoso.Shipping.Api.dll)
```

`packages` explains why the image is linked to the project: the `dotnet publish` path, resolved through the `COPY` mapping and the pipeline's build context, and the entrypoint assembly name.

## helm

### What it does

Lists Helm charts with version, app version and location, and for each **release** (a combination of the chart with value files) the value files, environment, the pipeline that deploys it, the resulting image and the rendered Kubernetes resources.

### Example

```bash
vogoban helm
```

### Output

```text
charts/shipping/shipping 1.2.0 (appVersion 1.2.0)  charts/shipping/Chart.yaml:1
  release shipping (values-prod.yaml)  values=charts/shipping/values.yaml,charts/shipping/values-prod.yaml
    image=contoso/shipping-api:1.2.0  resources: Deployment/${helm:.Release.Name}-api, Ingress/${helm:.Release.Name}-ingress, Service/${helm:.Release.Name}-api
  release shipping  values=charts/shipping/values.yaml,charts/shipping/values-prod.yaml  environment=prod  deployed by azure-pipelines.yml, azure-pipelines.yml#DeployProd/DeployShipping
    image=contoso/shipping-api:1.2.0  resources: Service/shipping-api, Ingress/shipping-ingress, Deployment/shipping-api
  release shipping (default)  values=charts/shipping/values.yaml
    image=contoso/shipping-api:latest  resources: Ingress/${helm:.Release.Name}-ingress, Service/${helm:.Release.Name}-api, Deployment/${helm:.Release.Name}-api
```

Three releases are derived:

- `shipping (default)`: the chart with `values.yaml` only;
- `shipping (values-prod.yaml)`: the chart with each additional values file found next to it;
- `shipping`: the release the pipeline actually deploys (`releaseName: shipping`, environment `prod`). Its release name is known, so `{{ .Release.Name }}` is rendered (`Deployment/shipping-api`). In the other two it stays as the placeholder `${helm:.Release.Name}`.

Templates are rendered statically with Vogoban's own Go-template evaluator (values, release fields, `if`/`with`/`range`, `include` of named templates and common functions). Expressions it cannot evaluate stay as visible placeholders instead of being guessed.

## deployments

### What it does

Lists Kubernetes workloads (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Pod) from manifests and rendered Helm releases, with images and tags, the .NET application they run, the services selecting them, environment, Helm release and location.

### Usage

```bash
vogoban deployments [--app A] [--repo <repo>] [--json]
```

### Example

```bash
vogoban deployments
```

### Output

```text
workload                                                           images                       runs application  services                                                        environment  helm release                 location
-----------------------------------------------------------------  ---------------------------  ----------------  --------------------------------------------------------------  -----------  ---------------------------  ----------------------------------------
shipping (default)::Deployment/${helm:.Release.Name}-api           contoso/shipping-api:latest  -                 shipping (default)::Service/${helm:.Release.Name}-api           -            shipping (default)           charts/shipping/templates/deployment.yam…
shipping (values-prod.yaml)::Deployment/${helm:.Release.Name}-api  contoso/shipping-api:1.2.0   -                 shipping (values-prod.yaml)::Service/${helm:.Release.Name}-api  -            shipping (values-prod.yaml)  charts/shipping/templates/deployment.yam…
shipping::Deployment/shipping-api                                  contoso/shipping-api:1.2.0   -                 shipping::Service/shipping-api                                  prod         shipping                     charts/shipping/templates/deployment.yam…
```

Workloads are named `<release>::<Kind>/<name>` when they come from Helm. `runs application` is `-` here because the deployed image could not be tied to the built image (see [images](#images)). `--app` keeps workloads that run the named application (exact name, case-insensitive).

## k8s-services and ingress

### What it does

`k8s-services` lists Kubernetes Services with type, ports, selector, the workloads the selector matches, the ingresses that route to them and unresolved selectors. `ingress` lists Ingress resources with class, host/path routes, backend services, TLS secrets and unresolved backends.

### Example

```bash
vogoban ingress
```

### Output

```text
ingress                                                             class  routes                                                                  services                                                        tls secrets  unresolved backends
------------------------------------------------------------------  -----  ----------------------------------------------------------------------  --------------------------------------------------------------  -----------  -------------------
shipping (default)::Ingress/${helm:.Release.Name}-ingress           nginx  shipping.contoso.example/api/shipments -> ${helm:.Release.Name}-api:80  shipping (default)::Service/${helm:.Release.Name}-api           -
shipping (values-prod.yaml)::Ingress/${helm:.Release.Name}-ingress  nginx  shipping.contoso.com/api/shipments -> ${helm:.Release.Name}-api:80      shipping (values-prod.yaml)::Service/${helm:.Release.Name}-api  -
shipping::Ingress/shipping-ingress                                  nginx  shipping.contoso.com/api/shipments -> shipping-api:80                   shipping::Service/shipping-api                                  -
```

```bash
vogoban k8s-services
```

```text
service                                                         type       ports     selector          routes to                                                          ingress                                                             unresolved
--------------------------------------------------------------  ---------  --------  ----------------  -----------------------------------------------------------------  ------------------------------------------------------------------  ----------
shipping (default)::Service/${helm:.Release.Name}-api           ClusterIP  80->8080  app=shipping-api  shipping (default)::Deployment/${helm:.Release.Name}-api           shipping (default)::Ingress/${helm:.Release.Name}-ingress
…
shipping::Service/shipping-api                                  ClusterIP  80->8080  app=shipping-api  shipping::Deployment/shipping-api                                  shipping::Ingress/shipping-ingress
```

The host per release comes from the values file that release uses (`values-prod.yaml` overrides `ingress.host`).

## configuration

### What it does

Lists configuration entries, environment variables, ConfigMaps and secret references declared in pipelines, Dockerfiles, Kubernetes manifests, Helm values, App Configuration and appsettings: kind, name, source, value kind (and value when it is a literal, never for secrets), role, environment, and the code configuration key it supplies.

### Usage

```bash
vogoban configuration [secret | env | configmap] [--role service-url|database] [--source S] [--json]
```

### Example

```bash
vogoban configuration
```

### Output

```text
kind                 configuration                                                          source                       value                                 role         environment  supplies code key
-------------------  ---------------------------------------------------------------------  ---------------------------  ------------------------------------  -----------  -----------  -----------------
Configuration        pipeline:azure-pipelines.yml:containerRegistry                         pipeline-variable            literal acr-contoso                   -            -            -
Configuration        pipeline:azure-pipelines.yml:imageRepository                           pipeline-variable            literal contoso/shipping-api          -            -            -
EnvironmentVariable  Deployment/${helm:.Release.Name}-api/api:ConnectionStrings__Shipments  secretKeyRef                 secret-reference                      -            -            -
…
EnvironmentVariable  Deployment/shipping-api/api:ConnectionStrings__Shipments               secretKeyRef                 secret-reference                      -            prod         -
EnvironmentVariable  Dockerfile:ENV ASPNETCORE_URLS                                         dockerfile-env               url http://+:8080 hosts=+:8080        service-url  -            -
SecretReference      Secret/shipping-secrets                                                kubernetes-secret-reference  (secret reference, value not stored)  -            -            -
…
```

Secret values are never read or stored, only the reference (`Secret/shipping-secrets`, a Key Vault reference, a pipeline secret variable). `supplies code key` links an entry to the configuration key the code reads, when the code reads it. In the example the API never reads `ConnectionStrings:Shipments`, so the column is `-`.

### Useful options

The positional filter is `secret` (secret references), `env` (environment variables) or `configmap`. `--role` filters by detected role (`service-url`, `database`), `--source` by source (`pipeline-variable`, `dockerfile-env`, `secretKeyRef`, ...).

## environments

### What it does

Lists environments with the evidence for each (`pipeline-deployment-environment`, `helm-release-environment`, `configured` through `vogoban.json` `infrastructure.environments`, `aspnetcore-appsettings-convention`, `dotenv-file-convention`, `hosting-environment-variable`) and the declared resources per kind.

### Example

```bash
vogoban environments
```

### Output

```text
environment  evidence                         declared resources
-----------  -------------------------------  --------------------------------------------------------------------------------
prod         pipeline-deployment-environment  PipelineJob=1 KubernetesService=1 Deployment=1 KubernetesIngress=1 HelmRelease=1
```

## topology

### What it does

Assembles the end-to-end declared topology: application, the image that packages it and the pipeline that builds it, the workload that runs the image, the service that selects the workload and the ingress that routes to the service.

### Usage

```bash
vogoban topology [--app A] [--json]
```

### Example

```bash
vogoban topology
```

### Output

```text
Application Contoso.Shipping.Api  <- built by azure-pipelines.yml
  -> image    $(serviceConnection:$(containerRegistry))/contoso/shipping-api
  -> workload -
  -> service  -
  -> ingress  -
(no application link)
  -> image    contoso/shipping-api
  -> workload shipping::Deployment/shipping-api  charts/shipping/templates/deployment.yaml:2  [prod]
  -> service  shipping::Service/shipping-api
  -> ingress  shipping::Ingress/shipping-ingress
…
(declared topology from static files; not observed runtime state)
```

The application chain stops at the image and the deployment chain starts at a differently named image, so Vogoban shows separate chains instead of guessing that they connect.

## unresolved-infrastructure

### What it does

Lists infrastructure relationships that could not be resolved: Service selectors that match no workload, ingress backends without a service, images whose names are computed, pipeline templates that are not in the repository, and similar.

### Example

```bash
vogoban unresolved-infrastructure
```

### Output

The example repository resolves everything:

```text
type  target  source  category  reason  location
----  ------  ------  --------  ------  --------
```

A Service whose selector matches no workload in the repository appears with category `selector-unmatched`.

## Common mistakes

- **Reading declared state as deployed state.** These views show what files say. A `kubectl edit`, a manual pipeline run with overridden variables or a cluster-side admission policy is not visible.
- **Expecting a cluster view per environment from one values file.** Each values file next to a chart produces its own release; the release a pipeline deploys is the one with an environment.
- **Missing pipelines.** Pipeline YAML must be named `azure-pipelines*.yml`, live under `pipelines/`, start with `stages:`/`jobs:`/`steps:`/`extends:`, or be listed in `vogoban.json` `infrastructure.pipelines`.

## Related

- [infrastructure.md](../features/infrastructure.md): what is modelled and how
- [azure.md](azure.md): Bicep, ARM, Terraform and Aspire resources
- [impact.md](impact.md): `service-impact` includes deployments
- [security.md](security.md): `secrets` and `sensitive-resources`
