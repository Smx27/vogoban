# Enterprise platform: operator guide

The platform runs Vogoban as a shared, multi-tenant service: an API with a web application, MCP over HTTP and webhooks (`vogoban platform serve`), and background workers that analyze repositories (`vogoban platform worker`). This page is for the people who deploy and operate it: configuration, bootstrap, identity and roles, jobs and workers, analysis isolation, integrations, the API, and observability. How the platform is built is described in [Platform architecture](../architecture/platform.md); day-2 procedures are in the [runbook](runbook.md).

The local CLI does not need any of this. Use the platform when several teams need the same graphs, with access control, audit and scheduled analysis.

## Components

| Component | Command | State |
|---|---|---|
| API, web app, MCP over HTTP, webhooks, health, metrics | `vogoban platform serve` | Stateless. Reads tenant graphs. Scale horizontally. |
| Worker | `vogoban platform worker` | Runs jobs. The only writer of tenant graphs. Scale horizontally. |
| Platform database | PostgreSQL (enterprise) or SQLite (local mode) | Tenants, users, RBAC, tokens, jobs (the queue), graph versions, policy and metadata documents, audit log, AI usage. |
| Data volume | `VOGOBAN_DATA_DIR` (`/data` in the image) | `tenants/<tenant-id>/graph.db` (one graph store per tenant), repository checkouts, PR-check scratch graphs, exports, tenant NuGet roots. |

API replicas and workers must share the data volume. Graph writes are serialized per tenant by a lease, so tenants analyze in parallel and several workers are safe.

The container image `vogoban:0.18.0` (built with `docker build -t vogoban:0.18.0 .` from the source tree) is the supported way to run `platform serve` and `platform worker`. A global `bun install -g` installation cannot run jailed analysis in 0.18.0: the jail exposes only the package directory, while Bun installs the dependencies one level up, so every job fails with `Cannot find package 'yaml'` ([details](troubleshooting.md#jailed-analysis-fails-with-cannot-find-package)). The image keeps its dependencies inside `/app` and prebuilds the Roslyn analyzer. Its entrypoint already is the CLI, so the same image runs every role:

```bash
docker run vogoban:0.18.0 platform serve        # the default CMD
docker run vogoban:0.18.0 platform worker
docker run vogoban:0.18.0 platform migrate status
```

## Modes

| | `local` (default) | `enterprise` |
|---|---|---|
| Database | SQLite at `<data dir>/platform.db` by default | PostgreSQL required (`VOGOBAN_ALLOW_SQLITE_PLATFORM=1` allows SQLite for single-node evaluation) |
| Sign-in | API tokens from `platform token create`; OIDC optional | OIDC issuer and client id required |
| Public URL | `http://localhost:8080` allowed | must be `https://` (`VOGOBAN_ALLOW_INSECURE_HTTP=1` only for local evaluation) |
| Listen address | `127.0.0.1` | `0.0.0.0` |
| `file://` repositories | allowed | refused unless `VOGOBAN_GIT_ALLOW_FILE_URLS=1` |

Startup refuses an enterprise configuration that breaks these rules, for example:

```text
platform configuration invalid:
  - enterprise mode requires PostgreSQL (VOGOBAN_DATABASE_URL); set VOGOBAN_ALLOW_SQLITE_PLATFORM=1 for single-node evaluation
```

`VOGOBAN_MODE` is shared with the CLI's `privacy` report, which uses the values `LOCAL`, `SELF_HOSTED` and `HOSTED`. The platform accepts only `local` and `enterprise` ("mode must be local or enterprise"). Set `VOGOBAN_MODE` per process, not globally on a host that runs both.

## Configuration

Configuration comes from environment variables, which override an optional YAML file named by `VOGOBAN_PLATFORM_CONFIG` (see `deploy/platform.example.yaml`). Print the effective configuration, secrets masked, with:

```bash
vogoban platform config
```

`platform config` exits 2 when the configuration is invalid and lists the errors in `"errors"`.

| Variable | YAML key | Default | Purpose |
|---|---|---|---|
| `VOGOBAN_MODE` | `mode` | `local` | `local` or `enterprise` |
| `VOGOBAN_DATABASE_URL` | `databaseUrl` | `sqlite://<data dir>/platform.db` | `postgres://…` or `sqlite:///path`. Inject from a secret; credentials in the YAML file are rejected. |
| `VOGOBAN_DATA_DIR` | `dataDir` | `.vogoban-platform` (image: `/data`) | Tenant graph stores, checkouts, exports |
| `VOGOBAN_PUBLIC_URL` | `publicUrl` | `http://localhost:8080` | External URL (OIDC redirect, cookies, MCP endpoint) |
| `VOGOBAN_HOST`, `VOGOBAN_PORT` | `listen.host`, `listen.port` | `127.0.0.1`/`0.0.0.0`, `8080` | API listen address |
| `VOGOBAN_TRUSTED_PROXIES` | `trustedProxies` | empty | Proxy addresses or IPv4 CIDRs whose `X-Forwarded-For` is trusted for client IP |
| `VOGOBAN_OIDC_ISSUER`, `VOGOBAN_OIDC_CLIENT_ID` | `auth.issuer`, `auth.clientId` | – | OIDC relying party |
| `VOGOBAN_OIDC_CLIENT_SECRET_REF` | `auth.clientSecretRef` | – | Secret reference for the client secret |
| `VOGOBAN_OIDC_SCOPES` | `auth.scopes` | `openid,email,profile` | Requested scopes |
| `VOGOBAN_OIDC_AUDIENCE` | `auth.audience` | client id | Expected audience of bearer JWTs |
| `VOGOBAN_SESSION_TTL_HOURS` | `auth.sessionTtlHours` | `12` | Web session lifetime |
| `VOGOBAN_SECURE_COOKIES` | `auth.secureCookies` | true for https | Secure cookie flag |
| `VOGOBAN_PLATFORM_OPERATORS` | `auth.operators` | empty | Verified emails allowed to create tenants and see platform status |
| `VOGOBAN_GIT_ALLOWED_HOSTS` | `git.allowedHosts` | `github.com,gitlab.com,dev.azure.com,bitbucket.org` | Hosts repositories may be cloned from |
| `VOGOBAN_GIT_ALLOW_PRIVATE_NETWORKS` | `git.allowPrivateNetworks` | `false` | Allow repository hosts that resolve to private addresses |
| `VOGOBAN_GIT_ALLOW_FILE_URLS` | `git.allowFileUrls` | `true` in local mode | Allow `file://` repositories. Never on a multi-tenant deployment: anyone who can register a repository could make the worker read local Git repositories. |
| `VOGOBAN_GIT_TIMEOUT_SECONDS` | `git.timeoutSeconds` | `300` | Git operation timeout |
| `VOGOBAN_WORKER_DOTNET_RESTORE` | `git.restore` | `false` | Run `dotnet restore` (solutions first, then solution filters) before analysis |
| `VOGOBAN_WORKER_CONCURRENCY` | `worker.concurrency` | `2` | Jobs per worker process |
| `VOGOBAN_WORKER_POLL_SECONDS` | `worker.pollSeconds` | `2` | Queue poll interval |
| `VOGOBAN_WORKER_LEASE_SECONDS` | `worker.leaseSeconds` | `60` | Job lease; an expired lease re-queues the job |
| `VOGOBAN_ANALYSIS_TIMEOUT_MINUTES` | `worker.analysisTimeoutMinutes` | `60` | Analyzer process timeout |
| `VOGOBAN_JOB_MAX_ATTEMPTS` | `worker.maxAttempts` | `3` | Attempts for retryable failures |
| `VOGOBAN_WORKER_HEALTH_PORT` | `worker.healthPort` | `9464` | Worker health and metrics port (`0` disables) |
| `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES` | – | unset | `1` allows `trusted-unconfined` analysis when no jail is available |
| `VOGOBAN_FEATURE_AI`, `_MCP`, `_INTEGRATIONS`, `_SECURITY`, `_GOVERNANCE`, `_EXPORTS` | `features.*` | `true` | Platform-wide feature flags; tenants can further disable |
| `VOGOBAN_MAX_BODY_BYTES` | `limits.maxBodyBytes` | `1048576` | Request body limit |
| – | `rateLimits.<category>` | see below | Token buckets per tenant, principal and category |
| `VOGOBAN_METRICS_TOKEN_REF` | `metricsTokenRef` | unset | Bearer token (reference) required on `/metrics` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | `otel.endpoint`, `otel.serviceName` | unset, `vogoban` | OpenTelemetry traces over OTLP/HTTP |
| `VOGOBAN_LOG_LEVEL`, `VOGOBAN_LOG_FORMAT` | – | `info`, JSON | Platform log level; `text` for human-readable logs |
| `VOGOBAN_HEALTHCHECK_PORT` | – | `8080` | Port the image `HEALTHCHECK` probes (`9464` on worker containers) |
| `VOGOBAN_MAX_SOURCE_FILE_BYTES` | – | 8 MiB | Per-file source limit for analysis |

Default rate limits (capacity / refill per minute): auth 20/20, search 60/120, graph 60/120, ai 5/10, mcp 60/120, exports 5/5, analysis 10/10, webhooks 60/120, default 120/300.

**Secrets are references only**: `env:NAME` or `file:/absolute/path` (Kubernetes or Docker secrets, Vault agent). This applies to the OIDC client secret, repository credentials, webhook secrets, AI provider keys and the metrics token. The API rejects raw values; they are never written to the database or graph, and they are redacted from logs, audit metadata and Git error messages.

## Deploy with Docker Compose

`deploy/docker-compose.yml` is a single-node reference deployment: PostgreSQL 17, one API (`platform serve`, port 8080) and one worker (`platform worker`) built from the repository's `Dockerfile`, sharing the `data` volume. TLS terminates at your ingress or load balancer in front of the API.

Required environment (from `.env` next to the file or your secret store): `POSTGRES_PASSWORD`, `VOGOBAN_PUBLIC_URL` (the https URL users see), `VOGOBAN_OIDC_ISSUER`, `VOGOBAN_OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. Optional: `VOGOBAN_PLATFORM_OPERATORS`, `VOGOBAN_GIT_ALLOWED_HOSTS`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and the credentials your secret references name (`GITHUB_TOKEN_ORG`, `OPENAI_API_KEY`).

The worker service sets `security_opt: [seccomp=unconfined, apparmor=unconfined, systempaths=unconfined]` so that analysis can run in the namespace jail, and `VOGOBAN_WORKER_HEALTH_PORT`/`VOGOBAN_HEALTHCHECK_PORT` to 9464 so the container health check probes the worker's own port.

```bash
cd deploy
docker compose up -d
docker compose run --rm api platform tenant create contoso "Contoso" --admin-email alice@contoso.com
```

## Bootstrap

The sequence below was run against a local-mode platform (SQLite) and against PostgreSQL 17:

```bash
vogoban platform migrate up
vogoban platform tenant create contoso "Contoso" --admin-email alice@contoso.com
vogoban platform token create contoso ci --role org_admin
vogoban platform serve
vogoban platform worker
```

```text
applied: 1, 2
created tenant contoso (ten_baeb9ae0f270426dbde02c38); alice@contoso.com becomes Organization Admin at first login
vgb_…
service token tok_02805b8eab51404b98ddf433 (org_admin, 90 days); the secret above is shown only once
```

- `migrate up` also runs automatically when `serve` or `worker` start.
- The invited admin signs in through OIDC; a verified email claims open invitations, so the admin becomes Organization Admin at first login. Further users are invited by email with a role and scope (Administration → Members, or `POST /api/v1/t/{tenant}/invitations`).
- `token create <tenant> <name> --role <role> [--scope-repo <repository-id>] [--days N]` prints the secret once on stdout (default lifetime 90 days). Without OIDC, tokens are the way to sign in.
- `platform tenant list` lists tenants; `platform help` prints the platform command summary.

Then register a repository and let the worker analyze it:

```bash
curl -s -X POST "$VOGOBAN_URL/api/v1/t/contoso/repositories" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"url":"https://github.com/contoso/orders.git","name":"contoso-orders"}'
```

The response holds the platform repository id (`repo_…`) and the queued `ANALYZE_REPOSITORY` job. Repository URLs must be https, on an allowed host, without embedded credentials, and must not resolve to private addresses. Private repositories need `credentialRef` (a secret reference).

Check readiness:

```bash
curl -s "$VOGOBAN_URL/health/ready"
```

```text
{"status":"ready","version":"0.18.0","checks":{"database":{"ok":true,"detail":"sqlite"},"queue":{"ok":true,"detail":{"queued":0,"liveWorkers":0}},"workers":{"ok":true,"detail":"no live worker: jobs stay queued until a worker starts (API remains available)"},"identityProvider":{"ok":true,"detail":"not configured"},"dataDir":{"ok":true}}}
```

## Identity, tenants and roles

**Authentication.** The web app signs in through OIDC (authorization code with PKCE). The server-side session is stored hashed; the cookie is HttpOnly, SameSite=Lax and Secure over https, and cookie-authenticated writes must come from the same origin. API and MCP clients send `Authorization: Bearer` with an OIDC JWT (issuer, audience and signature verified against the issuer's JWKS) or a platform API token (`vgb_…`, stored as SHA-256, bound to one tenant, with expiry and revocation).

**Tenancy.** Every route under `/api/v1/t/{tenant}` needs active membership or a token issued for that tenant. Non-members get 404, so tenant existence is not revealed. Each tenant's graph data is in its own store.

**Roles.** Built-in roles and their permissions (`src/platform/rbac.ts`):

| Permission | `org_admin` | `architecture_admin` | `security_admin` | `repository_analyst` | `viewer` |
|---|---|---|---|---|---|
| `tenant.admin`, `members.manage` | yes | | | | |
| `repos.read` | yes | yes | yes | yes | yes |
| `repos.manage` | yes | yes | | | |
| `analysis.run` | yes | yes | | yes | |
| `graph.read` | yes | yes | yes | yes | yes |
| `impact.run` | yes | yes | yes | yes | |
| `governance.read` | yes | yes | yes | yes | yes |
| `policies.manage` | yes | yes | | | |
| `security.read` | yes | | yes | | |
| `metadata.manage` | yes | yes | yes | | |
| `ownership.read` | yes | yes | yes | yes | yes |
| `ai.use`, `mcp.use`, `exports.create` | yes | yes | yes | yes | |
| `audit.read` | yes | | yes | | |

Custom roles take any subset of these 16 permissions (`GET`/`POST …/roles`). A role binding grants a role to a user, a team (members inherit it) or a service token, at tenant, team (repositories owned by the team or its sub-teams) or repository scope, optionally restricted to environments (`POST …/role-bindings`).

**Resource scope.** Repository lists, jobs, graph versions, entity search, relationships, neighborhoods, tool queries, governance, security and ownership summaries, exports, AI and MCP are filtered to the repositories on which the caller holds the needed permission. Inaccessible repositories and entities return 404 or "not found".

## Jobs and workers

Job types: `ANALYZE_REPOSITORY`, `METAGRAPH_BUILD`, `GOVERNANCE_EVALUATION`, `SECURITY_ANALYSIS`, `PULL_REQUEST_ANALYSIS`, `EXPORT`, `RETENTION`. Statuses: `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`.

- Jobs are rows in the platform database. Workers lease them atomically and renew the lease while running. A crashed worker's lease expires and the job is re-queued; on its last attempt it becomes `FAILED` with `WORKER_LOST`.
- An identical active job (same tenant and dedupe key) is returned instead of duplicated. An analysis whose tenant, repository, commit, analyzer version and analysis-configuration fingerprint match the current graph version completes as `deduplicated` without re-analyzing; `force: true` overrides this.
- Failures are classified `transient`, `repository_unavailable`, `authentication`, `configuration`, `permanent` or `cancelled`. Only the first two are retried, with exponential backoff, up to `maxAttempts`.
- Cancellation (`POST …/jobs/{id}/cancel`) is honoured within about 3 seconds: the analyzer child process is killed, and because the graph write is one transaction the current graph is never partially replaced. On SIGTERM a worker stops claiming jobs and re-queues the running ones.
- A successful analysis queues a MetaGraph rebuild and, when the features are enabled, governance and security evaluations.
- The worker clones a single commit (shallow fetch, credential passed as an HTTP header, never stored in the remote URL) into `<tenant dir>/checkouts/<repository-id>`, optionally restores packages, then runs `analyze` in a child process against the tenant's store.
- `platform worker --once` processes the queue once and exits (useful for batch runs and tests).

## Analysis isolation

Repository analysis can evaluate repository-controlled MSBuild files, so workers confine it. On its first analysis job, each worker process decides a sandbox plan and logs it as `sandbox.plan`:

| Mode | Meaning |
|---|---|
| `namespace-jail` | User, mount, PID and network namespaces with a `pivot_root` jail: only the toolchain, the .NET SDK and application (read-only), the tenant NuGet root and the tenant directory are visible; no network. Full fidelity. |
| `static-only` | No jail possible: MSBuild evaluation is disabled, so no repository build logic runs. Reduced fidelity. |
| `trusted-unconfined` | No jail possible and `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1`. Only acceptable if every repository is trusted. |

Verified with the 0.18.0 image: under Docker's default profile the worker logs `static-only`; with `--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined` it logs `namespace-jail` and analysis completes. Kubernetes was not validated; it would need `procMount: Unmasked` and unconfined seccomp/AppArmor profiles, or accept `static-only`.

In every mode the analyzer runs with an allowlisted environment (no platform or provider secrets), a per-tenant NuGet root (`<tenant dir>/.nuget`), and `HOME`/`DOTNET_CLI_HOME` in the tenant directory, so tenants never share a package cache or profile. Inside the jail there is no network: packages must be restored before analysis (`VOGOBAN_WORKER_DOTNET_RESTORE=1` restores outside the jail with the same per-tenant NuGet root), and the Roslyn analyzer must already be built (the image prebuilds it).

Run workers from the container image. A 0.18.0 worker installed with `bun install -g` fails every jailed analysis with `Cannot find package 'yaml'`, because that installation keeps its dependencies outside the application directory the jail exposes; see [Troubleshooting](troubleshooting.md#jailed-analysis-fails-with-cannot-find-package).

More on the trade-offs: [Trust modes](trust-modes.md).

## Graph versions and retention

Every analysis records a graph version: repository, catalog id, commit, branch, graph version hash, snapshot id, analyzer version, graph schema version, analysis-configuration fingerprint (analyzer, schema, plugin versions, restore mode), the active policy and enterprise-metadata document versions, job id and correlation id. Older versions become `HISTORICAL` and stay queryable (`GET …/graph-versions/{id}/entities`). A graph store written with another schema version is refused with `GRAPH_SCHEMA_INCOMPATIBLE` (HTTP 409).

Policies and enterprise metadata are versioned documents (`PUT …/policies/{name}`, `PUT …/enterprise-metadata`). Each version is validated by the governance or enterprise engine, stored with its author and hash, audited, and triggers re-evaluation.

Retention is opt-in per tenant (`PATCH …/settings`, field `retention`); nothing is deleted while a value is `null`:

| Setting | Deletes |
|---|---|
| `jobsDays` | Finished jobs older than N days, except jobs referenced by a non-archived graph version. An export job's file goes with its row. |
| `aiHistoryDays`, `exportsDays` | AI answer history and export files older than N days |
| `evaluationsDays` | Governance and security evaluations older than N days, always keeping the latest of each kind |
| `graphVersionsKeep` | Marks older versions `ARCHIVED` (provenance rows kept) and deletes snapshots no kept version references. The `CURRENT` version is never archived. |
| `auditDays` | A contiguous prefix of the audit hash chain older than the cutoff, recorded as an `audit.purge` event with the chain anchor |

Retention runs hourly in the worker, per tenant. It does not prune expired sessions and OIDC states, revoked or expired tokens, `ai_usage` counters, invitations, document versions, MetaGraph snapshots, worker rows, repository checkouts, or free pages inside tenant graph stores; monitor database and volume size. Repositories move through `active` → `archived` → `deleted` (`PATCH …/repositories/{id}`); graph history is kept until retention removes it.

## Integrations and webhooks

- **Providers:** GitHub, GitLab, Azure DevOps and generic Git. Analysis itself is provider-neutral Git.
- **Webhooks:** `POST /api/v1/hooks/{repositoryId}`, verified with the repository's `webhookSecretRef`: GitHub `X-Hub-Signature-256`, GitLab `X-Gitlab-Token`, Azure DevOps basic auth, or generic `X-Vogoban-Signature`. The event must name the registered repository. A push to the tracked branch queues analysis; a pull request queues a PR check. Analysis never runs inline. Rejections (no secret configured, invalid signature, unknown repository) are audited.
- **CI:** the pull-request check API is described in [CI workflows](ci.md#platform-pull-request-check).

## AI and MCP

- **AI provider** per tenant (`PUT …/settings/ai`): `openai-compatible`, `azure-openai` or `anthropic`, with model, allowed models, token caps and a key reference. Calls run only on the server. The endpoint is validated when configured and before every call (https, no private addresses outside evaluation mode), and redirects are not followed.
- **Budgets:** daily request and token limits per user, team and tenant (`GET …/ai/usage`), reserved atomically before the provider is called. Exceeding a budget returns 429 `RATE_LIMITED` with `retryAfterSeconds`.
- **Without a provider**, or when it fails, answers fall back to the deterministic graph result.
- **MCP:** clients call `POST /api/v1/t/{tenant}/mcp` (Streamable HTTP, JSON responses) with a bearer token. It exposes the same read-only tools, resources and prompts as the stdio server (30 tools in 0.18.0), with the caller's permissions: the caller needs `mcp.use` and `graph.read`, and per-tool permissions such as `security.read` or `impact.run` apply. `tools/call` and `resources/read` are audited. `GET /api/v1/t/{tenant}/mcp` returns connection details. Error semantics: [Troubleshooting](troubleshooting.md#mcp-or-api-authentication-fails).

Details of the AI trust boundary: [AI and MCP architecture](../architecture/ai-mcp.md).

## REST API and OpenAPI

The API is versioned by path (`/api/v1`). The OpenAPI 3.1 document is served without authentication at `GET /api/v1/openapi.json` (53 paths in 0.18.0). It is generated from the same route table and schemas the server validates with, and documents authentication, the required permission and feature per route, pagination (`limit` and an opaque `cursor`, returning `{ items, nextCursor }`) and error codes.

Errors are structured: `{ "error": { "code", "message", "correlationId", "details" } }`, never stack traces.

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` (unknown fields, wrong types, raw secrets instead of references, bad URLs) |
| 401 | `UNAUTHENTICATED`, `INVALID_TOKEN` |
| 403 | `FORBIDDEN`, `FEATURE_DISABLED` |
| 404 | `NOT_FOUND` (also for resources the caller may not see) |
| 409 | `CONFLICT`, `GRAPH_NOT_ANALYZED`, `GRAPH_SCHEMA_INCOMPATIBLE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` (rate limit or AI budget) |
| 500 | `INTERNAL` (report the correlation id) |
| 503 | `DEPENDENCY_UNAVAILABLE` (database or identity provider unavailable) |

## Observability

- **Logs:** JSON on stderr with `component`, `correlation_id`, `trace_id`, `tenant`, `principal`, route, status and latency. Analyzer subprocess logs carry the job's correlation id and are forwarded by the worker.
- **Correlation:** the `X-Correlation-Id` request header (or a generated id) is returned on every response and copied into jobs, worker logs, analyzer logs, graph versions and audit events.
- **Traces:** OpenTelemetry over OTLP/HTTP. Job spans join the API request's trace through the persisted W3C `traceparent`.
- **Metrics:** Prometheus format on `/metrics` (API) and `:9464/metrics` (worker): HTTP requests and latency, rate-limit rejections, jobs by type and status with durations, graph size per repository, AI requests and tokens, MCP calls, worker heartbeats, queue depth.
- **Health:** API `/health/live` (process) and `/health/ready` (database and pending migrations, job queue and live workers, identity provider, data directory). Missing workers or an unreachable identity provider are reported but do not make the API unready. Workers serve `/health/live` and `/health/ready` on their health port.

## Security hardening summary

- Strict CSP with no inline script or style, frame denial, nosniff, no-referrer, HSTS behind https, `no-store` on API responses.
- Validated JSON bodies with a size limit, strict schemas that reject unknown fields, bounded page sizes, depths and node counts.
- Token-bucket rate limits per tenant, principal and category.
- The client IP for rate limits and audit is the socket peer unless that peer is listed in `VOGOBAN_TRUSTED_PROXIES`.
- OIDC `return_to` is restricted to a same-origin path.
- Repository and AI provider URLs are checked against private, loopback, link-local, IPv4-mapped IPv6 and unspecified addresses after DNS resolution.
- Tenant ids are validated before filesystem use; export downloads strip path segments; policy includes cannot reference files outside the tenant.
- The audit log is append-only (database triggers reject updates; deletes only through retention), with a per-tenant SHA-256 hash chain checked by `GET …/audit/verify` or `vogoban platform audit verify <tenant>` (exit 4 when invalid).

## Degradation

| Failure | Effect |
|---|---|
| Database | API readiness fails; workers stop claiming jobs. After recovery, expired leases re-queue in-flight jobs. |
| Worker | The API stays available; jobs stay queued or are re-queued when their lease expires. |
| Repository provider | Jobs fail as transient and retry with backoff; existing graphs stay readable. |
| AI provider | Answers fall back to deterministic results; graph, impact, governance, security and MCP tools are unaffected. |
| Identity provider | New logins fail and readiness reports it; existing sessions and API tokens keep working. |

## Limitations

- Performance was measured at moderate scale (one tenant, two repositories, about 16k entities). Capacity for large fleets was not load-tested; see the [release readiness report](../release/release-readiness.md).
- Kubernetes deployment and `pg_upgrade` were not validated.
- Jailed analysis has no network; package restore must happen before it.
- Windows hosts are not supported.

## Related

- [Runbook](runbook.md)
- [Backup and restore](backup-restore.md)
- [Platform architecture](../architecture/platform.md)
- [`platform` commands](../cli/platform.md)
- [Release reports](../release/README.md)
