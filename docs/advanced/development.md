# Development

How to build, run and test Vogoban from source, how the source tree is organized, and how to extend it with analyzers, graph kinds and CLI commands. This page and [Contributing](contributing.md) are the only pages that use development commands; user documentation always uses the installed `vogoban` command.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Linux x86_64 | Ubuntu 24.04 validated | Windows is unsupported; use WSL2 or the container |
| Bun | 1.3 or later (1.3.14 validated) | Runtime, package manager, test runner |
| Git | any recent | Repository discovery, incremental sync, tests |
| .NET SDK | 8 or later (9 and 10 used in development) | Roslyn semantic analyzer in `semantic/Vogoban.Roslyn`; semantic test suites |
| Python 3 | optional | Harness scripts under `test/azure/harness` |
| Docker, PostgreSQL | optional | Container image, platform tests against PostgreSQL |

## Setup from source

```bash
git clone <your vogoban remote> vogoban
cd vogoban
bun install
bun run build:roslyn
bun src/cli/main.ts --version
```

- `bun install` installs the TypeScript dependencies (tree-sitter grammars, the TypeScript compiler used for frontend analysis, YAML/XML parsers, OpenTelemetry, `jose`).
- `bun run build:roslyn` runs `dotnet build semantic/Vogoban.Roslyn -c Release`. It is optional: the first semantic analysis builds the analyzer automatically (network access to NuGet needed once) and writes the source stamp `semantic/Vogoban.Roslyn/bin/.source-hash`. Whenever a `.cs` or `.csproj` file of the analyzer changes, the stamp no longer matches and the next analysis rebuilds it.

## Running the CLI from source

```bash
bun src/cli/main.ts analyze ~/src/my-repo
bun src/cli/main.ts stats
bun src/cli/main.ts platform help
```

`package.json` also defines `bun run vogoban -- <args>`. To test the installed experience against your working tree, link it globally:

```bash
bun install -g "$PWD"
vogoban --version
```

## Type checking

```bash
bun run typecheck
```

This runs `tsc --noEmit` with the strict settings in `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `.ts` import extensions). It covers `src/` only; tests are type-checked by Bun when they run. On a scratch copy of the 0.18.0 tree it completed with exit 0 in 0.9 s.

## Tests

```bash
bun test --timeout 180000
```

Pass the timeout on the command line. `bunfig.toml` sets `[test] timeout = 180000` for the integration suites, but Bun 1.3.14 does not apply that key: a minimal test with `timeout = 100` in `bunfig.toml` still timed out at Bun's 5-second default. Without the flag, a slow first run can fail with "this test timed out after 5000ms"; on the 0.18.0 tree, `D-05 secrets never enter persistent analysis state` failed this way in a plain `bun test` run and passed with the flag.

Results on a scratch copy of the 0.18.0 tree (Ubuntu 24.04, Bun 1.3.14, .NET SDK 9.0.318 and 10.0.401):

```text
 285 pass
 16 skip
 2 todo
 0 fail
 27784 expect() calls
Ran 303 tests across 22 files. [58.13s]
```

Run one file or one test name:

```bash
bun test --timeout 180000 test/security/boundary-secrets.test.ts
bun test --timeout 180000 -t "D-05"
```

### What is skipped and why

| Suite | Skips when |
|---|---|
| `test/azure/iac/{bicep,arm,terraform}.test.ts` corpus tests | The cloned public corpora are not present under `~/.capy/work/repos` (and `~/.capy/work/repos-tf` for Terraform). Unit tests in the same files always run. |
| `test/azure/sdk-initializers.test.ts` (Cosmos initializer cases, D-02) | The fixture `cosmos-initializers` cannot be restored offline from the NuGet cache (`$NUGET_PACKAGES` or `~/.nuget/packages`): a required package is missing, or the offline `dotnet restore` fails. The reason is printed as `sdk-initializers: skipped (…)`. In the run above it failed on a NU1603 version warning. Restore the fixture once with network access to enable it. |
| `test/security/boundary-secrets.test.ts` | No .NET SDK is found (`VOGOBAN_DOTNET`, `dotnet` on `PATH`, `~/.dotnet/dotnet`). |
| `test/security/worker-jail.test.ts` jail cases | The host cannot create the namespace jail (the sandbox plan is not `namespace-jail`). |

The two `todo` entries are documented known limitations in `test/ai/ssrf.test.ts` (DNS rebinding between validation and connect; the CLI's local AI provider not running outbound URL validation).

## Test layout

| Directory | Contents |
|---|---|
| `test/ai/` | AI planner and tools: adversarial prompts, Azure tools, budgets, SSRF guards. `helpers.ts` builds stores for them. |
| `test/azure/` | Azure Functions (.NET and Node), SDK usage, identity and MetaGraph resolution, IaC evaluation. `iac/` holds parser tests for Bicep, ARM and Terraform; `analyze-helper.ts` copies a fixture to a temporary directory, runs the real CLI into a fresh store and opens it read-only. |
| `test/azure/fixtures/` | Enterprise fixtures (`contoso-orders`, `contoso-fulfillment`, `contoso-platform-infra`, `identity/*`, `node-functions`, `cosmos-initializers`); see its `README.md`. The .NET projects need `dotnet restore` for full semantic resolution. |
| `test/azure/harness/` | Scripts run by hand for release verification: `azure_security.sh` (hostile repository under strace in a network namespace), `azure_incr.py` (incremental vs full equivalence), `azure_verify.py` (cold/warm timing and fact counts on real repositories). |
| `test/frontend/` | Angular/React lazy-route resolution on `fixtures/lazy-routes`. |
| `test/incremental/` | Git failure handling of `graph sync` (`git_state_unreadable`, identity preservation). |
| `test/platform/` | API hardening, CLI hygiene, client IP and trusted proxies, MCP over HTTP, OIDC `return_to`. `helpers.ts` starts the API in SQLite mode on a random port with an isolated data directory. |
| `test/security/` | Repository boundary (symlinks, MSBuild `Compile` items outside the root), secret redaction canaries, resource limits (`boundary-secrets.test.ts` with `fixtures/boundary-secrets`), and the worker namespace jail (`worker-jail.test.ts`). |

Harness usage:

```bash
bash test/azure/harness/azure_security.sh /tmp/azure-security
python3 test/azure/harness/azure_incr.py fixtures /tmp/azure-incr
python3 test/azure/harness/azure_verify.py /tmp/azure-verify ~/repos/some-functions-repo
```

Most integration tests spawn the real CLI (`bun src/cli/main.ts …`) on a copied fixture, then query the SQLite store directly. Follow that pattern: tests never analyze inside the source tree, and they assert on stored entities, relationships, unresolved references and diagnostics rather than on human output.

## Source layout

| Path | Contents |
|---|---|
| `src/cli/main.ts` | The CLI: `HELP` text, `parseArgs` options, one `case` per command; `format.ts` and `ai-format.ts` render tables and trees |
| `src/pipeline/` | `analyze.ts` (analysis run, `AnalysisError`), `discovery.ts` (repository identity, file discovery, size limit), `config.ts` (`vogoban.json`) |
| `src/plugins/` | Plugin contracts (`types.ts`) and the ordered default set (`registry.ts`) |
| `src/graph/` | Graph model (`model.ts`: entity kinds, relationship types, evidence levels, schema version), `builder.ts`, `identity.ts` |
| `src/store/` | `GraphStore` interface and the SQLite implementation (schema, backup) |
| `src/dotnet/`, `semantic/Vogoban.Roslyn/` | MSBuild project reading, C# syntax, the Roslyn process backend and its C# source, framework plugins (ASP.NET Core, DI, configuration, HTTP clients, messaging) |
| `src/frontend/` | TS/JS workspace, syntax, semantic, Angular, React, modules, HTTP calls |
| `src/azure/`, `src/infrastructure/`, `src/contracts/`, `src/ownership/` | Azure, Docker/Helm/Kubernetes/pipelines, OpenAPI and API/message resolvers, CODEOWNERS |
| `src/analysis/` | Traversal, impact (`impact.ts`, propagation rules in `semantics.ts`), risk, diff, structure |
| `src/incremental/` | Change sets, Git adapter, planner, sync, hooks |
| `src/metagraph/`, `src/query/` | MetaGraph build and catalog; read-side query classes used by the CLI |
| `src/governance/`, `src/enterprise/` | Policy loading and evaluation; ownership, security, enterprise metadata |
| `src/ai/` | Graph tools, planner, assistant, providers, MCP server |
| `src/platform/` | Platform API, auth, RBAC, jobs, worker, sandbox, store, migrations, web app |

## Adding an analyzer (plugin)

Analyzers are plugins listed in `defaultPlugins()` in `src/plugins/registry.ts`. The pipeline sorts them by category, in the order `workspace`, `language`, `semantic`, `framework`, `contract`, `infrastructure`, `resolver`, keeping registry order within a category.

There are two contracts in `src/plugins/types.ts`:

- **`LanguagePlugin`** (`category: "language"`): declares `extensions`, a `syntaxArtifact` key, `init()` and `parse(path, source)` returning `{ facts, errors }`. The pipeline calls `parse` per matching file, caches results by plugin version and file hash, records up to five `syntax-error` diagnostics per file, and stores the facts map in the artifact store for later plugins.
- **`AnalysisPlugin`** (any other category): `id`, `version`, `category` and `run(ctx)`.

A minimal analysis plugin:

```ts
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";

const ID = "example.todo-comments";
const VERSION = "1";

export const todoCommentsPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    for (const file of ctx.files.filter((f) => f.language === "csharp")) {
      const text = await ctx.readText(file.path);
      if (!text.includes("TODO")) continue;
      ctx.graph.diagnostic({
        repositoryId: ctx.repository.id, category: "framework", plugin: ID, file: file.path,
        severity: "info", recoverable: true, code: "todo-found", message: `TODO comment in ${file.path}`,
      });
    }
  },
};
```

What the context gives you:

- `ctx.files` (discovered files with category, language, hash, `generated`), `ctx.skippedFiles`, `ctx.readText(path)`, `ctx.fileEntityId(path)`.
- `ctx.graph`: `entity()`, `relate()`, `annotate()`, `unresolved()`, `diagnostic()`, `conflict()`. Every entity and relationship needs `provenance`, built with `ctx.provenance({ plugin, extractor, mechanism, version, location })`, and every relationship an evidence level (`EXACT`, `COMPILER_RESOLVED`, `DECLARED`, `STRUCTURALLY_RESOLVED`, `INFERRED`, `HEURISTIC`, `UNKNOWN`).
- `ctx.artifacts`: typed values shared between plugins (`artifactKey<T>(name)`), for example syntax facts or the semantic index.
- `ctx.cache`: the persistent fact cache (`get`/`put` by scope and key). Key it by your plugin version and the content hashes you depend on.
- `ctx.config`: the parsed `vogoban.json`; `ctx.options.semantic`; `ctx.log`.

Rules the existing plugins follow:

- Never execute repository content and never use the network.
- When something cannot be determined statically, record an unresolved reference with a category and a reason instead of guessing.
- Keep ids deterministic: entity keys are built from repository identity and stable names (`src/graph/identity.ts`).
- A thrown error does not fail the analysis: the pipeline records a `plugin-failed` diagnostic and marks the graph degraded (`analyze` warns, `graph sync` exits 4). Catch per file or per project when the rest of the work can continue.
- Bump `version` when the output changes. Plugin versions are part of the graph version and of the sync plan, so the next `graph sync` runs as a full rebuild (`plugin_versions_changed`).
- If the plugin reads new file types, teach `classifyFile` in `src/pipeline/discovery.ts` about them, and the incremental planner (`src/incremental/planner.ts`) which domains they affect.

## Adding entity kinds and relationship types

1. Add the kind to `ENTITY_KINDS`, or the type to the right group of `RELATIONSHIP_TYPES`, in `src/graph/model.ts`. `isEntityKind`/`isRelationshipType` (used by `--kind` and `--type`) pick them up.
2. Give the kind an impact category in `CATEGORY` in `src/analysis/semantics.ts` (default `CODE`).
3. Give the relationship type a propagation rule in `RULES` in the same file. The helpers say which way impact flows: `dep(label)` (the source depends on the target, so a change to the target impacts the source), `flow(label)` (impact flows to the target), `producer`, `delivery`, `hosting` and `contains`. A potential flag marks edges that only *may* propagate (dispatch, inferred edges). A type without a rule does not propagate impact.
4. Check MetaGraph resolvers, governance selectors and AI tools if the new kind should be visible there.
5. Adding values does not change the graph schema. Changing table structure in `src/store/sqlite.ts` does: bump `GRAPH_SCHEMA_VERSION`, and existing stores will be refused with a schema mismatch.

## Adding a CLI command

1. Add a line to the `HELP` text in `src/cli/main.ts`, in the right section.
2. Add any new option to the `parseArgs` `options` object (options are global: one definition serves every command).
3. Add a `case "my-command": { … break; }` in the main `switch`. Use the existing helpers: `one(query, ref, store)` to resolve an entity reference (it raises the ambiguity error with candidates), `repoId(store)` / `catalogRef()` for `--repo`, `depthOpt`, `rowLimit`, `kinds()`, `types()`.
4. Print through `output(() => humanText, data)`, which prints `data` as JSON with `--json`. Build tables with `table(rows, headers)` from `src/cli/format.ts`.
5. Throw `CliError` for usage, validation, not-found and ambiguity errors (exit 2, with `{"error", "category": "cli"}` under `--json`). Set `process.exitCode` for result-based codes (for example 3/4 for governance).
6. Platform subcommands live in `src/platform/cli.ts` (`PLATFORM_HELP` and `platformCommand`).
7. Document the command in exactly one page under `docs/cli/`.

## Adding tests

- Put the test next to its area under `test/<area>/`, named `*.test.ts`, using `bun:test`.
- Copy fixtures to a temporary directory (`mkdtempSync(join(tmpdir(), …))`) and run the CLI with `--db` pointing into it; never analyze inside the source tree.
- Assert on the store (`bun:sqlite`, read-only) or on `--json` output.
- Long integration tests set a per-hook timeout (for example `beforeAll(…, 300_000)`) and should be run with `--timeout 180000`.
- Gate tests on environment prerequisites with `describe.skipIf(…)` / `test.skipIf(…)`, as the .NET, corpus and jail suites do, so the suite stays green on hosts without them.
- Regression tests reference the finding id they cover in the test name (for example `D-05`, `C-02`).

## Coding conventions observed in the repository

- TypeScript ES modules on Bun; imports use explicit `.ts` extensions and `import type` for types.
- Bun APIs are used directly: `Bun.spawn`/`Bun.spawnSync` for processes, `Bun.file` for reads, `bun:sqlite` for stores, `bun:test` for tests.
- Every fact has provenance and an evidence level; unknowns become unresolved references with a category and reason, never guesses.
- Deterministic output: ids are hashes of stable keys, lists are sorted before hashing and printing.
- Secrets: strings from repositories pass through the redaction filter before persistence; platform secrets are references (`env:`/`file:`) only.
- Exit codes and error shapes follow the CLI conventions listed in [Troubleshooting](troubleshooting.md).
- Comments are short doc comments on exported functions and on non-obvious invariants.

## Related

- [Contributing](contributing.md)
- [Architecture overview](../architecture/overview.md)
- [Analyzers](../architecture/analyzers.md)
- [Repository structure](../architecture/repository-structure.md)
