# RepositoryGraph

The RepositoryGraph is the stored result of analyzing one repository: entities, relationships, unresolved references,
diagnostics and conflicts, each with deterministic identity and provenance. It is the authoritative record of
everything Vogoban knows about that repository. This page describes the model (`src/graph/model.ts`), how it is built
(`src/graph/builder.ts`, `src/graph/identity.ts`) and how it is stored (`src/store/store.ts`, `src/store/sqlite.ts`).

## Why it is authoritative

A repository-local fact (a method, a call, an endpoint, a Bicep resource, a Function trigger) is derived from that
repository's files at one commit, and only there. The RepositoryGraph is the only place such facts are written:

- Analysis of a repository writes only rows whose `repository_id` is that repository (plus shared external entities
  such as NuGet packages, which have `repository_id = NULL`).
- The MetaGraph reads repository facts and writes to separate `meta_*` tables; it never changes a repository row
  (see [metagraph.md](metagraph.md)).
- Query, impact, governance, AI and platform layers read the store; the AI layer reads it through a wrapper that throws on
  any write method (`readOnlyStore` in `src/ai/access.ts`).

So a repository fact always has exactly one origin, one commit and one analysis run, and can be re-derived by analyzing
that commit again.

## Model at a glance

| Record | Type in `src/graph/model.ts` | Id prefix | Stored in |
|---|---|---|---|
| Entity | `Entity` | `e_` | `entities` |
| Relationship | `Relationship` | `r_` | `relationships` |
| Unresolved reference | `UnresolvedReference` | `u_` | `unresolved` |
| Diagnostic | `Diagnostic` | `d_` | `diagnostics` |
| Conflict | `Conflict` | `c_` | `conflicts` |
| Analysis run | `AnalysisRun` | `run_` | `runs` |
| Graph snapshot | `GraphSnapshotRecord` | `gs_` | `graph_snapshots` |

All ids are `stableId(prefix, key)` = `prefix + "_" + sha256(key)[0..24]` (`src/graph/identity.ts`). Ids are therefore
a pure function of their key; running the same analysis twice produces the same ids.

## Entities

An entity has:

| Field | Meaning |
|---|---|
| `id`, `key` | Stable id and the semantic key it is derived from (see [identity.md](identity.md)) |
| `kind` | One of the 64 `ENTITY_KINDS` (`Repository`, `Project`, `Type`, `Method`, `Endpoint`, `ApiOperation`, `Message`, `FrontendRoute`, `AzureFunction`, `AzureResource`, ...) |
| `layer` | One of `GRAPH_LAYERS`: `source`, `semantic`, `application`, `repository`, `contract`, `infrastructure`, `meta` |
| `name`, `qualifiedName` | Display name and fully qualified name |
| `repositoryId`, `projectId`, `assembly`, `language` | Ownership; `repositoryId` is `null` for external entities shared across repositories |
| `symbolKey` | Compiler-level symbol key for code symbols (for .NET `<assembly>::<documentation id>`) |
| `location` | `SourceLocation` (`file`, `startLine`, `startColumn`, optional end) |
| `external` | `true` for entities that are referenced but not declared in the repository (NuGet types, npm packages) |
| `metadata` | Kind-specific key/value data (`Metadata`) |
| `provenance` | Up to 50 `Provenance` records (see below) |

`GraphBuilder.entity()` merges drafts with the same key: provenance is appended (deduplicated by plugin, extractor,
mechanism and location), metadata is merged with existing values winning, and a declared (non-external) or located
draft replaces an external or unlocated one. A real entity from the demo store:

```bash
vogoban show e_59b9c5fef4e9584104bbaee6 --json
```

```text
{
 "id": "e_59b9c5fef4e9584104bbaee6",
 "key": "transport|e_9a2cfe3a9823cb05539c79e5|azure-service-bus|queue-or-topic|sb-contoso-orders/orders",
 "kind": "Queue",
 "layer": "contract",
 "name": "sb-contoso-orders/orders",
 "qualifiedName": "azure-service-bus:service-bus-entity:sb-contoso-orders/orders",
 "repositoryId": "e_9a2cfe3a9823cb05539c79e5",
 …
 "external": false,
 "provenance": [
  {
   "repositoryId": "e_9a2cfe3a9823cb05539c79e5",
   "commit": "ccaffed660b7f947a60737e24447c6ace2a90559",
   "location": { "file": "src/Contoso.Orders.Functions/OrderFunctions.cs", "startLine": 18, "startColumn": 31 },
   "plugin": "azure.resolver",
   "extractor": "FUNCTION_BINDING",
   "resolver": "azure.resolver",
   "mechanism": "azure-resource-resolution",
   "analysisVersion": "0.1.0/1+323b31cc3e63"
  },
  …
```

Ids in your store differ: they are derived from the repository identity (here a `local:` path).

## Relationships

A relationship has `id`, `type`, `sourceId`, `targetId`, `repositoryId`, `evidence`, `confidence` (0..1),
`metadata` and `provenance`. Its id is `stableId("r", "<type>|<sourceId>|<targetId>")`, so there is at most one
relationship of a given type between two entities. When several facts produce the same relationship,
`GraphBuilder.relate()` keeps one row, appends provenance, counts `metadata.occurrences`, and upgrades the evidence to
the strongest level seen (lower index in `EVIDENCE_LEVELS`), taking the stronger draft's metadata and confidence.

Relationship types are grouped in `RELATIONSHIP_TYPES` (`src/graph/model.ts`):

| Group | Examples |
|---|---|
| `code` | `CONTAINS`, `DECLARES`, `CALLS`, `CONSTRUCTS`, `IMPLEMENTS`, `INHERITS`, `OVERRIDES`, `USES_TYPE`, `READS_FIELD`, `ATTRIBUTED_WITH` |
| `projects` | `PROJECT_REFERENCES`, `PACKAGE_DEPENDS_ON`, `PROJECT_CONTAINS`, `DEFINES_ASSEMBLY`, `DEFINES_APPLICATION` |
| `application` | `IMPLEMENTED_BY`, `REGISTERS`, `RESOLVES_TO`, `USES_MIDDLEWARE`, `REQUIRES_AUTHORIZATION`, `ALLOWS_ANONYMOUS` |
| `api` | `EXPOSES_ENDPOINT`, `ROUTES_TO`, `CALLS_ENDPOINT`, `ACCEPTS_REQUEST`, `CALLS_EXTERNAL_API` |
| `dependencyInjection` | `REGISTERS_SERVICE`, `INJECTS` |
| `messaging` | `PUBLISHES`, `CONSUMES`, `HANDLES_MESSAGE`, `SENDS_TO`, `RECEIVES_FROM`, `CARRIES`, `CONSUMED_BY`, `HANDLED_BY` |
| `data` | `READS_FROM`, `WRITES_TO`, `CONNECTS_TO`, `USES_DATABASE`, `USES_STORAGE` |
| `infrastructure` | `DEPLOYED_AS`, `RUNS_IN`, `CONTAINS_RESOURCE`, `REFERENCES_CONFIG`, `USES_SECRET`, `RUNS_IMAGE`, `SUPPLIES_CONFIG` |
| `pipelines` | `BUILDS`, `PACKAGES`, `PRODUCES_ARTIFACT`, `DEPLOYS`, `TRIGGERS`, `DEPENDS_ON_STAGE` |
| `metagraph` | `PROVIDES_API`, `CONSUMES_API`, `PUBLISHES_MESSAGE`, `CONSUMES_MESSAGE`, `USES_SHARED_PACKAGE`, ... |
| `enterprise` | `OWNS_REPOSITORY`, `OWNS_SERVICE`, `EXPOSES_PUBLIC_ENDPOINT`, `CROSSES_TRUST_BOUNDARY`, ... |
| `frontend` | `IMPORTS`, `DYNAMIC_IMPORTS`, `RENDERS`, `USES_HOOK`, `EXPOSES_ROUTE`, `ROUTES_TO_COMPONENT`, `GUARDED_BY`, `LOADS_COMPONENT` |
| `azure` | `PUBLISHES_TO`, `SUBSCRIBES_TO`, `CHANGE_FEED`, `HAS_ROLE_ON`, `CREATES`, `DECLARED_BY`, `HOSTED_ON`, `SHARES_RESOURCE`, ... |
| `repositories` | `DEPENDS_ON_REPOSITORY`, `CALLS_REPOSITORY`, `CONSUMES_REPOSITORY_CONTRACT`, `SHARES_CONTRACT_WITH` |

Each type has an impact propagation rule in `src/analysis/semantics.ts`, which decides how a change travels along it
in `impact`, `paths` and `blast-radius`.

## Evidence levels

`EVIDENCE_LEVELS` in `src/graph/model.ts`, strongest first:

| Level | Meaning |
|---|---|
| `EXACT` | The fact is the structure itself (a file in a repository, an implemented endpoint) |
| `COMPILER_RESOLVED` | A compiler (Roslyn or the TypeScript compiler) bound the symbol |
| `DECLARED` | Explicitly declared in a manifest, project file, attribute, IaC or configuration |
| `STRUCTURALLY_RESOLVED` | Derived by matching structure (same symbolic IaC expression, method and route, account-qualified name) |
| `INFERRED` | Derived from a single unambiguous candidate (for example one route match for a frontend call) |
| `HEURISTIC` | Pattern-based; defined in the model, not emitted by 0.18.0 analyzers |
| `UNKNOWN` | Evidence cannot be classified; defined in the model, not emitted by 0.18.0 analyzers |

The read-side engines treat `EXACT`, `COMPILER_RESOLVED`, `DECLARED` and `STRUCTURALLY_RESOLVED` with confidence ≥ 0.7
as confirmed (`isConfirmed` in `src/analysis/graph.ts`); everything else is reported as potential or inferred.

When and how each level is assigned is described in [evidence-provenance.md](evidence-provenance.md). The demo store's
distribution, from `vogoban stats`:

```text
Evidence
level                  count
---------------------  -----
COMPILER_RESOLVED      675
DECLARED               140
EXACT                  272
INFERRED               5
STRUCTURALLY_RESOLVED  59
```

## Provenance

`Provenance` records where a fact came from:

| Field | Meaning |
|---|---|
| `repositoryId`, `commit` | Repository and commit analyzed |
| `location` | Source location of the fact, or `null` |
| `plugin` | Plugin id (for example `dotnet.roslyn`, `azure.resolver`, `vogoban.core`) |
| `extractor` | The rule inside the plugin (`declaration`, `FUNCTION_BINDING`, `RESOURCE_DECLARATION`, ...) |
| `resolver` | The resolver plugin when the fact was linked by a resolver, else `null` |
| `mechanism` | How it was derived (`roslyn-semantic-model`, `bicep-static`, `filesystem`, `git`, ...) |
| `analysisVersion` | `<ANALYZER_VERSION>/<plugin version>` |

In addition, the store keeps `first_seen_commit`, `last_seen_commit`, `first_seen_run` and `last_seen_run` per entity and
relationship (`vogoban provenance <id>` prints them). See [evidence-provenance.md](evidence-provenance.md).

## Unresolved references

When an analyzer sees a reference it cannot bind to exactly one target, it records an `UnresolvedReference` instead of
a relationship: `type` (the relationship that would have existed), `sourceId`, `targetDisplay`, `resolver`, `reason`,
`confidence` (0 by default), `metadata` and `provenance`. The id is `stableId("u", "<type>|<sourceId>|<targetDisplay>")`.
`finalize()` drops unresolved references whose source entity was not produced.

The category lives in `metadata.category`; `vogoban stats` groups by it (`uncategorized` when absent). Categories are
analyzer-specific. Examples from the code:

| Area | Categories |
|---|---|
| .NET semantics (`unresolvedCategory` in `src/dotnet/semantic-graph.ts`) | `conditional-compilation`, `dependent-on-unresolved-type`, `generated-dependency-unavailable`, `missing-package`, `missing-assembly`, `unknown-symbol`, `overload-resolution`, `inaccessible`, `compilation-failure`, `analyzer-limitation` |
| Frameworks and messaging | `dynamic-transport-name`, `dynamic-message-type`, `dynamic-registration`, `dynamic-configuration-key`, `unresolved-handler`, `unregistered-hosted-service`, `conventional-route-unknown`, `dynamic-route` |
| Contracts | `dynamic-url`, `no-matching-operation`, `unimplemented-operation`, `unresolved-ref`, `external-ref` |
| Frontend | `unresolved-module`, `dynamic-lazy-route`, `unresolved-guard` |
| Azure | `unresolved-azure-account`, `ambiguous-azure-resource`, `unresolved-azure-client`, `dynamic-function-name`, `dynamic-durable-name`, `unknown-trigger`, `hosting-unresolved`, `event-source-unresolved`, `apim-operation-unmatched`, `aspire-reference-unresolved` |
| Infrastructure | `image-parameterized`, `dockerfile-unresolved`, `selector-unmatched`, `configmap-unresolved`, `ingress-backend-unresolved`, `pipeline-template-unresolved`, `deployment-target-unresolved` |

A real one from the demo:

```bash
vogoban unresolved --json
```

```text
[
  {
    "id": "u_cb505ae3c2c63384aee6ed67",
    "type": "SENDS_TO",
    "sourceId": "e_4d81acc47db3e34477346b29",
    "repositoryId": "e_9a2cfe3a9823cb05539c79e5",
    "targetDisplay": "SendMessageAsync (sender entity)",
    "resolver": "dotnet.messaging.azure-service-bus",
    "reason": "sender is not created by a visible CreateSender call",
    "confidence": 0,
    "metadata": { "category": "dynamic-transport-name", "framework": "azure-service-bus" },
    …
```

Here the messaging plugin could not see a `CreateSender` call for the injected `ServiceBusSender`, so it did not guess a
topic. (The Azure SDK analyzer independently resolved the same call to topic `sb-contoso-orders/orders` through the
DI registration; both facts are kept.)

## Diagnostics

A `Diagnostic` reports a problem with analysis itself: `category` (`repository`, `discovery`, `project`, `parser`,
`compilation`, `semantic`, `framework`, `resolver`, `storage`), `plugin`, `file`, `severity` (`info`, `warning`,
`error`), `recoverable`, `code` and `message`. The id is `stableId("d", repo|plugin|file|code|message)`, so a repeated
problem is one row.

Common codes: `file-skipped` (discovery: symlink, submodule, size limit, build output), `config-invalid` (bad
`vogoban.json`), `syntax-error` and `parse-failed` (language plugins), `semantic-unavailable` (no .NET SDK, Roslyn falls
back to syntax), `source-rejected` and `FILE_SKIPPED_RESOURCE_LIMIT` (Roslyn file admission), `plugin-failed` (a plugin
threw; the graph is still published), `dangling-relationship` (`finalize()` removed a relationship whose endpoint was
not produced), `iac-syntax-error`.

Diagnostics are visible as counts in `vogoban stats` (Diagnostics table) and in `--json` of `stats` and `analyze`, and
individually in `vogoban export` output (the `diagnostics` array in `json`, `{"record":"diagnostic",...}` lines in
`jsonl`). `vogoban diagnostics` is an alias of `privacy` in 0.18.0 and does not list analysis diagnostics.

## Conflicts

A `Conflict` records that two or more facts disagree about the same subject: `kind`, `subject`, `factIds`, `severity`,
`status` (`unresolved`, `resolved`, `accepted`), `description` and `provenance`. The id is
`stableId("c", "<kind>|<subject>")`. Repository-level kinds include `multiple-service-registrations` (DI),
`duplicate-endpoint-route` (ASP.NET Core), `conflicting-api-operation` and `conflicting-api-schema` (OpenAPI),
`conflicting-message-schema`, `conflicting-ingress-route`, `conflicting-infrastructure-declaration` and
`conflicting-image-tag`. Vogoban reports conflicts; it never picks a winner silently.

## Graph version and snapshots

After the plugins run, `analyzeDiscovered` (`src/pipeline/analyze.ts`) computes the **graph version**: the first 32
hex characters of SHA-256 over the schema version, analyzer version and plugin versions, then every entity id with its
metadata, every relationship id with evidence and metadata, every unresolved id and every conflict id, in id order.
Equal content gives an equal graph version, which is what the full ≡ incremental check compares
([incremental-engine.md](incremental-engine.md#full--incremental)).

In the same transaction the catalog entry is set to `READY` with that graph version and a **graph snapshot** is
captured (`captureRepositorySnapshot` in `src/analysis/diff.ts`): a compact payload of entity and relationship tuples,
id `gs_` + hash of repository and graph version. Snapshots drive `diff`, `governance --at`, `ownership-history` and the
sync metrics.

```bash
vogoban graph-snapshots
```

```text
snapshot                     scope       repository      commit        graph version             created                   entities  relationships
---------------------------  ----------  --------------  ------------  ------------------------  ------------------------  --------  -------------
gs_6051b800aa8a89df548b7514  repository  contoso-orders  ccaffed660b7  a021d2d5c8bd74c1d8d6e8bc  2026-10-11T16:54:46.535Z  553       1151
```

`GRAPH_SCHEMA_VERSION` is `1`. `SqliteGraphStore` refuses to open a store written with a different schema version.

## GraphStore and the SQLite schema

`GraphStore` (`src/store/store.ts`) is a synchronous interface: `saveRepositoryGraph`, `transaction` (nested calls
become savepoints), entity, relationship, unresolved, diagnostic and conflict queries with keyset pagination, catalog
methods, MetaGraph methods (`replaceMetaCategory`, `saveMetaSnapshot`, ...), graph snapshots, baselines, the fact cache
(`getCachedFacts` / `putCachedFacts`) and `backup`. `SqliteGraphStore` (`src/store/sqlite.ts`, `bun:sqlite`) is the only
implementation. It opens the database with `busy_timeout = 60000`, `journal_mode = WAL` and `synchronous = NORMAL`.

| Table | Contents |
|---|---|
| `meta` | `schema_version`, `fact_cache_generation` |
| `repositories` | One row per analyzed repository (root path, remote, branch, commit, dirty) |
| `runs` | Analysis runs with schema/analyzer/plugin versions and stats |
| `files` | Admitted files with hash, size, category, language |
| `entities` | Entities with location columns, JSON `metadata` and `provenance`, first/last seen commit and run |
| `relationships` | Relationships with JSON `metadata` and `provenance`, `file` (first provenance location), first/last seen |
| `unresolved`, `diagnostics`, `conflicts` | Per-repository records |
| `catalog` | MetaGraph catalog entry per repository, unique on `identity` |
| `meta_inputs`, `meta_snapshots`, `meta_entities`, `meta_relationships`, `meta_unresolved`, `meta_conflicts` | MetaGraph state |
| `graph_snapshots` | Snapshot records with a payload blob |
| `governance_baselines` | Named baselines; also sync history and the build-evaluation mode per repository |
| `fact_cache` | `scope` (primary key), `cache_key`, `payload` |

`saveRepositoryGraph` reconciles in one transaction: upsert the repository and insert the run, replace the `files`
rows, upsert every entity and relationship (keeping `first_seen_*`, updating `last_seen_*`), delete the repository's
entities and relationships whose `last_seen_run` is not this run, delete external entities (`repository_id IS NULL`)
that no relationship references, and replace the repository's unresolved references, diagnostics and conflicts.

## Limitations

- One relationship per (type, source, target): two different call sites of the same callee are one `CALLS` edge with
  several provenance records and an `occurrences` count, not two edges. At most 50 provenance records are kept.
- A rename or move produces a new identity; history does not follow it (see [identity.md](identity.md#renames-and-moves)).
- `HEURISTIC` and `UNKNOWN` exist in the model and are understood by the readers (traversal marks `INFERRED` and
  `HEURISTIC` hops with `?`), but no 0.18.0 analyzer emits them for stored relationships; where a resolver cannot prove a
  link it records an unresolved reference instead.

## Related

- [Identity](identity.md)
- [Evidence and provenance](evidence-provenance.md)
- [Analysis pipeline](analysis-pipeline.md)
- [Graph commands](../cli/graph.md)
