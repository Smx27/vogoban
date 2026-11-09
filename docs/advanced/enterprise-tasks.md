# Enterprise Architecture Intelligence Improvement Tasks & Testing Prompts

This document details the tasks and prompt templates for improving Vogoban's enterprise capabilities, developer experience, and multi-repository scalability, tested against real-world projects such as `dotnet/eShop`.

---

## Task 1: Smart CLI Entity Kind Inference & Prioritization

### Description
Enhance the Vogoban CLI entity resolution so that domain-specific commands automatically infer, prioritize, and filter to their expected target entity kinds, avoiding false collisions (e.g. `Assembly Catalog.API is not an Application`).

### Prompt Template
```markdown
**Goal:** Enhance the Vogoban CLI entity resolution so that domain-specific commands automatically infer, prioritize, and filter to their expected target entity kinds, avoiding false collisions (e.g. `Assembly Catalog.API is not an Application`).

**Requirements:**
1. In `src/cli/main.ts`, update `target(ref)` and command-level entity resolution:
   - For `service-impact`: default/prefer `kinds: ["Application"]` when resolving target entities.
   - For `api-impact`: default/prefer `kinds: ["ApiOperation", "Api"]`.
   - For `message-impact`: default/prefer `kinds: ["Message", "SharedContract"]`.
   - For `project`: default/prefer `kinds: ["Project"]`.
2. When multiple candidates exist across different entity kinds, prefer the command's expected kind if present. If multiple candidates of the same expected kind exist, display the ambiguous candidates list with their kinds and IDs.
3. If the user explicitly passes `--kind`, respect the explicit flag.
4. **Testing on Real Enterprise Repo (`dotnet/eShop`):**
   - Verify `vogoban service-impact Catalog.API` resolves directly to `Application Catalog.API` without requiring `--kind Application`.
   - Verify `vogoban service-impact Ordering.API` and `vogoban service-impact Basket.API` work without errors.
   - Ensure unit tests and CLI argument parsing tests pass.
```

---

## Task 2: Multi-Repository Batch Auto-Discovery (`vogoban metagraph discover`)

### Description
Add a `vogoban metagraph discover <directory>` command to automatically discover all Git repositories under a parent workspace directory, register them into the catalog, and optionally run analysis and MetaGraph build.

### Prompt Template
```markdown
**Goal:** Add a `vogoban metagraph discover <directory>` command to automatically discover all Git repositories under a parent workspace directory, register them into the catalog, and optionally run analysis and MetaGraph build.

**Requirements:**
1. Implement directory traversal in `src/metagraph/catalog.ts` via `discoverRepositories(baseDir, maxDepth)` that detects valid Git roots.
2. Wire `vogoban metagraph discover <path>` into `src/cli/main.ts` with options:
   - `--analyze`: automatically trigger analysis for all discovered repositories.
   - `--build`: trigger `metagraph build` after analysis completes.
   - `--max-depth`: search depth limit for repo root detection (default 3).
3. Provide structured human and `--json` summary output showing discovered, newly registered, and existing repositories.
4. **Testing on Real Enterprise Repos:**
   - Test against a multi-repo folder containing `dotnet/eShop` alongside Azure fixture repositories (e.g., `contoso-orders`, `contoso-fulfillment`).
   - Verify all repositories are discovered, registered, analyzed, and successfully linked in the MetaGraph snapshot.
```

---

## Task 3: Interactive Local Web UI Neighborhood Expansion & Drill-Down

### Description
Upgrade the local React Flow web graph viewer (`vogoban graph`) to support dynamic neighborhood expansion and entity drill-down for large enterprise repositories.

### Prompt Template
```markdown
**Goal:** Upgrade the local React Flow web graph viewer (`vogoban graph`) to support dynamic neighborhood expansion and entity drill-down for large enterprise repositories.

**Requirements:**
1. In `src/local/web/react-app.tsx` and the Inspector:
   - Add multi-hop expansion buttons (e.g., 1-hop and 2-hop neighborhood expansion).
   - Support calling `/api/entity/:id/neighborhood?depth=<depth>` dynamically.
   - Re-render the visual workspace with updated nodes and relationships smoothly.
2. Add search-and-focus: selecting an entity from search centers and expands its immediate neighborhood in the visual workspace.
3. **Testing on Real Enterprise Repo (`dotnet/eShop`):**
   - Run `vogoban graph` on `/app/samples/eshop` or `/var/tmp/eshop`.
   - In the visualizer, select `Catalog.API`, trigger 1-hop and 2-hop expansions, and verify that connected endpoints, DI services, and configuration nodes render properly.
```

---

## Task 4: Standalone Self-Contained CLI Packaging & Dependency Hardening

### Description
Ensure all runtime dependencies (such as `chalk`, `yaml`, `tree-sitter`, etc.) are reliably available or statically bundled with the `vogoban` binary executable so zero runtime dependency issues occur across diverse environments.

### Prompt Template
```markdown
**Goal:** Ensure all runtime dependencies (such as `chalk`, `yaml`, `tree-sitter`, etc.) are reliably available or statically bundled with the `vogoban` binary executable so zero runtime dependency issues occur across diverse environments.

**Requirements:**
1. Validate `bunfig.toml` and `package.json` configurations.
2. Verify that running `bun src/cli/main.ts` across any directory does not fail due to external node_modules resolution.
3. Add test coverage ensuring CLI commands execute reliably in clean subshells without ambient environment pollution.
4. **Testing on Real Enterprise Repo (`dotnet/eShop`):**
   - Execute the full suite of CLI commands (`analyze`, `stats`, `endpoints`, `apis`, `security`, `impact`, `mcp`, `graph`) from an external directory against `dotnet/eShop` to confirm flawless execution.
```
