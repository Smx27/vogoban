# Operational runbook

Procedures for running the Vogoban platform in production: deploy, migrate, monitor, recover failed jobs, restart workers, recover the database, rotate credentials, investigate analysis failures, and disable AI or integrations safely. Configuration and concepts are in the [Enterprise platform guide](enterprise.md); release evidence is in the [release reports](../release/README.md).

Commands assume the container image `vogoban:0.18.0` (whose entrypoint is the CLI, for example `docker run vogoban:0.18.0 platform migrate status`) or an installed `vogoban`, with platform configuration supplied through environment variables.

## Supported platforms

Production target: Linux x86_64 (validated on Ubuntu 24.04, kernel 6.x) with Bun 1.3.14 and PostgreSQL 16 or 17 for the platform database, either directly or in the container image. Windows is not supported or validated (path, junction and reparse-point handling is unverified; the CLI prints a warning on Windows). On Windows workstations run the CLI in the container image or in WSL2; WSL2 itself has not been separately validated. macOS has not been validated.

## Deploy

1. Provision PostgreSQL and a shared data volume (`VOGOBAN_DATA_DIR`, `/data` in the image) reachable by the API and the workers.
2. Set configuration (see `deploy/platform.example.yaml` and the [variable table](enterprise.md#configuration)). Supply secrets as references: `VOGOBAN_OIDC_CLIENT_SECRET_REF=file:/run/secrets/oidc`, `VOGOBAN_DATABASE_URL` from a secret, repository and AI credentials as `env:NAME` or `file:/path`.
3. Run `vogoban platform migrate up` (also run automatically by `serve` and `worker`).
4. Start one or more `platform serve` behind a TLS-terminating load balancer whose external URL is `VOGOBAN_PUBLIC_URL`, and one or more `platform worker`.
5. Verify `GET /health/ready` returns 200 on the API and on the worker health port.
6. Queue one analysis and check that the worker logs `sandbox.plan` with the expected mode. The plan is decided on a worker's first analysis job, not at startup.

**The Roslyn analyzer must be prebuilt.** Inside the jail there is no network and the application directory is read-only, so a first-use build fails and analysis falls back to syntax-only C# with a `semantic-unavailable` diagnostic. The image prebuilds the analyzer and records its source stamp. Outside the image, run one `vogoban analyze` with network access on the worker host before starting jailed workers.

**Run workers from the image.** A worker installed with `bun install -g` cannot load its dependencies inside the jail in 0.18.0 (`Cannot find package 'yaml'`); see [Troubleshooting](troubleshooting.md#jailed-analysis-fails-with-cannot-find-package).

**Confirm analysis confinement.** The `sandbox.plan` log line names the mode: `namespace-jail` (confined, full fidelity), `static-only` (no repository build logic executed, reduced fidelity) or `trusted-unconfined` (only acceptable if all repositories are trusted). The jail needs unprivileged user, mount and PID namespaces and a private `/proc`. Under default Docker none of that is allowed and the worker uses `static-only`. With Docker, the worker runs jailed only with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined` (verified with the 0.18.0 image); relaxing seccomp and AppArmor alone is not enough, because Docker's masked `/proc` paths forbid mounting a new procfs. When any part is missing, the probe picks `static-only`. On Kubernetes, use an equivalent pod security setting (`procMount: Unmasked` plus unconfined seccomp/AppArmor profiles) or accept `static-only`; Kubernetes was not validated. See [Trust modes](trust-modes.md).

## CLI in containers and CI

- Run the container as the owner of the mounted repository (`docker run --user "$(id -u):$(id -g)"`); Git refuses repositories owned by another user, and Vogoban reports that instead of overriding it. With `--user`, set `VOGOBAN_DB` to a writable path in a mount, because `/data` belongs to uid 10001:

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo" -e VOGOBAN_DB=/repo/.vogoban/graph.db vogoban:0.18.0 analyze /repo
  ```

- CI synchronization (`graph sync --base/--head`) does not evaluate repository build files unless `--trust-repository` is passed. Use the platform worker (namespace jail) for full-fidelity analysis of untrusted code. See [CI workflows](ci.md).
- Back up a local graph store with `vogoban backup --out <file>`; when copying files directly, copy `graph.db`, `graph.db-wal` and `graph.db-shm` together. See [Backup and restore](backup-restore.md).

## Migrate

- Status: `vogoban platform migrate status`. Apply: `vogoban platform migrate up`. Roll back: `vogoban platform migrate down --to-version N`.
- Migrations run one per transaction. The platform refuses to start against a database with unknown (newer) or drifted migrations. Take a database backup before upgrades.
- A failing migration rolls back as a whole, and the error names it: "migration N (name) failed and was rolled back; the database remains at version M: …". Fix the cause (for example a conflicting object) and rerun `migrate up`, or restore the backup.
- `migrate down` refuses when the database has migrations this build does not know; roll back with the build that applied them.
- `migrate down --to-version 0` drops every platform table, including the audit log, without confirmation. It is never part of a normal rollback; recover only from a backup.
- While migrations are pending, API and worker `/health/ready` return 503; take the processes out of rotation until `migrate up` completes.
- PostgreSQL major upgrades (verified 16.15 → 17.11): `pg_dump -Fc` from the old server, `pg_restore --exit-on-error` into the new one, restore the data volume, then start Vogoban, which applies pending migrations. Physical data directories are not portable across major versions; `pg_upgrade` has not been verified.
- The platform connects with unnamed (unprepared) statements, which also keeps it compatible with transaction-pooling proxies. Each connection sets `statement_timeout=30s` and `lock_timeout=10s`, so a blocked or stalled database surfaces as 503 `DEPENDENCY_UNAVAILABLE` (not 500) within about 10–35 s, and readiness turns 503. Connection acquisition has no separate timer in Bun 1.3.14, so during a long outage queued requests wait for these timeouts; put a request timeout on the load balancer.
- A full PostgreSQL data volume makes PostgreSQL stop (WAL PANIC). Keep at least 20 % free space, alert on it, and recover by growing the volume.

## Retention

Retention is opt-in per tenant and runs hourly in the worker; see [Graph versions and retention](enterprise.md#graph-versions-and-retention) for what each setting deletes and what it never touches. Sessions, expired tokens, worker rows, `ai_usage` counters, MetaGraph snapshots, checkouts of deleted repositories and free pages in graph stores are not pruned: monitor the data volume and database size and clean them as an operator task. After an `auditDays` purge, `vogoban platform audit verify <tenant>` must still return `"valid": true`.

## Health and monitoring

- `GET /health/live`: process up. `GET /health/ready`: database (and pending migrations), job queue, live workers, identity provider, data directory. The API stays ready when workers or the identity provider are down (jobs queue; existing sessions and tokens keep working).
- Metrics: `GET /metrics` on the API and `/metrics` on the worker health port, Prometheus format (protect with `VOGOBAN_METRICS_TOKEN_REF`).
- The container `HEALTHCHECK` probes `http://localhost:${VOGOBAN_HEALTHCHECK_PORT:-8080}/health/live`. The reference Compose file sets `VOGOBAN_WORKER_HEALTH_PORT=9464` and `VOGOBAN_HEALTHCHECK_PORT=9464` on the worker so that the worker's own health port is probed.
- Behind a reverse proxy, set `VOGOBAN_TRUSTED_PROXIES` (comma-separated addresses or IPv4 CIDRs). `X-Forwarded-For` is honoured for rate limiting and audit only when the immediate peer is listed; otherwise the socket address is used and the header is ignored.
- Workers restore NuGet packages into `<tenant data dir>/.nuget` and run with `HOME`/`DOTNET_CLI_HOME` in the tenant directory, in the jail and in static-only mode alike, so no tenant shares a package cache or profile. Source files above `VOGOBAN_MAX_SOURCE_FILE_BYTES` (default 8 MiB) are skipped with `FILE_SKIPPED_RESOURCE_LIMIT`; files outside the repository, symbolic links and non-regular files are rejected (`source-rejected`) and never read.
- Suggested alerts: API 5xx rate; `vogoban_jobs_total{status="FAILED"}` rate; queue depth (`vogoban_jobs_queued`) rising while `vogoban_worker_last_heartbeat_seconds` does not advance; database readiness failing; AI error rate and token spend; authentication failure spikes; unusual export volume; data-volume capacity.

## Inspect and recover failed jobs

- List failures: `GET /api/v1/t/{tenant}/jobs?status=FAILED`. Each job carries `error.{code,class,message}`, `attempts`, `correlationId`, `worker` and `graphVersionId`.
- `transient` and `repository_unavailable` failures retry automatically with backoff. `permanent`, `configuration` and `authentication` failures do not: fix the cause (bad ref, credential reference, policy or metadata validation) and request analysis again (`POST …/repositories/{id}/analyze`).
- A job stuck in `RUNNING`: a dead worker's lease expires (`VOGOBAN_WORKER_LEASE_SECONDS`) and the job is re-queued, unless a cancel was requested (it becomes `CANCELLED`) or it was on its last attempt (it becomes `FAILED` with `WORKER_LOST`, so a job that kills its worker cannot loop forever). Cancel with `POST …/jobs/{id}/cancel`.
- Analyzer failures appear as `ANALYSIS_FAILED: analyzer exited with <code>: <last log lines>` (exit 2 is classified `permanent`, others `transient`) or `ANALYSIS_TIMEOUT` when the analyzer was killed after `VOGOBAN_ANALYSIS_TIMEOUT_MINUTES`.

## Restart workers

Workers are stateless. Stop them with SIGTERM (no new claims; running jobs are re-queued) and start them freely. Scale by running more `platform worker` processes; graph writes are serialized per tenant by a lease. Restart a worker after changing its container security options, because the sandbox plan is decided once per process.

## Recover the database

1. Stop the API and workers.
2. Restore PostgreSQL from backup (managed point-in-time recovery, or `pg_restore --exit-on-error` of a `pg_dump -Fc`) into the database named by `VOGOBAN_DATABASE_URL`.
3. Restore the `VOGOBAN_DATA_DIR` volume (tenant graph stores) from its snapshot.
4. Verify: `vogoban platform migrate status` shows every migration applied with matching checksums; `vogoban platform audit verify <tenant>` returns `"valid": true`; spot-check `GET …/graph-versions`.
5. Start the API and workers.

Graph data is reproducible: re-run analysis of a recorded version's commit (same analyzer version and configuration fingerprint) with `force: true` to rebuild a missing graph. This sequence was exercised on PostgreSQL 17; see [Backup and restore](backup-restore.md#platform-postgresql-and-data-volume).

## Rotate credentials

Secrets are referenced, not stored. Rotate the underlying value (environment variable or mounted secret file) and restart the process; no database change is needed. For repository, webhook and AI secrets, update the referenced secret; the new value is used on the next job or request. Revoke API tokens with `DELETE /api/v1/t/{tenant}/tokens/{id}` (tokens are stored hashed). There is no CLI command to revoke a token.

## Investigate an analysis failure

Start from the job's `correlationId`: it appears on the API request, the job row, worker logs, the analyzer subprocess logs, the resulting graph version and audit events.

Reproduce locally on a checkout of the same commit:

```bash
vogoban analyze . --untrusted --log-level debug
vogoban stats
vogoban export --format jsonl --out graph.jsonl
grep '"record":"diagnostic"' graph.jsonl
```

Use `--untrusted` when the worker ran `static-only`, so that the local run matches. Analysis diagnostics (parser, semantic, project and resolver issues) are counted in `vogoban stats` and listed one by one in the export. `vogoban unresolved` and `vogoban conflicts` list unresolved references and conflicts. `vogoban diagnostics` is **not** the place to look: in 0.18.0 it is an alias of `vogoban privacy`. A `static` project evaluation in `static-only` mode is expected, not a failure. See [Troubleshooting](troubleshooting.md).

## Disable AI safely

Per tenant: `PATCH …/settings {"features":{"ai":false}}` (and `"mcp":false`). Platform-wide: `VOGOBAN_FEATURE_AI=false`, `VOGOBAN_FEATURE_MCP=false`. Graph, impact, governance, security, ownership, API and exports keep working. An AI provider outage already degrades to deterministic answers automatically.

## Disable an integration safely

Per tenant: `PATCH …/settings {"features":{"integrations":false}}` (rejects new webhooks and repository registration; existing graphs stay readable). Platform-wide: `VOGOBAN_FEATURE_INTEGRATIONS=false`. Narrow Git reach with `VOGOBAN_GIT_ALLOWED_HOSTS`. Archive a single repository with `PATCH …/repositories/{id} {"status":"archived"}`.

## Incident questions the platform answers

- **What failed, and for whom?** Job rows and audit events carry tenant, repository, actor, outcome and correlation id.
- **Which graph version, commit and worker?** `graphVersionId`, `commit` and `worker` on the job and the graph version.
- **What changed?** `compare_snapshots` / `get_architecture_diff` tools, and the versioned policy and enterprise-metadata documents (author and hash per version).
- **Can we recover?** Yes, see [Recover the database](#recover-the-database): graph data is reproducible and audit integrity is verifiable.

## Related

- [Enterprise platform](enterprise.md)
- [Backup and restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)
- [Release reports](../release/README.md)
