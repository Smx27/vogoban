# CI workflows

This page shows how to run Vogoban in a pipeline: build the graph for a pull request's base and head commits, gate on architecture rules, and publish the diff, change risk and graph export as artifacts. It also covers the platform's pull-request check API, for teams that run the [enterprise platform](enterprise.md).

Two approaches exist:

| | CLI in the CI job | Platform PR check |
|---|---|---|
| Where analysis runs | On the CI runner | In a platform worker (namespace jail when available) |
| Needs | Bun, Vogoban, optionally a .NET SDK on the runner | A running platform and a service token |
| Base graph | Built in the job (or restored from a cache) | The repository's current graph version on the platform |
| Gate | Exit codes of `governance-diff` / `governance` | `result.outcome` of the job: `PASS`, `WARN`, `FAIL` |

## Repository safety

A pull request is code you have not reviewed yet. In CI, Vogoban protects you as follows:

- `vogoban graph sync --base … --head …` is **untrusted by default**: MSBuild evaluation is disabled, so no repository build logic runs during analysis. Pass `--trust-repository` only for repositories and branches you trust. See [Trust modes](trust-modes.md).
- Analyze the base commit with `--untrusted` as well. Otherwise the sync sees an evaluation-mode change and runs a full rebuild (`evaluation_mode_changed`).
- Vogoban needs no secrets and makes no network calls during analysis. Do not give the job secrets it does not need (on GitHub, use `pull_request`, not `pull_request_target`).
- `dotnet restore` evaluates the repository's MSBuild files. Running it on pull-request code executes that code, independently of Vogoban's trust mode. Skip it (lower semantic precision, `missing-package` unresolved references) unless the job also builds the code.
- The CLI does not confine analysis. For full-fidelity analysis of untrusted code, use the platform PR check: platform workers run analysis in a namespace jail when the host allows it.
- Keep the graph store and reports outside the checkout (`VOGOBAN_DB`, output directory). Files written inside the checkout are untracked changes and would be part of the analyzed tree.

## The CLI steps

### 1. Build the base graph

```bash
git checkout --detach "$BASE_SHA"
vogoban analyze . --untrusted
```

If a cached store from a previous run already holds the base commit in the same trust mode, skip this step.

### 2. Update to the head commit

`graph sync` always analyzes the checked-out tree; the commit range only says what changed. Check out the head commit first:

```bash
git checkout --detach "$HEAD_SHA"
vogoban graph sync --base "$BASE_SHA" --head "$HEAD_SHA" --strict-incremental --json > sync.json
```

| Exit | Meaning | CI action |
|---|---|---|
| 0 | Success, no-op, or a safe full-rebuild fallback (`actualMode`, `fallbackCode` say which) | continue |
| 2 | Invalid request: `--head` is not the checked-out commit, unresolvable or malformed ref, not a Git repository | fix the job |
| 3 | Sync failed; the previous graph is preserved (including `Git state could not be read`) | fail |
| 4 | Graph published but degraded: a plugin crashed (`degradedPlugins`) | continue, but report |
| 5 | `--strict-incremental` and the incremental request ran as a full rebuild | decide: fail, or drop the flag |
| 1 | Unexpected environment error, for example the store is not writable | fail |

With `--head` not checked out, the command refuses instead of analyzing the wrong tree:

```text
--head/--to f01f533bb95b is not the checked-out commit (d1bc95f18896); synchronization analyzes the checked-out tree, so check out the head commit first
```

A sync into an empty store reports `FULL — no existing graph for this repository` and exits 0 even with `--strict-incremental`: there was no existing graph to update. An unresolvable base (shallow clone, deleted branch) falls back to a full rebuild with `missing_base_commit`, which `--strict-incremental` turns into exit 5. Fetch enough history for the base commit (`fetch-depth: 0` on GitHub).

The JSON result carries `status`, `requestedMode`, `actualMode`, `fallbackCode`, `previousCommit`, `currentCommit`, `graphVersion`, `metrics`, and `diffSnapshotFrom`/`diffSnapshotTo`, the two graph snapshots to compare in the next steps. Full field list: [`graph sync`](../cli/sync.md).

### 3. Reports

```bash
REPO=$(jq -r .repositoryId sync.json)
FROM=$(jq -r .diffSnapshotFrom sync.json)
TO=$(jq -r .diffSnapshotTo sync.json)
vogoban diff --repo "$REPO" --from "$FROM" --to "$TO"
vogoban risk --diff --repo "$REPO" --from "$FROM" --to "$TO"
vogoban export --format json --out graph.json
```

`diff` lists added, removed and changed entities and relationships plus architecture changes (new project dependencies, removed endpoints, changed contracts). `risk --diff` seeds an impact analysis with the changed entities and scores the change; the score is a deterministic structural measure, not a probability of failure. See [diff](../cli/diff.md) and [impact](../cli/impact.md).

### 4. Gate

`governance` evaluates every rule on the current graph; `governance-diff` compares two snapshots and fails only on violations the change introduced. Both exit 0 for PASS, 3 for WARN and 4 for FAIL (`--fail-on`/`--warn-on` set the thresholds, default `ERROR`/`WARNING`). Policies come from `--policy` or `./vogoban-policies`. See [governance](../cli/governance.md).

```bash
vogoban governance-diff --repo "$REPO" --from "$FROM" --to "$TO" --fail-on ERROR
```

## Generic shell example (executed)

This script was run end to end with Vogoban 0.18.0 on a scratch copy of the demo repository `contoso-orders`. The base commit adds a policy `vogoban-policies/boundaries.yaml`; the head commit makes the Functions project reference the API project, which the policy forbids:

```yaml
policy: contoso-boundaries
name: Contoso dependency boundaries
level: organization
layers:
  Functions: { kind: Project, name: ["*.Functions"] }
  Api: { kind: Project, name: ["*.Api"] }
rules:
  - id: CB001
    name: Functions must not reference the API project
    severity: ERROR
    mode: forbidden
    from: { layer: Functions }
    to: { layer: Api }
    relationships: [PROJECT_REFERENCES]
```

`vogoban-ci.sh`:

```bash
#!/usr/bin/env bash
# Usage: vogoban-ci.sh <base-sha> <head-sha>   (run from the repository root)
set -uo pipefail
BASE="$1"; HEAD="$2"
OUT="${OUT_DIR:-$PWD/../vogoban-out}"                 # reports outside the checkout
export VOGOBAN_DB="${VOGOBAN_DB:-$PWD/../vogoban-ci/graph.db}"   # keep the store outside the checkout
mkdir -p "$OUT"

# 1. Graph of the base commit, static only (same trust mode as the CI sync below)
git checkout --quiet --detach "$BASE"
vogoban analyze . --untrusted --log-level warn > "$OUT/analyze-base.txt" || exit 1

# 2. Incremental update to the head commit (untrusted by default with --base/--head)
git checkout --quiet --detach "$HEAD"
vogoban graph sync --base "$BASE" --head "$HEAD" --strict-incremental --json > "$OUT/sync.json"
sync_rc=$?
echo "graph sync: exit $sync_rc, $(jq -r '"\(.status) \(.actualMode)"' "$OUT/sync.json")"
[ "$sync_rc" -eq 0 ] || [ "$sync_rc" -eq 4 ] || exit "$sync_rc"
FROM=$(jq -r .diffSnapshotFrom "$OUT/sync.json")
TO=$(jq -r .diffSnapshotTo "$OUT/sync.json")
REPO=$(jq -r .repositoryId "$OUT/sync.json")

# 3. Reports for reviewers
vogoban diff --repo "$REPO" --from "$FROM" --to "$TO" > "$OUT/diff.txt"
vogoban risk --diff --repo "$REPO" --from "$FROM" --to "$TO" > "$OUT/risk.txt"
vogoban governance --repo "$REPO" > "$OUT/governance.txt"
vogoban export --format json --out "$OUT/graph.json" > /dev/null

# 4. Gate on violations introduced by this change: exit 0 PASS, 3 WARN, 4 FAIL
vogoban governance-diff --repo "$REPO" --from "$FROM" --to "$TO" --fail-on ERROR > "$OUT/governance-diff.txt"
gate=$?
cat "$OUT/governance-diff.txt"
exit "$gate"
```

Run:

```bash
./vogoban-ci.sh "$(git rev-parse main~1)" "$(git rev-parse main)"
echo "exit $?"
```

Output (exit code 4):

```text
graph sync: exit 0, SUCCESS incremental
Governance diff  PASS -> FAIL
  from snapshots: repo@f01f533b (gs_172d962675a41e1a7b1f96ec)  as-of 2026-10-11  policies 42926137bba325e3
  to   snapshots: repo@d1bc95f1 (gs_784f697c51b031167e74cbca)  as-of 2026-10-11  policies 42926137bba325e3
  new 1  resolved 0  unchanged 0  status changes 0  severity changes 0
  newly expired exceptions: -  newly active exceptions: -

New violations (drift from declared architecture)
[ERROR] CB001 Functions must not reference the API project  VIOLATION  (gv_198b2a643b7af4b4e2e21e5a)
    Project src/Contoso.Orders.Functions/Contoso.Orders.Functions.csproj PROJECT_REFERENCES Project src/Contoso.Orders.Api/Contoso.Orders.Api.csproj, which the rule forbids
    Project src/Contoso.Orders.Functions/Contoso.Orders.Functions.csproj [repo] -[PROJECT_REFERENCES/DECLARED]-> Project src/Contoso.Orders.Api/Contoso.Orders.Api.csproj [repo]  @ src/Contoso.Orders.Functions/Contoso.Orders.Functions.csproj:24
    owner: UNOWNED via Project Contoso.Orders.Functions  repository repo
```

The reports written to the output directory:

```text
analyze-base.txt  diff.txt  governance-diff.txt  governance.txt  graph.json  risk.txt  sync.json
```

`diff.txt`:

```text
repository diff gs_f778aa35b6897d74d5a563a1 (f01f533bb95b) -> gs_92f7c04283f74bc471257614 (d1bc95f18896)  repository repo
entities: +0 -0 ~3   relationships: +17 -22 ~0
category    added  removed  changed
----------  -----  -------  -------
CODE        0      0        1
PROJECT     0      0        1
REPOSITORY  0      0        1

Architecture changes (1)
  [PROJECT] PROJECT_DEPENDENCY_ADDED: new PROJECT_REFERENCES src/Contoso.Orders.Functions/Contoso.Orders.Functions.csproj -> src/Contoso.Orders.Api/Contoso.Orders.Api.csproj
```

`risk.txt` (trimmed):

```text
Changes from diff gs_f778aa35b6897d74d5a563a1 -> gs_92f7c04283f74bc471257614: 1 architecture changes (0 potentially breaking), 1 changed entities used as seeds
…
Change risk: 23.1 (MODERATE) - deterministic structural engineering risk; not a probability of production failure
factor                       value  points  explanation
---------------------------  -----  ------  --------------------------------------------------------------------------------
direct                       4      9.3/10  entities directly dependent on the change
…
services                     1      4/10    applications affected
…
```

The repository name is `repo` because the scratch checkout directory was called `repo` and it has no `origin` remote; in a real clone the name comes from the remote URL or `vogoban.json`. Snapshot ids differ between runs.

## GitHub Actions example

This workflow wraps the script above. It was not executed on GitHub; the script it calls was. Vogoban is not published to the npm registry, so the job installs the source package from a location your organization controls (here a repository variable `VOGOBAN_PACKAGE_URL`); see [Installation](../installation.md).

```yaml
name: architecture
on: pull_request

permissions:
  contents: read

jobs:
  vogoban:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # base commit must be resolvable
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-dotnet@v4   # optional: Roslyn semantic analysis
        with:
          dotnet-version: 10.0.x
      - name: Install Vogoban
        run: |
          curl -fsSL "$VOGOBAN_PACKAGE_URL" -o "$RUNNER_TEMP/vogoban.tgz"
          bun install -g "$RUNNER_TEMP/vogoban.tgz"
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
        env:
          VOGOBAN_PACKAGE_URL: ${{ vars.VOGOBAN_PACKAGE_URL }}
      - name: Architecture check
        run: .github/scripts/vogoban-ci.sh "$BASE_SHA" "$HEAD_SHA"
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          OUT_DIR: ${{ runner.temp }}/vogoban-out
          VOGOBAN_DB: ${{ runner.temp }}/vogoban/graph.db
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vogoban-reports
          path: ${{ runner.temp }}/vogoban-out
```

Notes:

- On a `pull_request` event, `actions/checkout` checks out a merge commit, not `HEAD_SHA`. The script checks out the base and head commits itself, so this does not matter, but `fetch-depth: 0` is needed for both to exist locally.
- The first Roslyn analysis builds the bundled analyzer and needs network access to NuGet once per runner.
- To skip the base analysis on every run, cache the store directory keyed by the base commit, and analyze only on a cache miss. The cached store must have been built with `--untrusted`.
- A WARN (exit 3) fails a GitHub step. To let warnings pass, map exit 3 to 0 in the script.

## Platform pull-request check

With the platform, CI makes two HTTP calls: queue a `PULL_REQUEST_ANALYSIS` job, then poll it. The worker fetches the head commit, analyzes it into a scratch graph inside the same sandbox as normal analysis, compares it with the repository's current graph version and evaluates the tenant's active policies on both.

1. Create a service token bound to the repository (printed once):

   ```bash
   vogoban platform token create contoso ci --role repository_analyst --scope-repo <repository-id>
   ```

   `<repository-id>` is the platform repository id (`repo_…`) returned when the repository was registered. `repository_analyst` holds `analysis.run` and `repos.read`, which the two calls need.

2. Queue the check and poll:

   ```bash
   job=$(curl -sf -X POST -H "Authorization: Bearer $VOGOBAN_TOKEN" -H 'content-type: application/json' \
     "$VOGOBAN_URL/api/v1/t/contoso/repositories/$REPO_ID/pull-request-checks" \
     -d "{\"commit\":\"$HEAD_SHA\",\"failOn\":\"ERROR\"}" | jq -r .job.id)
   until s=$(curl -sf -H "Authorization: Bearer $VOGOBAN_TOKEN" "$VOGOBAN_URL/api/v1/t/contoso/jobs/$job") &&
         echo "$s" | jq -e '.status=="COMPLETED" or .status=="FAILED" or .status=="CANCELLED"' >/dev/null; do
     sleep 10
   done
   echo "$s" | jq '.result.outcome, .result.diff, .result.governance.newViolations'
   echo "$s" | jq -e '.result.outcome != "FAIL"'
   ```

The request body accepts `commit` (required), `pullRequest` (number, optional) and `failOn` (`INFO`, `WARNING`, `ERROR`, `CRITICAL`; default `ERROR`). Real result of a check against a local platform (trimmed):

```json
{
  "outcome": "PASS",
  "commit": "052f7df1e76c0a6c3d85ceda20f4f62831e18586",
  "base": { "graphVersionId": "gv_68adc12303084991bd40bdac", "commit": "474e594750ac8d527856266f3716849dbdbe1226" },
  "pullRequest": null,
  "diff": {
    "entities": { "added": 0, "removed": 0, "changed": 2 },
    "relationships": { "added": 0, "removed": 0 },
    "architecture": [],
    "breaking": 0
  },
  "governance": null,
  "risk": { "score": 0, "band": "LOW", "meaning": "deterministic structural engineering risk; not a probability of production failure", "factors": [ … ] },
  "impact": { … }
}
```

`governance` is `null` when the tenant has no active policy documents; the outcome is then always `PASS`. With policies, it holds `newViolations` and `resolved`, and the outcome is `FAIL` when a new violation reaches `failOn`, `WARN` when there are new violations below it, `PASS` otherwise. The job fails with `BASE_NOT_ANALYZED` when the repository has no current graph version: analyze the base branch first (`POST …/repositories/{id}/analyze`). Webhooks can queue the same checks automatically; see [Enterprise platform](enterprise.md#integrations-and-webhooks).

## Limitations

- `graph sync` analyzes the checked-out tree. Both CLI flows need a full checkout of the head commit.
- Untrusted analysis has lower fidelity for projects that depend on SDK logic (for example Aspire AppHosts).
- `governance-diff` and `governance` only know the rules you give them; without policies they always pass.
- Static analysis never proves runtime behaviour; a passing check is not a proof that a change is safe.

## Related

- [Trust modes](trust-modes.md)
- [`graph sync`](../cli/sync.md)
- [Governance commands](../cli/governance.md)
- [Incremental analysis](../features/incremental-analysis.md)
- [Enterprise platform](enterprise.md)
