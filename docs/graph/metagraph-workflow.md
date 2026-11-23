# Build and inspect a multi-repository MetaGraph

Repository-local analysis and MetaGraph federation are separate steps. Analyzing a parent folder once does not create independent RepositoryGraphs for its child repositories. Running `analyze-all` analyzes catalog entries but does not build the MetaGraph.

Use this workflow for independently analyzable repositories. For the full command reference, see [MetaGraph commands](../cli/metagraph.md); for the viewer, see [local graph visualization](visualization.md).

## Choose one explicit shared store

The default remains `<repository>/.vogoban/graph.db`. Federation is opt-in: pass the same `--db` to registration, analysis, MetaGraph builds, queries and the viewer. `metagraph build` does not search for or import separate repository-local databases.

From the folder containing the repositories, choose an absolute database path:

```bash
DB="$PWD/.vogoban/landscape-metagraph.db"
```

Keep this variable in the same shell for the following commands. Alternatively, set `VOGOBAN_DB` to that absolute path. An explicit `--db` takes precedence over the environment variable.

The examples assume `vogoban` is installed. From an extracted source distribution, first run `bun install --frozen-lockfile` in the source directory, then substitute `bun /absolute/path/to/v/src/cli/main.ts` for `vogoban` when working in another directory. See [installation](../installation.md).

## Discover repositories automatically

`vogoban discover <dir>` finds the repositories under a folder, registers them, analyzes the new or changed ones and rebuilds the MetaGraph in one command:

```bash
cp -r example/vogoban-enterprise-landscape ~/landscape   # the bundled sample, copied out of the Vogoban checkout
cd ~/landscape
vogoban discover . --db "$DB" --dry-run                  # list what would be registered
vogoban discover . --db "$DB" --trust-repository
```

A folder is a repository when it contains `.git`, `vogoban.json` or `catalog-info.yaml`. The walk does not descend into a repository it found, skips `node_modules`, `bin`, `obj`, `dist`, `target`, `vendor` and dot-folders, and stops at `--depth` (default 4). Running it again analyzes only Git checkouts whose commit or working tree changed (folders without Git are always reanalyzed) and lists catalog entries whose folder has disappeared as stale. `--no-analyze` only registers, `--no-build` skips the MetaGraph build, and `--force` reanalyzes everything.

A folder with only a `catalog-info.yaml` inside another Git repository is reported as `SKIPPED`: Vogoban identifies a repository by its Git root, so such a folder would be analyzed as the enclosing repository. That is why the bundled sample is copied out of the Vogoban checkout first. When a .NET project was analyzed without restored packages, the result line says so; run `dotnet restore` for that repository and run `discover` again.

The manual steps below do the same thing one command at a time.

## Register and analyze each repository

For the bundled `example/vogoban-enterprise-landscape` sample (copied out of the Vogoban checkout as above), run this from its root:

```bash
for repo in \
  enterprise-contracts platform-gateway orders-service customer-service \
  notification-service order-processing reporting-platform admin-portal \
  customer-portal operations-portal infrastructure
do
  vogoban register "./$repo" --db "$DB" || break
done

vogoban repositories --db "$DB" --json
```

Check that the catalog contains eleven distinct repositories before continuing. Register the sibling repositories, not just the landscape parent. Registration discovers Git roots; a subdirectory of one Git repository is not automatically a separate repository. For other systems, replace the sample names with their actual repository roots.

For code you trust, restore any .NET projects whose package compile references are needed, following that repository's build instructions. Vogoban reads restored assets; restoration is not a universal prerequisite for every language or analyzer. MSBuild evaluation is a trusted-project boundary. For untrusted input, use `analyze-all --untrusted --db "$DB"` to disable MSBuild evaluation, and do not restore or build that input merely to get a graph. See [trust modes](../advanced/trust-modes.md).

For a trusted .NET repository with sibling `ProjectReference` dependencies, build the referenced projects first in Debug configuration if their compiled outputs are not available. Vogoban evaluates their project metadata to locate existing compatible outputs, including custom output paths; it does not build those dependencies or import their source into the consuming RepositoryGraph. This metadata evaluation is disabled by `--untrusted`. Restore alone does not produce a sibling project's compiled assembly.

```bash
vogoban analyze-all --db "$DB" --log-level warn
vogoban repositories --db "$DB" --json
```

`READY` means a repository graph is available. It does not certify that semantic analysis has zero compiler diagnostics or that every expected interaction was resolved.

## Build, check and open the MetaGraph

```bash
vogoban metagraph build --db "$DB" --json
vogoban metagraph stats --db "$DB" --json
vogoban metagraph unresolved --db "$DB" --json
vogoban metagraph conflicts --db "$DB" --json
vogoban graph ./orders-service --db "$DB"
```

Open the **MetaGraph** view rather than a repository projection. The path passed to `graph` is one registered repository; the explicit database supplies the federated data. The viewer binds to loopback and serves its assets locally.

Use **Show all relationships** and clear type filters to compare the stored graph with the rendered graph. Focus narrows the visible neighborhood; reset it before judging overall coverage. Missing endpoint diagnostics indicate incomplete stored facts, not permission to fabricate nodes or edges.

After a repository changes, either analyze it and rebuild explicitly, or use incremental synchronization for a Git-backed repository:

```bash
vogoban analyze-repo orders-service --db "$DB"
vogoban metagraph build --db "$DB"
```

```bash
vogoban graph sync ./orders-service --meta --db "$DB"
```

See [sync](../cli/sync.md) for incremental behavior and prerequisites.

## Read the relationship type, not just the line

| Stored relationship | What it establishes | What it does not establish |
| --- | --- | --- |
| `USES_SHARED_PACKAGE` | A repository uses a shared dependency. | A call to another repository or a message exchange. |
| `USES_EXTERNAL_SYSTEM` | A repository references an external system. | The complete runtime path through that system. |
| `PROVIDES_API` | A repository provides an API. | A resolved consumer calling that API. |

Inspect the endpoints, evidence and provenance for every claimed interaction. `connections` can include source entities and shared bridge entities; its row count is not a count of direct repository-to-repository dependencies. An unresolved route candidate is not a confirmed API call. The sample's expected-link answer key describes intended behavior, not facts already extracted by Vogoban.

## Supported extraction and evidence boundaries

Service Bus extraction follows bounded, uniquely initialized message locals through `ServiceBusMessage`, `BinaryData.FromString`, and compiler-bound JSON serializers. Direct generic helper call sites contribute their concrete contract types. Reassigned or mutated locals, unknown batches, arbitrary serializer names and ambiguous sender assignments do not acquire guessed payload or transport edges.

Compiler-bound `ProcessMessageAsync` method-group registrations associate SDK body deserialization with the actual handler. A Functions trigger with a string parameter can also carry a concrete contract when a supported Newtonsoft.Json or System.Text.Json deserializer reads that exact parameter or a unique alias. Other parameters, shadowing lambdas and reassigned parameters are not treated as trigger payloads. `CARRIES` attaches to the actual binding leaf; this does not invent a missing namespace.

Azure SDK identity can follow declared default options bindings through `Configure<T>(GetSection(...))`, `AddOptions<T>().Bind(...)`, and `BindConfiguration(...)`, including nested sections and proven constructor field aliases. Configuration values retain their source locations and structural evidence. Explicit DI factory method groups and processor subscription paths are modeled. Conflicting environment values, named-option/default-option ambiguity, unrelated `Options.Create` instances and unresolved client assignments remain unknown. Root-level `appsettings.json` is associated with its owning project as well as nested project configuration.

Next.js App Router `route.ts`/`route.js` handlers declare API operations. Same-origin frontend fetches resolve only to their own application's matching method and route. Cross-repository API matching preserves declared URL configuration and base-path semantics; a development host, dynamic base, placeholder, or shared payload type alone cannot establish a production provider. Declared host ownership is required for host-based federation.

## Verified enterprise-landscape results and limits

Validation on October 14, 2026 registered and analyzed all eleven sample repositories, then built the MetaGraph from the isolated, dependency-restored trusted copy. Before the extraction fixes this produced 115 shared-resource/API-provider relationships and no message or Azure federation. With the fixes, the same unmodified sample produces:

| Observation | Result |
| --- | ---: |
| Catalog repositories with `READY` graphs | 11 |
| `USES_SHARED_PACKAGE` relationships | 70 |
| `USES_EXTERNAL_SYSTEM` relationships | 35 |
| `PROVIDES_API` relationships | 11 |
| Message resolver relationships | 16 |
| Azure resolver relationships | 19 |
| Repository dependencies on `enterprise-contracts` (`ProjectReference` paths and npm `file:` dependencies) | 9 |
| Total MetaGraph relationships | 161 |
| Unresolved API candidates | 22 |
| MetaGraph conflicts | 0 |
| `SharedContract` / `ExternalSystem` / `Database` meta entities | 6 / 3 / 0 |
| Deployment resolver relationships | 0 |

The release check of November 17, 2026 repeated the run with `vogoban discover` and added cross-repository `ProjectReference` and npm `file:` resolution: the six .NET repositories that reference `Enterprise.Contracts.csproj` by a sibling path and the three portals that depend on `file:../enterprise-contracts/typescript` now each have a `DEPENDS_ON_REPOSITORY` edge to `enterprise-contracts` (evidence `project-reference-path` or `file-dependency-path`), plus one `PRODUCES_PACKAGE` edge for the npm package, so `vogoban metagraph-topology enterprise-contracts --reverse` lists all nine consumers. Without `dotnet restore`, the same sample gives 126 relationships with no message or Azure federation, because the Azure SDK and Service Bus types cannot be bound. These counts describe that validation run, not promised output for every checkout. The new relationships include `PUBLISHES_MESSAGE`, `CONSUMES_MESSAGE`, `CONSUMED_BY`, `CARRIES`, `SHARES_CONTRACT_WITH`, `SHARES_RESOURCE`, `DECLARED_BY`, `DEPENDS_ON_REPOSITORY` and `CONSUMES_REPOSITORY_CONTRACT`. In particular, `order-processing` and `notification-service` consume the `OrderCreatedEvent` contract published by `orders-service`; notification shares the statically identified orders topic with the publisher. Orders, notification and reporting also have evidence-backed infrastructure dependencies. These are extracted contracts and resource identities, not runtime tracing or proof of every intended sample interaction. Zero conflicts does not mean complete coverage.

The initial restored-copy run recorded 91 compiler errors for `Orders.Api` even though the project built successfully. Two compiler-reference defects have since been fixed: upgraded NuGet assemblies were discarded when a framework assembly shared their name, and built sibling-project dependencies were omitted from compilation. Reanalysis now reports zero compiler errors for all six .NET application/service projects and the `Enterprise.Contracts` library. The contracts test project still reports `CS5001` because its generated entry point is not supplied to semantic compilation. This is not a zero-diagnostics claim.

The remaining API candidates lack sufficient deployment identity: twelve are `development-host-unresolved`, nine are `dynamic-host-unresolved`, and one remains `route-only-candidates`. Eight of the dynamic-host candidates are `platform-gateway`'s typed clients for orders, customers and reporting: their base address comes from options at runtime, so they are reported as candidates rather than resolved, and (since the release check) no longer matched to the gateway's own controllers. The previously missing same-origin Next.js call now resolves locally rather than appearing as a cross-repository candidate. A development port or a matching route alone is not proof of which production repository handles a request. Non-loopback consumer URLs and provider host mappings must be supported by declared configuration, not inferred from repository names.

The order-processing Function's Key Vault connection reference still does not reveal its Service Bus namespace; the analyzer does not retrieve secrets or infer a namespace from the topic name. Custom serializers, indirect generic helper chains, unresolved SDK factory wrappers and ambiguous client instances can still leave partial paths. The new extraction deliberately keeps those limits visible rather than filling in an attractive but unsupported graph.

Projects with external project dependencies, and their dependent compilations, bypass semantic fact caching so rebuilding a sibling assembly cannot silently reuse stale compiler results. The registered repositories and source-reading boundaries remain separate.

After rebuilding a sibling dependency, rerun full analysis of its consumers (`analyze-repo` or `analyze-all`) before rebuilding the MetaGraph. A no-op incremental sync does not watch binary changes outside the selected repository.

The complete-mode viewer was checked against this store: it rendered all 90 loaded endpoint entities and all 151 stored relationships, with no missing endpoints or browser errors. Focusing the `OrderCreatedEvent` shared contract showed ten entities and nine relationships, including the publisher repository and both consumer repositories. That verifies rendering coverage, not semantic completeness. If an expected interaction is absent from the stored facts, changing layout or adding technology icons cannot supply it.

When investigating a sparse graph, check the selected database, catalog roots, analysis diagnostics, resolver counts and unresolved reasons before treating the absence of an edge as proof that no dependency exists.
