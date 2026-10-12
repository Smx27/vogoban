# CLI overview

`vogoban` is a single command-line program with one flat command per question you can ask the architecture graph. This page explains how the commands are organised, the options every command shares, how entity references are resolved, what the output and exit codes mean, and which environment variables the CLI reads. It ends with an index of every command.

## How the CLI is organised

```text
vogoban <command> [arguments] [options]
```

Every command works against one **graph store**, a SQLite file that `vogoban analyze` fills and every other command reads. Commands fall into four groups:

| Group | What it does | Example |
| --- | --- | --- |
| Analysis | Reads a repository and writes its graph into the store | `vogoban analyze .` |
| Synchronization | Updates an existing graph from a Git change set | `vogoban graph sync` |
| Queries | Read the store and print a view; they never change it | `vogoban find Order --kind Type` |
| Platform | Runs the multi-tenant server and workers | `vogoban platform serve` |

A few commands have subcommands (`graph`, `azure`, `metagraph`, `baseline`, `hooks`, `explain`, `cycles`, `configuration`, `platform`). Everything else is a single word such as `endpoints` or `frontend-chain`.

`graph` is a prefix for the incremental commands only: `graph sync`, `graph status`, `graph changes`, `graph history` and `graph diff` (the same as `diff`). There is no `graph search`; searching is `vogoban find`.

Typical session:

```bash
cd ~/src/contoso-orders
vogoban analyze .                     # build the graph into ./.vogoban/graph.db
vogoban stats                         # what was found
vogoban find SubmitAsync              # locate an entity
vogoban show OrderService --kind Type # identity and every relationship
vogoban impact OrderService --kind Type
```

## Global options

These options are parsed for every command. A command ignores options it does not use; an option that does not exist at all is rejected with exit code 2.

| Option | Meaning |
| --- | --- |
| `--db <path>` | Graph store to use. Default: `$VOGOBAN_DB`, otherwise `./.vogoban/graph.db` relative to the **current directory** (not to the analyzed path). |
| `--json` | Print machine-readable JSON on stdout instead of the human view. Every command accepts it. |
| `--depth <n>` | Traversal depth. Defaults differ per command: `deps`/`callers`/`callees` 1, `path` 8, `frontend-chain` 12, `azure flow` 14, `impact` 6 (see [impact.md](impact.md)). |
| `--type <T,...>` | Restrict relationship types, for example `--type CALLS,USES_TYPE`. Used by `show`, `deps`, `references`, `path`, `paths`. Unknown types are rejected. |
| `--kind <K,...>` | Restrict entity kinds, for example `--kind Method` or `--kind Queue,Topic`. Used by `find` and by entity-reference resolution in every command. Unknown kinds are rejected. `azure resources --kind` is different: it takes an Azure service name (see [azure.md](azure.md)). |
| `--limit <n>` | Maximum rows. Defaults differ: `find` 50, `show`/`references` 200, `unresolved` 100, `azure flow` 40 paths, analysis views 40. |
| `--repo <repo>` | Restrict to one repository (id, identity or name) when the store holds several. Not listed under "Options" in `--help`, but accepted by most query commands. |
| `--offline` | Refuse any non-local network call, which in practice means external AI endpoints. Same as `VOGOBAN_OFFLINE=1`. Local graph queries, MCP and local models still work. |
| `--mode <m>` | `LOCAL` (default), `SELF_HOSTED` or `HOSTED`. Only reported by `privacy`; local use needs no mode and no account. |
| `--log-level <lvl>` | `debug`, `info`, `warn` or `error`. Default `info` for `analyze`, `warn` for everything else. Logs go to stderr. |
| `--log-json` | Write logs as one JSON object per line on stderr. |
| `--untrusted` | Disable MSBuild evaluation of repository build files (static project reading only). See [analyze.md](analyze.md#trust---untrusted). |
| `--version` | Print the version (`0.18.0`) and exit 0. |
| `--help`, `-h` | Print the command list and exit 0. |

Command-specific options (`--reverse`, `--dispatch`, `--method`, `--app`, `--upstream`, `--no-semantic`, ...) are documented on each command page.

`vogoban help` is not a command; it prints "unknown command 'help'" and the help text and exits 2. Use `vogoban --help`. Running `vogoban` with no arguments prints the help text and exits 1. `vogoban platform help` prints the platform help.

## Entity references

Commands that take an `<entity>` (`show`, `deps`, `callers`, `path`, `impact`, `azure flow`, `frontend-chain`, ...) accept any of:

| Form | Example |
| --- | --- |
| Entity id | `e_ecc5728e9c08860af51f6d2f` |
| Symbol key | `Contoso.Orders.Api::T:Contoso.Orders.Api.Services.OrderService` |
| Qualified name | `Contoso.Orders.Api.Services.OrderService` |
| Name | `OrderService` |

Resolution is tried in that order: id, exact symbol key, exact qualified name, exact name (for methods, the qualified name without the parameter list also counts), then a case-insensitive substring match. Entity ids are derived from repository identity, so the ids in these pages will differ from yours. Get your ids from `vogoban find`.

### Ambiguous references

Names are often ambiguous: a method and its parameters share the method's name, an interface method and its implementation share a name, a message contract and its C# record share a name, an Azure Function and its handler method share a name. When a reference matches more than one entity, the command prints the candidates and exits 2:

```bash
vogoban callers SubmitAsync --kind Method
```

```text
'SubmitAsync' is ambiguous (2 matches); use an id or --kind:
  e_6f14f6b41a1d6425acf108e4  Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, …)  src/Contoso.Orders.Api/Services/OrderService.cs:10
  e_4d81acc47db3e34477346b29  Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)  src/Contoso.Orders.Api/Services/OrderService.cs:24
```

Fix it with `--kind`, a longer qualified name, or the id:

```bash
vogoban callers Contoso.Orders.Api.Services.OrderService.SubmitAsync --kind Method
vogoban callers e_4d81acc47db3e34477346b29
```

Two rules to remember:

- `--kind` applies to **every** reference in the command. For `path A B` or `azure flow A --to B` where A and B are different kinds, pass ids.
- The exact-name step only looks at the first 50 substring matches. In a large repository, a short name such as `Contoso.Orders.Api` can match an assembly and a namespace but miss the project of the same name; add `--kind Project` (or use the id).

With `--json`, an ambiguous reference prints `{"error": ..., "category": "cli", "details": [{"id", "kind", "qualifiedName"}, ...]}` on stdout, so scripts can pick a candidate.

## Output conventions

- Human output is plain text tables (header row, dashed rule, aligned columns) or indented trees. Long cells are truncated to fit; use `--json` for full values.
- Relationship lines read `-[TYPE/EVIDENCE]-> Target` (outgoing) and `<-[TYPE/EVIDENCE]- Source` (incoming). The evidence level says how the fact was established: `COMPILER_RESOLVED` (Roslyn or the TypeScript checker), `EXACT`, `STRUCTURALLY_RESOLVED`, `DECLARED` (read from configuration or IaC), `INFERRED`, `HEURISTIC`. See [concepts.md](../concepts.md).
- External entities (framework types, NuGet packages) are marked `[external]`.
- Locations are `path:line`, relative to the repository root.
- `--json` writes indented JSON to stdout. Logs and warnings always go to stderr, so `vogoban ... --json > out.json` stays valid JSON.
- Errors go to stderr as one message. With `--json` the error is printed on stdout as `{"error", "category", "details"}` where `category` is `cli`, `repository`, `storage` or `internal`.

Static analysis never proves runtime behaviour. Every view shows what the code, project files and infrastructure files declare; a relationship that only exists at runtime (reflection, configuration resolved in production, a portal-created subscription) is absent or reported as unresolved.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (also for a query that returns no rows) |
| 1 | Unexpected internal error (set `VOGOBAN_DEBUG=1` to print the stack trace), or `vogoban` run without arguments |
| 2 | Usage or validation error: unknown option or command, missing argument, entity not found, ambiguous reference, unreadable repository path |
| 3 | `governance` / `governance-diff`: WARN. `ask` / `explain` / `ai-tool`: ambiguous, not found, rejected, out of scope or error. `graph status`: FAILED. `graph sync`: failed (previous graph preserved) |
| 4 | `governance` / `governance-diff`: FAIL. `graph sync`: degraded (a plugin crashed). `platform audit verify`: invalid chain |
| 5 | `graph sync --strict-incremental`: an incremental request ran as a full rebuild |

`validate-rules`, `validate-enterprise` and `ai-config` exit 2 when the configuration is invalid. The full `graph sync` table is in [sync.md](sync.md).

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `VOGOBAN_DB` | all commands | Graph store path when `--db` is not given |
| `VOGOBAN_OFFLINE=1` | all commands | Same as `--offline` |
| `VOGOBAN_MODE` | `privacy` | Operating mode when `--mode` is not given |
| `VOGOBAN_HOSTED_ENDPOINT` | `privacy` | Hosted endpoint reported in `HOSTED` mode |
| `VOGOBAN_MSBUILD_EVALUATION=0` | `analyze`, `graph sync` | Disable MSBuild evaluation (what `--untrusted` sets) |
| `VOGOBAN_DOTNET` | `analyze`, `graph sync` | Path to the `dotnet` executable for Roslyn analysis (otherwise `dotnet` on `PATH`, then `~/.dotnet/dotnet`) |
| `VOGOBAN_MAX_SOURCE_FILE_BYTES` | `analyze`, `graph sync` | Largest file analyzed (default 8 MiB) |
| `VOGOBAN_POLICIES` | governance commands | Policy files or directories (default `./vogoban-policies`) |
| `VOGOBAN_ENTERPRISE` | security and ownership commands | Enterprise metadata file (default `./vogoban-enterprise.yaml`; `none` disables) |
| `VOGOBAN_AI`, `VOGOBAN_AI_PROVIDER`, `VOGOBAN_AI_MODEL`, `VOGOBAN_AI_ENDPOINT`, `VOGOBAN_AI_API_KEY_ENV` | AI commands | AI configuration file and overrides (see [ai.md](ai.md)) |
| `VOGOBAN_BIN` | `hooks install` | Command written into Git hooks (default `vogoban`) |
| `VOGOBAN_DEBUG=1` | all commands | Print stack traces for internal errors |
| `VOGOBAN_CORRELATION_ID`, `VOGOBAN_JOB_ID` | all commands | Added to every log record (used by platform workers) |
| `VOGOBAN_PLATFORM_CONFIG` and other `VOGOBAN_*` platform settings | `platform` | See [platform.md](platform.md) |

## Command index

Every command and subcommand, with the page that documents it.

### Analysis and repository graph

| Command | Purpose | Page |
| --- | --- | --- |
| `analyze <path>` | Analyze a repository into the graph store | [analyze.md](analyze.md) |
| `repos` | List repositories in the store | [graph.md](graph.md) |
| `repo [repo]` | Repository metadata and analysis runs | [graph.md](graph.md) |
| `stats` | Entity, relationship, evidence, unresolved and diagnostic counts | [graph.md](graph.md) |
| `show <entity>` | Identity, location and every relationship of one entity | [graph.md](graph.md) |
| `deps <entity> [--reverse]` | Dependency (or dependent) traversal | [graph.md](graph.md) |
| `callers <method> [--dispatch]` | Callers of a method | [graph.md](graph.md) |
| `callees <method>` | Methods called by a method | [graph.md](graph.md) |
| `implementations <type\|member>` | Implementations, derived types, overrides, DI registrations | [graph.md](graph.md) |
| `inheritance <type\|member>` | Ancestors and descendants | [graph.md](graph.md) |
| `references <entity>` | Resolved references with source locations | [graph.md](graph.md) |
| `path <from> <to>` | Shortest relationship path between two entities | [graph.md](graph.md) |
| `projects` | Project reference graph with cycle detection | [graph.md](graph.md) |
| `project <project>` | Frameworks, assembly, references, packages, compilation state | [graph.md](graph.md) |
| `shared` | Entities referenced from more than one repository | [graph.md](graph.md) |
| `find <text> [--kind K]` | Search entities by name or qualified name | [search.md](search.md) |

### Application graph (ASP.NET Core and generic host)

| Command | Purpose | Page |
| --- | --- | --- |
| `applications` | Detected applications with detection signals | [application.md](application.md) |
| `endpoints` | HTTP endpoints with verb, route, authorization, handler | [application.md](application.md) |
| `endpoint <id\|"VERB /route">` | One endpoint in detail | [application.md](application.md) |
| `routes` | Effective routes and route groups | [application.md](application.md) |
| `services` | Dependency-injection registrations of application services | [application.md](application.md) |
| `registrations` | All DI registrations including framework `Add*` calls | [application.md](application.md) |
| `middleware` | Middleware pipelines in static source order | [application.md](application.md) |
| `hosted-services` | Hosted services and their registration | [application.md](application.md) |
| `authorization` | Authorization metadata with endpoint counts | [application.md](application.md) |
| `config` | Configuration keys and environment variables read by code | [application.md](application.md) |

### Contract graph (APIs and messaging)

| Command | Purpose | Page |
| --- | --- | --- |
| `apis` | APIs (OpenAPI and code-first) with operation counts | [contracts.md](contracts.md) |
| `api <id\|name>` | Operations of one API | [contracts.md](contracts.md) |
| `operations` | API operations with filters | [contracts.md](contracts.md) |
| `operation <id\|"VERB /path">` | Contract, implementation, consumers, schemas of one operation | [contracts.md](contracts.md) |
| `openapi` | OpenAPI documents with parse status | [contracts.md](contracts.md) |
| `contracts` | All contract entities | [contracts.md](contracts.md) |
| `contract <id>` | Any contract entity with its relationships | [contracts.md](contracts.md) |
| `messages` | Message contracts with publishers, consumers, transports | [contracts.md](contracts.md) |
| `message <id\|name>` | One message contract in detail | [contracts.md](contracts.md) |
| `publishers` / `consumers` | Message publishers or consumers | [contracts.md](contracts.md) |
| `transports` | Topics, exchanges and queues with senders and receivers | [contracts.md](contracts.md) |
| `http-clients` | HTTP clients and every static HTTP call | [contracts.md](contracts.md) |
| `contract-provenance <id>` | Sources and evidence of a contract entity | [contracts.md](contracts.md) |
| `unresolved-contracts` | Unresolved operations, calls, `$ref`s, message types, transports | [contracts.md](contracts.md) |

### Frontend graph

| Command | Purpose | Page |
| --- | --- | --- |
| `frontend` | npm packages, frontend applications, roles, routes, HTTP resolution | [frontend.md](frontend.md) |
| `components [--role R]` | Components, hooks, services, guards, interceptors | [frontend.md](frontend.md) |
| `frontend-routes [--app A]` | Angular, React Router and Next.js routes | [frontend.md](frontend.md) |
| `frontend-chain <entity>` | Route or component through HTTP calls to API operations and backend handlers | [frontend.md](frontend.md) |

### Azure graph

| Command | Purpose | Page |
| --- | --- | --- |
| `azure` / `azure summary` | Functions, resources by service, unresolved Azure references | [azure.md](azure.md) |
| `azure functions` | Azure Functions with triggers, bindings, hosting, auth level | [azure.md](azure.md) |
| `azure triggers` | Trigger source to Function rows | [azure.md](azure.md) |
| `azure resources [--kind K]` | Declared Azure resources with name resolution state | [azure.md](azure.md) |
| `azure messaging` | Service Bus, Event Hubs, Event Grid, Storage queues | [azure.md](azure.md) |
| `azure infrastructure` | IaC files, hosting, identity, roles, observability | [azure.md](azure.md) |
| `azure flow <entity>` | Architecture flow downstream or upstream | [azure.md](azure.md) |

### Infrastructure graph

| Command | Purpose | Page |
| --- | --- | --- |
| `infrastructure` | Infrastructure statistics | [infrastructure.md](infrastructure.md) |
| `pipelines` | Azure Pipelines with triggers, stages, artifacts, builds, deployments | [infrastructure.md](infrastructure.md) |
| `pipeline <id\|file>` | One pipeline in detail | [infrastructure.md](infrastructure.md) |
| `artifacts` | Build artifacts with producers and consumers | [infrastructure.md](infrastructure.md) |
| `images` | Container images with builders, packaged applications, deployments | [infrastructure.md](infrastructure.md) |
| `docker` | Dockerfiles with stages and packaged projects | [infrastructure.md](infrastructure.md) |
| `helm` | Helm charts, releases and rendered resources | [infrastructure.md](infrastructure.md) |
| `deployments` | Kubernetes workloads | [infrastructure.md](infrastructure.md) |
| `k8s-services` / `ingress` | Kubernetes services and ingress routes | [infrastructure.md](infrastructure.md) |
| `configuration [secret\|env\|configmap]` | Configuration entries, environment variables, secret references | [infrastructure.md](infrastructure.md) |
| `environments` | Environments and the resources declared for them | [infrastructure.md](infrastructure.md) |
| `topology` | Application to image to workload to service to ingress | [infrastructure.md](infrastructure.md) |
| `unresolved-infrastructure` | Unresolved infrastructure relationships | [infrastructure.md](infrastructure.md) |

### Diagnostics and evidence

| Command | Purpose | Page |
| --- | --- | --- |
| `unresolved` | Unresolved references with reasons | [diagnostics.md](diagnostics.md) |
| `conflicts` | Conflicting facts | [diagnostics.md](diagnostics.md) |
| `provenance <id>` | Evidence for an entity, relationship or unresolved reference | [diagnostics.md](diagnostics.md) |
| `privacy` / `diagnostics` | Privacy and data-boundary report (`diagnostics` is an alias) | [diagnostics.md](diagnostics.md) |

### Impact and architecture analysis

| Command | Purpose | Page |
| --- | --- | --- |
| `impact <entity...>` | Change impact with explanation paths | [impact.md](impact.md) |
| `blast-radius <entity...>` | Structural exposure score | [impact.md](impact.md) |
| `dependencies <entity>` / `dependents <entity>` | Direct, indirect and transitive dependencies | [impact.md](impact.md) |
| `paths <from> <to>` | All relationship paths with direction and kind filters | [impact.md](impact.md) |
| `api-impact <operation>` | Impact of an API change | [impact.md](impact.md) |
| `message-impact <message>` | Producer, consumer, contract and transport impact | [impact.md](impact.md) |
| `service-impact <application>` | Upstream and downstream impact of a service | [impact.md](impact.md) |
| `repository-impact <repo>` | Cross-repository impact | [impact.md](impact.md) |
| `risk <entity...>` | Change-risk score (`risk --diff` is in [diff.md](diff.md)) | [impact.md](impact.md) |
| `cycles` | Project, repository, service or relationship cycles | [impact.md](impact.md) |
| `orphaned` | Structures with no observed consumer | [impact.md](impact.md) |

### Snapshots and diff

| Command | Purpose | Page |
| --- | --- | --- |
| `diff` / `graph diff` | Graph diff between snapshots | [diff.md](diff.md) |
| `graph-snapshots` | Stored graph snapshots | [diff.md](diff.md) |

### Incremental synchronization and hooks

| Command | Purpose | Page |
| --- | --- | --- |
| `graph sync [path]` | Update the graph incrementally (also `sync`) | [sync.md](sync.md) |
| `graph status [path]` | Whether the graph matches the checkout (also `sync-status`) | [sync.md](sync.md) |
| `graph changes [path]` | The detected change set (also `sync-changes`) | [sync.md](sync.md) |
| `graph history [path]` | Recent synchronizations (also `sync-history`) | [sync.md](sync.md) |
| `hooks install\|uninstall\|status` | Optional Git hooks | [hooks.md](hooks.md) |

### MetaGraph (multi-repository)

| Command | Purpose | Page |
| --- | --- | --- |
| `register <path>` | Add a repository to the catalog | [metagraph.md](metagraph.md) |
| `analyze-repo <repo>` / `analyze-all` | Analyze catalog repositories | [metagraph.md](metagraph.md) |
| `repositories` / `repository <repo>` | Catalog entries and status | [metagraph.md](metagraph.md) |
| `metagraph [build\|stats\|snapshots\|unresolved\|conflicts\|export]` | Build and inspect the MetaGraph | [metagraph.md](metagraph.md) |
| `connections [repo]` | Cross-repository relationships | [metagraph.md](metagraph.md) |
| `providers` / `api-providers` | Provider repositories of an API | [metagraph.md](metagraph.md) |
| `api-consumers` | Consumers of an API | [metagraph.md](metagraph.md) |
| `message-publishers` / `message-consumers` | Publishers or consumers of a message across repositories | [metagraph.md](metagraph.md) |
| `shared-packages` | Packages used by several repositories | [metagraph.md](metagraph.md) |
| `external-systems` | External systems and databases | [metagraph.md](metagraph.md) |
| `metagraph-topology <repo>` | Downstream or upstream repositories | [metagraph.md](metagraph.md) |

### Governance

| Command | Purpose | Page |
| --- | --- | --- |
| `validate-rules` | Validate policy files | [governance.md](governance.md) |
| `policies` / `policy <id>` | Loaded policies | [governance.md](governance.md) |
| `rules` / `rule <id>` | Rules; `rule` also evaluates one | [governance.md](governance.md) |
| `governance` | Evaluate all rules (exit 0/3/4) | [governance.md](governance.md) |
| `violations` | Violations with path and evidence | [governance.md](governance.md) |
| `exceptions` | Policy exceptions | [governance.md](governance.md) |
| `baseline save\|list\|show` | Violation baselines | [governance.md](governance.md) |
| `governance-diff` | New, resolved and unchanged violations | [governance.md](governance.md) |

### Security, ownership and enterprise metadata

| Command | Purpose | Page |
| --- | --- | --- |
| `validate-enterprise` | Validate enterprise metadata | [security.md](security.md) |
| `security` / `security-posture` | Posture indicators (and findings) | [security.md](security.md) |
| `security-findings` | Findings with evidence | [security.md](security.md) |
| `security-endpoints` | Endpoint exposure and protection | [security.md](security.md) |
| `secrets` | Secret references (never values) | [security.md](security.md) |
| `sensitive-resources` | Classified data stores and other sensitive resources | [security.md](security.md) |
| `trust-boundaries` / `security-flows` | Boundary crossings and public-entry flows | [security.md](security.md) |
| `ownership` / `owners` / `unowned` / `ownership-conflicts` | Component ownership | [security.md](security.md) |
| `ownership-history <component>` | Owners across snapshots | [security.md](security.md) |
| `teams` / `team-dependencies` / `team-impact` | Teams and cross-team dependencies | [security.md](security.md) |
| `security-impact <component>` | Blast radius of a security-sensitive component | [security.md](security.md) |
| `inventory` | Governance-sensitive components | [security.md](security.md) |
| `governance-context <entity>` | Rules, violations, findings and ownership for one component | [security.md](security.md) |
| `security-diff` / `ownership-diff` | Snapshot comparison | [security.md](security.md) |

### AI and MCP

| Command | Purpose | Page |
| --- | --- | --- |
| `ask` / `ai` / `ai-query` | Answer a question from graph evidence | [ai.md](ai.md) |
| `explain <what> <ref>` | Evidence-backed explanation (`service`, `repository`, `api`, `message`, `deployment`, `entity`, `path`, `dependency`, `violation`, `finding`) | [ai.md](ai.md) |
| `ai-plan` | Show the query plan without executing it | [ai.md](ai.md) |
| `ai-tools` / `mcp-tools` | Graph tools and their input schemas | [ai.md](ai.md) |
| `ai-tool <tool> [json]` | Run one graph tool | [ai.md](ai.md) |
| `ai-config` | AI provider configuration and destination | [ai.md](ai.md) |
| `ai-audit [record-id]` | AI answer audit records | [ai.md](ai.md) |
| `mcp` | MCP server on stdio | [ai.md](ai.md) |

### Export, backup and restore

| Command | Purpose | Page |
| --- | --- | --- |
| `export --format json\|jsonl\|csv --out <path>` | Export the graph | [backup-restore.md](backup-restore.md) |
| `backup --out <path>` | Single-file copy of the store | [backup-restore.md](backup-restore.md) |
| `restore --from <path>` | Replace the store from a backup | [backup-restore.md](backup-restore.md) |

### Enterprise platform

| Command | Purpose | Page |
| --- | --- | --- |
| `platform serve` | API, web application, MCP over HTTP, webhooks | [platform.md](platform.md) |
| `platform worker [--once]` | Background analysis worker | [platform.md](platform.md) |
| `platform migrate [status\|up\|down]` | Platform database migrations | [platform.md](platform.md) |
| `platform config` | Effective platform configuration | [platform.md](platform.md) |
| `platform tenant create\|list` | Tenants | [platform.md](platform.md) |
| `platform token create` | Service tokens | [platform.md](platform.md) |
| `platform audit verify <tenant>` | Verify the audit hash chain | [platform.md](platform.md) |
| `platform help` | Platform command help | [platform.md](platform.md) |

## Related

- [analyze.md](analyze.md): building the graph
- [search.md](search.md): finding entities and common search recipes
- [concepts.md](../concepts.md): entities, relationships, evidence levels
- [troubleshooting.md](../advanced/troubleshooting.md)
