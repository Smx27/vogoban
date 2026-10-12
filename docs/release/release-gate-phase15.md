# Phase 15 — Production hardening and release gate

- **Version:** 0.15.0 · graph schema 1 · analyzer 0.1.0 · API v1 · platform DB schema 2
- **Method:** the implementation was treated as the system under audit. Every result below was produced by executing real code against real repositories (dotnet/eShop, dotnet-architecture/eShopOnContainers), real Git history, real PostgreSQL 17, a real container image and a running API with two or more tenants. Anything not executed is listed under "Not verified" and is not claimed.
- **Phase 15 decision (superseded):** READY WITH CONDITIONS, with ten conditions left unverified.
- **Phase 15.1 decision: READY WITH CONDITIONS.** Each of the ten conditions was executed. Nine P1 defects and a set of P2 defects were found and fixed, and the fixes were re-verified on the final tree. No P0 or P1 remains open. The operational conditions are listed under "Phase 15.1 conditions". The fixes change code, so they must ship as **0.15.1**: the version string in this tree still reads 0.15.0, and the image has to be rebuilt.

## Phase 15.1 release-condition closure

Every result in this section was produced by executing code. The original 0.15.0 tree was kept unmodified for comparison runs; "final tree" means 0.15.0 plus every fix listed below. The test environment was Ubuntu 24.04 (x86_64), Bun 1.3.14, PostgreSQL 17.11 (16.15 for the upgrade source), Keycloak 26.0, Docker 29.9, .NET SDK 9/10, and dotnet/eShop at `dc7ea499`. Evidence lives under `~/.capy/work/e15/` on the verification machine (`oidc/`, `incr/`, `local/`, `security/`, `submodules/`, `retention/`, `pool/`, `smoke/`, `evidence-upgrade/`, `evidence-resilience/`, `resil-final/`).

### Verification results on the final tree

| # | Condition | How it was executed | Result |
|---|---|---|---|
| 1 | OIDC identity and roles | Real Keycloak realm. Browser-equivalent authorization-code + PKCE logins for 7 users across 2 tenants: org admin, analyst, viewer, repo- and environment-scoped analyst, unverified email, custom AI-only role, and a second tenant's admin. Plus forged, expired and replayed tokens and callbacks. | **PASS.** Matrix 104/104, callback 6/6, real 120 s token expiry 10/10. Every forged token is rejected with 401: tampered, `alg=none`, HS256 key confusion, foreign issuer. Replayed or forged callbacks are rejected, the open redirect is neutralised, cross-tenant and over-privileged calls are denied, logout invalidates the session, and disabling a membership blocks both session and bearer. |
| 2 | AI prompt injection, rate limits, budgets | Mock OpenAI-compatible provider with adversarial, citation-faking, planner, slow, error, malformed and redirect modes. Hostile repository content and canary secrets. | **PASS after fixes.** 92/92, redirect 4/4, model 4/4. Before the fixes: 90/92 and redirect 2/4 (defects P15.1-1 to -3). Injected text reaches the model only as nonce-delimited `graph_data`. Fabricated citations and planner-invented tools are rejected. Canaries and other tenants' data were never sent, and each tenant uses only its own credential. |
| 3 | Data retention and lifecycle | Retention executed under libfaketime against real jobs, evaluations, AI history, exports, graph versions and audit. Audit chain tests use clock-skewed writers. | **PASS after fixes.** Audit 8/8 on the final tree vs 6/8 on 0.15.0. Lease recovery 3/3 vs 1/3. F3/F4/F5 re-verified on the patched build. The types retention does not cover are documented. |
| 4 | Disk full | Loop-mounted ext4 and tmpfs at 0 B to 16 MiB free, for analyze, sync, the sync lock, the WAL, export, backup and MetaGraph. Plus a full PostgreSQL data volume. | **PASS after fixes** on the final tree for every local write path (`resil-final/`). The previous graph, catalog, snapshot, backup and json/jsonl export always survive, and a retry recovers. CSV export can be left partial (P2). A full PostgreSQL volume makes PostgreSQL PANIC: the API answers 503, the worker survives, and recovery works once the volume is grown. |
| 5 | Connection-pool exhaustion | 120 concurrent mixed-user request chains, locked tables, `max_connections` exhaustion, and about 1,000 `pg_terminate_backend` calls in 30 s during an analysis. | **PASS after fixes.** The burst returns all 200s with no identity mismatch. In the terminate storm: 0× 500, 196× 503, 266× 200 (the rest 429), the worker kept its PID, and the job completed on attempt 2. Before the fixes: 500s, a worker crash, and a worker wedged for 18+ min (2 of 2 runs). |
| 6 | Upgrade and migration failure | A PostgreSQL 16.15 database at schema 1 (data written through 0.15 code paths, then migrated down) → `pg_dump`/`pg_restore` into 17.11 → 0.15 startup migration 1→2. Conflicting-object, mid-migration and unknown-migration failures. | **PASS, limited.** No data loss (every table's row count and md5 identical). Tokens, permissions, audit chain and graph versions intact, and new analysis works. Failed migrations roll back as a whole and are now actionable. **Limitation:** the source data was not written by an earlier production binary. |
| 7 | CI incremental fallback semantics | 24-case regression on eShop with semantic analysis. Each result was compared field-by-field with a clean full rebuild. | **PASS after fix.** 24/24 equivalent. Exit codes now follow the documented policy (P15.1-5). |
| 8 | Git submodules and nested repositories | Initialized, nested, changed-commit, dirty, uninitialized, missing and deleted submodules. | **PASS after fix.** A deterministic diagnostic is emitted in every case, no submodule content enters the graph, and incremental results equal a full rebuild. 0.15.0 skipped submodules silently. |
| 9 | Windows | Code and documentation review. | **Not a supported platform.** It is now documented as such, and the CLI warns on Windows. It was not validated. |
| 10 | Security regression and production smoke | Symlink, path-traversal and build-evaluation leak tests (CLI, untrusted CI, platform jail). SSRF, 25 cases. Local-only workflow under `unshare -rn` with connect tracing. Full container smoke flow. | **PASS.** SSRF 25/25. No secret or host file in any untrusted graph, log or output. Local-only 14/14 steps with 0 AF_INET connects. Container smoke 26/26 (below). |

**Container smoke flow (final image, `namespace-jail`, Keycloak OIDC), 26/26.** Steps: install → start (migrations applied) → operator creates tenant → OIDC login → register → jailed semantic analysis (6,658 entities) → search and resolve → commit and re-analyze (previous version HISTORICAL) → impact (45 evidence items) → governance → security → AI through the tenant provider → MCP → audit valid → `pg_dump` + volume backup → destroy containers, volume and database → restore → identical graph versions, audit valid, old session valid → new analysis. Then the CLI inside the image with `--network none`: analyze → commit → incremental sync → backup → delete store → restore → query → incremental sync.

### Defects found and fixed in Phase 15.1

| ID | Sev | Defect (reproduced on 0.15.0) | Fix | Re-verified |
|---|---|---|---|---|
| P15.1-1 | P1 | When `allowedModels` was empty, any requested model, including an unapproved expensive one, was sent to the provider. | An empty allow-list means only the default model; anything else gets 403. | model 4/4 |
| P15.1-2 | P1 | Five concurrent requests against a daily budget of 3 all succeeded, because the check and the record were not atomic. | Atomic reservation of the user and tenant request budgets before the provider call, with rollback when over budget. | AI suite budget cases |
| P15.1-3 | P1 | A provider 307 redirect to an internal URL was followed, and the internal body (`INTERNAL-ONLY-CANARY-5521`) leaked into the answer's limitations. | Redirects are never followed. The endpoint is re-validated before every call. | redirect 4/4 |
| P15.1-4 | P1 | Bun 1.3.14 SQL with named prepared statements stranded pooled connections under about 60–120 concurrent chains. Requests failed with 500 after 30 s and the worker wedged with no claims, heartbeats or SIGTERM handling (D3). Separately, waits had no bound at all. | `prepare: false`. `statement_timeout=30s` and `lock_timeout=10s` on every connection. Connection, idle, recovery, disk and SQLSTATE 08/53/57P0x/57014/55P03 errors map to 503. | repro 0/10 stalls; burst 120 all 200; storm 0× 500 |
| P15.1-5 | P1 | `graph sync --base X --head <older commit>` or `--head nope` silently rebuilt the checked-out commit with exit 0. | A commit range requires Git, and the head must resolve to the checked-out commit; otherwise exit 2. Added `requestedMode`/`actualMode`/`fallbackCode`, `--strict-incremental` (exit 5), structured JSON for unexpected errors (exit 1), and validated refs. | regress 24/24 |
| P15.1-6 | P1 | A full disk during analyze or sync replaced the live graph tables while the catalog and snapshot still named the old version, so an unpublished graph was served as current (D1). | The graph, catalog and snapshot publish in one transaction. | `resil-final/a1b`, `a2` |
| P15.1-7 | P1 | The worker process exited when the job-status write failed during a database outage, through an unhandled rejection (D2). | The failure is logged and the job is recovered through lease expiry. | storm: same PID, job completed on attempt 2 |
| P15.1-8 | P1 | `auditDays` purged by timestamp, so clock skew punched a hole in the chain and `audit verify` failed after a legitimate purge. Truncation of the newest or oldest records was not detected (F1/F2). | The purge removes a contiguous prefix and records its anchor. Verify checks the head and the anchor, and tolerates legacy purges without an anchor. | audit 8/8 (0.15.0: 6/8) |
| P15.1-9 | P1 | In the container image, every jailed or offline analysis was syntax-only: the prebuilt Roslyn analyzer had no source stamp, so it was rebuilt at runtime, and the rebuild failed without network. With relaxed seccomp the jail probe passed without `/proc`, and every analysis crashed with exit 139. | The image records the analyzer stamp. The jail probe requires a private `/proc` (otherwise `static-only`), and `sandbox.sh` fails loudly without it. | smoke: 6,658 semantic entities in the jail; probe gives the right mode under 3 Docker configs |
| P15.1-10 | P2 | `backup --out` deleted the previous backup first, so ENOSPC left a 0-byte file. json/jsonl exports truncated the previous file first. MetaGraph build was not atomic. An owner-less sync lock blocked forever. | Temp file plus rename, a MetaGraph transaction, and owner-less lock recovery after 30 s. | `resil-final/a45`, `a7b`, `a2b` |
| P15.1-11 | P2 | Retention deleted the current posture (latest evaluations), jobs referenced by graph versions, and export rows while orphaning their files. It skipped deleted repositories (F3–F5). | Keep the latest evaluation per kind and referenced jobs, delete export files with their rows, cover deleted repositories. | subagent T11 (patched build) |
| P15.1-12 | P2 | A cancel on a RUNNING job whose worker died was ignored, and a job that killed its worker was re-queued forever (F11). | It becomes CANCELLED, or FAILED `WORKER_LOST` after `max_attempts`. | lease 3/3 (0.15.0: 1/3) |
| P15.1-13 | P2 | Worker readiness stayed 200 with pending migrations (F10). Migration errors were raw (F7). `migrate down` was a silent no-op over unknown migrations (F8). | Readiness checks pending migrations. Errors name the migration and the remaining version. Refuse with exit 2. | worker 503 at schema 1 → 200 after `migrate up` |
| P15.1-14 | P2 | Submodule contents were silently not analyzed. | A `file-skipped` diagnostic for every gitlink and nested Git directory. | `submodules/sub-fixed.log` |
| P15.1-15 | P2 | Git disk-full errors were classified by accident (`5\d\d` matched digits in the tenant id). | An explicit `STORAGE_FULL` transient class. | code only; worker path not re-run |

Behaviour changes that come from these fixes, and are now documented: an invalid CI head exits 2 instead of 0, an empty model allow-list means default-only, failed AI calls still consume budget, submodules produce diagnostics, and Windows prints a warning.

### Phase 15.1 conditions

1. **Release as 0.15.1.** Bump the version, rebuild the image from this tree, and exclude `.vogoban-platform/` from the release tarball (0.15.0 shipped an empty-schema WAL and SHM, F14).
2. **Analysis confinement.** In Docker the worker is jailed only with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`; otherwise it runs `static-only`, which is safe but lower fidelity. Confirm `sandbox.plan`. Kubernetes was not validated. Jailed analysis has no network for package restore: on eShop it produced 6,658 entities, against 7,298 for trusted local analysis.
3. **Platforms.** Linux x86_64 with Bun 1.3.14 and PostgreSQL 16 or 17. Windows is not supported. macOS was not validated.
4. **Upgrade.** Verified: a PostgreSQL 16 → 17 logical dump and restore, plus the 0.15 schema 1 → 2 migration, on data produced by 0.15 code. Not verified: data written by an earlier production binary, and `pg_upgrade`. Take a backup and rehearse on a copy before upgrading production.
5. **Capacity and operations.** Keep at least 20 % free space on the PostgreSQL volume and alert on it. Put a request timeout on the load balancer, because connection acquisition has no dedicated timer and waits are bounded only by the 10–35 s database timeouts. Retention does not prune sessions, tokens, worker rows, `ai_usage`, MetaGraph snapshots, checkouts of deleted repositories or SQLite free pages; these are operator tasks. Scale is unvalidated beyond the measured table.
6. **Never enable** `VOGOBAN_GIT_ALLOW_FILE_URLS` on multi-tenant deployments. It is opt-in outside local mode, not local-only as stated earlier.

### Remaining accepted limitations (P2/P3)

CSV export is not atomic. A stale sync lock whose recorded owner PID is alive but unrelated is not recovered (F12; remove it manually). `migrate down --to-version 0` drops every table without a prompt (F9; documented). Fractional retention values are accepted (F13). A graph version analyzed for an explicit commit records the SHA as its branch (F15). Not executed: the resilience tests on postgres:16, a full data volume with `pg_wal` on a separate volume, worker-path disk-full under the final tree, semantic-mode disk-full, and a dedicated acquisition timer. The worker-wedge sample is small (2 runs unpatched, 2 patched, 1 with the full fix).

### Final status

- **Security:** no open P0 or P1. Tenant isolation, OIDC, SSRF, secrets, sandbox and AI trust boundary were all re-verified on the final tree.
- **Data integrity:** atomic publication under disk-full, audit-chain integrity under retention and clock skew, backup/restore and destroy/restore verified, PostgreSQL major-version dump/restore verified.
- **Incremental sync:** equivalent to full rebuild in 24/24 cases, with deterministic and documented exit semantics.
- **Upgrade:** verified with the limitation in condition 4.

## Severity model

P0 release blocker (isolation failure, sandbox escape, secret leakage, auth bypass, corruption, data loss, unsafe incremental reconciliation, broken backup, startup failure). P1 must fix before production (incorrect graph or incremental result, serious reliability or operability gap, unsafe default). P2 acceptable only when bounded, documented, non-security-critical and non-data-loss.

## Findings fixed in this phase

| # | Sev | Component | Finding and evidence | Fix | Verification |
|---|---|---|---|---|---|
| 1 | P1 | Incremental planner | Graph built from a dirty tree, then changes reverted: sync reported no-op and the removed file's entity stayed in the graph (stale state). | Planner re-derives when the graph was built dirty. | Add file, sync, delete file, sync: 0 entities remain. |
| 2 | P1 | File discovery (full and incremental) | A tracked symlink (`link.cs -> /etc/passwd`, `x.json -> /etc/hostname`) was followed: host files were hashed and parsed into the graph. | Symlinks are skipped with a recorded reason, checked before any read. | After fix: 0 entities for symlinked paths; platform and CLI. |
| 3 | P1 | CLI/CI sync trust boundary | The plain CLI path (used by `graph sync`, hooks and CI) evaluated MSBuild property functions. A malicious `Directory.Build.props` placed an environment secret canary and `/etc/hostname` into graph entities. Phase 14 wrongly stated sync shared the worker sandbox. | CI base/head sync is untrusted by default (no build evaluation); `--trust-repository` is an explicit opt-in; `--untrusted` forces it anywhere. Evaluation mode is part of the cache key and a switch forces a full rebuild. | Canary and hostname: present with trust, absent (0/0) in CI mode, in the facts cache, logs, API responses and audit; worker namespace jail re-verified with the same repository. |
| 4 | P1 | Graph store concurrency | Four concurrent `analyze` runs into one store: `database is locked` made plugins fail silently, one repository was lost, exit code 0, degraded graphs. | `busy_timeout` of 60 s; analyze warns when plugins failed; sync reports `degradedPlugins` and exit 4. | 4/4 repositories registered, 0 plugin failures, integrity ok; same-repo lock serializes 3 simultaneous syncs. |
| 5 | P1 | Incremental planner | Unresolvable refs were reported as "full rebuild requested" with no fallback reason. | Explicit reason and `fallbackReason`. | Missing base/head, deleted branch, non-Git directory, shell metacharacters. |
| 6 | P1 | Incremental planner | Syncing with a different semantic mode silently replaced a semantic graph with a syntax-only one (+2402/-4615 entities for a one-line change). | Mode change is an analysis-model change: explicit full rebuild. | Both directions. |
| 7 | P1 | CI sync | Retrying an identical range re-analyzed; `--head` not checked out labelled the wrong state. | Idempotent no-op when the graph is at the checked-out commit; refuse a non-checked-out head (exit 2). | Verified. |
| 8 | P2 | Planner | Shared build files (`Directory.*`, `global.json`, `.editorconfig`, props/targets, solutions) reported "affected projects 0" though all recompile. | They widen the reported scope to every project. | 28 of 28 reported. |
| 9 | P2 | Hooks | Hook script could fail noisily without the binary, could recurse, lost a foreign hook on `--force`. | Quoted command, absent-binary guard, recursion guard, clears Git hook env, backs up and restores a foreign hook, always exits 0. | Foreign hook preserved and restored; commit succeeds with a missing binary; background storm of 5 commits (228 ms) converged to a graph identical to a clean rebuild, 0 stale locks. |
| 10 | P2 | Discovery | Git "dubious ownership" was swallowed: wrong repository identity, no commit, "not a Git repository". | Loud error with the fix (`docker run --user`). Vogoban does not override Git's check. | Verified in the image. |
| 11 | P2 | Platform | Local mode listened on all interfaces. | Defaults to 127.0.0.1 in local mode. | Listener shows 127.0.0.1. |
| 12 | P2 | Platform API | Database outage returned 500. | 503 `DEPENDENCY_UNAVAILABLE`; auto-recovers. | PostgreSQL stopped and started under a running API. |
| 13 | P2 | Release artifacts | `deploy/docker-compose.yml` pinned `vogoban:0.11.0`; docs referenced 0.12.0. | Aligned to 0.15.0. | Image reports 0.15.0. |
| 14 | P2 | CLI | Raw stack trace and internal path on a missing repository. | Clean error, exit 2 (stack only with `VOGOBAN_DEBUG=1`). | Verified. |

## Re-validated without change

- **Strict incremental/full equivalence.** Every column of entities (id, key, kind, name, symbol key, location, metadata, provenance), relationships (identity, type, endpoints, evidence, metadata, provenance), unresolved references, diagnostics, conflicts, files, and the graph-version hash are identical to a clean full rebuild after: mixed delete/rename/add/project-reference edits; three commit-range jumps (including back to main); an infrastructure change; the platform-restored store; and background-hook syncs.
- **Failure injection.** Persistence failure, MetaGraph reconciliation failure, plugin crash and change-detection failure each leave the previous graph intact (entity and relationship counts, graph version and catalog verified); retry recovers; the failure is recorded in sync history.
- **Cache hardening.** Target-framework change on a leaf project invalidated 17 of 28 projects (project plus dependents) and reused 11; a `LangVersion`/`DefineConstants` change in `Directory.Build.props` invalidated all 28; the cache key includes tool-source hash, project metadata, every source hash, framework references, the transitive project closure and the evaluation mode.
- **Authentication and authorization (API tokens, local mode).** 401 unauthenticated and invalid token; 403 for a viewer's write; tenant-scoped paths return 404 for another tenant's tenant ID.
- **Tenant isolation.** Two tenants each with a real analyzed graph: the other tenant's graph-version, entity, neighborhood, relationship, query-tool, search, AI and export identifiers all fail without disclosing existence; MCP is read-only (24 tools, none write-like) and rejects unauthenticated calls.
- **SSRF.** Repository registration is default-deny by host allowlist after URL normalization: loopback and metadata addresses, IPv4-mapped IPv6, decimal and hex encodings, `localhost`, embedded credentials, non-https schemes were all rejected.
- **API hardening.** Malformed JSON, wrong content type, 5 MB body (413), 20 KB query (431), bounded pagination, invalid enums and traversal IDs; no stack traces or filesystem paths in error bodies; rate limiting returned 429 under burst (55 of 60 AI requests, 16 of 80 searches) while the API stayed healthy.
- **Workers.** SIGKILL mid-job: lease expired, a new worker claimed the job (attempts 2), it completed, integrity check ok, 0 orphaned relationships, historical versions retained; a missing ref fails the job visibly with a structured code after 3 bounded attempts.
- **Database.** Fresh install, up/down/up, checksum drift refused on `migrate` and `serve`, a newer schema refused ("upgrade the platform instead of downgrading"), an earlier version's graph store opens unchanged (schema 1).
- **Backup and restore (executed).** Seeded tenant with a real analysis, governance and security jobs; `pg_dump -Fc` plus data-volume copy; original database and volume destroyed; restore into a new database and directory: identical graph version, entity, impact result (19 evidence items), repository list, working API token and a valid audit chain; incremental sync then worked on the restored store. Back up `graph.db` together with its `-wal` and `-shm` files.
- **Local-first.** Tracing every connect-family syscall across analyze, sync, status, impact, privacy, export, backup and MCP produced 0 network (AF_INET) connections; the full workflow also ran with `--network none` in the container.
- **Image.** Built from a clean tree; non-root (uid 10001); no secrets in layer history or environment; no compilers; health check; reports 0.15.0.
- **Sandbox.** Namespace jail active on this host and verified with a malicious repository; under default Docker the jail is unavailable and the worker runs static-only (verified); with relaxed seccomp the jail activates. *(Phase 15.1 correction: with relaxed seccomp alone, the 0.15.0 jail activated without `/proc` and every analysis crashed with exit 139; see P15.1-9.)*

## Measured performance and limits (this hardware only)

All numbers are measured on one machine with the real repositories; none is a universal capacity figure.

| Scenario | Result |
|---|---|
| eShop, full analysis (683 files, 28 projects, 7,298 entities, 26,210 relationships) | 18.3 s, 500 MB RSS, 76 MB store |
| Incremental: 1 file / 10 files / leaf project file | 9.9 s / 10.7 s / 5.8 s (about 1.7x to 3x faster) |
| Incremental: 251-file range touching all projects | 16.6–18.2 s (no benefit) |
| No-op sync | about 0.5 s |
| 6 repositories (3 eShop + 3 eShopOnContainers copies with distinct identities: a replicated real corpus, not 6 independent codebases) | 30,626 entities, 114,817 relationships, 348 MB store; MetaGraph build 2.4 s, 169 MB RSS |
| Query latency on that store | find 170 ms, impact 147 ms, stats 674 ms |
| 4 concurrent analyses, one store | 25–29 s each, peak 946 MB RSS |

Capacity beyond these sizes (hundreds of repositories, many concurrent workers, very large single repositories, PostgreSQL growth at fleet scale) was **not** measured. Size a deployment by measuring a representative sample of its own repositories.

## Conditions of the release

1. **Analysis confinement.** Full-fidelity analysis of untrusted repositories requires a worker where the namespace jail works (confirm `sandbox.plan` reports `namespace-jail`). Under default Docker the worker is static-only: safe, with reduced fidelity (fewer semantic facts, for example no application entities). `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1` and the CLI `--trust-repository` are acceptable only for trusted repositories. Owner: deployment operator.
2. **Local CLI trust.** Local `analyze`/`sync` evaluate your repository's build files (trusted by design). Do not run them on untrusted code without `--untrusted`.
3. **Scale.** Not validated beyond the table above; validate per deployment.
4. **Not verified in this phase (limited to earlier-phase evidence or not executed):** the OIDC login flow and role scopes beyond API tokens; AI prompt-injection behavior and AI rate limits; data-retention/lifecycle jobs; disk-full and connection-pool exhaustion; Helm/Kubernetes-specific and message-contract incremental cases (an infrastructure change, a Dockerfile change and OpenAPI add/change were verified); Windows paths and junctions; submodules; upgrade from an earlier production PostgreSQL database with real data (schema checks and a prior-version graph store were verified). *(Phase 15.1 executed every one of these; see "Phase 15.1 closure" above.)*

## Accepted P2 limitations

| Limitation | Rationale and mitigation |
|---|---|
| Image is about 2.9 GB (two .NET SDKs). | Needed for analysis; pull once. Slim only with a measured plan. |
| A plugin crash publishes a degraded graph with a diagnostic (existing full-analysis behavior). | Now surfaced (`degradedPlugins`, exit 4, analyze warning). |
| Sync is CLI/CI only; the worker does not record sync mode/metrics and Prometheus has no sync metrics. | Worker analysis uses the same caches; sync history records mode and metrics. |
| Wide changes gain little from incremental analysis. | Correctness is preserved; the granularity is a project. |
| An unresolvable CI **base** falls back to a full rebuild with exit 0 (an unresolvable or non-checked-out **head** exits 2 since 0.15.1). | Explicit `fallbackCode`/`fallbackReason`; `--strict-incremental` exits 5. |
| Free pages in a SQLite file may retain earlier values after a mode switch. | Local file, same trust domain; `VACUUM` if needed. Tenant stores never evaluate build files. |
| `database is locked` waits up to 60 s under heavy parallel writers. | Platform serializes writers per tenant; scale CLI jobs with separate stores. |

## Security-sensitive configuration

`VOGOBAN_MODE` (local|enterprise), `VOGOBAN_HOST` (loopback by default in local mode), `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES`, `VOGOBAN_MSBUILD_EVALUATION` (`0` disables build evaluation), CLI `--untrusted` and `--trust-repository`, `VOGOBAN_GIT_ALLOWED_HOSTS`, `VOGOBAN_GIT_ALLOW_FILE_URLS` (on by default only in local mode; never enable on multi-tenant deployments), `VOGOBAN_OFFLINE`, `VOGOBAN_METRICS_TOKEN_REF`, secrets by reference (`env:`/`file:`), and `VOGOBAN_ALLOW_INSECURE_HTTP`. Development credentials and debug endpoints are not present in the image.

## Smoke flow executed

Install image or CLI, start, authenticate with a service token, register a repository, analyze through the worker, query graph, modify and commit, incremental sync, impact, governance and security jobs, MCP, backup, destroy, restore, query again, incremental sync again: all passed as described above.
