# Privacy, data boundaries and operating modes

The local CLI and the local MCP server run entirely on your machine against a local SQLite graph, with no telemetry and no phone-home of any kind. This page lists exactly where data can go, how to check it for your configuration, and how to keep everything offline.

There is no analytics endpoint, usage beacon, crash reporter, update check or license heartbeat anywhere in Vogoban. You do not need an account, a login or any vendor service to analyze repositories, query the graph and MetaGraph, run impact, governance, security or ownership analysis, use AI with a local model, or serve MCP.

## Check the data boundary

`vogoban privacy` prints the data boundary of your current configuration: operating mode, telemetry status, storage location, AI destination, configured Git remotes, hosted status and every outbound network destination implied by the configuration. It never prints secret values; credentials appear only as the name of the environment variable they come from.

```bash
vogoban privacy
```

```text
Operating mode: LOCAL
Telemetry: OFF (none implemented; no vendor endpoint exists in this product)
Phone-home: none  ·  update checks: none  ·  crash reporting: none  ·  license heartbeat: none
Storage: local sqlite at .vogoban/graph.db (architecture data stays local)
AI: not configured (deterministic answers only; no external calls)
MCP: local stdio (…) — no vendor dependency
Git: analysis reads the local checkout only. Configured remotes: none
Hosted platform: disabled — hosted platform is not used; no data leaves this machine
Outbound network for this configuration: none
```

The MCP line (trimmed here) names a source-checkout invocation in 0.18.0; with an installed CLI the stdio server is started with `vogoban mcp`.

`--json` gives the same report as an object with the keys `mode`, `offline`, `telemetry`, `phoneHome`, `storage`, `ai`, `mcp`, `git`, `hosted` and `outboundNetwork`.

`vogoban diagnostics` is an alias of `vogoban privacy` in 0.18.0 and prints this same report. It does not list analysis diagnostics; see [Troubleshooting](troubleshooting.md#diagnostics-prints-the-privacy-report).

Like every graph command, `privacy` opens the store named by `--db`/`VOGOBAN_DB` (default `./.vogoban/graph.db`) and creates it if it does not exist.

## Operating modes

The mode is explicit and never inferred from network connectivity. Local use needs no mode and no account.

| Mode | Meaning |
|---|---|
| `LOCAL` (default) | Everything stays on this machine. No hosted platform, no account, no outbound network except an AI provider you configure yourself. |
| `SELF_HOSTED` | You run the platform (PostgreSQL, API, workers) on your own infrastructure; data stays in your deployment. OIDC and OTLP tracing are available but off until you configure them. |
| `HOSTED` | You explicitly point at a hosted platform endpoint (`VOGOBAN_HOSTED_ENDPOINT`). Never turned on for you; `privacy` shows the endpoint. |

Set it with `--mode LOCAL|SELF_HOSTED|HOSTED` or `VOGOBAN_MODE`. It only changes what `privacy` reports; local analysis is identical in all three modes.

`VOGOBAN_MODE` is also read by the platform, which accepts only `local` and `enterprise`. With `VOGOBAN_MODE=enterprise` set for the platform, `vogoban privacy` reports `Operating mode: ENTERPRISE`; with `SELF_HOSTED` or `HOSTED` set, `vogoban platform …` refuses to start ("mode must be local or enterprise"). Use `--mode` for the privacy report on hosts that run the platform.

## Where data can go

Local analysis reads only your local Git checkout and writes only the local graph store. Nothing is sent anywhere unless you configure it. There are exactly two configurable outbound destinations:

1. **An AI provider you configure** (`vogoban-ai.yaml`, `--ai-config`, or the `VOGOBAN_AI_*` environment variables). This is the only path by which graph content leaves the machine, and only when you run `ask` or `explain` with an LLM enabled. `privacy` and `ai-config` classify the destination:

   - **LOCAL MODEL**: a loopback endpoint (localhost, 127.0.0.1, ::1). No data leaves the machine.

     ```text
     AI: LOCAL MODEL on this machine (http://localhost:11434/v1)
     ```

   - **USER-CONFIGURED PROVIDER**: an external endpoint you set. Graph evidence within the requested scope is sent there. Before each such call the CLI prints the destination on stderr; `--no-llm` gives a deterministic answer with no external call.

     ```text
     AI: USER-CONFIGURED PROVIDER openai-compatible at api.example.com  [graph evidence is sent here when you run ask/explain without --no-llm]
     Outbound network for this configuration: AI provider (USER-CONFIGURED PROVIDER openai-compatible at api.example.com)
     ```

   Vogoban ships no default AI endpoint and contacts no AI vendor on its own.

2. **A hosted platform endpoint**, only in `HOSTED` mode, and only the one you set.

Analysis itself never uses the network. The Roslyn analyzer is built on first semantic analysis, which downloads NuGet packages once through the .NET SDK; `dotnet restore`, if you run it, contacts your NuGet feeds. Neither sends graph data.

## Offline mode

`--offline` (or `VOGOBAN_OFFLINE=1`) hard-refuses any non-loopback AI endpoint:

```text
Operating mode: LOCAL (OFFLINE: external AI endpoints are refused)
```

The local graph, MetaGraph, analysis, exports, local models and local MCP keep working; an external AI call is refused with a message and the CLI falls back to the deterministic graph result. The product was verified to work inside a network namespace with no interfaces up.

## No vendor lock-in

- Export the full graph to open formats at any time: `vogoban export --format json|jsonl|csv --out <path>`.
- Back up the store with `vogoban backup --out <path>` (a consistent single-file SQLite copy) and restore it with `vogoban restore --from <path>`. Restore closes the store, swaps the file and reopens; graph, MetaGraph, analysis and local MCP use the restored data immediately. See [Backup and restore](backup-restore.md).

None of these touch the network.

## Secrets never persist

Every string an analyzer extracts from a repository (C# literals and argument values, JS/TS literals, IaC defaults, app settings, connection strings, URLs) passes through one redaction filter before it is written anywhere. The fact cache, graph entities, diagnostics, exports, backups, MCP and AI tool results, tenant stores and logs all see only the redacted form (`SharedAccessKey=[redacted]`, `sig=[redacted]`, `[redacted]`). Arguments bound to credential parameters of Azure SDK and credential constructors are redacted regardless of their shape.

The fact cache carries a generation stamp and is purged on the first open after an upgrade that changed the redaction rules, so values cached by an earlier release do not survive.

Accepted edge case: a letters-only value of 32–63 characters that is not bound to a credential-like name or parameter is kept, because it cannot be told apart from an identifier. The `test/security/boundary-secrets` suite checks redaction with canary values in every trust mode.

## Secure defaults for local use

- Telemetry: none exists.
- Phone-home, update checks, crash reporting, license heartbeat: none.
- Hosted platform: disabled; never inferred from connectivity.
- Git hooks: not installed unless you run `vogoban hooks install`; `vogoban hooks status` shows them.
- Account: not required and not requested.
- Configuration is local; there is no remote configuration fetch.

## Related

- [Trust modes](trust-modes.md)
- [AI and MCP](../features/ai.md)
- [Security model](../architecture/security-model.md)
- [Backup and restore](backup-restore.md)
