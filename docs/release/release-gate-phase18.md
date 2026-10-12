# Vogoban — Phase 18 release-candidate audit (0.18.0)

- **Version:** 0.18.0 (package, image tag, `vogoban --version`) · graph schema 1 · analyzer 0.1.0 · API v1 · platform DB schema 2
- **Audit date:** 2026-10-11
- **Baseline:** the 0.17.0 source tarball (commit `16c526b` in the audit repository); every change is one of the ten commits on top of it, listed at the end.
- **Method:** every statement below was produced by running code on this tree (Ubuntu 24.04 x86_64, Bun 1.3.14, .NET SDK 8.0.425 and 10.0.401, unprivileged user namespaces available). Evidence directories are named per item. Nothing was measured on a live Azure subscription, in Kubernetes, or on Windows/macOS.

## Executive status

**READY** for 0.18.0. Every P0 (D-06, D-05, B-13) and every P1 (F-01, C-02, C-03, D-01, D-02, D-03, D-08, D-09, D-11, A-01) from the 0.17.0 audit is closed with a regression test on this tree. The security suites that were unverified at 0.17.0 (API/MCP hardening, SSRF, AI adversarial and budget atomicity, worker jail and cross-tenant isolation, boundary/secret leakage) now exist and pass. The full regression gate passes: `bun test` 299 pass / 0 fail (301 tests, 22 files, 2 `test.todo`), `bun run typecheck` clean, incremental equivalence 60/60 (17 corpus + 43 fixture scenarios, all `incremental` mode, byte-equal graph tables, catalog and graph version), Azure security harness 16/16, and the three-repository Azure E2E + MetaGraph flow resolves end to end with zero unresolved Azure identities.

Exactly one condition is carried: six P2 identifiers from the 0.17.0 audit (B-02, B-03, B-06, B-07, B-08, C-06) are not restated here because their definitions were not available to this phase; the P2 items whose definitions were available (B-04, B-05, A-02, C-04, C-05, C-07, C-08, D-04, D-10) are fixed or documented below. Nothing in this release depends on them.

## P0 closure

| ID | Finding (0.17.0) | Root cause | Fix | Proof |
|---|---|---|---|---|
| D-06 | The Roslyn analyzer read any file MSBuild evaluation or a project handed it, including symlinks and paths outside the repository, in every trust mode. | Discovery enforced the boundary but the analyzer trusted MSBuild `Compile` items, the project file and `project.assets.json` without re-checking. | `semantic/Vogoban.Roslyn/RepositoryFiles.cs`: normalized-root containment by path segment, symlink/reparse rejection on every component below the root, regular-file check and size bound, applied in `Program.cs` before every `File.ReadAllText` (`Admit()`), to MSBuild `Compile` items, the project file and the restore output. Rejections surface as `source-rejected` diagnostics (`source-outside-repository`, `source-missing`, `source-symlink`). | `test/security/boundary-secrets.test.ts` 9/9: canary host file via symlink and traversal never read, in default, `--trust-repository`, `--untrusted` and CI commit-range sync. `azure_security.sh` 16/16 (host secret never opened). Equivalence scenario `f18-orders-symlink-added` (the diagnostic is identical in incremental and full analysis). |
| D-05 | Secret literals reached the fact cache, entities and exports; a cache written by 0.17 kept them. | Redaction ran only on a name-based allowlist, after persistence of cached facts. | One value-level filter `redactSecretText` (`src/infrastructure/common.ts`) mirrored by `Redaction.Text` in Roslyn, applied before persistence to C#, JS/TS and IaC strings; `SecretArguments.cs` redacts arguments bound to credential parameters of Azure SDK/credential constructors regardless of shape; `FACT_CACHE_GENERATION = "2"` purges every store's fact cache on first open after upgrade. The blanket "any `key` parameter" rule was narrowed to cloud-SDK targets because it redacted `IConfiguration` indexer keys and broke Cosmos account resolution. | `boundary-secrets.test.ts` (canaries absent from `fact_cache`, entities, diagnostics, exports in all trust modes; "a fact cache written by an earlier generation is purged on open"), `azure_security.sh` canary checks 6/6, equivalence scenarios `f18-secrets-*` 3/3, `f18-orders-local-settings-secret`. |
| B-13 | A Git failure (unreadable `.git`, missing binary, corrupt index) was treated as "no changes" or re-registered the checkout under a path-derived `local:` identity. | `discovery.ts git()` returned `null` for every non-zero exit; sync mapped `null` to "no changes". | `GitStateError` thrown when `.git`/`GIT_DIR` exists but git cannot answer; `graph sync` refuses with exit 3, records `FAILED` / `git_state_unreadable`, runs no analysis; `analyze.ts` refuses to register a checkout under a `local:` identity when the catalog already holds it under another identity. | `test/incremental/git-failure.test.ts` 15/15 (previous graph, catalog entry, snapshot and identity byte-identical after each failure class). |

## P1 closure

| ID | Fix | Proof |
|---|---|---|
| F-01 | `AZURE_TOOLS` pushed before `TOOL_INDEX` is built (`src/ai/tools.ts`); `get_azure_triggers`, `get_azure_messaging`, `get_azure_infrastructure` added over the existing `azure-query.ts` functions. Callable from the AI planner, MCP stdio, MCP over HTTP, REST `/query/{tool}` and `ai-tool`. | `test/ai/azure-tools.test.ts` 12/12, `test/platform/mcp-http.test.ts` 10/10, `test/platform/api-hardening.test.ts` 13/13. |
| C-02 / C-03 | `src/frontend/modules.ts` `lazyImportTarget()` / `moduleExport()`: Angular `loadComponent`/`loadChildren` and React `lazy()` resolve default, named, aliased and re-exported targets from the imported file; non-literal specifiers stay unresolved with a reason. | `test/frontend/lazy-routes.test.ts` 12/12; equivalence `f18-lazy-*` 6/6. |
| D-01 | Terraform parent chains evaluated deepest-first (`account/database/container`). | `test/azure/terraform-identity.test.ts` 5/5, `f18-platform-tf-cosmos-module`, E2E `DECLARED_BY` Terraform `main.tf:30`. |
| D-02 | Clients in field/property initializers traced (`Resolver.fromAssignment`, `AssignmentFact` from `ProjectAnalyzer.cs`). | `test/azure/sdk-initializers.test.ts` 5/5, `f18-cosmos-init-*` 3/3, E2E `ShipmentStore` → `cosmos-contoso-fulfillment/fulfillmentdb/shipments`. |
| D-03 | Identity is `<account>/<leaf>`; bare leaf names never match a declaration (`unresolved-azure-account`, `ambiguous-azure-resource`); `azure-resources` MetaGraph resolver v3 is account-qualified. | `test/azure/identity.test.ts` 8/8, `metagraph-azure.test.ts` 5/5 (two namespaces with `orders` never cross-link; unknown-namespace consumer links to neither), `f18-identity-*` 6/6. |
| D-08 | CommonJS Node v4 registrations (`require("@azure/functions")`, `functions.app.http`, `import f = require`), mixed `.mjs`/`.cjs`, legacy `function.json`. | `test/azure/functions-node.test.ts` 6/6, `f18-node-*` 4/4. |
| D-09 | Empty/whitespace names are never identities: declarations get `nameState: unresolved` with site-suffixed keys, bindings produce no entity/edge. | `test/azure/evaluate.test.ts` 7/7, `identity.test.ts` EmptyNames case, `f18-identity-unknown-consumer-empty-name`. |
| D-11 | Source files above `VOGOBAN_MAX_SOURCE_FILE_BYTES` (8 MiB default) skipped with `FILE_SKIPPED_RESOURCE_LIMIT` by discovery and Roslyn alike; the rest of the repository is analyzed. | `boundary-secrets.test.ts`, `f18-orders-oversized-added` (9 MiB file: identical diagnostic incremental vs full, no crash). |
| A-01 | `safeReturnTo()` restricts OIDC `return_to` to a same-origin path at save and callback; bad percent-encoding in a path parameter is 400, not 500. | `test/platform/return-to.test.ts` 10/10, `api-hardening.test.ts`. |

Found and fixed during this phase, outside the 0.17.0 list: SSRF `isPrivateAddress()` accepted IPv4-mapped IPv6 (`::ffff:10.0.0.1`) and `[::]` (`test/ai/ssrf.test.ts` 50/50); the Roslyn fact-cache key ignored files discovery had skipped under a project, so an incremental sync after adding a symlink or oversized file reused cached facts and dropped the rejection diagnostic that a full analysis emits (`projectCacheKeys` now includes skipped paths and reasons; found by `f18-orders-symlink-added` / `f18-orders-oversized-added`, both now equivalent).

## Security gate

| Suite | Result | Notes |
|---|---|---|
| `test/security/boundary-secrets.test.ts` | 9/9 | Offline; `dotnet restore` uses packages already in the local NuGet cache. |
| `test/security/worker-jail.test.ts` | 5/5 | Namespace jail active on this host; hostile repository, cross-tenant store isolation, per-tenant NuGet root (`<tenant>/.nuget`) and HOME in jail and static-only modes. |
| `test/ai/ssrf.test.ts` | 50/50 + 2 todo | The two `todo` entries record accepted gaps: DNS rebinding between validation and connect (needs connect-time pinning) and the CLI/local provider endpoint being operator-owned and not validated. |
| `test/ai/adversarial.test.ts` / `budget.test.ts` | 26/26, 7/7 | Prompt-injection through tool results, tool-name spoofing, tenant/repository scoping, budget debit atomicity under concurrency. |
| `test/platform/api-hardening.test.ts`, `mcp-http.test.ts`, `client-ip.test.ts`, `return-to.test.ts`, `cli-hygiene.test.ts` | 13, 10, 3, 10, 8 — all pass | |
| `test/azure/harness/azure_security.sh` | 16/16 | No IaC/CLI execution, no network, host secret never read, canaries absent from store/export/logs, pathological Bicep bounded. |

## Regression gate

- **`bun test`:** 299 pass, 0 fail, 2 todo, 301 tests across 22 files, 60.5 s (`~/.capy/work/bun-test-final.txt`). **`bun run typecheck`:** clean.
- **Incremental equivalence (`test/azure/harness/azure_incr.py`):** 60/60 scenarios equivalent, 60/60 `actualMode: incremental`. 17 corpus scenarios over the Azure-Samples/aspire corpus (unchanged from 0.17: function add/modify/delete/rename, trigger, Bicep queue, Event Hubs, Event Grid, Cosmos, Bicep/Terraform resources, Aspire, shared module, configuration, azd manifest, host.json, Durable) plus 43 new `f18-*` scenarios over the shipped fixtures covering every Phase 18 change: Bicep/Terraform renames at namespace, topic, subscription and Cosmos-chain level, `local.settings.json` namespace changes, Node CommonJS/ESM/mixed/legacy functions, Cosmos field-initializer edits, Angular/React lazy-route edits, identity fixtures, secret literal edits, symlink and oversized file additions. Equality is over `entities`, `relationships`, `unresolved`, `diagnostics`, `conflicts`, `files` and the catalog graph version (`~/.capy/work/incr-final/results.json`). Run with `azure_incr.py fixtures <work>` for the fixture set alone.
- **Azure E2E + MetaGraph** (`~/.capy/work/e2e`, SDK 10): `contoso-orders`, `contoso-fulfillment`, `contoso-platform-infra` analyzed into one store; `unresolved: none` for fulfillment and platform-infra, one `dynamic-transport-name` in orders (a runtime-chosen transport, correctly left unresolved). `metagraph build` recomputed 17 Azure relationships (`DECLARED_BY`, `SHARES_RESOURCE sb-contoso-orders/orders`, `DEPENDS_ON_REPOSITORY`, `CONSUMES_REPOSITORY_CONTRACT`, 0 `meta_unresolved`). `azure flow "/orders/new" --depth 24` reaches route → component → API call → endpoint → service → `PUBLISHES_TO` → `SUBSCRIBES_TO sb-contoso-orders/orders/fulfillment` → `TRIGGERS Contoso.Fulfillment.Functions:FulfillOrder` → `WRITES_TO cosmos-contoso-fulfillment/fulfillmentdb/shipments`, with `DECLARED_BY` edges to `messaging.bicep:15` and `terraform/main.tf:30`; the upstream walk from the Bicep topic returns to the frontend. The fixtures gained `local.settings.json` files naming the namespaces (`OrdersBus__fullyQualifiedNamespace`, …) because under account-qualified identity a consumer without namespace evidence must stay unlinked — that is the D-03 rule working, not a regression.

## P2 and accepted limitations

- **B-04** worker healthcheck: the image `HEALTHCHECK` probes `${VOGOBAN_HEALTHCHECK_PORT:-8080}`; Compose sets the worker to 9464 so it probes its own health port. Compose also carries the `security_opt` the jail needs (documented in the runbook since 15.1).
- **B-05** release residue: the 0.17.0 tarball contained `.vogoban-platform/platform.db-wal` and `-shm`. `.vogoban-platform/`, `*.db*`, `test/**/bin|obj`, `__pycache__/` are ignored; `git archive HEAD` contains none of them.
- **A-02** `X-Forwarded-For` is honoured only from peers listed in `VOGOBAN_TRUSTED_PROXIES` (`client-ip.test.ts`).
- **C-04** wrapper routes: inline JSX children are followed; a wrapper taking the page through a prop or an `<Outlet/>` layout is not.
- **C-05** lazy loaders: only literal `import()` specifiers with a single selected export resolve; variables, element access, `loadable()` and multi-property `.then` mappings stay unresolved with the reason (over-approximation never produces a guessed edge).
- **C-07** CLI hygiene: `--version` prints `0.18.0`; unknown options exit 2 with a usage line (`cli-hygiene.test.ts`).
- **C-08** `hooks install --db` bakes the absolute store path into the hook. Limitation: every non-platform command opens the `--db` store eagerly.
- **D-04** frontend → Azure-hosted API in another repository is linked only through OpenAPI/route contract matching; Azure hosting does not bridge repositories.
- **D-10** a letters-only value of 32–63 characters with no credential-like name or parameter is kept as an identifier.
- **SSRF** DNS rebinding between validation and connect is not prevented (todo in `ssrf.test.ts`).
- **Jail probe:** inside the namespace jail `touch /etc/jail-write-probe` succeeded; whether that `/etc` is the jail's private tmpfs or the host's was not established, so the suite asserts repository/tenant/NuGet isolation and host-secret unreadability but not `/etc` read-only. Operators should treat `/etc` write protection as unverified.
- **Not restated:** B-02, B-03, B-06, B-07, B-08, C-06 (definitions unavailable to this phase).

## Release hygiene

`package.json` 0.18.0; `deploy/docker-compose.yml` image `vogoban:0.18.0`; `docs/runbook.md` names 0.18.0; `docs/release-readiness.md` is marked historical (Phase 12) and points here; `docs/release-gate-phase15.md` is a historical record and keeps its 0.15 numbers. `docs/azure.md`, `docs/frontend.md`, `docs/privacy.md`, `docs/incremental-sync.md`, `docs/platform.md`, `docs/runbook.md` describe the behaviour proven above and name every accepted limitation. `bunfig.toml` sets a 180 s test timeout for the .NET-backed suites; `test/azure/iac/{bicep,arm}.test.ts` corpus globs are skipped when the corpus directory is absent.

## Commits on the 0.17.0 baseline

`6823b3e` D-06/D-05/D-11 · `c15e59d` B-13 · `07ccb1c` C-02/C-03/C-04 · `a189a71` A-01/F-01/C-07 + API/MCP hardening suites · `f726ad7` SSRF/AI adversarial/budget suites · `81bd2d4` worker per-tenant NuGet/HOME + jail tests · `e521612` D-01/D-02/D-03/D-08/D-09 + CommonJS + TS redaction · `1cffc39` D-05 cloud-SDK scoping, E2E fixture evidence, test budget · `cca84be` release hygiene (0.18.0, B-04, A-02, C-08, B-05) · final: Roslyn cache key over skipped files, Phase 18 equivalence scenarios, docs and this report.
