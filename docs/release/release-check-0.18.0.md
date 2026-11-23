# Vogoban 0.18.0 release check (November 17, 2026)

This report records the release check of the 0.18.0 source distribution: the auto-discovery feature, the gaps and defects fixed before release, how they were verified, and what remains open. Every result below was produced by running this tree (Ubuntu 24.04 x86_64, Bun 1.4.4, .NET SDK 8.0.428, and 9/10 for eShop).

## New in this release

- `vogoban discover <dir>` finds every repository under a folder (`.git`, `vogoban.json` or `catalog-info.yaml`), registers it, analyzes new or changed checkouts, rebuilds the MetaGraph, reports stale catalog entries and refuses to merge two checkouts of the same remote. See [MetaGraph commands](../cli/metagraph.md#discover).
- Cross-repository `ProjectReference` paths and npm `file:` dependencies become `DEPENDS_ON_REPOSITORY` edges (`project-reference-path`, `file-dependency-path`), so contract repositories have dependents and a blast radius.
- Backstage `catalog-info.yaml` owners are an ownership source; KEDA `ScaledObject` and `TriggerAuthentication` are modelled.
- MCP stdio accepts JSON-RPC batches.

## Defects fixed

| Area | Defect | Fix |
|---|---|---|
| backup/restore | `restore --from X --db X` deleted the only backup | refused; restore now copies to a staging file and renames |
| API resolution | typed `HttpClient` calls with a runtime base address resolved to the caller's own controllers, hiding gateway → service calls | never matched to the calling application; reported as unresolved candidates |
| MetaGraph API | a service-host name alone created `CALLS_REPOSITORY` between unrelated systems (eShop → eShopOnContainers) | a repository edge requires a matching operation |
| MetaGraph packages | contract repositories had no dependents | path-based project and npm links (above) |
| MCP scope | `get_external_systems` leaked other repositories under `--repo`; `--scope repository` served MetaGraph facts | accessors and systems filtered by scope; MetaGraph tools refuse in repository scope |
| MCP | `get_message_consumers` summary named the contract as consumer; batches were dropped | summary lists repositories and handlers; batches answered |
| Local graph server | no Host validation (DNS rebinding), no security headers | loopback Host required (403 otherwise); CSP, nosniff, frame and referrer headers |
| CLI | missing `--db` silently created an empty store | read commands exit 2 with `no graph store at <path>` |
| CLI | `analyze-all` exited 0 when repositories failed; `help` was unknown; `register` accepted files and silently re-pointed another checkout of the same remote; export errors named a temporary file | exit 1 on failure; `help` works; register validates and needs `--force` to re-point; the missing directory is named |
| Status | `graph status` on a tree analyzed without a commit said `UP_TO_DATE` after edits | `FULL_REBUILD_REQUIRED` |
| Diagnostics | unrestored or uncompilable .NET projects silently lost SDK and messaging facts | warning in `discover`/`analyze-all` and in the compiler diagnostic |
| Topology | wording said "depends on" for every edge; `--reverse` listed contract consumers as upstream | each step is phrased from its stored direction; shared contracts are not walked upstream |
| Governance | `governance` failed without a policy folder | passes with "No policies configured" |
| AI | "who consumes OrderCreatedEvent" was ambiguous between a shared contract and its per-repository copies | resolves to the shared contract |

## Verification

- `bun test`: 0 failures; `bun run typecheck` clean; documentation site builds 76 pages.
- Bundled landscape with `discover` (restored): 11 repositories, 161 MetaGraph relationships, 22 unresolved API candidates, 0 conflicts; without `dotnet restore`: 126 relationships and a restore warning.
- One store with 33 repositories from dotnet/eShop, its seven-service split, eShopOnContainers, two landscape copies and two Azure-Samples todo apps: discovered and analyzed in 2 min 8 s with 654 MB peak memory; no eShop ↔ eShopOnContainers edge; two same-remote checkouts reported as `CONFLICT`; reruns skip unchanged commits.
- CLI sweep of 136 commands with and without `--json`: no crash; non-zero exits are documented usage outcomes (ambiguous or unknown references).
- QA reproduction scripts: every P1 and the P2s listed above no longer reproduce.
- Container image builds and runs `discover` offline (`--network none`).

## Known issues carried into this release

- `diff --meta` can report a message contract as removed when one consumer changes (P2).
- Local graph UI: search does not find MetaGraph entities; "Explore impact" fails for MetaGraph entities; "Show all relationships" on a graph the size of eShop (30k relationships) freezes the tab for tens of seconds (P2).
- Duplicate rows in `service-impact` and multi-repository tables without a repository column; `endpoint` lookups do not normalize route templates; numeric option validation; several MCP input-validation and documentation gaps (P3).
- Incremental sync equals a full rebuild but is only about 25% faster on eShop.
