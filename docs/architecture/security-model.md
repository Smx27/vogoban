# Security model

Vogoban analyzes repositories it may not trust and stores architecture facts that may be sensitive. This page describes
the protections in the analyzers (which hold wherever Vogoban runs) and the protections of the platform runtime (which
hold only when the platform is deployed as documented), with the code that implements each one. Operating guidance is
in [trust modes](../advanced/trust-modes.md), [privacy](../advanced/privacy.md) and the [runbook](../advanced/runbook.md).

## Threat model in one paragraph

A repository can contain hostile content: symlinks to host secrets, paths that escape the root, huge or deeply nested
files, secrets in configuration, build files that run code during MSBuild evaluation, npm lifecycle scripts, Terraform
provisioners and azd hooks. Analysis must not execute repository code, must not read outside the repository, must not
persist secret values, and must stay bounded. On the platform, tenants must not see each other's data and callers must
only see what their role allows, including through AI and MCP.

## Guarantees at a glance

| Protection | Kind | Implemented in |
|---|---|---|
| Repository boundary: only discovered files inside the root are read | Static-analysis guarantee | `src/pipeline/discovery.ts`, `ctx.readText`, `semantic/Vogoban.Roslyn/RepositoryFiles.cs`, `src/frontend/resolve.ts`, `src/azure/iac/*` |
| Symbolic links never followed | Static-analysis guarantee | `discoverFiles` (`lstat`), `RepositoryFiles.Validate` (every path component) |
| Per-file size and nesting limits | Static-analysis guarantee | `maxSourceFileBytes()` (8 MiB default), `IAC_LIMITS` (4 MiB, depth 64) |
| Secret values never persisted | Static-analysis guarantee | `redactSecretText` / `isSecretName` (`src/infrastructure/common.ts`), `redactSecretValues` (`src/dotnet/roslyn.ts`), `Redaction.cs`, `SecretArguments.cs`, fact-cache generation |
| No execution of repository code by analyzers | Static-analysis guarantee, with the MSBuild evaluation caveat | All analyzers; `MsBuildEvaluation.cs` is the caveat |
| Trust modes (`--untrusted`, CI untrusted by default) | Static-analysis guarantee (CLI) | `src/cli/main.ts` sets `VOGOBAN_MSBUILD_EVALUATION=0` |
| Offline / local-first, no telemetry | Runtime guarantee of the CLI | no telemetry code; `--offline` refuses external AI endpoints |
| AI and MCP are read-only and evidence-checked | Runtime guarantee | `readOnlyStore`, `validatePlan`, `parseAnswer` (`src/ai`) |
| Worker isolation (namespace jail) | Platform/runtime guarantee | `src/platform/sandbox.ts`, `sandbox.sh` |
| Tenant isolation | Platform/runtime guarantee | `src/platform/graph.ts` (per-tenant store), API tenant scoping |
| OIDC authentication, API tokens, sessions | Platform/runtime guarantee | `src/platform/auth.ts` |
| RBAC and resource scope | Platform/runtime guarantee | `src/platform/rbac.ts`, `src/platform/api.ts`, `src/platform/graph.ts` |
| MCP authorization | Platform/runtime guarantee | `src/platform/api.ts` (`/api/v1/t/{tenant}/mcp`), `GraphAccess` |

A static-analysis guarantee holds on a laptop, in CI and in a worker, because it is part of the analyzer code path. A
platform guarantee depends on the deployment (namespaces available, PostgreSQL, OIDC, correct proxy configuration).

## Repository boundary

- Discovery lists files with `git ls-files -co --exclude-standard` (or a walk), drops ignored directories, submodules
  and nested repositories, and admits only classified files. Plugins read through `ctx.readText(path)`, which joins a
  discovered repository-relative path with the root.
- The Roslyn analyzer re-checks every file it is about to open, including MSBuild-evaluated `Compile` items, the
  project file and `project.assets.json` (`RepositoryFiles.Validate`): the normalized path must lie inside the root by
  path segment, no component below the root may be a symlink or reparse point, and it must be a regular file below the
  size limit. A rejected file is never opened and becomes a `source-rejected` diagnostic. This holds in every trust
  mode.
- Frontend module resolution works only on discovered files; `tsconfig` `extends` outside the repository is refused
  (`tsconfig-extends-missing`), relative imports leaving the root stay unresolved, and `node_modules` is never read.
- IaC `loadJsonContent`/`loadTextContent` and module paths outside the repository are refused; Terraform remote modules
  and Bicep registry modules are never fetched.

## Symlink protection

`discoverFiles` uses `lstat` and skips every symbolic link (`file-skipped`, "symbolic links are not followed"). The
Roslyn analyzer rejects any path with a symlink component, so a symlinked directory inside a project cannot smuggle a
file in through MSBuild globbing. The hostile-repository suites (`test/security/boundary-secrets.test.ts`,
`test/azure/harness/azure_security.sh`, `frontend_security.sh`) include symlinks to host secrets.

## File-size and resource limits

| Limit | Value | Effect |
|---|---|---|
| Source file size (`VOGOBAN_MAX_SOURCE_FILE_BYTES`) | 8 MiB default | Skipped by discovery and by the Roslyn analyzer with `FILE_SKIPPED_RESOURCE_LIMIT`; the rest of the repository is analyzed |
| IaC file size (`IAC_LIMITS.maxBytes`) | 4 MiB | Parser returns an error and no declarations |
| IaC expression nesting (`IAC_LIMITS.maxDepth`) | 64 | Deeper expressions become `unknown` |
| Syntax errors reported per file | 5 | Further errors are not stored |
| Provenance records per row | 50 | Further records are dropped |
| Pathological TS/JS (e.g. 20,000-level nesting) | per file | The file fails with a diagnostic; the project keeps its other facts |

## Secret redaction

Every string an analyzer extracts (C# literals and argument values, JS/TS literals, IaC defaults, app settings,
connection strings, URLs) passes through one value-level filter before it reaches the fact cache, an entity, a
diagnostic, an export, a backup, an MCP or AI result, a tenant store or a log: `redactSecretText` in
`src/infrastructure/common.ts`, mirrored by `Redaction.Text` in the Roslyn analyzer. Connection strings keep
non-secret pairs (`Endpoint`, `AccountName`, `SharedAccessKeyName`) and lose `SharedAccessKey`, `AccountKey`,
`Password`, `Token`, ...; URLs lose user info and secret query parameters; JWTs, PEM blocks, cloud API keys, SAS tokens
and opaque key material are replaced entirely. Arguments bound to credential parameters of Azure SDK and credential
constructors are redacted whatever their shape (`SECRET_PARAMETER`, `CLOUD_SDK_SECRET_PARAMETER` in
`src/dotnet/roslyn.ts`; `SecretArguments.cs`). Secret-named configuration keys become `SecretReference` entities with
`valueStored: false`.

The store records `fact_cache_generation`; when it differs from `FACT_CACHE_GENERATION` (currently `"2"`), the whole
fact cache is purged on first open, so values cached by a release with older redaction rules never survive. Accepted
edge (D-10): a letters-only value of 32–63 characters with no credential-like name or parameter is kept, because it is
indistinguishable from an identifier.

## No execution of repository code

The analyzers parse and compile; they never run repository code, package scripts, builds, Functions hosts, Aspire
AppHosts, Terraform, Bicep CLI, azd hooks, Helm or `kubectl`. External processes Vogoban starts during analysis are
`git` (read-only queries), and, for semantic analysis, `dotnet build` of Vogoban's own `semantic/Vogoban.Roslyn` tool
(once per tool version) and the analyzer process itself.

**The MSBuild evaluation caveat.** When MSBuild evaluation is enabled (the default for local `analyze` and
`graph sync`), the Roslyn analyzer evaluates the repository's project files with `Microsoft.Build.Locator` to get the
real compile items and references. MSBuild evaluation runs property functions and imports `.props`/`.targets` files,
so a hostile build file can read files and environment variables during evaluation. That is why:

- `--untrusted` on any command sets `VOGOBAN_MSBUILD_EVALUATION=0` (static project parsing only);
- `graph sync --base/--head` (CI) is untrusted unless `--trust-repository` is passed;
- platform workers evaluate only inside the namespace jail, and otherwise run `static-only`;
- a change of evaluation mode forces a full rebuild (`evaluation_mode_changed`), so facts from different trust modes
  never mix.

Static mode produces fewer semantic facts (for example fewer detected applications) but executes nothing from the
repository.

## Trust modes

| Mode | MSBuild evaluation | Selected by |
|---|---|---|
| Local default | On | `analyze`, `graph sync` without flags |
| Untrusted | Off | `--untrusted`, or `graph sync --base/--head` without `--trust-repository` |
| Trusted CI | On | `graph sync --base/--head --trust-repository` |
| Worker `namespace-jail` | On, inside the jail | Namespaces available |
| Worker `static-only` | Off | No namespace sandbox |
| Worker `trusted-unconfined` | On, unconfined | `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1` |

Details and recommendations: [trust-modes.md](../advanced/trust-modes.md).

## Worker isolation

`sandboxPlan()` (`src/platform/sandbox.ts`) probes once whether it can create a user, mount, PID and network namespace,
mount a private `/proc` and `pivot_root` into a tmpfs (`unshare --user --map-root-user --mount --pid --fork --net`).

- **`namespace-jail`**: the worker runs `vogoban analyze` inside `sandbox.sh`, which builds a new root exposing only
  the toolchain (`/usr`, `/bin`, `/lib`, ... read-only), the application source and .NET SDK (read-only), the NuGet
  cache and exactly one tenant directory (read-write), with no network interfaces. Other tenants' data, host secrets,
  `/etc`, `/home` and the platform database are invisible. The environment is reduced to an allow-list
  (`PATH`, `HOME`, locale, `DOTNET_*`, `NUGET_*`, `MSBUILD*`, three `VOGOBAN_*` variables).
- **`static-only`**: no sandbox is available, so `VOGOBAN_MSBUILD_EVALUATION=0` is forced; no repository code runs,
  at reduced fidelity.
- **`trusted-unconfined`**: the operator declared all repositories trusted; a warning is logged.

In every mode each analysis gets a per-tenant `NUGET_PACKAGES`, `HOME` and `DOTNET_CLI_HOME` under the tenant
directory. Under default Docker the jail is not possible and workers fall back to `static-only` (see the runbook for
the required security options).

Caveat: when `VOGOBAN_WORKER_DOTNET_RESTORE` is enabled (default off), the worker runs `dotnet restore` in the checkout
**before** analysis, directly (`src/platform/worker.ts`), not through the sandbox wrapper, with the tenant-scoped
environment from `restoreEnv`. Restore evaluates the repository's project files and needs network access, so enable it
only for trusted repositories.

## Offline and local-first

The CLI has no telemetry, update check, crash reporter or license heartbeat. The only outbound destinations are an AI
provider the user configures and, in `HOSTED` mode, the endpoint the user sets. `--offline` (`VOGOBAN_OFFLINE=1`)
refuses any non-loopback AI endpoint and falls back to the deterministic graph result. Analysis and MetaGraph builds
need no network (the one exception is the first build of the Roslyn tool, which restores its NuGet packages).

## Tenant isolation

Each tenant has its own graph store at `<VOGOBAN_DATA_DIR>/tenants/<tenant-id>/graph.db` (`PlatformGraphs` in
`src/platform/graph.ts`); tenant ids must match `^[a-z]+_[0-9a-f]{24}$` before any filesystem use. Checkouts, NuGet
caches, exports and the analysis `HOME` live under the tenant directory. Every API route under `/api/v1/t/{tenant}`
requires active membership or a token issued for that tenant; non-members get 404, so tenant existence is not revealed.
Graph writes are serialized per tenant by a lease in the platform database.

## Authentication (OIDC, tokens, sessions)

`src/platform/auth.ts`: the web app signs in with OIDC authorization code + PKCE; the server-side session is stored
hashed, the cookie is HttpOnly, SameSite=Lax and Secure over https; cookie-authenticated writes must be same-origin;
`return_to` is restricted to a same-origin path (`safeReturnTo`). API and MCP clients send `Authorization: Bearer` with an
OIDC JWT (issuer, audience and signature verified against JWKS) or a platform API token (`vgb_…`, stored as SHA-256,
bound to one tenant, with expiry and revocation). Enterprise mode refuses to start without PostgreSQL, an OIDC provider
and an https public URL.

## RBAC

`src/platform/rbac.ts` defines 16 permissions (`tenant.admin`, `members.manage`, `repos.read`, `repos.manage`,
`analysis.run`, `graph.read`, `impact.run`, `governance.read`, `policies.manage`, `security.read`, `metadata.manage`,
`ownership.read`, `ai.use`, `mcp.use`, `exports.create`, `audit.read`) and built-in roles `org_admin`,
`architecture_admin`, `security_admin`, `repository_analyst` and `viewer`. Bindings grant a role to a user, team or
service token at tenant, team or repository scope, optionally per environment. Repository lists, entity search,
relationships, tool queries, summaries, exports, AI and MCP are filtered to the repositories the caller holds the needed
permission on; inaccessible items return 404 or "not found".

## MCP and AI authorization

The local MCP server (`vogoban mcp`) and the AI commands use a `GraphAccess` over `readOnlyStore(store)`: any call to a
mutating `GraphStore` method throws `ReadOnlyViolation`. On the platform, `POST /api/v1/t/{tenant}/mcp` requires
`mcp.use` and is intersected with `graph.read`; tools that need another permission (`security.read`,
`governance.read`, `ownership.read`, `impact.run`) are added to `deniedTools` when the caller lacks it, and composite
results omit sections the caller may not see. Authorization is applied before any evidence reaches a model; there is
no privileged AI identity. Graph text placed in a prompt is JSON-encoded with `<` and `>` escaped so repository content
cannot close the data boundary (`src/ai/context.ts`). See [ai-mcp.md](ai-mcp.md).

## Limitations

- Static analysis never proves runtime security: a declared guard, `[Authorize]`, role assignment or private endpoint is
  a declaration, not proof of enforcement.
- MSBuild evaluation in trusted mode can read host files and environment variables; use `--untrusted` or the jailed
  worker for code you do not trust.
- The jail requires unprivileged user, mount and PID namespaces and a mountable `/proc`; Kubernetes was not validated.

## Related

- [Trust modes](../advanced/trust-modes.md)
- [Privacy](../advanced/privacy.md)
- [Security features](../features/security.md)
- [Platform architecture](platform.md)
