# Incremental sync commands: graph sync, status, changes, history

`graph sync` keeps an existing graph current by re-analyzing only what a change affects, reconciling the result into the store and recording a new graph version and snapshot. `graph status` tells you whether the graph matches the checkout, `graph changes` shows the change set sync would use, and `graph history` lists past syncs.

Sync always analyzes the **checked-out tree**. The change source (working tree, a commit, a commit range, staged changes) only decides what is re-analyzed. An incremental result is equivalent to a clean full rebuild of the same commit; when incremental reuse would be unsafe, sync runs a full rebuild and says why. How the planner and caches work is described in [Incremental analysis](../features/incremental-analysis.md) and [Incremental engine](../architecture/incremental-engine.md).

All four commands take an optional repository path (default `.`), use the store from `--db`, `$VOGOBAN_DB` or `./.vogoban/graph.db` relative to the current directory, and accept `--json`. The repository must already be in the store (run `vogoban analyze .` once); otherwise sync performs a full analysis.

## Before you start: keep the store out of the change set

If the store lives inside the repository (the default `./.vogoban/graph.db`), its files are untracked changes. `graph status` then reports `CHANGES_DETECTED` with `.vogoban/graph.db`, `-wal` and `-shm` as added `other` files. The same happens with `bin/` and `obj/` after `dotnet restore`. Add them to `.gitignore`, or keep the store outside the repository with `--db` or `VOGOBAN_DB`:

```text
bin/
obj/
.vogoban/
```

A repository without a Git remote gets a `local:<absolute path>` identity. Copying or moving such a checkout makes it a different repository for the store (`graph status` reports `NEVER_ANALYZED`).

## graph sync

### What it does

Detects changes, plans the invalidation scope, re-analyzes affected files and projects, reconciles the graph in one transaction, and records a graph version, a snapshot and a history entry. Every run is classified as **no-op**, **incremental** or **full**. A no-op creates no new graph version.

### Usage

```bash
vogoban graph sync [path] [--since <commit>] [--from <a> --to <b>] [--base <a> --head <b>]
                   [--staged] [--full] [--meta] [--quiet] [--json] [--strict-incremental]
                   [--no-semantic] [--untrusted] [--trust-repository]
```

| Option | Meaning |
| --- | --- |
| *(none)* | Working-tree mode: changes between the last analyzed commit and the checkout, including uncommitted edits. |
| `--since <commit>` | Changes since that commit. |
| `--from <a> --to <b>` | A commit range. `--base`/`--head` are the same, for CI. `--to`/`--head` must resolve to the checked-out commit. |
| `--staged` | Only staged changes. |
| `--full` | Force a full rebuild (plan code `full_requested`; not counted as a fallback). |
| `--meta` | After a successful sync, rebuild the MetaGraph in the same store. |
| `--quiet` | Print nothing (used by hooks). `--json` still prints. |
| `--json` | Print the structured result. |
| `--strict-incremental` | Exit 5 when an incremental request on an existing graph ran as a full rebuild. |
| `--no-semantic` | Syntax-only analysis (no Roslyn). Changing it between runs forces a full rebuild. |
| `--untrusted` | Disable MSBuild evaluation of repository build files. |
| `--trust-repository` | With `--base`/`--head`, keep build evaluation on. Without it, CI-mode sync is untrusted. |

Precedence when several are given: a commit range (`--from/--to/--base/--head`) wins over `--staged`, which wins over `--since`.

### Example

After committing the route change shown in [diff.md](diff.md):

```bash
vogoban graph sync
```

### Output

```text
contoso-orders: INCREMENTAL — 1 file change(s): +0 ~1 -0 renamed 0
  commit ccaffed660b7 -> 0cae16393195  [working-tree]
  graph version 52302929f3b5 -> 13f471b55659
  changed files 1  ·  analyzed 33  ·  affected projects 2
  reconciled entities +2 ~2 -2  relationships +9 ~0 -11
  duration 2113 ms (baseline full 3095 ms)
  domains: api, application, azure, code, messaging, metagraph
  diff: vogoban diff --from gs_cde2ce457ff69559062d15ba --to gs_217c92a3ca9107dc26178aa8
```

| Line | Meaning |
| --- | --- |
| first line | Repository, run kind (`NO-OP`, `INCREMENTAL`, `FULL`, `FULL (FALLBACK)`) and reason. |
| `commit` | Previous analyzed commit → current commit, and the change source (`working-tree`, `since`, `staged`, `commit-range`). |
| `graph version` | Previous → new graph version hash. |
| `changed files · analyzed · affected projects` | Files in the change set, files re-analyzed (changed files plus the import/project closure), projects recompiled. |
| `reconciled` | Entities and relationships created (`+`), updated (`~`) and deleted (`-`). |
| `duration` | This run, and the last full-analysis duration for comparison. |
| `domains` | Planner domains re-derived (code, api, messaging, azure, frontend, infrastructure, metagraph, ...). |
| `diff` | The command that shows what changed architecturally. |

Running it again on the same commit is a no-op:

```text
contoso-orders: NO-OP — graph already reflects the checked-out commit
  commit ccaffed660b7 -> ccaffed660b7  [working-tree]
  graph version 52302929f3b5 -> 52302929f3b5
```

A full rebuild that replaced an incremental request prints a `fallback:` line with the reason and code. Here a CI-mode sync (`--base/--head`, untrusted) ran against a graph built by a trusted local `analyze`:

```bash
vogoban graph sync --base ccaffed --head HEAD --strict-incremental
```

```text
note: repository build evaluation is disabled in CI mode (static analysis only); use --trust-repository on a trusted repository for full fidelity
contoso-orders: FULL (FALLBACK) — repository build evaluation mode changed (on -> off); the analysis trust model differs
  fallback: repository build evaluation mode changed (on -> off); the analysis trust model differs [evaluation_mode_changed] (requested incremental, ran full)
  commit ccaffed660b7 -> 0cae16393195  [commit-range]
  graph version 13f471b55659 -> 4c1292c4b254
  changed files 1  ·  analyzed 33  ·  affected projects 0
  reconciled entities +0 ~4 -6  relationships +0 ~18 -45
  duration 2128 ms (baseline full 2113 ms)
  diff: vogoban diff --from gs_217c92a3ca9107dc26178aa8 --to gs_8dc19bb6ecb81428373083f1
strict incremental: the incremental request ran as a full rebuild (evaluation_mode_changed); exit 5
```

The untrusted rebuild removed 6 entities and 45 relationships that only build evaluation can produce. Without `--strict-incremental` the same run exits 0.

`--full` forces a rebuild:

```text
contoso-orders: FULL — full rebuild requested
  commit 0cae16393195 -> 0cae16393195  [working-tree]
  graph version 4c1292c4b254 -> 13f471b55659
  changed files 0  ·  analyzed 33  ·  affected projects 0
  reconciled entities +6 ~4 -0  relationships +45 ~18 -0
  duration 2383 ms (baseline full 2128 ms)
  diff: vogoban diff --from gs_8dc19bb6ecb81428373083f1 --to gs_217c92a3ca9107dc26178aa8
```

With `--meta` in a multi-repository store, the MetaGraph is rebuilt after the repository sync (`vogoban metagraph snapshots` shows a new snapshot):

```bash
vogoban graph sync ./contoso-fulfillment --meta --db meta/graph.db
```

```text
contoso-fulfillment: INCREMENTAL — 1 file change(s): +0 ~1 -0 renamed 0
  commit 1de8ed1b819b -> 103417fcbc5d  [working-tree]
  graph version cc4370444f9d -> 006a3a3071d3
  changed files 1  ·  analyzed 7  ·  affected projects 1
…
```

### JSON output

`--json` prints one object with these fields:

| Field | Meaning |
| --- | --- |
| `repository`, `repositoryId` | Repository name and id. |
| `requestedMode` | `incremental` or `full` (what you asked for). |
| `actualMode` / `mode` | `noop`, `incremental` or `full` (what ran). |
| `status` | `SUCCESS`, `NO_OP` or `FAILED`. |
| `reason` | Human-readable reason. |
| `fallbackCode`, `fallbackReason` | Null unless a requested incremental sync ran as a full rebuild. |
| `previousCommit`, `currentCommit` | Full commit hashes. |
| `previousGraphVersion`, `graphVersion` | Graph version hashes. |
| `changeSource` | `working-tree`, `since`, `staged` or `commit-range`. |
| `plan` | Invalidation plan: affected files, projects and domains. |
| `metrics` | `changedFiles`, `filesAnalyzed`, `affectedProjects`, `entitiesCreated/Updated/Deleted`, `relationshipsCreated/Updated/Deleted`, `durationMs`, `baselineDurationMs`. |
| `diffSnapshotFrom`, `diffSnapshotTo` | Snapshot ids for `vogoban diff`. Null on a no-op. |
| `degradedPlugins` | Plugins that crashed (exit 4). |
| `error` | Failure message when `status` is `FAILED`. |
| `timestamp` | When the run finished. |
| `metaGraph` | Only with `--meta`: `{"status":"OK"}` or `{"status":"FAILED","error":…}`. |

```bash
vogoban graph sync --base ccaffed --head HEAD --json
```

```json
{
  "repositoryId": "e_ebfb205c403f02991a5b8df1",
  "repository": "contoso-orders",
  "requestedMode": "incremental",
  "actualMode": "noop",
  "mode": "noop",
  "status": "NO_OP",
  "reason": "graph already reflects the checked-out commit",
  "fallbackReason": null,
  "fallbackCode": null,
  "previousCommit": "ccaffed660b7f947a60737e24447c6ace2a90559",
  "currentCommit": "0cae1639319573a79259cbf9b097a30937e73bd7",
  "previousGraphVersion": "4c1292c4b254a63757f88f2c00a590a2",
  "graphVersion": "4c1292c4b254a63757f88f2c00a590a2",
  "changeSource": "commit-range",
  …
  "diffSnapshotFrom": null,
  "diffSnapshotTo": null,
  "degradedPlugins": [],
  "error": null,
  "timestamp": "2026-10-11T17:05:12.363Z"
}
```

With `--json`, the CI-mode `note:` on stderr is not printed.

### Fallback codes

`fallbackCode` is one of:

| Code | Cause |
| --- | --- |
| `missing_base_commit` | The base commit cannot be resolved (deleted branch, shallow clone). |
| `not_a_git_repository` | No reliable change source. |
| `no_existing_graph` | The store has no graph for this repository. |
| `no_prior_run` | No previous run to compare with. |
| `semantic_mode_changed` | `--no-semantic` was toggled. |
| `evaluation_mode_changed` | Build evaluation (trust mode) differs from the previous run. |
| `schema_version_changed` | Graph schema version changed. |
| `analyzer_version_changed` | Analyzer version changed. |
| `plugin_versions_changed` | A plugin version changed. |
| `configuration_changed` | `vogoban.json` or the configuration fingerprint changed. |

`full_requested` is the plan code for `--full`; it is not a fallback and never triggers exit 5.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success, no-op, or safe full-rebuild fallback (see `actualMode`, `fallbackCode`). |
| 1 | Unexpected environment error, for example the store is not writable. The previous graph is preserved. With `--json`, `{"error", "category": "internal"}` is printed. |
| 2 | Invalid request: malformed or unresolvable `--head`/`--to`, commit range outside a Git repository, head not checked out, unreadable path. |
| 3 | Sync failed; the previous graph is preserved and the failure is recorded in history. Also returned when `--meta` fails after a successful repository sync (the previous MetaGraph snapshot is kept). |
| 4 | Succeeded, but the graph is degraded because a plugin crashed (`degradedPlugins`). |
| 5 | `--strict-incremental` and the incremental request ran as a full rebuild. |

```bash
vogoban graph sync --from ccaffed --to nosuchref
```

```text
cannot resolve --head/--to commit: nosuchref
```

(exit 2). An unresolvable **base** (`--from`/`--base`/`--since`) is not an error: sync falls back to a full rebuild of the checkout (`missing_base_commit`) and exits 0, or 5 with `--strict-incremental`.

If a `.git` directory exists but Git cannot answer (binary missing, corrupt or locked index), sync refuses with exit 3, records `FAILED` with reason `git_state_unreadable`, and leaves the previous graph and repository identity untouched.

### Useful options

- In CI, use `--base "$BASE_SHA" --head "$HEAD_SHA" --json` and read `actualMode` and `fallbackCode`. Add `--strict-incremental` if a silent full rebuild must fail the job. See [CI](../advanced/ci.md).
- Keep CI stores separate from local stores, or pass the same trust flag everywhere. Mixing trusted local analysis and untrusted CI sync in one store produces `evaluation_mode_changed` full rebuilds.

### Common mistakes

- Checking out the base commit before syncing a range. `--head`/`--to` must be the checked-out commit; otherwise exit 2.
- Expecting `--trust-repository` to matter without `--base`/`--head`. Local sync is already trusted.
- Concurrent syncs of one repository wait on a lock next to the store. A stale lock held by a live but unrelated PID (for example PID 1 after a crashed container) is not recovered: the sync waits 120 s and fails with "another synchronization of this repository is in progress". Remove the `locks/sync-<repositoryId>.lock` directory next to the store after confirming nothing is running. See [Troubleshooting](../advanced/troubleshooting.md).

## graph status

### What it does

Compares the analyzed commit with the checkout and reports one state: `UP_TO_DATE`, `CHANGES_DETECTED`, `FULL_REBUILD_REQUIRED`, `NEVER_ANALYZED` or `FAILED`. It does not change the store.

### Usage

```bash
vogoban graph status [path] [--json]
```

### Example

```bash
vogoban graph status
```

### Output

Before committing the route change (uncommitted edit):

```text
contoso-orders: CHANGES_DETECTED
  analyzed commit  ccaffed660b7
  working commit   ccaffed660b7 (dirty)
  up to date       no  ·  changed files 1
  last sync        2026-10-11T17:04:36.183Z (noop, NO_OP)
```

A repository that is in the store under a different identity, or not at all:

```text
contoso-orders: NEVER_ANALYZED
  analyzed commit  (never)
  working commit   ccaffed660b7
  up to date       no  ·  changed files 0
  last sync        (none)
  full rebuild     required — repository has not been analyzed
```

`--json` returns `repository`, `repositoryId`, `analyzedCommit`, `workingCommit`, `dirty`, `lastSyncAt`, `lastSyncMode`, `lastSyncStatus`, `fallbackReason`, `state`, `upToDate`, `changedFiles`, `changeSet`, `fullRebuildRequired` and `fullRebuildReason`.

Exit code: 0, or 3 when the state is `FAILED`.

### Common mistakes

- Seeing `CHANGES_DETECTED` right after `analyze` because the store, `bin/` or `obj/` are untracked inside the repository. See [Before you start](#before-you-start-keep-the-store-out-of-the-change-set).

## graph changes

### What it does

Prints the change set that sync would use: each file with its status (`added`, `modified`, `deleted`, `renamed`) and category (`source`, `project`, `solution`, `config`, `infrastructure`, `pipeline`, `contract` or `other`). Nothing is analyzed.

### Usage

```bash
vogoban graph changes [path] [--since <commit>] [--from <a> --to <b>] [--staged] [--limit N] [--json]
```

Without options, the base is the last analyzed commit. Unlike `graph sync`, this command reads `--from`/`--to` but not `--base`/`--head`.

### Example

```bash
vogoban graph changes
vogoban graph changes --since ccaffed
```

### Output

```text
contoso-orders: 1 change(s) [working-tree] ccaffed660b7 -> 0cae16393195
  +0 ~1 -0 renamed 0  ·  categories: source=1
  modified source         src/Contoso.Orders.Api/Controllers/OrdersController.cs
```

```text
contoso-orders: 1 change(s) [since] ccaffed660b7 -> 0cae16393195
  +0 ~1 -0 renamed 0  ·  categories: source=1
  modified source         src/Contoso.Orders.Api/Controllers/OrdersController.cs
```

`--json` returns `changeSet` (`repositoryId`, `repositoryIdentity`, `source`, `previousCommit`, `currentCommit`, `dirty`, `changes[]`) and `summary` (`total`, `added`, `modified`, `deleted`, `renamed`, `byCategory`, `structural`, `contracts`, `infrastructure`).

### Common mistakes

- Passing `--base`/`--head` here. They are ignored; use `--from`/`--to`.

## graph history

### What it does

Lists recent syncs of a repository, newest first, with mode, status, commit, changed-file count, duration and fallback reason.

### Usage

```bash
vogoban graph history [path] [--limit N] [--json]
```

### Example

```bash
vogoban graph history
```

### Output

```text
timestamp                 mode         status   commit        files  ms    fallback
------------------------  -----------  -------  ------------  -----  ----  --------------------------------------------------------------------------------
2026-10-11T17:05:12.895Z  full         SUCCESS  0cae16393195  0      2383
2026-10-11T17:05:12.363Z  noop         NO_OP    0cae16393195  1      0
2026-10-11T17:05:09.404Z  full         SUCCESS  0cae16393195  1      2128  repository build evaluation mode changed (on -> off); the analysis trust model d
2026-10-11T17:05:00.838Z  noop         NO_OP    0cae16393195  0      0
2026-10-11T17:04:43.103Z  incremental  SUCCESS  0cae16393195  1      2113
2026-10-11T17:04:36.183Z  noop         NO_OP    ccaffed660b7  0      0
```

`analyze` runs are not listed; only `graph sync` (including hook-triggered syncs) records history. `--json` returns the full records with the same fields as the sync result.

### Common mistakes

- Expecting history for a repository analyzed only with `analyze`: `No sync history.`

## Related

- [diff.md](diff.md): compare the snapshots sync produces
- [hooks.md](hooks.md): run sync from Git hooks
- [Incremental analysis](../features/incremental-analysis.md)
- [Trust modes](../advanced/trust-modes.md)
- [CI](../advanced/ci.md)
