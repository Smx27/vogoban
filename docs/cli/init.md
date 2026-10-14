# `vogoban init`

`vogoban init [path]` creates private, repository-scoped Vogoban state at `<repository>/.vogoban/`. It detects repository languages, frameworks, package managers and supported analyzers, then writes only `.vogoban/config.json` plus local workspace directories. It never creates a graph database, resets a graph, clears a cache, or overwrites existing configuration.

In an interactive terminal, init shows a local Figlet banner and a keyboard-driven wizard. Use the arrow keys to choose the recommended, full, minimal, custom, or discovery-only scope. Custom selection uses Space to toggle analyzer groups and Enter to continue. The wizard also configures exclusion patterns, semantic analysis, incremental graph sync, snapshot capture, and whether to open the graph after interactive analysis. A final review and confirmation happens before any workspace files are written. Ctrl+C cancels with exit code 130; declining the final confirmation writes nothing.

Re-running init reports the existing workspace and preserves its configuration, graph, cache, and snapshots. Use [`vogoban configure`](configure.md) for deliberate settings changes; init refuses to overwrite an existing workspace even when new setting flags are supplied. Invalid existing configuration is reported, never silently replaced.

For scripts, `--json`, `--no-interactive`, `--yes`, redirected input/output, CI, or a dumb terminal disables the wizard. Noninteractive init accepts defaults or explicit settings and creates no graph database:

```bash
vogoban init . --yes
vogoban init . --json --analyzers dotnet,frontend,contracts --no-semantic --exclude generated,examples/**
```

All settings live in `.vogoban/config.json`. Analyzer groups and exclusions control the analysis pipeline, including frontend semantic reads and Roslyn evaluated Compile sources. `analyze` always runs a full analysis of the selected scope; the incremental preference controls `graph sync`. Disabling snapshots prevents new captures without deleting existing snapshots. `NO_COLOR` disables terminal coloring, including prompt themes; machine-readable output never includes banners or terminal control sequences.

Run `vogoban analyze <path>` after initialization to create the local graph. `vogoban graph <path>` serves the graph on loopback only.
