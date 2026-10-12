# Platform commands

`vogoban platform` runs and administers the multi-tenant enterprise platform: the API and web application, background workers, database migrations, tenants, service tokens and audit verification. This page is the command reference. Architecture, configuration, deployment, identity, RBAC, retention and observability are covered in [Enterprise operations](../advanced/enterprise.md), the [Runbook](../advanced/runbook.md) and [Platform architecture](../architecture/platform.md).

The local CLI does not need the platform. Nothing on this page is required to analyze or query a repository.

## How platform commands are configured

Platform commands do not use the graph store options (`--db`, `VOGOBAN_DB`). They read their configuration from environment variables and an optional YAML file named by `VOGOBAN_PLATFORM_CONFIG`. The ones you need for a local trial:

| Variable | Meaning |
| --- | --- |
| `VOGOBAN_MODE` | `local` (default) or `enterprise`. |
| `VOGOBAN_DATABASE_URL` | Platform database: `sqlite:///<absolute path>` (local) or `postgres://…` (enterprise). |
| `VOGOBAN_DATA_DIR` | Tenant graph stores, checkouts and exports. |

The full variable list (OIDC, public URL, Git host allow-list, worker tuning, feature flags, rate limits, OpenTelemetry) is in [Enterprise operations](../advanced/enterprise.md). `platform config` prints the effective values.

The configuration is validated before any subcommand runs. When it has errors, only `platform help` and `platform config` work; every other subcommand exits 2 with `platform configuration invalid:` and the list of errors. Enterprise mode, for example, requires an OIDC issuer and client id, PostgreSQL and an https public URL:

```bash
VOGOBAN_MODE=enterprise vogoban platform migrate status
```

```text
platform configuration invalid:
  - enterprise mode requires an OIDC issuer and client id (VOGOBAN_OIDC_ISSUER, VOGOBAN_OIDC_CLIENT_ID)
  - enterprise mode requires PostgreSQL (VOGOBAN_DATABASE_URL); set VOGOBAN_ALLOW_SQLITE_PLATFORM=1 for single-node evaluation
  - enterprise mode requires an https public URL (TLS terminates at the ingress/load balancer); set VOGOBAN_ALLOW_INSECURE_HTTP=1 only for local evaluation
```

Every subcommand other than `help`, `config` and `migrate` first applies pending migrations and seeds the built-in roles. Errors from platform commands exit 2; `platform audit verify` exits 4 when the chain is invalid.

The examples use a local trial database:

```bash
export VOGOBAN_DATA_DIR=$HOME/vogoban-platform/data
export VOGOBAN_DATABASE_URL=sqlite:///$HOME/vogoban-platform/platform.db
```

## platform help

### What it does

Prints the platform command list. `vogoban platform` with no subcommand does the same.

### Usage

```bash
vogoban platform help
```

### Output

```text
Enterprise platform (configuration from $VOGOBAN_PLATFORM_CONFIG and VOGOBAN_* environment variables; see docs/platform.md)
  platform serve                 API + web application + MCP over HTTP + webhooks + health/metrics
  platform worker [--once]       Background worker (repository analysis, MetaGraph, governance, security, PR checks, exports, retention)
  platform migrate [status|up|down --to-version N]   Platform database migrations (up is also run by serve/worker)
  platform config                Effective platform configuration (secret references only)
  platform tenant create <slug> <name> --admin-email <email>   Create a tenant and invite its first Organization Admin
  platform tenant list
  platform token create <tenant> <name> --role <role> [--scope-repo <repository-id>] [--days N]   Service token for CI/MCP (printed once)
  platform audit verify <tenant> Verify the tenant's audit hash chain
```

The `docs/platform.md` reference in the help text points at the pre-0.18 documentation location; the content now lives in [Enterprise operations](../advanced/enterprise.md).

## platform config

### What it does

Prints the effective platform configuration as JSON. Secrets appear only as references (`env:NAME`, `file:/run/secrets/name`), never as values. The `errors` array lists configuration problems; when it is not empty the command exits 2.

### Usage

```bash
vogoban platform config
```

### Output

```json
{
  "mode": "local",
  "dataDir": "/home/user/.capy/work/scratch/cli2/platform/data",
  "database": "sqlite:////home/user/.capy/work/scratch/cli2/platform/platform.db",
  "publicUrl": "http://localhost:8080",
  "listen": {
    "host": "127.0.0.1",
    "port": 8080
  },
  "auth": {
    "issuer": null,
    "clientId": null,
    "clientSecretRef": null,
    "scopes": ["openid", "email", "profile"],
    "audience": null,
    "sessionTtlHours": 12,
    "secureCookies": false,
    "operators": 0
  },
  "git": {
    "allowedHosts": ["github.com", "gitlab.com", "dev.azure.com", "bitbucket.org"],
    "allowPrivateNetworks": false,
    "allowFileUrls": true,
    "timeoutSeconds": 300,
    "restore": false
  },
  "worker": {
    "concurrency": 2,
    "pollSeconds": 2,
    "leaseSeconds": 60,
    "analysisTimeoutMinutes": 60,
    "maxAttempts": 3,
    "healthPort": 9464
  },
  "rateLimits": { "auth": { "capacity": 20, "refillPerMinute": 20 }, …, "default": { "capacity": 120, "refillPerMinute": 300 } },
  "features": { "ai": true, "mcp": true, "integrations": true, "security": true, "governance": true, "exports": true },
  "limits": { "maxBodyBytes": 1048576, "maxPageSize": 200, "maxDepth": 8 },
  "otel": { "endpoint": null, "serviceName": "vogoban" },
  "errors": []
}
```

(`sqlite:///` followed by an absolute path gives four slashes.)

## platform migrate

### What it does

Manages platform database schema migrations. `status` prints each migration with whether it is applied and whether its checksum matches. `up` (the default) applies pending migrations. `down --to-version N` rolls back to version N. `serve` and `worker` run `up` automatically.

### Usage

```bash
vogoban platform migrate [status|up|down --to-version N]
```

### Example

```bash
vogoban platform migrate status
vogoban platform migrate up
```

### Output

On a new database:

```json
[
  {
    "version": 1,
    "name": "platform core",
    "applied": false,
    "appliedAt": null,
    "checksumMatches": null
  },
  {
    "version": 2,
    "name": "append-only audit log",
    "applied": false,
    "appliedAt": null,
    "checksumMatches": null
  }
]
```

```text
applied: 1, 2
```

After `up`, `status` shows `"applied": true` with `appliedAt` and `"checksumMatches": true`. Running `up` again prints `applied: none (up to date)`.

### Common mistakes

- `vogoban platform migrate down` without `--to-version` exits 2 (`migrate down needs --to-version N`).
- Rolling back a database that `serve`/`worker` will use: they re-apply migrations on start.

## platform serve

### What it does

Starts the API, web application, MCP over HTTP (`/api/v1/t/{tenant}/mcp`), webhooks and health/metrics endpoints. It applies migrations first, listens on the configured host and port (default `127.0.0.1:8080`) and runs until SIGINT or SIGTERM.

### Usage

```bash
vogoban platform serve
```

There are no command-line options; host, port, public URL, identity provider and features come from the configuration. The API is stateless and can run as several replicas that share the data directory. See [Enterprise operations](../advanced/enterprise.md) for deployment.

### Example

```bash
vogoban platform serve
curl -s localhost:8080/health/live
```

### Output

Structured JSON logs on stderr, one line per event and request:

```text
{"ts":"2026-10-11T17:25:24.344Z","level":"info","event":"api.started","component":"api","url":"http://localhost:8080","port":8080,"mode":"local","database":"sqlite","oidc":false}
{"ts":"2026-10-11T17:25:27.069Z","level":"info","event":"request","component":"api","correlation_id":"cor_680b7ffab6114450bcd6a1c4","method":"GET","route":"/health/live","status":200,"ms":3}
{"ts":"2026-10-11T17:25:30.053Z","level":"info","event":"api.stopping","component":"platform"}
```

The health request returns:

```json
{"status":"ok","version":"0.18.0"}
```

In local mode there is no identity provider; sign in to the API with service tokens from `platform token create`.

## platform worker

### What it does

Runs the background worker: it leases jobs from the platform database (repository analysis, MetaGraph builds, governance and security evaluation, pull-request checks, exports, retention) and is the only writer of tenant graph stores. It serves `/health/live`, `/health/ready` and `/metrics` on the worker health port (default 9464) and stops on SIGINT/SIGTERM, re-queuing running jobs.

### Usage

```bash
vogoban platform worker [--once]
```

`--once` keeps claiming and running jobs until the queue is empty and nothing is running (follow-up jobs queued by a finished job are processed too), then exits; the health endpoint is not started. Useful for tests and scheduled runs.

### Example

```bash
vogoban platform worker --once
```

### Output

Structured JSON logs on stderr:

```text
{"ts":"2026-10-11T17:09:55.908Z","level":"info","event":"worker.started","component":"worker","worker":"wrk_cox.local_152214_8bf391fb","concurrency":2,"version":"0.18.0"}
{"ts":"2026-10-11T17:09:55.911Z","level":"info","event":"worker.stopped","component":"worker","worker":"wrk_cox.local_152214_8bf391fb"}
```

Workers confine repository analysis according to the configured sandbox mode; see [Trust modes](../advanced/trust-modes.md).

## platform tenant create and tenant list

### What it does

`tenant create` creates a tenant and invites its first Organization Admin (`org_admin`) by email; that user becomes admin at first sign-in. The creation is written to the tenant's audit log. `tenant list` prints every tenant's id, slug, status and name.

### Usage

```bash
vogoban platform tenant create <slug> <name> --admin-email <email>
vogoban platform tenant list
```

The slug must be lowercase letters, digits or dashes (2–41 characters, starting with a letter or digit). All words after the slug form the name.

### Example

```bash
vogoban platform tenant create contoso Contoso Ltd --admin-email alice@contoso.example
vogoban platform tenant list
```

### Output

```text
created tenant contoso (ten_981bb5f58c8d44b1aa83625d); alice@contoso.example becomes Organization Admin at first login
```

```text
ten_981bb5f58c8d44b1aa83625d  contoso  active  Contoso Ltd
```

### Common mistakes

- Creating a tenant that exists: `tenant contoso exists` (exit 2).
- Omitting `--admin-email`: the usage line is printed and the command exits 2.

## platform token create

### What it does

Creates a service token for CI or MCP clients in a tenant, binds it to a role (tenant-wide, or scoped to one repository with `--scope-repo`), and records a `token.create` audit event. The token secret is printed **once** on stdout; the token id, role and lifetime go to stderr. Store the secret in your CI secret store immediately; it cannot be shown again.

### Usage

```bash
vogoban platform token create <tenant> <name> --role <role> [--scope-repo <repository-id>] [--days N]
```

| Option | Meaning |
| --- | --- |
| `--role` | Role key: built-in `org_admin`, `architecture_admin`, `security_admin`, `repository_analyst`, `viewer`, or a custom role key of the tenant. |
| `--scope-repo` | Platform repository id; limits the token to that repository. |
| `--days` | Lifetime in days (default 90). |

### Example

```bash
vogoban platform token create contoso ci-pipeline --role repository_analyst --days 30
```

### Output

```text
vgb_…
service token tok_0dd297aef33c4e7ca6488484 (repository_analyst, 30 days); the secret above is shown only once
```

The first line is the secret (`vgb_` followed by a random string; elided here). Use it as `Authorization: Bearer <secret>` against the API or MCP endpoint.

### Common mistakes

- Unknown role: `unknown role nope` (exit 2).
- `--scope-repo` with an id that is not a repository of that tenant: `repository not found` (exit 2).
- Redirecting stdout and stderr to the same log in CI, which writes the secret into the log.

## platform audit verify

### What it does

Verifies the tenant's append-only audit log hash chain and prints the result as JSON. Exits 4 when the chain is broken, 0 when it is valid.

### Usage

```bash
vogoban platform audit verify <tenant>
```

### Example

```bash
vogoban platform audit verify contoso
```

### Output

```json
{
  "valid": true,
  "records": 2,
  "brokenAt": null,
  "reason": null
}
```

The two records are the `tenant.created` and `token.create` events from the examples above. On a broken chain, `brokenAt` and `reason` identify the first record that does not verify. Retention purges are recorded with their chain anchor; see [Enterprise operations](../advanced/enterprise.md).

### Common mistakes

- Unknown tenant: the usage line `platform audit verify <tenant>` is printed and the command exits 2.

## Related

- [Enterprise operations](../advanced/enterprise.md)
- [Runbook](../advanced/runbook.md)
- [Platform architecture](../architecture/platform.md)
- [ai.md](ai.md) for the local stdio MCP server
