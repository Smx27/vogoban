# Diff and snapshot commands

Every analysis and every successful `graph sync` stores a **graph snapshot**: the full entity and relationship set of one repository at one commit. `diff` compares two snapshots and reports added, removed and changed entities and relationships plus the architecture changes they mean (a route changed, an API consumer disappeared, a message gained a publisher). `graph-snapshots` lists and prunes snapshots, and `risk --diff` scores the changed entities.

Snapshots compare what the analyzer extracted at two commits. A diff describes structural change in the graph, not observed runtime behaviour.

The examples use a scratch copy of the `contoso-orders` demo. The route in `src/Contoso.Orders.Api/Controllers/OrdersController.cs` was changed and committed, then the graph was synchronized:

```csharp
[ApiController]
[Route("api/v2/orders")]   // was: [Route("api/orders")]
[Authorize]
public sealed class OrdersController(IOrderService orders) : ControllerBase
```

```bash
git commit -am "Move orders API to /api/v2/orders"
vogoban graph sync
```

`graph sync` ends with the exact diff command to run (`diff: vogoban diff --from gs_… --to gs_…`). See [sync.md](sync.md) for the sync output.

## diff (and graph diff)

### What it does

Compares two snapshots of one repository, or two MetaGraph snapshots with `--meta`. Without `--from`/`--to` it compares the latest two. `vogoban graph diff` is the same command.

### Usage

```bash
vogoban diff [--repo R | --meta] [--from S --to S] [--limit N] [--out F --format json|jsonl|csv]
vogoban graph diff [same options]
```

`--from` and `--to` accept a snapshot id (`gs_…`), a commit (prefix) or a graph version (prefix).

### Example

```bash
vogoban diff
```

### Output

```text
repository diff gs_cde2ce457ff69559062d15ba (ccaffed660b7) -> gs_217c92a3ca9107dc26178aa8 (0cae16393195)  repository contoso-orders
entities: +2 -2 ~2   relationships: +9 -11 ~0
category    added  removed  changed
----------  -----  -------  -------
API         1      1        0
CODE        0      0        1
REPOSITORY  0      0        1
SERVICE     1      1        0

Architecture changes (5)
  [API] API_CONSUMER_REMOVED: removed CALLS_ENDPOINT web/src/api/orders.ts:createOrder -> Contoso.Orders.Api:POST /api/orders
  [API] API_OPERATION_ADDED: new ApiOperation Contoso.Orders.Api v2.0:POST /api/v2/orders
  [API] API_OPERATION_REMOVED (potentially breaking): ApiOperation Contoso.Orders.Api:POST /api/orders no longer exists
  [API] API_ROUTE_CHANGED (potentially breaking): Contoso.Orders.Api:POST /api/orders became Contoso.Orders.Api v2.0:POST /api/v2/orders (same handler)
  [API] API_VERSION_CHANGED (potentially breaking): Contoso.Orders.Api:POST /api/orders became Contoso.Orders.Api v2.0:POST /api/v2/orders (same handler)
```

How to read it:

- The header names both snapshots and their commits.
- `entities: +2 -2 ~2` counts added, removed and changed entities. The operation and endpoint were replaced (new identity, because the route is part of it); the controller file and the repository entity changed (`changedKeys` in JSON says which fields).
- The category table groups entity changes.
- **Architecture changes** interpret the raw changes. `API_ROUTE_CHANGED` is detected because the new operation has the same handler. `API_CONSUMER_REMOVED` shows that the React client still calls `/api/orders`, which no longer matches any operation: the frontend is now broken.

`--json` returns `old`, `new` (snapshot id, commit, graph version, counts), `graphScope`, `repositoryId`, `entities.added|removed|changed`, `relationships.added|removed|changed`, `byCategory` and `architecture`. Each architecture change has `kind`, `category`, `change` (`added`, `removed`, `changed`), `subject`, `description`, `breakingPotential` and `evidence` (relationship or entity ids):

```json
{"kind":"API_CONSUMER_REMOVED","category":"API","change":"removed","subject":"web/src/api/orders.ts:createOrder -> Contoso.Orders.Api:POST /api/orders","description":"removed CALLS_ENDPOINT web/src/api/orders.ts:createOrder -> Contoso.Orders.Api:POST /api/orders","breakingPotential":false,"evidence":["r_5d253be31b255a9d6009c0f4"]}
```

Comparing explicit commits:

```bash
vogoban diff --from ccaffed --to 0cae163 --limit 0
```

With `--limit 0` only the counts and category table are printed (`Architecture changes (5, showing 0; --limit N for more)`).

MetaGraph diff in a multi-repository store:

```bash
vogoban diff --meta
```

```text
meta diff gs_f16c604ff47644f70ed2d4b4 (snap_8e9bc4c) -> gs_c7eca405e2b0375c010ed1dd (snap_356ec3b)
entities: +0 -0 ~1   relationships: +0 -0 ~0
category    added  removed  changed
----------  -----  -------  -------
REPOSITORY  0      0        1

Architecture changes (0)
```

### Useful options

- `--repo R` is required when the store holds several repositories.
- `--limit N` controls how many architecture changes are printed (default 40).
- `--out F --format csv` writes one row per change (`change,kind,subject,category,…`).

### Common mistakes

- Running `diff` in a store with several repositories and no `--repo`: `diff needs --repo when the store holds several repositories` (exit 2).
- Running it before there are two snapshots: `need two repository snapshots for contoso-platform-infra (found 1); analyze another commit or pass --from/--to` (exit 2).
- Passing the same snapshot twice (for example two commit prefixes that resolve to one snapshot): `--from and --to resolve to the same snapshot` (exit 2).
- Expecting the working tree to be compared. `diff` compares stored snapshots; run `graph sync` first.

## graph-snapshots

### What it does

Lists stored repository snapshots (or MetaGraph snapshots with `--meta`), oldest first. `--prune` deletes repository snapshots that were superseded by a newer analysis of the same commit.

### Usage

```bash
vogoban graph-snapshots [--repo R | --meta]
vogoban graph-snapshots --prune [--repo R]
```

### Example

```bash
vogoban graph-snapshots
```

### Output

```text
snapshot                     scope       repository      commit        graph version             created                   entities  relationships
---------------------------  ----------  --------------  ------------  ------------------------  ------------------------  --------  -------------
gs_cde2ce457ff69559062d15ba  repository  contoso-orders  ccaffed660b7  52302929f3b5444b45172d86  2026-10-11T17:04:35.253Z  553       1151
gs_217c92a3ca9107dc26178aa8  repository  contoso-orders  0cae16393195  13f471b55659f49f9465d0b8  2026-10-11T17:04:45.373Z  553       1149
gs_8dc19bb6ecb81428373083f1  repository  contoso-orders  0cae16393195  4c1292c4b254a63757f88f2c  2026-10-11T17:05:11.787Z  524       1104
```

The third snapshot is the same commit analyzed again in CI mode (build evaluation disabled), which produced a smaller graph. Two snapshots of one commit can exist whenever the analysis model differs.

```bash
vogoban graph-snapshots --prune
```

```text
Pruned 1 repository snapshots superseded by a newer analysis of the same commit: contoso-orders@0cae16393195 gs_217c92a3ca9107dc26178aa8
```

For each repository and commit, `--prune` keeps the snapshot with the latest `created` time and deletes the others. MetaGraph snapshots and snapshots without a commit are never pruned.

### Useful options

- `--repo R` limits listing or pruning to one repository.
- `--json` returns the snapshot records (or, with `--prune`, the deleted ones).

### Common mistakes

- Assuming `created` is the time of the latest analysis. A snapshot id is derived from its content, so re-publishing an identical graph (for example a later `graph sync --full` that returns to the same graph version) reuses the old snapshot row and keeps its original `created` time. `--prune` can then delete the snapshot that matches the current graph and keep an older, different one. In the example above, the current graph version was `13f471b5…` but `--prune` removed `gs_217c…`. Check `vogoban repositories` (graph version column) before pruning; a later `graph sync --full` recreates the snapshot. This is a known defect in 0.18.0.
- Expecting `--prune` to remove old commits. It only removes duplicates of the same commit; history across commits is kept.

## risk --diff

### What it does

Uses every entity added or changed between two snapshots, plus the dependents of removed entities, as seeds for a change-risk score. The architecture changes from the diff feed the breaking-change factors. Score factors are described in [impact.md](impact.md#risk).

### Usage

```bash
vogoban risk --diff [--repo R | --meta] [--from S --to S] [--limit N]
```

### Example

```bash
vogoban risk --diff --limit 3
```

### Output

```text
Changes from diff gs_cde2ce457ff69559062d15ba -> gs_217c92a3ca9107dc26178aa8: 5 architecture changes (3 potentially breaking), 7 changed entities used as seeds
impact of ApiOperation Contoso.Orders.Api v2.0:POST /api/v2/orders, Endpoint Contoso.Orders.Api:POST /api/v2/orders, AzureResource Microsoft.ApiManagement/service/apis/operations:apim-contoso-orders/orders/create-order, Method web/src/api/orders.ts:c…
  16 entities  levels: DIRECT=7 INDIRECT=3 POTENTIAL=5 TRANSITIVE=1  categories: CODE=8 INFRASTRUCTURE=3 PROJECT=2 REPOSITORY=1 SERVICE=2
  repositories: contoso-orders(16)  unresolved at boundary: 2  conflicts: 0
  graph: contoso-orders@0cae1639/13f471b5 READY
…
Change risk: 57.6 (HIGH) - deterministic structural engineering risk; not a probability of production failure
factor                       value  points  explanation
---------------------------  -----  ------  --------------------------------------------------------------------------------
…
contract-change              7      10/10   changed entities that are API, message or contract boundaries
breaking-change-kinds        3      10/15   change kinds that can break consumers (removed/renamed operations, changed metho
…
```

The seeds include the API Management operation that routes to the endpoint and the React client method, because both are connected to changed entities.

### Useful options

`--from`/`--to`/`--repo`/`--meta` as for `diff`, plus the impact options (`--depth`, `--scope`, `--out`).

### Common mistakes

- Passing entity references together with `--diff`. With `--diff` the seeds come from the snapshots and positional arguments are ignored.

## Snapshot comparisons on other pages

Three commands compare snapshots for a specific concern and are documented with their families:

- `governance-diff`: new, resolved and unchanged rule violations between two snapshots. See [governance.md](governance.md#governance-diff).
- `security-diff`: security posture indicators and findings between two snapshots. See [security.md](security.md#security-diff-and-ownership-diff).
- `ownership-diff`: ownership changes between two snapshots. See [security.md](security.md#security-diff-and-ownership-diff).

## Related

- [sync.md](sync.md): how snapshots are produced incrementally
- [impact.md](impact.md): impact and risk scoring
- [Incremental analysis](../features/incremental-analysis.md)
