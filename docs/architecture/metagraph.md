# MetaGraph

The MetaGraph connects independently analyzed RepositoryGraphs: which repository calls another's API, publishes a
message another consumes, uses a package another produces, deploys another's image, or shares an Azure resource with
it. It is derived entirely from the repository graphs in the same store and stored separately from them. The code is
in `src/metagraph` (`build.ts`, `catalog.ts`, `emitter.ts`, `resolver.ts` and one module per resolver).

## Design rule: never a second source of truth

The MetaGraph only *reads* repository facts and only *writes* `meta_*` rows:

- Resolvers receive a `GraphStore` and the catalog view of each repository and call read methods
  (`findEntities`, `findRelationships`, `findUnresolved`). They emit through `MetaEmitter`, whose batch is written by
  `replaceMetaCategory` into `meta_entities`, `meta_relationships`, `meta_unresolved` and `meta_conflicts`.
- A meta relationship points at repository entity ids (an `ApiOperation`, a `Queue`, a `Repository` entity); it never
  copies or edits them. When a repository is re-analyzed, its entities keep their ids if their identity is unchanged.
- Each category is fully replaced on recomputation, so the MetaGraph always equals "resolvers applied to the current
  repository graphs". There is no MetaGraph state that cannot be rebuilt from repository graphs.

Why this matters: a repository fact has exactly one origin (its repository at one commit). If the MetaGraph could hold
its own version of, say, an API operation, the two could disagree and nobody could tell which is right. Keeping the
MetaGraph derived means every cross-repository edge can be explained by two repository facts plus a resolver rule, and
a stale or wrong edge is fixed by re-analyzing a repository, never by editing the MetaGraph.

## Independent RepositoryGraphs and the catalog

Repositories are analyzed one at a time (`analyze`, `analyze-repo`, `analyze-all`, `graph sync`) into the same store.
Each analysis writes only its own repository's rows, so analyzing one repository never changes another's graph.

The **catalog** (`catalog` table, `CatalogEntry` in `src/graph/model.ts`) has one row per repository: identity, name,
URL, provider, organization, default branch, local path, status, analyzed commit, dirty flag, run, analysis time,
graph version, analyzer version, semantic flag and last error. `register` (`registerRepository` in
`src/metagraph/catalog.ts`) adds an entry without analyzing. Status values (`REPOSITORY_STATUSES`):

| Status | Set by |
|---|---|
| `REGISTERED` | `register`, before the first analysis |
| `ANALYZING` | `analyzeRepository` while running |
| `READY` | Successful analysis; refined at read time by `catalogStatus` |
| `STALE` | Computed: the checkout's `HEAD` differs from the analyzed commit, or it has uncommitted changes the graph does not reflect |
| `UNAVAILABLE` | Computed: the local checkout no longer exists; the stored graph is still usable |
| `FAILED` | Analysis failed; `lastError` holds the reason and any previous graph stays |

A repository participates in the MetaGraph when it has a graph version (`usableForMetaGraph`), so a `STALE`,
`UNAVAILABLE` or `FAILED` repository contributes its last successful graph, and the snapshot records that status.

## Build and recomputation

`buildMetaGraph(store, log, force)` runs in one store transaction:

1. Collect the usable repositories, ordered by repository id.
2. Compute the snapshot id: `snap_` + hash of the schema version, resolver versions and every
   `<repositoryId>@<graphVersion>`. The same inputs give the same snapshot id.
3. For each resolver, for each repository, look up the cached input digest
   (`meta-input|<resolver>@<version>|<repoId>` keyed by the repository's graph version); on a miss, run
   `resolver.collect(store, repo)` and store the SHA-256 of the collected input.
4. The category fingerprint is the hash of resolver id, version and all input digests. If it equals the stored
   fingerprint (`meta_inputs`) and `--force` was not given, the category is kept as is (`recomputed: false`).
5. Otherwise `resolver.resolve(inputs, emitter, store)` runs and `replaceMetaCategory` deletes and re-inserts that
   category's rows.
6. Save the `MetaSnapshot` (`meta_snapshots`) and a compact graph snapshot (`graph_snapshots`, scope `meta`).

Only categories whose inputs changed are recomputed. `graph sync --meta` runs the build after a repository sync; a
MetaGraph failure leaves the previous MetaGraph snapshot unchanged.

```bash
vogoban metagraph build
```

```text
MetaGraph snapshot snap_126908bc7645dadecd391eda
  contoso-fulfillment @ 1de8ed1b819b graph 86f3260a4c3d [READY]
  contoso-platform-infra @ 71a45f03cfbd graph 277cd288604c [READY]
  contoso-orders @ ccaffed660b7 graph a021d2d5c8bd [READY]
category    state       relationships  unresolved  conflicts
----------  ----------  -------------  ----------  ---------
package     recomputed  12             0           0
message     recomputed  9              0           0
deployment  recomputed  0              0           0
api         recomputed  3              0           0
external    recomputed  4              0           0
azure       recomputed  17             0           0
```

## Resolvers

`CROSS_REPOSITORY_RESOLVERS` in `src/metagraph/build.ts`, in execution order. Each implements
`CrossRepositoryResolver<T>` (`src/metagraph/resolver.ts`): `id`, `version`, `category`, `collect(store, repo)` and
`resolve(inputs, emit, store)`.

| Resolver (version) | Category | Collects | Emits |
|---|---|---|---|
| `packages` (3) | `package` | Projects, direct `PACKAGE_DEPENDS_ON`, contract projects, pack/push pipeline tasks | `PRODUCES_PACKAGE`, `USES_SHARED_PACKAGE`, `DEPENDS_ON_REPOSITORY`, `SHARES_CONTRACT_WITH`; `conflicting-package-producer` |
| `messages` (1) | `message` | `Message` entities, transports, `CARRIES`, publishers, consumers | `SharedContract` entities, `PUBLISHES_MESSAGE`, `CONSUMES_MESSAGE`, `CONSUMED_BY`, `CARRIES`, `CONTAINS`, `CONSUMES_REPOSITORY_CONTRACT`, `SHARES_CONTRACT_WITH`; `name-only-match` unresolved; `conflicting-message-schema` |
| `deployments` (1) | `deployment` | Images, Dockerfiles, pipelines, workloads, applications | `RUNS` (workload → application in another repository), `RESOLVES_TO` (deployed image → producing image), `DEPLOYS_REPOSITORY`; `image-producer-ambiguous`; `conflicting-image-producer` |
| `apis` (1) | `api` | `Api`, `ApiOperation`, implementations, payload types, unresolved `CALLS_ENDPOINT`, external calls, configured URLs, infrastructure host index | `PROVIDES_API`, `CALLS_ENDPOINT`, `CONSUMES_API`, `CALLS_REPOSITORY`, `ROUTES_TO`; `service-url-placeholder`, `provider-conflict`, `operation-not-found-at-provider`, `configuration-value-missing`; `conflicting-service-host` |
| `external-systems` (3) | `external` | External API calls, configured URLs, connection strings, infrastructure hosts | `ExternalSystem` and `Database` entities, `USES_EXTERNAL_SYSTEM`, `CALLS_EXTERNAL_SYSTEM`, `USES_DATABASE`; `service-host-unknown` |
| `azure-resources` (3) | `azure` | Code-side Azure resources with exact names, exact declared IaC resources, producers and consumers | `SharedContract` per account-qualified resource, `SHARES_RESOURCE`, cross-repository `DECLARED_BY`, `CONSUMES_REPOSITORY_CONTRACT`, `DEPENDS_ON_REPOSITORY`; `ambiguous-azure-declaration` |

### Packages

A project produces a package when it has an explicit `PackageId` (or the repository has a pack/push pipeline task):
evidence `DECLARED`; otherwise its assembly name is used: `STRUCTURALLY_RESOLVED`. A package used by several
repositories, or produced in one and consumed in another, gets `USES_SHARED_PACKAGE` edges and, for consumers of a
produced package, `DEPENDS_ON_REPOSITORY`. Two repositories producing the same package id is a conflict.

### Messages

Message contracts are grouped in tiers (next section) into `SharedContract` entities. Publishers and consumers in
different repositories get `PUBLISHES_MESSAGE`/`CONSUMES_MESSAGE`, `CONSUMED_BY` to the handlers, and repository-level
`CONSUMES_REPOSITORY_CONTRACT`. Groups whose members declare different field sets raise `conflicting-message-schema`.

### Deployments and images

A Kubernetes workload in one repository that runs an image produced (Dockerfile, Compose build or pipeline) in another
repository links to the producing repository's application. An image produced by several repositories is reported as
ambiguous, never assigned to one.

### APIs and service URLs

For each consumer call (unresolved `CALLS_ENDPOINT` or external call from the repository graph), the resolver collects
host candidates from the absolute URL, the client base address and configured URL values (with environment). Hosts are
resolved to applications through the infrastructure host index (ingress hosts, Kubernetes services, Compose services).
A matching provider operation (same method, same normalized route shape) yields `CALLS_ENDPOINT` (confidence 0.85,
evidence kinds `service-host:<via>`, the URL source and `method+route`), `CONSUMES_API` and `CALLS_REPOSITORY`. A host
claimed by applications in several repositories is a `conflicting-service-host` and `provider-conflict`. Without a
host, a call can still link when exactly one other repository has a matching operation whose request or response type
comes from a package the caller uses (`shared-contract-type`, confidence 0.8). Placeholder hosts (`localhost`,
`example.com`, `${...}`) never link.

### External systems

Hosts that are not internal to any catalog repository become `ExternalSystem` (`api`, `message-broker` or
`database` by URL scheme) and `Database` entities, linked with `USES_EXTERNAL_SYSTEM`, `CALLS_EXTERNAL_SYSTEM` or
`USES_DATABASE`. In the demo both repositories' Cosmos DB endpoints come from configuration:

```bash
vogoban connections
```

```text
from                 relationship                  to                                              evidence               confidence  environment  evidence kinds
-------------------  ----------------------------  ----------------------------------------------  ---------------------  ----------  -----------  --------------------------------------
contoso-fulfillment  CONSUMES_REPOSITORY_CONTRACT  contoso-orders                                  STRUCTURALLY_RESOLVED  0.8         -            exact-resource-name, producer-consumer
contoso-fulfillment  DEPENDS_ON_REPOSITORY         contoso-orders                                  STRUCTURALLY_RESOLVED  0.8         -            infrastructure-declaration
contoso-fulfillment  DEPENDS_ON_REPOSITORY         contoso-platform-infra                          STRUCTURALLY_RESOLVED  0.8         -            infrastructure-declaration
contoso-fulfillment  USES_EXTERNAL_SYSTEM          cosmos-contoso-fulfillment.documents.azure.com  DECLARED               0.9         local        configuration-url
contoso-orders       USES_EXTERNAL_SYSTEM          cosmos-contoso-orders.documents.azure.com       DECLARED               0.9         local        configuration-url
contoso-fulfillment  CONSUMES_REPOSITORY_CONTRACT  contoso-orders                                  STRUCTURALLY_RESOLVED  0.6         -            namespace-name-version
contoso-fulfillment  SHARES_CONTRACT_WITH          contoso-orders                                  STRUCTURALLY_RESOLVED  0.6         -            namespace-name-version
```

### Azure resources

Code-side logical resources are grouped by Azure kind and account-qualified exact name across repositories
(`service-bus-entity|sb-contoso-orders/orders`). Only facts with exact or statically derived names, a known account
from IaC or a literal host (Aspire parents do not qualify across repositories) and no empty segment participate; a
declaration participates only with `nameState: exact`, a parent path and no blank segment. Publisher in one repository
and consumer in another give `SHARES_RESOURCE` (publisher side → consumer side); a declaration in a third repository
gives `DECLARED_BY` and `DEPENDS_ON_REPOSITORY`. Two namespaces that both contain `orders` are two contracts. Details:
[azure-engine.md](azure-engine.md#cross-repository-metagraph).

## Identity tiers and evidence kinds

Cross-repository matches state *why* they match. Messages use explicit tiers (`src/metagraph/messages.ts`):

| Tier | Rule | Evidence | Confidence |
|---|---|---|---|
| `exact-semantic-identity` | Same Roslyn symbol key (`<assembly>::<doc id>`) in two or more repositories, declared in at most one | `COMPILER_RESOLVED` | 1.0 when consumers reference the producer's package, else 0.95 |
| `namespace+name+version` | Same namespace-qualified name and version | `STRUCTURALLY_RESOLVED` | 0.6 |
| `transport-configuration+message-name` | Same broker, transport kind and transport name, and the same simple message name | `STRUCTURALLY_RESOLVED` | 0.7 |
| name only | Only the simple name matches | Not linked: `name-only-match` unresolved reference listing candidates | – |

Azure resources match on Azure kind plus account-qualified exact name. APIs match on host plus method plus route shape,
or on a shared contract type plus method plus route. Packages match on ecosystem plus package id.

Every meta relationship lists its **evidence kinds** in `metadata.evidenceKinds`. Values used by the resolvers include:
`compiled-contract-identity`, `shared-contract-package`, `namespace-name-version`, `transport-configuration`,
`message-name`, `package-identity`, `package-reference`, `explicit-package-id-or-pack-task`,
`packable-library-assembly-name`, `endpoint-implementation`, `api-contract-document`, `method+route`,
`service-host:<via>`, `configuration:<key>`, `absolute-url`, `client-base-address`, `shared-contract-type`,
`configuration-url`, `connection-string-host`, `http-call-host`, `external-api-host`, `image-identity`,
`exact-resource-name`, `same-azure-service`, `producer-consumer`, `infrastructure-declaration`, `single-declaration`.

## Meta tables

| Table | Contents |
|---|---|
| `meta_inputs` | `category` → input fingerprint of the last computation |
| `meta_snapshots` | Snapshot id, time, schema version, resolver versions, repositories (id, name, commit, graph version, status), per-category fingerprint and counts |
| `meta_entities` | MetaGraph-owned entities (`SharedContract`, `ExternalSystem`, `Database`), id `me_…`, with category |
| `meta_relationships` | Id `mr_…` = hash of category, type, source, target and environment; source and target repository ids, environment, evidence, confidence, metadata, provenance, snapshot id |
| `meta_unresolved` | Id `mu_…`; category, type, source, repository, display, resolver, reason |
| `meta_conflicts` | Id `mc_…`; category, kind, subject, fact ids, description |

## Provenance of meta relationships

Meta provenance records have `plugin` and `resolver` = `metagraph.<resolver id>`, the resolver's extractor (for example
`AZURE_REPOSITORY_LINK`, `API_CONSUMER`, `MESSAGE_CONSUMER`), `mechanism: cross-repository-resolution` and
`analysisVersion` = resolver version. The metadata ties the edge to the exact repository states it was computed from:

```bash
vogoban connections --json
```

```text
  "metadata": {
   "azureResources": [ "service-bus-entity:sb-contoso-orders/orders" ],
   "graphScope": "meta",
   "resolver": "metagraph.azure-resources@3",
   "evidenceKinds": [ "exact-resource-name", "producer-consumer" ],
   "sourceScope": "repository",
   "sourceRepository": "contoso-fulfillment",
   "sourceCommit": "1de8ed1b819b047bb4d04fad2be948f5da95c98b",
   "sourceGraphVersion": "86f3260a4c3dcc4d1228df36a7156f73",
   "targetScope": "repository",
   "targetRepository": "contoso-orders",
   "targetCommit": "ccaffed660b7f947a60737e24447c6ace2a90559",
   "targetGraphVersion": "a021d2d5c8bd74c1d8d6e8bc6b9d5833"
  },
```

## Unresolved and conflicts

MetaGraph unresolved references (`meta_unresolved`) follow the same principle as repository ones: a cross-repository
link that cannot be proven is reported with a reason and category instead of being guessed (`name-only-match`,
`provider-conflict`, `operation-not-found-at-provider`, `service-url-placeholder`, `configuration-value-missing`,
`image-producer-ambiguous`, `service-host-unknown`, `ambiguous-azure-declaration`). Conflicts (`meta_conflicts`) record
disagreements across repositories (`conflicting-package-producer`, `conflicting-message-schema`,
`conflicting-image-producer`, `conflicting-service-host`). `vogoban metagraph unresolved` and
`vogoban metagraph conflicts` list them.

## Snapshots

Every build writes a `MetaSnapshot` and a meta-scope graph snapshot whose payload excludes volatile metadata (source
and target commits and graph versions, resolver tag), so two builds over equivalent graphs compare equal. `diff --meta`
and `governance-diff --meta-from/--meta-to` compare them.

```bash
vogoban metagraph snapshots
```

```text
snap_126908bc7645dadecd391eda  2026-10-11T16:57:36.028Z
  contoso-fulfillment @ 1de8ed1b819b graph 86f3260a4c3d [READY]
  contoso-platform-infra @ 71a45f03cfbd graph 277cd288604c [READY]
  contoso-orders @ ccaffed660b7 graph a021d2d5c8bd [READY]
  resolvers packages@3 messages@1 deployments@1 apis@1 external-systems@3 azure-resources@3  categories package:recomputed message:recomputed deployment:recomputed api:recomputed external:recomputed azure:recomputed
```

## Renames and reconciliation

- **Entity renames** inside a repository produce new repository entity ids. The next build sees a changed input
  digest for the affected categories, recomputes them and replaces their rows, so meta edges to the old id disappear and
  edges to the new id appear (if the rule still matches).
- **Repository moves** keep identity when the repository has a remote or a `vogoban.json` pin; `register` updates the
  local path of the existing entry. A repository with a `local:` identity gets a new identity (and a new catalog entry)
  when it moves. 0.18.0 has no command to remove a catalog entry, and the old entry (now `UNAVAILABLE`) still has a
  graph version, so its last graph keeps participating in the MetaGraph. Prefer a remote or a pin for repositories that
  move, or use a fresh store.
- **Resolver changes** change the resolver version, which changes every category fingerprint of that resolver and
  the snapshot id, so the category is recomputed.

## Limitations

- The MetaGraph only sees repositories analyzed into the same store.
- Cross-repository API links need a host that infrastructure or configuration in the catalog maps to an application, or
  a shared contract type; calls built from runtime values stay unresolved.
- A frontend in one repository calling an API hosted in Azure by another is linked only through the API resolver's
  contract and host matching; Azure hosting is not used to bridge the two.

## Related

- [MetaGraph features](../features/metagraph.md)
- [metagraph command reference](../cli/metagraph.md)
- [RepositoryGraph](repository-graph.md)
- [Identity](identity.md)
