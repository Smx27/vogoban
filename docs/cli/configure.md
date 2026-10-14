# `vogoban configure`

`vogoban configure [path]` deliberately updates the existing repository-local `.vogoban/config.json`. It never resets the graph, clears caches, deletes snapshots, or analyzes the repository. Run `vogoban init` first if there is no workspace.

In a terminal, the wizard starts from the current settings, offers analyzer selection, and presents a final review before saving. Declining confirmation or pressing Ctrl+C before saving leaves the workspace unchanged. Configuration is written with an atomic file replacement; edits detected while the wizard is open are rejected rather than silently overwritten. Unknown existing configuration fields are preserved.

For automation, supply explicit settings. Noninteractive configure without setting flags is rejected rather than guessing what should change:

```bash
vogoban configure .
vogoban configure . --json --analyzers dotnet,frontend,contracts --no-semantic
vogoban configure . --no-interactive --exclude generated,**/*.generated.cs --no-snapshots
vogoban configure . --incremental --snapshots --no-open
```

## Analyzer groups

| ID               | Scope                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `dotnet`         | MSBuild, C# syntax and Roslyn, .NET applications/frameworks, DI, HTTP clients and messaging.                |
| `frontend`       | Frontend workspaces, TypeScript/JavaScript syntax and semantics, modules, HTTP, Angular and React.          |
| `azure`          | Azure Functions, SDK usage, Aspire, Azure TypeScript, cloud declarations and Azure relationship resolution. |
| `infrastructure` | Docker, pipelines, Helm, Kubernetes, App Configuration and infrastructure resolution.                       |
| `contracts`      | OpenAPI and API/message contract resolution.                                                                |
| `ownership`      | CODEOWNERS rules.                                                                                           |

`--analyzers none` selects discovery only. Unknown group IDs are errors. Azure source extractors and contract resolvers consume facts from the selected language analyzers; selecting a resolver does not silently re-enable a language group. Recommended scope includes supported groups for the detected repository signals; it does not assert that every domain has observed facts.

## Settings and overrides

| Flag                                 | Effect                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--analyzers <ids>`                  | Replace the enabled group list with comma-separated IDs, or `none`.                                                                                                             |
| `--exclude <patterns>`               | Replace discovery exclusions with comma-separated directory names or root-relative globs. `none` or an empty value clears custom exclusions; built-in safety exclusions remain. |
| `--semantic` / `--no-semantic`       | Enable or disable semantic language analysis.                                                                                                                                   |
| `--incremental` / `--no-incremental` | Allow incremental `graph sync` or force full syncs. `analyze` remains full analysis.                                                                                            |
| `--snapshots` / `--no-snapshots`     | Enable or disable new automatic graph snapshots. Existing snapshots remain intact.                                                                                              |
| `--open` / `--no-open`               | Automatically open the graph after interactive analysis, or suppress graph opening.                                                                                             |

`configure` saves these settings. On `analyze` and `graph sync`, analysis flags override the saved settings for that run only and never rewrite configuration. Changing analysis settings invalidates a previously current incremental graph so it is rebuilt rather than incorrectly reported as unchanged. With snapshots disabled, sync does not provide a before/after snapshot diff.

Graph-opening prompts and browser launches are suppressed for JSON, CI, redirected input/output, `--yes`, and `--no-interactive`. In an interactive analysis, `--open` or the saved `openAfterAnalysis: true` preference starts a loopback server, prints its URL and tries the system browser. Otherwise, the CLI offers to open the graph with a default of No; `--no-open` suppresses that offer too. If browser launching is unavailable, the printed URL still works. Ctrl+C stops the server.

Malformed or unsupported existing configuration must be repaired explicitly. Configure does not discard it and start over. .NET semantic analysis still requires the SDK and honors the existing trusted/untrusted repository boundary; exclusions do not make execution of untrusted MSBuild files safe.
