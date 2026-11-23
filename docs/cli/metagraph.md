# MetaGraph commands (multi-repository)

The **MetaGraph** connects several repository graphs stored in one store: which repository provides an API another consumes, who publishes and consumes a shared message contract, which packages and external systems repositories share, and which repository depends on which infrastructure. Repository graphs stay authoritative for their own facts; the MetaGraph only adds cross-repository relationships with evidence and a confidence value.

This page covers `discover`, the catalog commands (`register`, `analyze-repo`, `analyze-all`, `repositories`, `repository`), `metagraph build|stats|snapshots|unresolved|conflicts|export`, and the cross-repository queries. Concepts are explained in [MetaGraph](../features/metagraph.md); cross-repository impact is `repository-impact` in [impact.md](impact.md#repository-impact).

For a copyable eleven-repository workflow and its verified connectivity limits, see [build and inspect a multi-repository MetaGraph](../graph/metagraph-workflow.md). Register and analyze each repository into the same explicitly selected store, then build the MetaGraph separately. Analyzing their parent folder once does not federate the children, and `metagraph build` does not import their separate local databases. Shared-package and external-system edges are not proof of service-to-service calls.

The examples use one store for three demo repositories: `contoso-orders` (ASP.NET Core API, Functions, React, Bicep), `contoso-fulfillment` (.NET Functions consuming `orders`, publishing `shipments`) and `contoso-platform-infra` (Terraform). Point every command at the shared store with `--db` or `VOGOBAN_DB`:

```bash
export VOGOBAN_DB=$HOME/demo/meta/graph.db
```

The repositories have no Git remote, so their identity is `local:<path>`. With a remote, the identity is derived from the remote URL and stays stable across clones. The outputs below come from two copies of the demo store, so paths, ids and commits vary between examples; yours will differ too.

## Typical workflow

```bash
vogoban discover .          # find, register and analyze every repository under this folder, then build the MetaGraph
vogoban connections
```

or step by step:

```bash
vogoban register ./contoso-orders
vogoban register ./contoso-fulfillment
vogoban register ./contoso-platform-infra
vogoban analyze-all
vogoban metagraph build
vogoban connections
```

After code changes, `vogoban graph sync <path> --meta` updates one repository and rebuilds the MetaGraph in one step (see [sync.md](sync.md)).

## discover

### What it does

Finds the repositories under a folder and brings the MetaGraph up to date in one step: it registers every repository it finds, analyzes the new and changed ones, and rebuilds the MetaGraph. A folder counts as a repository when it contains `.git`, `vogoban.json` or `catalog-info.yaml` (or `catalog-info.yml`). The walk does not descend into a repository it found, skips `node_modules`, `bin`, `obj`, `dist`, `target`, `vendor` and dot-folders, and never follows symbolic links.

A Git checkout whose commit and working tree match the last analysis is reported as `UNCHANGED` and not reanalyzed; a folder without Git is always reanalyzed (the fact cache keeps that cheap). Catalog entries registered under the folder whose path no longer exists are listed as stale; their stored graphs stay in the MetaGraph until you remove them. A descriptor-only folder inside another Git repository is `SKIPPED` with the reason, because Vogoban identifies a repository by its Git root.

### Usage

```bash
vogoban discover <dir> [--depth N] [--dry-run] [--no-analyze] [--no-build] [--force] [--no-semantic] [--trust-repository | --untrusted] [--json]
```

| Option | Default | Meaning |
|---|---|---|
| `--depth N` | 4 | How many folder levels below `<dir>` to search |
| `--dry-run` | off | List what was found and whether it is new; change nothing |
| `--no-analyze` | off | Register only (implies no MetaGraph build) |
| `--no-build` | off | Register and analyze, but do not rebuild the MetaGraph |
| `--force` | off | Reanalyze unchanged checkouts and recompute every MetaGraph category |

Exit code 0 when every repository was analyzed or unchanged, 1 when any analysis failed (the others still run and the MetaGraph is still built), 2 when the folder does not exist.

### Example

```bash
vogoban discover ~/landscape --db ~/landscape/.vogoban/meta.db --trust-repository
```

### Output

```text
repository            action     marker  path                               detail
--------------------  ---------  ------  ---------------------------------  --------------------------------------
admin-portal          UNCHANGED  .git    /home/me/landscape/admin-portal    analyzed at 4ba37f9061ef
customer-service      ANALYZED   .git    /home/me/landscape/customer-service  entities=504 relationships=1216 1931ms
…
stale catalog entry: operations-portal (/home/me/landscape/operations-portal) registered under this directory but no longer found there
MetaGraph snapshot snap_c043827f865b6ecc746e6ca1: 11 repositories, 161 relationships, 22 unresolved, 0 conflicts
```

### Common mistakes

- Running it on a folder that is itself inside a Git repository, such as `example/` in a Vogoban clone. Copy the folder out, or give each repository its own checkout.
- Expecting message and Azure links from .NET repositories whose packages are not restored. The detail column says `.NET project(s) not restored`; run `dotnet restore` and discover again.

## register

### What it does

Adds a repository to the catalog without analyzing it. The repository's identity, name, remote URL, provider and default branch are discovered from Git. Registering an already-known repository from the same path updates its metadata. Registering a second checkout with the same identity (for example another clone of the same remote) is refused with exit 2, because it would replace the first checkout's graph; pass `--force` to switch the catalog entry to the new checkout, or use a separate `--db`. A path that is not a directory exits 2. `vogoban analyze <path>` also adds the repository to the catalog, so `register` is only needed when you want to analyze later with `analyze-repo`/`analyze-all`.

### Usage

```bash
vogoban register <path> [--no-semantic]
```

`--no-semantic` is stored with the entry and makes `analyze-repo`/`analyze-all` run syntax-only analysis for it.

### Example

```bash
vogoban register ./contoso-orders
```

### Output

```text
Registered contoso-orders (e_ebfb205c403f02991a5b8df1) identity=local:/home/user/.capy/work/scratch/cli2/demo/contoso-orders status=REGISTERED
```

### Common mistakes

- Registering a subdirectory. The repository root is discovered from the path, so `register ./contoso-orders/src` registers `contoso-orders`.

## analyze-repo and analyze-all

### What it does

`analyze-repo` analyzes one catalog repository from its registered path. `analyze-all` analyzes every catalog repository in turn; a failure in one does not stop the others, and the command exits 1 when any repository `FAILED`. A repository whose .NET projects compiled with errors is still `READY`, and its detail column carries a warning (with a restore hint when packages are not restored). Each run is a normal full analysis (the same as `vogoban analyze <path>`).

### Usage

```bash
vogoban analyze-repo <repo> [--log-level L]
vogoban analyze-all [--log-level L]
```

`<repo>` is the catalog id, identity or name.

### Example

```bash
vogoban analyze-all --log-level warn
```

### Output

```text
repository              status  commit        detail
----------------------  ------  ------------  --------------------------------------
contoso-fulfillment     READY   1de8ed1b819b  entities=177 relationships=277 1881ms
contoso-orders          READY   fbe23c1098fd  entities=553 relationships=1149 2661ms
contoso-platform-infra  READY   71a45f03cfbd  entities=18 relationships=28 276ms
```

`status` is `READY`, `FAILED` (with the error in `detail`) or `UNAVAILABLE` (the registered path no longer exists).

`READY` does not mean semantic analysis was free of compiler diagnostics or that every expected cross-repository interaction was found. Check `metagraph stats`, `metagraph unresolved` and the repository's analysis diagnostics; the [enterprise-landscape validation](../graph/metagraph-workflow.md#verified-enterprise-landscape-results-and-limits) demonstrates this distinction.

### Useful options

`--log-level warn` hides the per-phase analysis logs. `--untrusted` disables MSBuild evaluation for every repository analyzed.

### Common mistakes

- Expecting `analyze-all` to build the MetaGraph. Run `vogoban metagraph build` afterwards.

## repositories

### What it does

Lists the catalog with each repository's status, identity, analyzed commit, graph version and analysis time.

### Usage

```bash
vogoban repositories [--json]
```

### Example

```bash
vogoban repositories
```

### Output

```text
repository              status  identity                                                              commit        graph version  analyzed at               note
----------------------  ------  --------------------------------------------------------------------  ------------  -------------  ------------------------  --------------------------------------------------
contoso-fulfillment     STALE   local:/home/user/.capy/work/scratch/cli2/demo/contoso-fulfillment     1de8ed1b819b  cc4370444f9d   2026-10-11T17:10:10.324Z  analyzed 1de8ed1b819b, checkout is at 103417fcbc5d
contoso-orders          READY   local:/home/user/.capy/work/scratch/cli2/demo/contoso-orders          fbe23c1098fd  966c82a440a7   2026-10-11T17:10:13.001Z
contoso-platform-infra  READY   local:/home/user/.capy/work/scratch/cli2/demo/contoso-platform-infra  71a45f03cfbd  92a4ed4efa8a   2026-10-11T17:10:13.345Z
```

| Status | Meaning |
| --- | --- |
| `REGISTERED` | In the catalog, never analyzed. Excluded from the MetaGraph. |
| `READY` | Analyzed, and the checkout is still at the analyzed commit. |
| `STALE` | The checkout moved to another commit, or has uncommitted changes since analysis. The stored graph is still used. |
| `UNAVAILABLE` | The registered path no longer exists. The stored graph is still usable. |
| `FAILED` | The last analysis failed; `note` shows the error. |

`vogoban repos` is a shorter inspection view of the same store (see [graph.md](graph.md)).

## repository

### What it does

Shows one catalog entry in detail: identity, URL, provider, analyzed commit and graph version, local path, detected roles and counts, and every cross-repository connection.

### Usage

```bash
vogoban repository <repo>
```

### Example

```bash
vogoban repository contoso-orders
```

### Output

```text
contoso-orders  [READY]
  id e_9a2cfe3a9823cb05539c79e5  identity local:/home/user/.capy/work/demo/contoso-orders
  url -  provider -  organization -  default branch -
  analyzed ccaffed660b7f947a60737e24447c6ace2a90559 at 2026-10-11T16:57:35.422Z  graph version a021d2d5c8bd74c1d8d6e8bc6b9d5833  semantic true
  path /home/user/.capy/work/demo/contoso-orders  graph scope repository:e_9a2cfe3a9823cb05539c79e5
  roles application  projects=6 applications=4 apis=3 operations=3 messages=1 pipelines=0 images=0 workloads=0 charts=0

Cross-repository connections (5)
  <-[CONSUMES_REPOSITORY_CONTRACT]- contoso-fulfillment  STRUCTURALLY_RESOLVED 0.8 [exact-resource-name, producer-consumer]
  <-[DEPENDS_ON_REPOSITORY]- contoso-fulfillment  STRUCTURALLY_RESOLVED 0.8 [infrastructure-declaration]
  -[USES_EXTERNAL_SYSTEM]-> cosmos-contoso-orders.documents.azure.com  DECLARED 0.9 env=local [configuration-url]
  <-[CONSUMES_REPOSITORY_CONTRACT]- contoso-fulfillment  STRUCTURALLY_RESOLVED 0.6 [namespace-name-version]
  <-[SHARES_CONTRACT_WITH]- contoso-fulfillment  STRUCTURALLY_RESOLVED 0.6 [namespace-name-version]
```

Each connection shows direction, relationship type, the other repository or system, evidence level, confidence (when below 1), environment and the kinds of evidence that produced it.

## metagraph build

### What it does

Builds a new MetaGraph snapshot from the latest graph of every analyzed catalog repository. Resolvers run per category (`package`, `message`, `deployment`, `api`, `external`, `azure`); a category whose inputs did not change is reused (`unchanged`). Repositories that were never analyzed are listed as excluded. The build is one transaction: a failure leaves the previous snapshot in place.

### Usage

```bash
vogoban metagraph build [--force]
```

`--force` recomputes every category even if its inputs are unchanged.

### Example

```bash
vogoban metagraph build
```

### Output

```text
MetaGraph snapshot snap_8e9bc4c6c66ec999c08e1740
  contoso-platform-infra @ 71a45f03cfbd graph 92a4ed4efa8a [READY]
  contoso-orders @ fbe23c1098fd graph 966c82a440a7 [READY]
  contoso-fulfillment @ 1de8ed1b819b graph cc4370444f9d [READY]
category    state       relationships  unresolved  conflicts
----------  ----------  -------------  ----------  ---------
package     recomputed  12             0           0
message     recomputed  9              0           0
deployment  recomputed  0              0           0
api         recomputed  3              1           0
external    recomputed  4              0           0
azure       recomputed  17             0           0
```

Running it again without changes reports every category as `unchanged` and returns the same snapshot id.

### Common mistakes

- Building before `analyze-all`. Unanalyzed repositories are excluded (`<name> excluded [REGISTERED] repository has not been analyzed`).

## metagraph stats

### What it does

Summarises the current MetaGraph: repository count, latest snapshot, relationships by type and evidence, MetaGraph entities (shared contracts, external systems, databases) and unresolved references by category. `vogoban metagraph` with no subcommand runs `stats`.

### Usage

```bash
vogoban metagraph stats
```

### Output

```text
repositories=3 snapshot=snap_126908bc7645dadecd391eda unresolved=0 conflicts=0
relationship                  count
----------------------------  -----
CONSUMED_BY                   2
CONSUMES_MESSAGE              2
CONSUMES_REPOSITORY_CONTRACT  2
CONTAINS                      11
DECLARED_BY                   4
DEPENDS_ON_REPOSITORY         2
PROVIDES_API                  3
PUBLISHES_MESSAGE             1
SHARES_CONTRACT_WITH          1
SHARES_RESOURCE               1
USES_EXTERNAL_SYSTEM          4
USES_SHARED_PACKAGE           12
evidence               count
---------------------  -----
DECLARED               16
EXACT                  3
STRUCTURALLY_RESOLVED  26
meta entity     count
--------------  -----
SharedContract  5
ExternalSystem  2
Database        0
unresolved category  count
-------------------  -----
```

## metagraph snapshots

### What it does

Lists MetaGraph snapshots, newest first, with the repository graph versions each was built from, resolver versions and which categories were recomputed.

### Usage

```bash
vogoban metagraph snapshots
```

### Output

```text
snap_356ec3b8fde438d1753ebc22  2026-10-11T17:10:30.894Z
  contoso-platform-infra @ 71a45f03cfbd graph 92a4ed4efa8a [READY]
  contoso-orders @ fbe23c1098fd graph 966c82a440a7 [READY]
  contoso-fulfillment @ 103417fcbc5d graph 006a3a3071d3 [READY]
  resolvers packages@3 messages@1 deployments@1 apis@1 external-systems@3 azure-resources@3  categories package:recomputed message:recomputed deployment:unchanged api:recomputed external:recomputed azure:recomputed

snap_8e9bc4c6c66ec999c08e1740  2026-10-11T17:10:14.483Z
…
```

`vogoban graph-snapshots --meta` lists the stored MetaGraph graph snapshots used by `diff --meta` (see [diff.md](diff.md)).

## metagraph unresolved

### What it does

Lists cross-repository references that no catalog repository satisfies, with the resolver, category, source and reason.

### Usage

```bash
vogoban metagraph unresolved [--repo R] [--limit N]
```

`--limit` defaults to 200.

### Example

After the `contoso-orders` API moved from `/api/orders` to `/api/v2/orders` while the React client still calls the old route:

```bash
vogoban metagraph unresolved
```

### Output

```text
resolver  category                repository      source                             target            reason
--------  ----------------------  --------------  ---------------------------------  ----------------  ---------------------------------------------------------
api       no-provider-in-catalog  contoso-orders  web/src/api/orders.ts:createOrder  POST /api/orders  no repository in the catalog exposes a matching operation
```

An unresolved reference can also mean the provider lives in a repository you have not registered.

## metagraph conflicts

### What it does

Lists cross-repository conflicts (for example two repositories claiming to provide the same operation or resource) with severity and description.

### Usage

```bash
vogoban metagraph conflicts
```

### Output

```text
No cross-repository conflicts.
```

## metagraph export

### What it does

Writes the catalog, MetaGraph snapshots, MetaGraph entities, relationships, unresolved references and conflicts to a file (`json`, `jsonl`) or a directory of CSV files.

### Usage

```bash
vogoban metagraph export --format json|jsonl|csv --out <path>
```

`--out` is required; `--format` defaults to `json`.

### Example

```bash
vogoban metagraph export --format jsonl --out metagraph.jsonl
```

### Output

```text
Exported MetaGraph jsonl to metagraph.jsonl: repositories=3 snapshots=1 entities=7 relationships=45 unresolved=1 conflicts=0
```

Each JSONL line has a `record` field: `header`, `repository`, `snapshot`, `entity`, `relationship`, `unresolved` or `conflict`:

```json
{"record":"header","graphScope":"meta","schemaVersion":1,"latestSnapshot":"snap_8e9bc4c6c66ec999c08e1740"}
```

`--format csv` writes `catalog.csv`, `snapshots.csv`, `meta-entities.csv`, `meta-relationships.csv`, `meta-unresolved.csv` and `meta-conflicts.csv` into the `--out` directory. Repository graphs are exported with `vogoban export` (see [backup-restore.md](backup-restore.md)).

### Common mistakes

- `vogoban metagraph export` without `--out` exits 2 (`--out is required`).
- Unknown subcommands exit 2: `unknown metagraph subcommand 'frob'`.

## connections

### What it does

Lists cross-repository relationships, optionally for one repository, with evidence level, confidence, environment and evidence kinds.

### Usage

```bash
vogoban connections [repo]
```

### Example

```bash
vogoban connections
```

### Output

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

`contoso-fulfillment` consumes the `orders` Service Bus entity declared by `contoso-orders` (matched by exact resource name, confidence 0.8) and shares the `OrderSubmitted` contract (matched by namespace, name and version, confidence 0.6). The Cosmos DB endpoints are only declared in `local` settings.

## providers (api-providers) and api-consumers

### What it does

`providers` finds the repository, API and implementing endpoint for an API name or `"VERB /path"`. `api-consumers` lists the clients that call it, split into cross-repository and same-repository consumers. `api-providers` is an alias of `providers`.

### Usage

```bash
vogoban providers <api|"VERB /path">
vogoban api-consumers <api|"VERB /path">
```

### Example

```bash
vogoban providers "POST /api/orders"
vogoban api-consumers "POST /api/orders"
```

### Output

```text
ApiOperation Contoso.Orders.Api:POST /api/orders  provided by contoso-orders
  implemented by Contoso.Orders.Api:POST /api/orders src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
```

```text
Subjects: Contoso.Orders.Api:POST /api/orders [contoso-orders]
Cross-repository consumers (0)
Same-repository consumers (1)
  contoso-orders: web/src/api/orders.ts:createOrder -> Contoso.Orders.Api:POST /api/orders  (INFERRED)
```

### Common mistakes

- Quoting: `"POST /api/orders"` must be one argument.
- An empty consumer list is not proof of no consumers; only analyzed repositories are searched.

## message-publishers and message-consumers

### What it does

For a message name, shows the shared contract (if the MetaGraph linked the message across repositories), its member messages, and which repositories publish or consume it. `message-consumers` also lists the handler methods. Messages that could not be linked across repositories are listed separately with the reason.

### Usage

```bash
vogoban message-publishers <message>
vogoban message-consumers <message>
```

### Example

```bash
vogoban message-consumers OrderSubmitted
```

### Output

```text
Shared contract Contoso.Orders.Contracts.OrderSubmitted (namespace+name+version)  members: contoso-fulfillment:Contoso.Orders.Contracts.OrderSubmitted, contoso-orders:Contoso.Orders.Contracts.OrderSubmitted
  consumed by contoso-fulfillment  STRUCTURALLY_RESOLVED 0.6 [consumer, namespace-name-version]
  consumed by contoso-orders  STRUCTURALLY_RESOLVED 0.6 [consumer, namespace-name-version]
    handler contoso-fulfillment:Contoso.Fulfillment.Functions.FulfillmentFunctions.FulfillOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)
    handler contoso-orders:Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)
```

`message-publishers OrderSubmitted` prints the same header with `published by contoso-orders  STRUCTURALLY_RESOLVED 0.6 [namespace-name-version, publisher]`.

The identity tier in parentheses says how the contract was matched (`namespace+name+version` here); a lower tier means a weaker match.

## shared-packages

### What it does

Lists packages used by more than one catalog repository, with versions per repository, classification and the repository that produces the package (if it is built in the catalog).

### Usage

```bash
vogoban shared-packages [--package P] [--limit N]
```

### Output

```text
package                                                 repos  used by (versions)                                   classification                  produced by
------------------------------------------------------  -----  ---------------------------------------------------  ------------------------------  -----------
Azure.Identity                                          2      contoso-fulfillment(1.13.2), contoso-orders(1.13.2)  third-party-runtime-dependency  -
Microsoft.Azure.Cosmos                                  2      contoso-orders(3.46.0), contoso-fulfillment(3.46.0)  third-party-runtime-dependency  -
…
Newtonsoft.Json                                         2      contoso-fulfillment(13.0.3), contoso-orders(13.0.3)  third-party-runtime-dependency  -
```

Different versions of one package across repositories show up as different values in `used by (versions)`.

## external-systems

### What it does

Lists external systems and databases referenced by catalog repositories, with the repositories that use them, the environments where they are declared, and the number of evidence facts.

### Usage

```bash
vogoban external-systems [filter]
```

### Output

```text
kind            system                                          system kind  repositories         environments  evidence facts
--------------  ----------------------------------------------  -----------  -------------------  ------------  --------------
ExternalSystem  cosmos-contoso-fulfillment.documents.azure.com  api          contoso-fulfillment  local         1
ExternalSystem  cosmos-contoso-orders.documents.azure.com       api          contoso-orders       local         1
```

## metagraph-topology

### What it does

Walks repository-level MetaGraph relationships from one repository and prints the reachable repositories as a tree, plus the external systems it uses. Each line states the stored fact in plain words, from the direction it was stored, followed by the relationship type, evidence, confidence and evidence kinds.

"Downstream" follows: from a contract provider to the repositories that consume its contracts (`CONSUMES_REPOSITORY_CONTRACT`, reversed), from a repository to the repositories it depends on, calls or deploys (`DEPENDS_ON_REPOSITORY`, `CALLS_REPOSITORY`, `DEPLOYS_REPOSITORY`), and to repositories that share a contract (`SHARES_CONTRACT_WITH`, whichever side stored it). `--reverse` walks the opposite way and skips shared contracts, because sharing a contract does not make either repository the other's upstream.

### Usage

```bash
vogoban metagraph-topology <repo> [--reverse] [--depth N] [--env E]
```

`--depth` defaults to 3.

### Example

```bash
vogoban metagraph-topology orders-service
vogoban metagraph-topology enterprise-contracts --reverse --depth 1
```

### Output

From the bundled enterprise landscape:

```text
orders-service (downstream)
  notification-service consumes contracts published by orders-service (CONSUMES_REPOSITORY_CONTRACT)  STRUCTURALLY_RESOLVED 0.8 [exact-resource-name, producer-consumer]
  orders-service depends on infrastructure (DEPENDS_ON_REPOSITORY)  STRUCTURALLY_RESOLVED 0.8 [infrastructure-declaration]
  order-processing consumes contracts published by orders-service (CONSUMES_REPOSITORY_CONTRACT)  COMPILER_RESOLVED 0.95 [compiled-contract-identity]
  external vg-enterprise-kv.vault.azure.net (USES_EXTERNAL_SYSTEM)  DECLARED 0.9 [configuration-url]
```

```text
enterprise-contracts (upstream)
  notification-service depends on enterprise-contracts (DEPENDS_ON_REPOSITORY)  DECLARED 0.95 [project-reference-path]
  admin-portal depends on enterprise-contracts (DEPENDS_ON_REPOSITORY)  DECLARED 0.95 [file-dependency-path]
  …
```

### Common mistakes

- Reading "downstream" as "data flows there" for every hop. The walk mixes message flow (provider to consumer) and dependency (dependent to dependency); the sentence on each line says which one the hop is.

## Related

- [MetaGraph feature guide](../features/metagraph.md)
- [MetaGraph architecture](../architecture/metagraph.md)
- [impact.md](impact.md#repository-impact) for `repository-impact`
- [sync.md](sync.md) for `graph sync --meta`
