# Contributing

How to propose a change to Vogoban: what a change must include, which checks to run before submitting, and the rules that keep the graph trustworthy. Setup, test layout and extension points are in [Development](development.md).

## Before you start

- Read the [architecture overview](../architecture/overview.md) and the page for the area you touch (for example [Analyzers](../architecture/analyzers.md) or [Incremental engine](../architecture/incremental-engine.md)).
- Reproduce the behaviour you want to change with the CLI from source, on a copy of a fixture or a scratch repository, never on a store you care about:

  ```bash
  cp -r test/azure/fixtures/contoso-orders /tmp/contoso-orders
  bun src/cli/main.ts analyze /tmp/contoso-orders --db /tmp/contoso.db
  bun src/cli/main.ts stats --db /tmp/contoso.db
  ```

## What a change includes

| Change | Must include |
|---|---|
| New or changed fact extraction | A test that analyzes a fixture with the real CLI and asserts on stored entities, relationships, evidence levels and unresolved references; a bumped plugin `version` |
| New entity kind or relationship type | Entries in `src/graph/model.ts`, an impact category and a propagation rule in `src/analysis/semantics.ts`, tests ([Development](development.md#adding-entity-kinds-and-relationship-types)) |
| Store schema change | A bumped `GRAPH_SCHEMA_VERSION`, and a release note that existing stores must be re-analyzed |
| New CLI command or option | `HELP` text, `--json` output, exit codes following the CLI conventions, and exactly one page under `docs/cli/` |
| Platform API change | Route definition with schema, permission and feature (the OpenAPI document is generated from it), audit entry for writes, a test in `test/platform/` |
| New platform migration | A new numbered migration (never edit an applied one; checksums are verified at startup) and its `down` |
| Security fix | A regression test named after the finding id |
| Documentation | Updated pages under `docs/`; doc commands must use the installed `vogoban` command except on this page and [Development](development.md) |

## Checks to run

```bash
bun run typecheck
bun test --timeout 180000
```

Both must pass. Pass `--timeout` explicitly: Bun 1.3.14 ignores the `[test] timeout` key in `bunfig.toml`, and the integration suites exceed Bun's 5-second default. If a suite is skipped on your machine (no .NET SDK, no namespace support, no corpora; see [What is skipped](development.md#what-is-skipped-and-why)), say so when you submit, so a reviewer can run it.

For analyzer changes that can affect incremental results, also run the equivalence harness, which compares incremental sync against a clean full rebuild:

```bash
python3 test/azure/harness/azure_incr.py fixtures /tmp/azure-incr
```

For changes to repository reading, sandboxing or redaction, run the hostile-repository harness:

```bash
bash test/azure/harness/azure_security.sh /tmp/azure-security
```

## Rules that keep the graph trustworthy

- **No guessing.** When an analyzer cannot determine something statically, it records an unresolved reference with a category and a reason. Name similarity is never evidence.
- **Provenance on every fact.** Entities and relationships carry the plugin, extractor, mechanism, location and an evidence level.
- **Never execute repository content**, except MSBuild evaluation in trusted mode, and never use the network during analysis.
- **Secrets never persist.** Strings from repositories pass through the redaction filter before they reach the cache, graph, logs or exports. Platform secrets are references (`env:NAME`, `file:/path`).
- **Determinism.** Same input, same graph version: ids are hashes of stable keys, outputs are sorted.
- **Incremental equals full.** A change that affects what a file contributes must also be reflected in the incremental planner, so incremental sync stays equivalent to a full rebuild.
- **Failures keep the previous graph.** Persistence happens in one transaction; a crashing plugin degrades the graph with a diagnostic instead of failing the run.
- **Measured numbers only.** Performance figures in docs and release notes come from real runs, with the repository, hardware and version.

## Commit and review

- Keep a change focused on one concern, with its tests and documentation in the same change.
- Describe what changed, how you verified it (commands and results), and anything you could not verify.
- Reference the finding or issue id when fixing a reported defect.

## Related

- [Development](development.md)
- [Repository structure](../architecture/repository-structure.md)
- [Analysis pipeline](../architecture/analysis-pipeline.md)
