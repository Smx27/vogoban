# Troubleshooting

Real error messages from Vogoban 0.18.0, with their cause, the fix, and how to confirm the fix. Messages were reproduced on scratch repositories unless marked "from source". Paths and ids in the messages are from those runs; yours will differ.

Exit codes used below: 0 success, 1 unexpected internal or environment error, 2 usage, validation, not found or ambiguous, 3 failed sync (previous graph preserved) or `graph status` FAILED. With `--json`, errors are printed as `{"error": "…", "category": "cli" | "repository" | "storage" | "internal", "details": …}`.

## Where to look first

| Question | Command |
|---|---|
| Did analysis skip or degrade anything? | `vogoban stats` (Diagnostics and Unresolved tables) |
| Which files and why? | `vogoban export --format jsonl --out graph.jsonl`, then `grep '"record":"diagnostic"' graph.jsonl` |
| Which references stayed unresolved and why? | `vogoban unresolved`, `vogoban unresolved-contracts`, `vogoban unresolved-infrastructure`, `vogoban azure`, `vogoban frontend` |
| Is the graph current? | `vogoban graph status`, `vogoban graph history` |
| More detail on a run | `--log-level debug`, `--log-json`; `VOGOBAN_DEBUG=1` for stack traces of exit-1 errors |

## Vogoban cannot find dotnet

**Symptom.** `analyze` succeeds, but C# has only syntax-level facts: no `CALLS` from compiled code, no applications or endpoints from semantic analysis. No warning is printed at the default log level. `vogoban stats` shows a `semantic` diagnostic, and the export contains:

```text
{"record":"diagnostic",…,"category":"semantic","plugin":"dotnet.roslyn","file":null,"severity":"warning","recoverable":true,"code":"semantic-unavailable","message":"dotnet SDK not found (set VOGOBAN_DOTNET or add dotnet to PATH); falling back to syntax-only declarations"}
```

**Cause.** No .NET SDK was found in `VOGOBAN_DOTNET`, on `PATH`, or at `~/.dotnet/dotnet`. Other `semantic-unavailable` messages: "Roslyn analyzer build failed: …" (the bundled analyzer is built on first use and needs network access to NuGet once).

**Solution.** Install a .NET SDK 8 or later and put `dotnet` on `PATH`, or point `VOGOBAN_DOTNET` at it:

```bash
export VOGOBAN_DOTNET="$HOME/.dotnet/dotnet"
vogoban analyze .
```

**Verification.** `vogoban stats` shows no `semantic` diagnostic, and the analyze log (`--log-level info`) contains `roslyn.project-analyzed … success=true` lines.

## Repository requires restore (missing packages)

**Symptom.** Many unresolved references with the category `missing-package`, plus `dependent-on-unresolved-type`:

```text
unresolved: analyzer-limitation=3 dependent-on-unresolved-type=34 ingress-backend-unresolved=1 missing-package=33 no-matching-operation=1 pipeline-project-unresolved=1 unimplemented-operation=1
```

`vogoban unresolved` shows rows such as `INHERITS  Aspire.Hosting.IProjectMetadata … base type could not be resolved`.

**Cause.** The projects declare NuGet packages but there is no restore output (`obj/project.assets.json`), so Roslyn cannot load the package assemblies. Vogoban never restores packages during local analysis. When packages are declared and restored, the same compiler errors are categorized `missing-assembly` or `unknown-symbol` instead.

**Solution.** Restore, then analyze again:

```bash
dotnet restore
vogoban analyze .
```

`dotnet restore` evaluates the repository's build files; only run it on code you would also build ([Trust modes](trust-modes.md)).

**Verification.** On the demo repository the line became `unresolved: dynamic-transport-name=1 ingress-backend-unresolved=1 no-matching-operation=1 pipeline-project-unresolved=1 unimplemented-operation=1` after restore.

## Repository analysis fails

**Symptom.** `analyze` exits 2 and prints one of the two `AnalysisError` categories (`src/pipeline/analyze.ts`):

| Category | Message | Cause |
|---|---|---|
| `repository` | `repository cannot be accessed: <path> (<reason>)` | The path does not exist, Git refuses the repository (dubious ownership), or Git state is unreadable. The reason in parentheses says which; see the sections below. |
| `repository` | `<root> is registered as <identity> but Git no longer reports a repository there (identity would become local:<root>); the Git checkout is missing or unusable. Restore it and retry; the previous graph is preserved.` | The store already knows this path under a Git or configured identity, and analysis would now produce a different, path-based identity. |
| `storage` | `graph persistence failed: <reason>` | Writing the graph failed (disk full, I/O error). The transaction rolls back and the previous graph is kept. |

With `--json` the category is in the output, for example `"category": "repository"`.

**Solution.** Fix the cause named in the message. For `storage`, free disk space or fix permissions; see [Store not writable](#store-not-writable).

**Verification.** `vogoban analyze .` exits 0 and `vogoban repositories` shows the repository `READY` with the expected identity.

### Repository identity changes after editing vogoban.json

**Symptom.** After editing `vogoban.json`, `analyze` fails with the "is registered as configured:… but Git no longer reports a repository there" message, although Git is fine:

```text
/home/user/.capy/work/scratch/adv/big is registered as configured:contoso/orders but Git no longer reports a repository there (identity would become local:/home/user/.capy/work/scratch/adv/big); the Git checkout is missing or unusable. Restore it and retry; the previous graph is preserved.
```

**Cause.** `vogoban.json` is not valid JSON (here a trailing comma). The whole file is ignored, including `repository.id`, so the identity falls back to the remote URL or `local:<path>`. The message blames Git because that is the usual reason for an identity change (a 0.18.0 wording defect). On a store that does not know the repository yet, the same broken file produces an `error` diagnostic `config-invalid`: "invalid vogoban.json: JSON Parse error: Property name must be a string literal".

**Solution.** Fix the JSON (`python3 -m json.tool vogoban.json` or `jq . vogoban.json` point at the error).

**Verification.** `vogoban repository <name>` shows `identity configured:<id>` again.

## Git state unreadable

**Symptom.** `graph sync` exits 3:

```text
contoso-orders: INCREMENTAL — Git state could not be read
  commit 474e594750ac -> ?  [manual]
  graph version 4d33f5467405 -> 4d33f5467405
  FAILED: Git state of /home/user/.capy/work/scratch/adv/gitbad cannot be determined (git rev-parse --show-toplevel: fatal: not a git repository (or any of the parent directories): .git); a .git directory exists but is unusable, so the repository identity and its changes are unknown. Fix or restore the Git checkout and retry.
  previous graph version 4d33f5467405 preserved
```

`analyze` exits 2 with `repository cannot be accessed: . (Git state of … cannot be determined …)`. `graph status` then reports `FAILED` (exit 3), and `graph history` itself exits 1 with the Git message while Git is broken.

**Cause.** A `.git` directory (or `GIT_DIR`) exists, but `git` cannot answer: missing `git` binary, corrupt `HEAD` or index, unreadable object store, permission error. Vogoban refuses rather than guessing: it does not treat this as "no changes", does not fall back to a full rebuild, and does not register a path-based identity. The sync history records `FAILED` with reason "Git state could not be read" (the internal change-set code is `git_state_unreadable`).

**Solution.** Repair the checkout (`git status` must work in it), or re-clone.

**Verification.** `git status` works; `vogoban graph sync` exits 0; `vogoban graph status` no longer says `FAILED`.

## Git "dubious ownership" in containers

**Symptom.** In a container, analysis of a mounted repository exits 2:

```text
repository cannot be accessed: /repo (Git refuses to read /repo because it is owned by a different user (dubious ownership). Run vogoban as the repository owner (for containers: docker run --user "$(id -u):$(id -g)"). Vogoban does not override this Git safety check.)
```

**Cause.** The image runs as uid 10001; Git refuses repositories owned by another user, and Vogoban does not add `safe.directory` exceptions.

**Solution.** Run the container as the owner of the checkout. With `--user`, the default store `/data/graph.db` is not writable for that user ("unable to open database file"), so put the store in the mounted repository or another writable mount:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo" -e VOGOBAN_DB=/repo/.vogoban/graph.db vogoban:0.18.0 analyze /repo
```

Do not pass `-w`: the image's entrypoint is relative to its working directory `/app`, and `docker run -w /repo …` fails with `error: Module not found "src/cli/main.ts"`. Without a remote or `vogoban.json`, the repository is named after the mount directory (`repo`).

**Verification.** The command prints `Analyzed <name> @ <commit> …` and exits 0.

## File skipped: FILE_SKIPPED_RESOURCE_LIMIT

**Symptom.** Some files are missing from the graph; `vogoban stats` shows `discovery` diagnostics. In the export:

```text
{"record":"diagnostic",…,"category":"discovery","plugin":"vogoban.core","file":"src/Contoso.Orders.Functions/OrderFunctions.cs","severity":"warning","recoverable":true,"code":"file-skipped","message":"FILE_SKIPPED_RESOURCE_LIMIT: file size 1844 bytes exceeds the source limit of 1500 bytes (VOGOBAN_MAX_SOURCE_FILE_BYTES)"}
```

The Roslyn analyzer logs the same for files it reaches through project evaluation: `roslyn.source-skipped … code=FILE_SKIPPED_RESOURCE_LIMIT reason=file size 1844 bytes exceeds the source limit of 1500 bytes`.

**Cause.** The file is larger than `VOGOBAN_MAX_SOURCE_FILE_BYTES` (default 8 MiB; the example used 1500 to reproduce it). The limit applies to every analyzable file type, IaC included.

**Solution.** Raise the limit if the file should be analyzed, keeping in mind it bounds memory use:

```bash
VOGOBAN_MAX_SOURCE_FILE_BYTES=16777216 vogoban analyze .
```

Other `file-skipped` reasons: "symbolic links are not followed", "git submodule not analyzed: …", "nested Git repository not analyzed: …", "frontend build output, bundle or vendored library not analyzed (N files); list it in vogoban.json frontend.include to analyze it". See [Analyzing real repositories](repository-analysis.md#file-discovery-rules).

**Verification.** The diagnostic is gone from the export and `vogoban find <symbol in that file>` finds it.

## Stale sync lock

**Symptom.** `graph sync` waits two minutes and exits 3:

```text
contoso-orders: INCREMENTAL — synchronization lock not acquired
  commit 474e594750ac -> 474e594750ac  [manual]
  graph version df5b0920727e -> df5b0920727e
  FAILED: another synchronization of this repository is in progress
  previous graph version df5b0920727e preserved
```

**Cause.** Syncs of one repository are serialized by a lock directory `locks/sync-<repositoryId>.lock` next to the graph store, holding the owner's PID. Locks of dead processes are recovered automatically, and a lock without an owner file after 30 seconds. A lock whose recorded PID belongs to an unrelated live process (typically PID 1 after a crashed containerized CLI) is not recovered.

**Solution.** Confirm that no sync is running, then remove the lock directory:

```bash
ls .vogoban/locks/
rm -r .vogoban/locks/sync-e_80079ca1b70ea3ecf15851a1.lock
```

**Verification.** `vogoban graph sync` completes within its normal duration.

## Store not writable

**Symptom.** Every command that opens the store, read-only commands included, exits 1:

```text
attempt to write a readonly database
```

With `--json`: `{"error": "attempt to write a readonly database", "category": "internal", "details": null}`. Inside a container running with `--user`, the same situation shows as `unable to open database file`.

**Cause.** The store file or its directory is not writable by the current user. Opening a store always writes (schema check, WAL mode, `-wal`/`-shm` files), so even `stats` needs write access.

**Solution.** Fix permissions, or copy the store to a writable location and use `--db`. A failed `analyze` or `graph sync` keeps the previous graph.

**Verification.** `vogoban stats` exits 0.

## Schema incompatible: GRAPH_SCHEMA_INCOMPATIBLE

**Symptom.** Every command on a store exits 1:

```text
Graph store schema v99 does not match engine schema v1
```

On the platform, graph routes return HTTP 409 with the code `GRAPH_SCHEMA_INCOMPATIBLE` ("Stored graph was produced by an incompatible engine schema").

**Cause.** The store was written by an engine with a different graph schema version. Vogoban never opens or migrates such a store.

**Solution.** Use the Vogoban version that wrote the store, or re-analyze into a new store (`--db new.db`, then `analyze`/`analyze-all`). On the platform, re-run analysis of the affected repositories with `force: true`.

**Verification.** `vogoban stats` exits 0 on the new store.

## Ambiguous entity reference

**Symptom.** A command exits 2 and lists candidates:

```text
'OrderSubmitted' is ambiguous (3 matches); use an id or --kind:
  e_531137123331896b07f20e02  Message Contoso.Orders.Contracts.OrderSubmitted  src/Contoso.Orders.Contracts/OrderSubmitted.cs:5
  e_e4a3bda557994688448271bb  Method:Constructor Contoso.Orders.Contracts.OrderSubmitted.OrderSubmitted(string, string, System.Collections.Generic.IReadOnlyList<Contoso.Orders.Contracts.OrderLine>)  src/Contoso.Orders.Contracts/OrderSubmitted.cs:5
  e_e81f893f669a2e7a96ac0ac3  Type:Record Contoso.Orders.Contracts.OrderSubmitted  src/Contoso.Orders.Contracts/OrderSubmitted.cs:5
```

A project path matches both the `File` and the `Project` entity:

```text
'src/Contoso.Orders.AppHost/Contoso.Orders.AppHost.csproj' is ambiguous (2 matches); use an id or --kind:
```

**Cause.** References accept an id, a symbol key, a qualified name or a name, and names are shared by different kinds (a record, its constructor and its `Message` contract; a project and its file; a method and its parameters).

**Solution.** Add `--kind` or use the id from the list:

```bash
vogoban show OrderSubmitted --kind Message
vogoban project Contoso.Orders.AppHost --kind Project
```

`--kind` applies to every reference in the command; for `paths A B` with different kinds, use ids.

**Verification.** The command prints the entity instead of the candidate list.

## diagnostics prints the privacy report

**Symptom.** `vogoban diagnostics` prints the operating mode, telemetry and outbound-network report instead of analysis diagnostics, and `analyze` prints `WARNING: graph is degraded; plugin(s) failed: … (see 'diagnostics')`.

**Cause.** In 0.18.0, `diagnostics` is an alias of `privacy`. The help text also lists it under "unresolved | diagnostics | conflicts", but that branch is unreachable (a known defect).

**Solution.** Read analysis diagnostics from `vogoban stats` (counts by category), `vogoban stats --json` / `vogoban analyze --json` (`stats.diagnosticsByCategory`), or one by one from an export (`"diagnostic"` records in jsonl, the `diagnostics` array in json). See [Privacy](privacy.md).

**Verification.** `grep '"record":"diagnostic"' graph.jsonl` lists each diagnostic with its plugin, code, file and message.

## Azure resource remains unresolved

**Symptom.** `vogoban azure` reports unresolved Azure references, for example:

```text
Unresolved Azure references         1
  unresolved-azure-client           1
```

and `vogoban unresolved --json` gives the reason: `PUBLISHES_TO  unresolved-azure-client  ServiceBusSender.SendMessageAsync  ServiceBusClient is injected and no registration or construction is visible in the application`.

**Cause.** Code is linked to Azure resources only through explicit names, settings, connection references and symbolic IaC references, never name similarity. Categories (`src/azure/*`):

| Category or state | Meaning |
|---|---|
| `unresolved-azure-client` | The SDK client is injected but no registration or construction is visible in the application. |
| `dynamic-resource-name` | The queue/topic/container name is empty or computed; no entity or edge is created. |
| `dynamic-transport-name` (messaging) | A sender's entity name comes from configuration or a variable (`CreateSender(configuration["…"])`). |
| `unresolved-azure-account` | A declared resource carries this leaf name but the namespace/account is not statically known; a bare leaf is not an identity. The candidate is in `metadata.candidates`. |
| `ambiguous-azure-resource` | Several declared resources match and the account is not statically known. |
| `hosting-unresolved` | No IaC resource carries the `azd-service-name` tag of an `azure.yaml` service (the tag may be computed at deployment time). |
| `event-source-unresolved` | No statically declared Event Grid subscription delivers to this function. |
| `apim-operation-unmatched` | An APIM operation matches no API operation of the hosted application. |
| `dynamic-function-name`, `dynamic-durable-name`, `unknown-trigger` | Function or orchestration names, or trigger types, that are not static. |
| `resolution: partially-resolved` | A code-side resource whose parent account is unknown keeps only its leaf path. |
| `nameState: unresolved` | A declaration with an empty or unknown name (`name: ''` in Bicep, unnamed Terraform resource); it never merges with others. |

**Solution.** Make the link explicit in the repository: register or construct the client in the application, use a literal or an IaC-declared name, give connection settings a `__fullyQualifiedNamespace` or a literal host, declare the resource in Bicep/Terraform. Values that are only known at deployment time stay unresolved by design. See [Azure analysis](../features/azure.md).

**Verification.** `vogoban azure` shows the reference resolved, and `vogoban azure flow <entity>` follows it.

## Frontend URL remains unresolved

**Symptom.** `vogoban frontend` reports unresolved HTTP calls:

```text
HTTP calls resolved to API operations  2
HTTP calls to external hosts           0
Unresolved HTTP calls                  3
```

`vogoban unresolved-contracts` lists them (other rows trimmed):

```text
type            category                 target                            source                                                                            location
--------------  -----------------------  --------------------------------  --------------------------------------------------------------------------------  --------------------------------------------------
CALLS_ENDPOINT  dynamic-url              GET (dynamic URL)                 web/src/api/orders.ts:loadReport                                                  web/src/api/orders.ts:19
CALLS_ENDPOINT  no-matching-operation    GET /api/orders                   web/legacy/orders.min.js:legacyOrders                                             web/legacy/orders.min.js:1
CALLS_ENDPOINT  no-matching-operation    POST /api/orders/{id}/cancel      web/src/api/orders.ts:cancelOrder                                                 web/src/api/orders.ts:15
…
```

**Cause.** Categories from the API resolver (`src/contracts/api-resolver.ts`) and the URL builder (`src/frontend/http.ts`):

| Category | Meaning |
|---|---|
| `dynamic-url` | "request URL is not statically determinable", "URL prefix (host or base path) is not statically determinable" or "URL could not be parsed". `urlReason` in the metadata says more: "URL starts with N undetermined values", "URL path contains a constructor-bound / configuration-bound / conditionally built fragment ({x}) whose segments are unknown", "URL path fragment {x} is not a whole path segment …". |
| `configured-url` | "URL comes from configuration key …" |
| `dynamic-method` | "HTTP method is not statically determinable" |
| `no-matching-operation` | "no API operation in this repository matches GET /api/…": the URL is known but no `ApiOperation` with that method and route exists in the repository (or it lives in another repository: build the MetaGraph). |
| `ambiguous-operation` | Several different providers expose the same method and route. |

**Solution.** Build URLs from literals, whole-segment template holes (`/api/orders/${id}`), axios `baseURL` or Angular interceptor prefixes the analyzer can follow; for cross-repository calls, register both repositories and run `vogoban metagraph build`. Calls whose URL is computed at runtime stay unresolved by design. See [Frontend analysis](../features/frontend.md).

**Verification.** `vogoban frontend-chain <component or function>` shows the `CALLS_ENDPOINT` hop to the API operation.

## Platform worker cannot use the namespace jail

**Symptom.** Analysis jobs run with reduced fidelity, and the worker log shows on its first analysis job:

```text
{"ts":"…","level":"info","event":"sandbox.plan","component":"sandbox","mode":"static-only","reason":"no namespace sandbox; MSBuild evaluation disabled so repository build logic is not executed"}
```

**Cause.** The worker probes, on its first analysis, whether it can create user, mount, PID and network namespaces, mount a tmpfs and a private `/proc`, and `pivot_root`. Docker's default seccomp/AppArmor profiles and its masked `/proc` paths forbid this. If the probe passes but mounting `/proc` fails later, the jailed analyzer exits 125 with `sandbox: cannot mount /proc in the analysis namespace` (from source), and the job fails with `ANALYSIS_FAILED: analyzer exited with 125: …`.

**Solution.** Either accept `static-only`, or run the worker with:

```bash
docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined … vogoban:0.18.0 platform worker
```

as `deploy/docker-compose.yml` does. Restart the worker afterwards; the plan is decided once per process. Only set `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1` (`trusted-unconfined`) when every repository is trusted.

**Verification.** The worker logs `"mode":"namespace-jail","reason":"user+mount+net namespace jail"` on its next analysis (verified with the image and these three options).

### Jailed analysis fails with "Cannot find package"

**Symptom.** Every analysis job is retried and fails:

```text
"error_code":"ANALYSIS_FAILED","error_class":"transient","message":"analyzer exited with 1: error: Cannot find package 'yaml' from '/home/user/.bun/install/global/node_modules/vogoban/src/governance/policy.ts' Bun v1.3.14 (Linux x64)"
```

**Cause.** A defect in 0.18.0: the jail exposes only the application directory, but a `bun install -g` installation keeps its dependencies in `~/.bun/install/global/node_modules`, outside it. The jailed analyzer cannot load them.

**Solution.** Run platform workers from the container image (dependencies live inside `/app`), which is the reference deployment.

**Verification.** The job reaches `COMPLETED` (`GET /api/v1/t/{tenant}/jobs/{id}`).

## MCP or API authentication fails

**Symptom and cause.** The platform answers with a structured error `{"error": {"code", "message", "correlationId"}}`. Real responses from `POST /api/v1/t/contoso/mcp`:

| HTTP | Code and message | Cause |
|---|---|---|
| 401 | `UNAUTHENTICATED` "authentication required" | No `Authorization` header (and no session cookie). |
| 401 | `INVALID_TOKEN` "API token is unknown, revoked or expired" | Wrong, revoked or expired `vgb_…` token. Other `INVALID_TOKEN` messages: "OIDC is not configured; use a platform API token" (a non-`vgb_` bearer without OIDC), "bearer token rejected: …" (JWT issuer, audience or signature check failed), "API token owner is disabled". |
| 404 | `NOT_FOUND` "tenant not found" | The tenant does not exist **or** the caller is not a member / the token belongs to another tenant. The two cases are deliberately indistinguishable. |
| 403 | `FORBIDDEN` "missing permission mcp.use" | Authenticated in the tenant, but the role lacks `mcp.use` (for example `viewer`). |
| 403 | `FEATURE_DISABLED` | MCP (or another feature) is disabled for the tenant or platform-wide (`VOGOBAN_FEATURE_MCP=false`). |
| 409 | `GRAPH_NOT_ANALYZED` "no repository of this tenant has been analyzed yet" | Authentication worked; there is no graph to query yet. |

**Solution.** Send `Authorization: Bearer <token>` with a token of the right tenant, created with a role that holds `mcp.use` (`repository_analyst`, `architecture_admin`, `security_admin` or `org_admin`):

```bash
vogoban platform token create contoso mcp-client --role repository_analyst
```

Use the URL with the tenant **slug**: `https://<host>/api/v1/t/<slug>/mcp`. `GET /api/v1/t/<slug>/mcp` returns the connection details for a caller who may use it.

**Verification.** `tools/list` returns the tool catalog:

```bash
curl -s -X POST "$VOGOBAN_URL/api/v1/t/contoso/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Related

- [Analyzing real repositories](repository-analysis.md)
- [Trust modes](trust-modes.md)
- [Runbook](runbook.md)
- [Backup and restore](backup-restore.md)
- [Diagnostics commands](../cli/diagnostics.md)
