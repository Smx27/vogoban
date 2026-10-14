# vogoban analyze

`vogoban analyze <path>` reads one repository and writes the architecture graph for its selected analyzer scope into the graph store. Use [`init`](init.md) to set up repository-local preferences first, or run analyze directly for legacy all-analyzer defaults when no workspace configuration exists. Every query command reads what analyze stored.

## What it does

`analyze` runs a full analysis of the repository that contains `<path>`:

1. **Discovery.** Finds the repository root (`git rev-parse --show-toplevel`, or the directory itself when it is not a Git checkout), reads the commit, branch, remote and dirty state, and lists the files to analyze.
2. **Parsing.** Parses C# and TypeScript/JavaScript files with tree-sitter (syntax facts).
3. **Semantic analysis.** Builds Roslyn compilations for every .NET project and runs the TypeScript checker for every `tsconfig` project. This resolves calls, type references, inheritance and overloads with `COMPILER_RESOLVED` evidence.
4. **Framework and infrastructure plugins.** ASP.NET Core, dependency injection, configuration, HTTP clients, messaging (Azure Service Bus, MassTransit, NServiceBus, MediatR, RabbitMQ, Kafka, configured abstractions), Azure Functions and SDK clients, .NET Aspire, Angular and React, OpenAPI, Docker, Azure Pipelines, Helm, Kubernetes, Bicep/ARM/Terraform, App Configuration, CODEOWNERS.
5. **Resolution.** Links HTTP calls to API operations, message publishers to consumers, code to declared Azure resources and infrastructure to applications.
6. **Persistence.** Replaces the repository's graph in the store in one transaction and records an analysis run and graph version. Automatic graph snapshots are captured unless disabled in the local settings or with `--no-snapshots`.

Analysis is static. Vogoban never runs repository code, never contacts Azure or any other service, and sends no telemetry. The one exception to "never runs code" is MSBuild evaluation of project files, described under [Trust](#trust---untrusted).

## Usage

```bash
vogoban analyze [path] [--no-semantic] [--untrusted] [--db <path>] [--json] [--log-level <lvl>] [--log-json]
```

- `path` defaults to `.`. Any directory inside a Git checkout analyzes the whole checkout.
- The store is `--db`, else `$VOGOBAN_DB`, else `<repository>/.vogoban/graph.db`. Analyzing `~/src/app` from your home directory writes `~/src/app/.vogoban/graph.db`. Run queries from that repository or pass the same `--db`.
- `.vogoban/config.json` controls analyzer groups, exclusions, semantic analysis and snapshot capture. Explicit `--analyzers`, `--exclude`, `--semantic`/`--no-semantic` and `--snapshots`/`--no-snapshots` override settings for this run without changing the file. Exclusions apply to discovery, frontend semantic imports and Roslyn evaluated source items.
- Analysis always runs fully within the selected scope. The saved incremental preference affects `graph sync`, not analyze. After successful interactive analysis, `--open` or the saved `openAfterAnalysis: true` preference opens the graph; otherwise, a graph-opening offer defaults to No. `--no-open` suppresses both behaviors. JSON, CI and noninteractive runs do not start a graph server or launch a browser.

## Example

Run from inside the repository so the store lands next to it:

```bash
cd ~/src/contoso-orders
vogoban analyze .
```

Progress logs go to stderr (abridged):

```text
INFO  discovery.repository repo=contoso-orders id=e_9a2cfe3a9823cb05539c79e5 root=/home/user/.capy/work/demo/contoso-orders commit=ccaffed660b7… branch=main dirty=false
INFO  discovery.files repo=contoso-orders files=33 skipped=0
INFO  dotnet.projects repo=contoso-orders plugin=dotnet.msbuild projects=4 solutions=0
INFO  parser.files repo=contoso-orders plugin=csharp.tree-sitter parsed=9 cached=0
INFO  roslyn.project-analyzed repo=contoso-orders plugin=dotnet.roslyn project=Contoso.Orders.Api frameworks=["net10.0"] ms=528 success=true symbols=16 relations=72 unresolved=0 skippedSources=0 compilerErrors=0
…
INFO  applications.detected repo=contoso-orders plugin=dotnet.applications applications=2 kinds=["Contoso.Orders.Api:aspnetcore","Contoso.Orders.Functions:azure-functions"]
…
```

The summary goes to stdout (trimmed):

```text
Analyzed contoso-orders @ ccaffed660b7 in 3114 ms
                               count
-----------------------------  -----
Projects                       6
Assemblies                     4
Files                          33
Namespaces                     9
Types                          19
  Classes                      11
  Records                      4
…
Methods                        33
Properties                     16
Parameters                     44
Calls                          65
Constructions                  14
Type References                152
Member References              25
Inheritance / Implementations  12
Project References             3
Assembly References            36
Package Dependencies           201
Unresolved References          1
Compilation Diagnostics        0
evidence: COMPILER_RESOLVED=675 DECLARED=140 EXACT=272 INFERRED=5 STRUCTURALLY_RESOLVED=59
unresolved: dynamic-transport-name=1

application graph                   count
----------------------------------  -----
Applications                        4
Controllers                         1
Endpoints                           3
…
contract graph                    count
--------------------------------  -----
APIs                              3
API Operations                    3
…
HTTP Client Calls                 2
  Resolved To Operations          2
Message Contracts                 1
Topics / Exchanges                2
Queues                            4
…
infrastructure graph (declared)          count
---------------------------------------  -----
…
Helm Resources                           14
Secret References                        3
Configuration Entries                    21
…
```

## Output

| Part                                           | Meaning                                                                                                                                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Analyzed <name> @ <commit> in <ms>`           | Repository name (from the Git remote, `vogoban.json`, or the folder name), the analyzed commit (`(no commit)` outside Git) and total time                                                                               |
| Summary table                                  | Code structure: projects (including npm packages), assemblies, files, namespaces, types by kind, members, and relationship counts (calls, type and member references, inheritance, project/assembly/package references) |
| `Unresolved References`                        | References Vogoban saw but could not bind to a target. Each has a category and reason; list them with `vogoban unresolved`                                                                                              |
| `Compilation Diagnostics`                      | Compiler errors and warnings reported by Roslyn while building the semantic model. Errors usually mean missing restore or unsupported build logic, and reduce semantic facts for that project                           |
| `evidence:`                                    | Relationship counts per evidence level. A high `COMPILER_RESOLVED` share means semantic analysis worked                                                                                                                 |
| `unresolved:`                                  | Unresolved references per category (`dynamic-transport-name`, `dependent-on-unresolved-type`, `analyzer-limitation`, ...)                                                                                               |
| application / contract / infrastructure tables | The same statistics as [`vogoban stats`](graph.md#stats) for those graphs. `infrastructure graph (declared)` counts are declarations from files, not runtime state                                                      |

`--json` prints `{ run, summary, applicationGraph, infrastructureGraph, stats }`. `run` has the run id, commit, timestamps, schema and analyzer versions, every plugin version, and `stats` with counts and per-plugin timings (`ms:<plugin>`). `stats.diagnosticsByCategory` holds the analysis diagnostic counts.

## What is scanned

Discovery lists files with `git ls-files -co --exclude-standard` (tracked plus untracked, respecting `.gitignore`). Outside Git it walks the directory tree. Files are classified by name:

| Category                | Files                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C# / Razor              | `*.cs`, `*.razor`, `*.cshtml`                                                                                                                                                                                           |
| MSBuild                 | `*.csproj`, `*.fsproj`, `*.vbproj`, `*.props`, `*.targets`; solutions `*.sln`, `*.slnx`, `*.slnf`                                                                                                                       |
| TypeScript / JavaScript | `*.ts`, `*.tsx`, `*.mts`, `*.cts`, `*.js`, `*.jsx`, `*.mjs`, `*.cjs`; component templates `*.html` next to a `.ts` file of the same name                                                                                |
| npm and frontend config | `package.json`, `tsconfig*.json`, `jsconfig*.json`, `angular.json`, `nx.json`, `lerna.json`, `pnpm-workspace.yaml`, `.env*`                                                                                             |
| .NET configuration      | `appsettings*.json`, `web.config`, `app.config`, `launchSettings.json`                                                                                                                                                  |
| Azure Functions         | `host.json`, `function.json`, `local.settings*.json`                                                                                                                                                                    |
| Azure Developer CLI     | `azure.yaml`                                                                                                                                                                                                            |
| Contracts               | `*openapi*`, `*swagger*`, `*asyncapi*` (`.json`/`.yaml`), and any JSON/YAML file whose first 4 KB declares `openapi:` or `swagger: 2`                                                                                   |
| Pipelines               | `azure-pipelines*.yml`, files under `pipelines/`, and YAML that starts with `stages:`/`jobs:`/`steps:`/`extends:` (Azure Pipelines syntax). `.github/workflows/*` files are discovered but not modeled                  |
| Containers              | `Dockerfile`, `Dockerfile.*`, `*.dockerfile`, `docker-compose*.yml`, `compose*.yml`                                                                                                                                     |
| Kubernetes and Helm     | `Chart.yaml`, `values*.yaml`, chart `templates/`, files under `charts/`, `helm/`, `k8s/`, `kubernetes/`, `manifests/`, `deploy/`, and YAML with `apiVersion:` and `kind:`                                               |
| Azure IaC               | `*.bicep`, `*.bicepparam`, `*.tf`, `*.tfvars`, ARM templates (JSON with a `deploymentTemplate` or `deploymentParameters` `$schema`), JSON/YAML/text files next to Bicep files (for `loadTextContent`/`loadJsonContent`) |
| Ownership and config    | `CODEOWNERS` (root, `.github/`, `docs/`, `.gitlab/`), `vogoban.json`                                                                                                                                                    |

Everything else is ignored. `vogoban.json` at the repository root can add explicit OpenAPI files (`openapi`), pipeline globs (`infrastructure.pipelines`), Helm value files (`infrastructure.helmValues`), environment globs, messaging abstractions, a stable repository id and name (`repository`), and frontend include/exclude globs (`frontend`). See [repository-analysis.md](../advanced/repository-analysis.md).

### Ignored directories, generated code and limits

- Directories never analyzed: `.git`, `bin`, `obj`, `node_modules`, `.vs`, `.idea`, `.vogoban`, `packages`, `TestResults`.
- Frontend build output and vendored code is skipped for TS/JS/HTML: `dist`, `build`, `out`, `coverage`, `.angular`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `.vite`, `storybook-static`, `bower_components`, `jspm_packages`, `.yarn`, `vendor`, `.docusaurus`, `wwwroot/lib`, and `*.min.js`, `*.bundle.js`, `*.chunk.js`, `*.js.map`. List a path in `vogoban.json` `frontend.include` to analyze it anyway.
- Generated files are analyzed but marked `generated`: `*.g.cs`, `*.g.i.cs`, `*.designer.cs`, `*.generated.cs`, `*.AssemblyInfo.cs`, `*.AssemblyAttributes.cs`, C# files with `<auto-generated`, and TS/JS files with markers such as `@generated`, `do not edit` or NSwag/openapi-generator/orval headers.
- Files larger than 8 MiB are skipped with a `FILE_SKIPPED_RESOURCE_LIMIT` diagnostic. Change the limit with `VOGOBAN_MAX_SOURCE_FILE_BYTES`.
- Symbolic links are not followed. Git submodules and nested Git repositories are not analyzed; register them as their own repositories (see [metagraph.md](metagraph.md)).

Skipped files are recorded as `discovery` diagnostics (`file-skipped`) and counted in `vogoban stats`.

### Repository identity

The repository id comes from the normalized Git remote `origin` URL (credentials stripped). Without a remote it comes from the local path (`local:/path/to/repo`), and `vogoban.json` `repository.id` overrides both. Copying or moving a checkout without a remote therefore creates a **second** repository in the store. Entity ids derive from this identity, so ids differ between machines unless the remote (or configured id) is the same.

## `--no-semantic`

`--no-semantic` skips Roslyn and keeps only syntax-level C# facts. It is much faster and needs no .NET SDK, but most of the .NET architecture graph disappears. Running both modes on the same repository:

|                        | Default | `--no-semantic` |
| ---------------------- | ------- | --------------- |
| Time                   | 3114 ms | 311 ms          |
| Calls                  | 65      | 0               |
| Type references        | 152     | 0               |
| Parameters             | 44      | 0               |
| ASP.NET Core endpoints | 3       | 0               |
| DI registrations       | 6       | 0               |
| API operations         | 3       | 0               |

Use it to check discovery and infrastructure quickly, or on a machine without .NET. Do not use it to answer call-graph, endpoint or contract questions. When the SDK is missing, semantic analysis degrades in the same way and logs `dotnet SDK not found (set VOGOBAN_DOTNET or add dotnet to PATH)`.

Semantic analysis needs restored projects (`dotnet restore`, so `obj/project.assets.json` exists) to load package references. The Roslyn analyzer itself is built on the first semantic run and needs network access once to fetch its NuGet packages.

## Trust (`--untrusted`)

To read a .NET project exactly as the build sees it, Vogoban evaluates MSBuild files (`.csproj`, `Directory.Build.props`, imported targets). MSBuild property functions can read files and environment variables, so **evaluating a repository's build files can run code from that repository**. Local `analyze` is trusted by default: use it on your own checkouts.

`--untrusted` (accepted by every command, it sets `VOGOBAN_MSBUILD_EVALUATION=0`) reads project files statically instead. Roslyn still runs, but properties and imports computed by MSBuild are not evaluated, so fidelity drops. The log line shows `evaluation=static … evaluationError=disabled`. On the demo repository:

|                         | Trusted | `--untrusted`                          |
| ----------------------- | ------- | -------------------------------------- |
| Calls                   | 65      | 53                                     |
| Unresolved references   | 1       | 14 (`dependent-on-unresolved-type=13`) |
| Compilation diagnostics | 0       | 2                                      |

The trust mode is recorded with the graph. A later `graph sync` in the other mode triggers a full rebuild (`evaluation_mode_changed`). CI synchronization with `--base/--head` is untrusted unless `--trust-repository` is passed. For full-fidelity analysis of untrusted code use the platform worker's sandbox. See [trust-modes.md](../advanced/trust-modes.md).

## Diagnostics and the degraded-graph warning

Analysis is designed to finish. A file that fails to parse, a project that fails to compile, or a skipped file becomes a **diagnostic** stored with the graph, and analysis continues. Diagnostic categories are `discovery`, `parser`, `project`, `semantic`, `compilation`, `framework` and `resolver`.

If an entire plugin throws, its facts are missing and `analyze` prints on stderr:

```text
WARNING: graph is degraded; plugin(s) failed: <plugin ids> (see 'diagnostics')
```

The exit code is still 0. In 0.18.0, `vogoban diagnostics` prints the privacy report instead of the analysis diagnostics; see [diagnostics.md](diagnostics.md#analysis-diagnostics) for the ways to list them (`stats`, `--json`, `export`).

## Re-analysis and caching

Running `analyze` again on the same repository **replaces** that repository's graph. There is no merge; entities that disappeared from the code or selected analyzer scope disappear from the graph. Each run adds an analysis run record (`vogoban repo`). When snapshot capture is enabled, a graph snapshot (`vogoban graph-snapshots`) is recorded per distinct graph version: re-analyzing an unchanged commit reuses the existing snapshot, while a different result for the same commit (for example after `--untrusted`) adds one. Disabling capture never deletes existing snapshots.

Two caches inside the store make repeated runs cheap:

- a per-file syntax cache keyed by plugin version and file content hash;
- a per-project semantic cache keyed by the project inputs and the trust mode.

On an unchanged checkout the logs show the hits and the run is several times faster:

```text
INFO  parser.files repo=contoso-orders plugin=csharp.tree-sitter parsed=0 cached=9
INFO  parser.files repo=contoso-orders plugin=typescript.tree-sitter parsed=0 cached=6
INFO  semantic.cache repo=contoso-orders plugin=dotnet.roslyn hits=4 misses=0
Analyzed contoso-orders @ ccaffed660b7 in 373 ms
```

Switching between trusted and `--untrusted` invalidates the semantic cache for that run.

## Failure handling

| Failure                                                         | What you see                                                                       | Exit   | Graph                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| Path missing or unreadable, Git state unusable                  | `repository cannot be accessed: <path> (…)` (`category: "repository"` in `--json`) | 2      | Previous graph kept                          |
| Checkout registered as `local:` whose Git directory disappeared | `… is registered as … but Git no longer reports a repository there …`              | 2      | Previous graph kept                          |
| Git refuses the directory (dubious ownership)                   | `Git refuses to read … (dubious ownership)`; run as the repository owner           | 2      | Previous graph kept                          |
| Store write fails                                               | `graph persistence failed: …` (`category: "storage"`)                              | 2      | Transaction rolled back, previous graph kept |
| Store directory cannot be created                               | `path not found: …` or `EACCES: …`                                                 | 1 or 2 | Unchanged                                    |
| One plugin crashes                                              | `WARNING: graph is degraded …` on stderr                                           | 0      | New graph without that plugin's facts        |
| Parse or compile errors                                         | Diagnostics only                                                                   | 0      | New graph, reduced for affected files        |

When analysis fails after it started, the repository's catalog status becomes `FAILED` with the error (see `vogoban repositories`).

```bash
vogoban analyze /nonexistent --json
```

```json
{
  "error": "repository cannot be accessed: /nonexistent (ENOENT: no such file or directory, lstat '/nonexistent')",
  "category": "repository",
  "details": null
}
```

## Analysis, synchronization and querying

|         | `analyze`                                                                    | `graph sync`                                                                        | Query commands |
| ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------- |
| Reads   | The whole checkout                                                           | Only the files a Git change set affects (plus anything they invalidate)             | The store only |
| Writes  | Replaces the repository graph                                                | Reconciles the affected part and records a new graph version                        | Nothing        |
| Speed   | Full cost (with caches)                                                      | Proportional to the change; falls back to a full rebuild when incremental is unsafe | Milliseconds   |
| Use for | First analysis, after config or SDK changes, any time you want a clean build | Keeping the graph current while you work, in Git hooks and CI                       | Every question |

A synchronized graph is equivalent to a clean `analyze` of the same commit. Use `vogoban graph status` to see whether the graph matches your checkout. Details: [sync.md](sync.md) and [incremental-analysis.md](../features/incremental-analysis.md).

If the store lives inside the repository (the default), add `.vogoban/` to `.gitignore`, together with `bin/` and `obj/` for .NET. Otherwise the store files and build output show up as untracked changes and `graph status` reports `CHANGES_DETECTED`.

## Useful options

| Option             | Effect                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| `--no-semantic`    | Syntax-only C# analysis (see above)                                      |
| `--untrusted`      | No MSBuild evaluation of repository build files                          |
| `--db <path>`      | Store location; use one store per set of repositories you query together |
| `--json`           | Run record and statistics as JSON on stdout                              |
| `--log-level warn` | Hide progress logs                                                       |
| `--log-json`       | JSON log records on stderr, for CI log processing                        |

## Common mistakes

- **Querying from another directory.** The default store is relative to the current directory. A query run elsewhere silently creates an empty `.vogoban/graph.db` there and prints empty tables. Run from the same directory or pass `--db`.
- **Analyzing without `dotnet restore`.** Package references cannot be loaded, compilation diagnostics rise and calls into packages stay unresolved. Restore first.
- **Expecting runtime facts.** Names computed at runtime, reflection-based registrations and portal-created resources are not in source; they appear as unresolved references or not at all.
- **Committing the store.** Add `.vogoban/` to `.gitignore`.
- **Analyzing a subdirectory and expecting only that subdirectory.** Inside a Git checkout the whole checkout is analyzed.

## Related

- [graph.md](graph.md): inspect what was analyzed
- [diagnostics.md](diagnostics.md): unresolved references and diagnostics
- [sync.md](sync.md): incremental synchronization
- [analysis-pipeline.md](../architecture/analysis-pipeline.md): how the pipeline works
- [trust-modes.md](../advanced/trust-modes.md)
