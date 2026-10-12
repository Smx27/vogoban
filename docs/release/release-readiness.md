# Vogoban — Production Readiness Report (Phase 12 release gate)

> Historical record of the Phase 12 gate. The current release-candidate audit is `docs/release-gate-phase18.md`
> (version 0.18.0); the numbers below describe the 0.12.0 tree they were measured on.

- **Final status: READY WITH CONDITIONS**
- **Audit date:** 2026-10-09
- **Version:** platform 0.12.0 · graph schema 1 · analyzer 0.1.0 · API v1 · platform DB schema 2
- **Auditor method:** code inspection plus live probing of a running deployment (PostgreSQL 17, Dex OIDC, Jaeger) against real repositories (`dotnet/eShop`, `dotnet-architecture/eShopOnContainers`). Findings are backed by executed evidence, not by claims.

## Verdict

One release-blocking issue (P0) was found and fixed: analysis of an untrusted repository could read arbitrary host files and environment variables (and, on a shared data volume, other tenants' graph data) through MSBuild property-function evaluation, and exfiltrate them into the graph. Repository analysis is now confined. No other P0 remains, and no unaccepted P1 remains.

The status is **READY WITH CONDITIONS** rather than PRODUCTION READY because the strongest confinement (a user+mount+network namespace jail) requires a container runtime that permits unprivileged user namespaces, which the default Docker configuration on the test host blocks. When the jail is unavailable the worker falls back to a secure **static-only** mode that does not execute any repository build logic — safe by default, but with slightly reduced analysis fidelity. Operators who want full-fidelity analysis of untrusted repositories must meet one documented condition (below). The two conditions are operational, understood, and mitigated.

## Conditions to accept for production

1. **Repository-analysis confinement.** Full-fidelity analysis of untrusted repositories (MSBuild evaluation on) requires the worker to create a namespace jail. In environments where unprivileged user namespaces are disabled (default Docker), the worker automatically runs **static-only** (no repository code executed) and this is the safe default. To get both full fidelity and confinement, run the worker where the jail works (host/VM, a userns-enabled container runtime, or `--security-opt seccomp=unconfined` with host userns), verified at startup by the `sandbox.plan` log line reporting `namespace-jail`. Setting `VOGOBAN_ANALYSIS_TRUST_REPOSITORIES=1` runs unconfined and is acceptable only when every registered repository is trusted.
2. **Scale.** Performance was measured at moderate scale (one tenant, two repositories, ~16k entities / ~57k relationships, 203 MB graph store) with sub-second query latency. Very-large-scale throughput (hundreds of repositories, large MetaGraphs, many concurrent workers) was not load-tested; query and traversal bounds are enforced, but capacity planning for large fleets is UNVERIFIED and should be validated per deployment.

## Audit matrix

| Area | Status | Severity | Evidence |
|---|---|---|---|
| Core graph / determinism | PASS | — | Same commit analyzed twice → identical 10148 entities / 41251 relationships and identical entity-id-set hash |
| Graph consistency | PASS | — | 0 orphaned relationships, 0 duplicate entities/relationships on a real 10k-entity graph |
| Graph versions / provenance | PASS | — | Every version records repository, commit, analyzer version, graph schema, config fingerprint, plugin versions, job, correlation id; historical versions queryable |
| Roslyn / semantic | PASS | — | Real eShop analysis: projects, types, methods, applications, endpoints with semantic identity |
| Application / contract / infrastructure | PASS | — | Services, APIs, endpoints, messages, deployments present on real repositories; infrastructure facts stay declared-only |
| MetaGraph | PASS | — | Cross-repository CALLS_REPOSITORY with evidence kinds; identical names do not create false links (verified in Phase 10/11) |
| Impact / blast radius | PASS | — | eShop Ordering.API impact matches the CLI exactly; every impacted node carries an evidence path |
| Governance | PASS | — | Real CA004 violations with rule, path, owners; conflicting rules reported, not silently resolved |
| Security intelligence | PASS | — | Public-endpoint protection states from endpoint metadata; secret values never collected |
| Ownership | PASS | — | CODEOWNERS + enterprise metadata; conflicts and unowned reported |
| AI / Graph RAG | PASS | — | Permission-scoped; deterministic fallback; prompt-injection grounding checks (Phase 10) |
| MCP | PASS | — | HTTP endpoint, 24 read-only tools, caller permissions enforced, out-of-scope tools refused |
| **Untrusted-repo analysis sandbox** | **FIXED** | **P0** | MSBuild property function read `/etc/hostname` + `$PROBE_SECRET` into package names; after fix, namespace jail blocks it and static-only fallback does not execute it; verified end-to-end (no leak in graph/logs) |
| Authentication | PASS | — | Real OIDC (auth code + PKCE) login; JWT bearer + API tokens; hashed sessions/tokens |
| Authorization / RBAC | PASS | — | Tenant/team/repository/environment scopes enforced; denials audited |
| Tenant isolation | PASS | — | Tenant B inaccessible to Tenant A directly and via search, entities, AI, MCP, audit, exports |
| AI / MCP authorization | PASS | — | Scoped graph access; per-tool permission; composite sections omitted when not permitted |
| API | PASS | — | Versioned, OpenAPI 3.1, structured errors with correlation id, no stack traces, pagination bounded |
| SSRF | PASS (hardened) | P2→fixed | Repository URL guard; added AI-endpoint guard blocking metadata/private addresses |
| Secrets | PASS | — | None in source, image layers, image env, graph, logs, audit metadata, or exports (real committed password not present) |
| Workers / jobs | PASS | — | Lease/heartbeat, retry with backoff, idempotent dedupe, cancellation without graph corruption, crash re-queue |
| Storage / migrations | PASS | — | up/down/drift-detection; indexes on hot paths; refuses newer/incompatible schema |
| Backup / restore | PASS | — | `pg_dump` → fresh DB restore preserved all tenants/versions/audit/documents; audit chain still valid |
| Clean deployment | PASS | — | Fresh DB + two containers from the image: migrate, auth, register, analyze, serve — all healthy; non-root; no secrets in image |
| Observability | PASS | — | JSON logs, Prometheus metrics, OTLP traces spanning API→jobs, correlation ids end to end |
| Graceful degradation | PASS | — | Worker/AI/repository-provider/DB outages degrade without data loss (Phase 11/12) |
| Scale (large fleet) | UNVERIFIED | P2 | Measured at moderate scale only; bounds enforced |

## Fix applied this phase

**P0 — untrusted repository analysis confinement** (`src/platform/sandbox.ts`, `src/platform/sandbox.sh`, worker). The analyzer subprocess now runs inside a user+mount+PID+network namespace jail (pivot_root into a tmpfs exposing only the toolchain read-only, the .NET SDK and NuGet cache, the application source read-only, and exactly one tenant directory read-write, with no network). Where the jail cannot be created, MSBuild evaluation is disabled so no repository build logic executes, unless the operator declares repositories trusted. The analyzer environment was reduced from a secret denylist to a strict allowlist. Verified: a repository whose `Directory.Build.props` reads `/etc/hostname` and `$PROBE_SECRET` produces a real graph with none of that data present anywhere.

**P2 — AI provider endpoint SSRF.** `PUT /settings/ai` now validates the endpoint with the same private-address guard used for repository URLs (blocks `169.254.169.254` and other private targets).

## Performance (moderate scale, PostgreSQL + one 2-repo tenant)

| Operation | Latency |
|---|---|
| Repository analysis (eShop, with restore) | ~14 s end to end |
| Repository analysis (eShop, static-only, in container) | ~30 s, 7297 entities / 26191 relationships |
| Entity search | 80 ms |
| Dependents (depth 3) | 143 ms |
| Impact + blast radius | 433 ms |
| Governance evaluation list | 11 ms |
| Dashboard (aggregate) | 235 ms |
| Neighborhood (depth 1) | 14 ms |

Graph query bounds are capped (depth ≤ 8, nodes ≤ 5000, results/page ≤ 200). Platform database for this tenant: 10 MB; per-tenant graph store: 203 MB.

## Remaining P2 / known limitations

- Namespace jail unavailable under default Docker (unprivileged userns disabled) → secure static-only fallback; see condition 1.
- Very-large-fleet throughput not load-tested; see condition 2.
- Per-tenant graph store size grows with provenance detail (203 MB for two repositories); retention (`graphVersionsKeep`) bounds history but per-version size is inherent to SQLite with provenance.
- Bitbucket provider not implemented; MCP transport is HTTP JSON (no streaming); Azure OpenAI and Anthropic AI providers implemented but not exercised against live endpoints.

## Out of scope (future, not implemented)

Horizontal graph-store sharding beyond per-tenant isolation, a managed secret-rotation workflow, and automated capacity autoscaling were recorded as future work rather than implemented, per the no-new-features rule.

## Deployment readiness

Deployable as a single container image (`vogoban:0.18.0` today; `vogoban:0.12.0` at the time of this report; non-root, health-checked) in three roles (serve / worker / CLI), with PostgreSQL and a shared data volume. A reference Compose file (`deploy/`), configuration example, migrations, backup/restore procedure and operational runbook (`docs/runbook.md`) are provided. Secrets are supplied only as references resolved from environment or mounted secret files.
