# Diagnostics, unresolved references and evidence

Vogoban reports what it could not determine instead of guessing. This page covers the commands that show those gaps and the evidence behind facts: `unresolved` (references that could not be bound), `conflicts` (facts that contradict each other), `provenance` (where any fact came from), how to see **analysis diagnostics** (parse, compile and discovery problems), and the `privacy` report and its `diagnostics` alias.

Examples run inside the `contoso-orders` demo repository unless stated. Your ids will differ.

## Kinds of "problem" records

| Record | What it means | Where to see it |
| --- | --- | --- |
| Unresolved reference | Vogoban saw a reference (a call, a queue name, a route backend, a lazy import) but could not identify the target statically | `unresolved`, `unresolved-contracts`, `unresolved-infrastructure`, `show` (per entity), `stats` (by category) |
| Conflict | Two facts claim the same thing differently (two ingresses for one route, two producers for one image tag, two schemas for one message) | `conflicts` |
| Analysis diagnostic | A problem during analysis: a skipped file, a syntax error, a compiler error, a crashed plugin, an invalid `vogoban.json` | `stats`, `analyze --json`, `stats --json`, `export` |

Unresolved references and conflicts are part of the graph. They are not errors in Vogoban, and most real repositories have some. They mark the places where static analysis stops and a human (or runtime data) has to decide.

## unresolved

### What it does

Lists unresolved references of all kinds with the reference type, the target as written, the source entity, the reason, and the location.

### Usage

```bash
vogoban unresolved [--repo <repo>] [--limit N] [--json]
```

### Example

```bash
vogoban unresolved
```

### Output

```text
type      target                            source                                                                            reason                                                location
--------  --------------------------------  --------------------------------------------------------------------------------  ----------------------------------------------------  --------------------------------------------------
SENDS_TO  SendMessageAsync (sender entity)  Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Collections.…  sender is not created by a visible CreateSender call  src/Contoso.Orders.Api/Services/OrderService.cs:28
```

In the `lazy-routes` test fixture (Angular and React lazy routes), the unresolved list explains the routes whose component is unknown:

```text
type                 target                                                                       source                 reason                                                             location
-------------------  ---------------------------------------------------------------------------  ---------------------  -----------------------------------------------------------------  ------------
LOADS_COMPONENT      () => import("./orders/orders.component").then((m) => m["OrdersComponent"])  lazy-angular:/lookup   lazy loader selects an export with an unsupported expression       angular/src/…
LOADS_COMPONENT      () => import(loaderName).then((m) => m.OrdersComponent)                      lazy-angular:/dynamic  lazy loader is not a static import() of a repository module        angular/src/…
ROUTES_TO_COMPONENT  lazy(() => import(pageName))                                                 lazy-react:/dynamic    React.lazy loader is not a static import() of a repository module  react/src/ro…
```

`type` is the relationship that would have been created. The category of each entry (for example `dynamic-transport-name`, `dependent-on-unresolved-type`, `selector-unmatched`) is in `--json` and is counted by `vogoban stats`.

### Useful options

`--limit N` (default 100). For focused lists use `unresolved-contracts` ([contracts.md](contracts.md#unresolved-contracts)) and `unresolved-infrastructure` ([infrastructure.md](infrastructure.md#unresolved-infrastructure)), which add a category column.

### Common mistakes

A sudden jump in `dependent-on-unresolved-type` entries means types from referenced assemblies could not be loaded, usually because the project was not restored or was analyzed with `--untrusted`. Fix the environment, not the code.

## conflicts

### What it does

Lists conflicts: facts that contradict each other, with severity, status, kind, description and the ids of the conflicting facts. Conflict kinds include `conflicting-ingress-route`, `conflicting-image-tag`, `conflicting-image-producer`, `conflicting-package-producer`, `conflicting-service-host`, `conflicting-message-schema` and `conflicting-infrastructure-declaration`.

### Usage

```bash
vogoban conflicts [--repo <repo>] [--json]
```

### Example

In a repository where two Kubernetes Ingress manifests both claim `shop.contoso.com/api`:

```bash
vogoban conflicts
```

### Output

```text
[warning/unresolved] conflicting-ingress-route: route shop.contoso.com/api is declared by 2 ingresses
  facts: e_923fdcf1975a2572483e2672, e_86f9d67a6c175ee1a9f63b59
```

Pass the fact ids to `vogoban show` to inspect each side. With no conflicts the command prints `No conflicts.`. Vogoban keeps both facts; it does not pick a winner.

## provenance

### What it does

Shows the evidence for an entity, a relationship or an unresolved reference: every extractor that produced it, the mechanism (Roslyn semantic model, framework rules, IaC resolution, ...), the exact source location with column, the repository, commit and analyzer version, and when the fact was first and last seen.

### Usage

```bash
vogoban provenance <entity | relationship id | unresolved id> [--kind K] [--json]
```

Entity references work as everywhere else; relationship ids (`r_…`) and unresolved ids (`u_…`) come from `--json` output of `show`, `unresolved` and other commands.

### Example

```bash
vogoban provenance OrderSubmitted --kind Message
```

### Output

```text
entity OrderSubmitted
  first seen ccaffed660b7f947a60737e24447c6ace2a90559 (run run_e34a0483c00f51f09da9bf04), last seen ccaffed660b7f947a60737e24447c6ace2a90559 (run run_e34a0483c00f51f09da9bf04)
  - dotnet.messaging.azure-service-bus/SERVICE_BUS_SEND via roslyn-semantic-model+framework-rules @ src/Contoso.Orders.Api/Services/OrderService.cs:28:15  repo=e_9a2cfe3a9823cb05539c79e5 commit=ccaffed660b7 v0.1.0/1
  - azure.resolver/FUNCTION_TRIGGER_PAYLOAD via roslyn-semantic-model+framework-rules @ src/Contoso.Orders.Functions/OrderFunctions.cs:18:31  repo=e_9a2cfe3a9823cb05539c79e5 commit=ccaffed660b7 v0.1.0/1+323b31cc3e63
```

For a relationship (here the Service Bus `TRIGGERS` relationship of the `ProcessOrder` Function, id taken from `vogoban show ProcessOrder --kind AzureFunction --json`):

```bash
vogoban provenance r_26aab6bc85f2cc30ebbf5d88
```

```text
relationship r_26aab6bc85f2cc30ebbf5d88
  first seen ccaffed660b7f947a60737e24447c6ace2a90559 (run run_e34a0483c00f51f09da9bf04), last seen ccaffed660b7f947a60737e24447c6ace2a90559 (run run_e34a0483c00f51f09da9bf04)
  - azure.resolver/SERVICEBUSTRIGGER_BINDING via azure-resource-resolution resolver=azure.resolver @ src/Contoso.Orders.Functions/OrderFunctions.cs:18:31  repo=e_9a2cfe3a9823cb05539c79e5 commit=ccaffed660b7 v0.1.0/1+323b31cc3e63
```

Each line is `plugin/extractor via mechanism [resolver=…] @ file:line:column`. `first seen`/`last seen` track the fact across analysis runs and synchronizations.

### Common mistakes

The header repeats what you typed (`entity OrderSubmitted`), not the resolved name. Check the locations to confirm it is the entity you meant. For contract entities, [`contract-provenance`](contracts.md#contract-provenance) adds the list of source files and conflicting definitions.

## Analysis diagnostics

Analysis diagnostics are recorded per repository with a category (`discovery`, `parser`, `project`, `semantic`, `compilation`, `framework`, `resolver`), a plugin, a code, a severity, the file and a message. Common codes:

| Code | Category | Meaning |
| --- | --- | --- |
| `file-skipped` | discovery | File not analyzed: over the size limit (`FILE_SKIPPED_RESOURCE_LIMIT`), symbolic link, submodule, nested repository, frontend build output |
| `config-invalid` | discovery | `vogoban.json` could not be parsed |
| `syntax-error` | parser | tree-sitter found a syntax error (up to 5 per file) |
| `parse-failed` | parser | A file could not be parsed at all |
| `CS…`, `compilation-errors` | compilation | Roslyn compiler errors (missing restore, unsupported build logic, broken code) |
| `plugin-failed` | any | A whole plugin crashed; its facts are missing and `analyze` warns that the graph is degraded |

### How to see them

`vogoban diagnostics` does **not** list them in 0.18.0 (it is an alias of `privacy`, see below). Use one of these:

**Counts by category** with `vogoban stats` (the `Diagnostics` table and the `diagnostics=` total). In a repository with a broken C# file and two files over a lowered size limit:

```bash
VOGOBAN_MAX_SOURCE_FILE_BYTES=600 vogoban analyze .
vogoban stats
```

```text
…
Diagnostics
category     count
-----------  -----
compilation  2
discovery    2
parser       1

files=9 unresolved=2 diagnostics=5 conflicts=0
```

**Counts as JSON** with `vogoban stats --json` (`diagnosticsByCategory`) or `vogoban analyze . --json` (`stats.diagnosticsByCategory`; `run.stats.diagnostics` is the total).

**Each diagnostic** with `vogoban export`. In JSON Lines every diagnostic is a record with `"record":"diagnostic"`:

```bash
vogoban export --format jsonl --out graph.jsonl
grep '"record":"diagnostic"' graph.jsonl
```

```text
{"record":"diagnostic","id":"d_0d615dabd38bc1a9480f369f","repositoryId":"e_442dc0180722642c78628469","category":"compilation","plugin":"dotnet.roslyn","file":"src/Contoso.Shipping.Api/Broken.cs","severity":"info","recoverable":true,"code":"CS1026","message":") expected (line 3)"}
{"record":"diagnostic","id":"d_1d48e8940f9fe0bd907e5d7d","repositoryId":"e_442dc0180722642c78628469","category":"discovery","plugin":"vogoban.core","file":"azure-pipelines.yml","severity":"warning","recoverable":true,"code":"file-skipped","message":"FILE_SKIPPED_RESOURCE_LIMIT: file size 1470 bytes exceeds the source limit of 600 bytes (VOGOBAN_MAX_SOURCE_FILE_BYTES)"}
{"record":"diagnostic","id":"d_de67e7bed584ec8f7a9549af","repositoryId":"e_442dc0180722642c78628469","category":"parser","plugin":"csharp.tree-sitter","file":"src/Contoso.Shipping.Api/Broken.cs","severity":"warning","recoverable":true,"code":"syntax-error","message":"unexpected syntax '(' at 3:16"}
…
```

`export --format json` puts them in a `diagnostics` array. See [backup-restore.md](backup-restore.md) for the export formats.

**Progress logs** during analysis: `vogoban analyze . --log-level debug` (or `--log-json`) shows per-plugin events, including `plugin.failed` and Roslyn `compilerErrors` counts per project.

Per project, `vogoban project <name> --kind Project` shows `compilation errors=… warnings=…`.

## privacy (alias: diagnostics)

### What it does

Prints the privacy and data-boundary report for the current configuration: operating mode, telemetry status, phone-home behaviour, where the graph is stored, whether an AI provider is configured and whether graph evidence would leave the machine, Git remotes, hosted status and the complete list of outbound network destinations.

`vogoban diagnostics` is an alias of `vogoban privacy` and prints the same report.

### Usage

```bash
vogoban privacy [--mode LOCAL|SELF_HOSTED|HOSTED] [--offline] [--json]
vogoban diagnostics [--mode …] [--offline] [--json]
```

### Example

```bash
vogoban diagnostics
```

### Output

```text
Operating mode: LOCAL
Telemetry: OFF (none implemented; no vendor endpoint exists in this product)
Phone-home: none  ·  update checks: none  ·  crash reporting: none  ·  license heartbeat: none
Storage: local sqlite at .vogoban/graph.db (architecture data stays local)
AI: not configured (deterministic answers only; no external calls)
MCP: local stdio (…) — no vendor dependency
Git: analysis reads the local checkout only. Configured remotes: (local path only)
Hosted platform: disabled — hosted platform is not used; no data leaves this machine
Outbound network for this configuration: none
```

With `--offline` (or `VOGOBAN_OFFLINE=1`) the first line reads `Operating mode: LOCAL (OFFLINE: external AI endpoints are refused)`. With an external AI provider configured, the `AI:` line names the destination and says graph evidence is sent there when you run `ask` or `explain` without `--no-llm`, and the outbound list includes it. `Configured remotes` lists only the host names of Git remotes.

`--json` returns the same report as structured data: `mode`, `offline`, `telemetry`, `phoneHome`, `storage`, `ai` (`provider`, `destination`, `external`, `sendsGraphContext`, `credentialRef`), `mcp`, `git`, `hosted`, `outboundNetwork`.

### Common mistakes

- Expecting `vogoban diagnostics` to list analysis problems. It prints the privacy report; the help text line `unresolved | diagnostics | conflicts` and the `analyze` hint "see 'diagnostics'" refer to an analysis-diagnostics view that is not reachable in 0.18.0. Use the methods in [Analysis diagnostics](#analysis-diagnostics).
- `--mode` only changes what the report says. It does not switch the CLI into a different mode of operation.

## Related

- [analyze.md](analyze.md#diagnostics-and-the-degraded-graph-warning): when diagnostics are produced
- [privacy.md](../advanced/privacy.md): the data boundary in detail
- [evidence-provenance.md](../architecture/evidence-provenance.md): how evidence and provenance are recorded
- [troubleshooting.md](../advanced/troubleshooting.md)
