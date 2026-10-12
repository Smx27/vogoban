# Export, backup and restore commands

Three commands move graph data out of and back into a local store:

- `export` writes the repository graph (entities, relationships, unresolved references, diagnostics, conflicts) as JSON, JSON Lines or CSV, for other tools to read.
- `backup` writes a consistent single-file copy of the whole SQLite store.
- `restore` replaces a local store with a backup.

All three work offline with local files only. Backup and restore apply to local SQLite stores; the platform's PostgreSQL database and tenant stores are backed up with your infrastructure tooling (see [Enterprise operations](../advanced/enterprise.md)). Backup schedules and recovery procedures are in [Backup and restore operations](../advanced/backup-restore.md).

The examples use a scratch copy of the `contoso-orders` demo store (`./.vogoban/graph.db`).

## What each output contains

| | `export --format json` / `jsonl` | `export --format csv` | `backup` |
| --- | --- | --- | --- |
| Repository records | yes | no | yes |
| Entities, relationships | yes | yes | yes |
| Unresolved references | yes | yes (`unresolved.csv`) | yes |
| Analysis diagnostics | yes | no | yes |
| Conflicts | yes | no | yes |
| Provenance and metadata per entity/relationship | yes | yes (JSON-encoded columns) | yes |
| Catalog, analysis runs, file index | no | no | yes |
| Graph snapshots (history for `diff`) | no | no | yes |
| MetaGraph and MetaGraph snapshots | no (use `metagraph export`) | no | yes |
| Governance baselines, sync history | no | no | yes |
| Analysis caches | no | no | yes |
| `ai-audit.jsonl`, `ai-sessions/`, `locks/` next to the store | no | no | no |
| Can be loaded back with `restore` | no | no | yes |

Policy and enterprise metadata files are not in the store; keep them in version control.

## export

### What it does

Writes the repository graph to a file (`json`, `jsonl`) or a directory (`csv`). With `--repo` only that repository is exported. Without `--repo`, a store with one repository exports it and a store with several exports all of them.

### Usage

```bash
vogoban export --format json|jsonl|csv --out <path> [--repo R]
```

`--out` is required. `--format` defaults to `json`.

### Example

```bash
vogoban export --format jsonl --out graph.jsonl
vogoban export --format csv --out graph-csv
```

### Output

```text
Exported jsonl to graph.jsonl: repositories=1 entities=553 relationships=1149 unresolved=3 diagnostics=0 conflicts=0
```

```text
Exported csv to graph-csv: repositories=1 entities=553 relationships=1149 unresolved=3 diagnostics=0 conflicts=0
```

**JSON** is one object: `{"schemaVersion": 1, "repositories": [...], "entities": [...], "relationships": [...], "unresolved": [...], "diagnostics": [...], "conflicts": [...]}`.

**JSON Lines** has one record per line, each with a `record` field: `header` (schema version and export time), `repository`, `entity`, `relationship`, `unresolved`, `diagnostic`, `conflict`:

```json
{"record":"header","schemaVersion":1,"exportedAt":"2026-10-11T17:08:55.437Z"}
{"record":"repository","id":"e_ebfb205c403f02991a5b8df1","name":"contoso-orders","rootPath":"/home/user/.capy/work/scratch/cli2/demo/contoso-orders","remoteUrl":null,"branch":"main","commit":"0cae1639319573a79259cbf9b097a3…
```

Counting record types in that file:

```text
    553 "record":"entity"
      1 "record":"header"
   1149 "record":"relationship"
      1 "record":"repository"
      3 "record":"unresolved"
```

Individual analysis diagnostics (for example a `file-skipped` diagnostic for a Git submodule) appear as `"record":"diagnostic"` lines; this demo has none.

**CSV** writes `entities.csv`, `relationships.csv` and `unresolved.csv` into the `--out` directory:

```text
id,kind,layer,name,qualifiedName,repositoryId,projectId,assembly,language,symbolKey,external,file,line,metadata,provenance
e_012c3a8b47646fd7ddeed5bb,Method,semantic,SendEventAsync,"Azure.Messaging.EventGrid.EventGridPublisherClient.SendEventAsync(Azure.Messaging.CloudEvent, System.Threading.CancellationToken)",,,Azure.Messaging.EventGrid,csharp,…
```

`relationships.csv` columns: `id,type,sourceId,targetId,repositoryId,evidence,confidence,metadata,provenance`. `metadata` and `provenance` are JSON strings.

### Useful options

- `--repo R` exports one repository from a multi-repository store.
- For MetaGraph data use `vogoban metagraph export` (see [metagraph.md](metagraph.md#metagraph-export)).
- Analysis commands such as `impact`, `governance` or `security-findings` have their own `--out F --format …` for result exports.

### Common mistakes

- Expecting CSV to include diagnostics and conflicts. Only JSON and JSON Lines do.
- Expecting `export` to be restorable. It is an interchange format; use `backup` for recovery.
- `json` and `jsonl` are written to a temporary file and renamed, so a failure leaves the previous export intact. `csv` writes the files directly and can be left partial on failure; re-run the export.

## backup

### What it does

Writes a consistent, compacted copy of the whole store to one file using SQLite `VACUUM INTO`. The copy is taken in a single read transaction, so it is consistent even if another process is writing. It is first written to `<out>.partial-<pid>` and renamed only when complete, so a failure (including a full disk) never replaces an existing backup with a broken one. Parent directories are created.

### Usage

```bash
vogoban backup --out <path> [--db <store>]
```

### Example

```bash
vogoban backup --out backups/orders-2026-10-11.db
```

### Output

```text
Backup written to backups/orders-2026-10-11.db (consistent single-file copy of the local graph; no network, no vendor).
```

The backup is a normal SQLite database (3.3 MB for this store). It can be opened directly with `--db`:

```bash
vogoban repositories --db backups/orders-2026-10-11.db
```

### Common mistakes

- `vogoban backup` without `--out` exits 2 (`--out is required`).
- Copying `graph.db` with `cp` while Vogoban is running. The store uses SQLite WAL mode, so recent writes may be in `graph.db-wal`. `backup` handles this; a plain file copy does not.

## restore

### What it does

Replaces the target store with a backup file:

1. Checks that `--from` exists, then opens it as a graph store and reads its statistics.
2. Closes the target store.
3. Deletes the target `graph.db`, `graph.db-wal` and `graph.db-shm`.
4. Copies the backup file to the target path.

The target is `--db`, `$VOGOBAN_DB` or `./.vogoban/graph.db`. After restore, every command (graph queries, MetaGraph, analysis, `graph sync`, local MCP) uses the restored data.

### Usage

```bash
vogoban restore --from <backup> [--db <target>]
```

### Example

```bash
vogoban restore --from backups/orders-2026-10-11.db --db restored/graph.db
vogoban graph-snapshots --db restored/graph.db
```

### Output

```text
Restored restored/graph.db from backups/orders-2026-10-11.db. Graph, MetaGraph, analysis and local MCP use the restored store immediately.
```

```text
snapshot                     scope       repository      commit        graph version             created                   entities  relationships
---------------------------  ----------  --------------  ------------  ------------------------  ------------------------  --------  -------------
gs_cde2ce457ff69559062d15ba  repository  contoso-orders  ccaffed660b7  52302929f3b5444b45172d86  2026-10-11T17:04:35.253Z  553       1151
gs_8dc19bb6ecb81428373083f1  repository  contoso-orders  0cae16393195  4c1292c4b254a63757f88f2c  2026-10-11T17:05:11.787Z  524       1104
gs_217c92a3ca9107dc26178aa8  repository  contoso-orders  0cae16393195  13f471b55659f49f9465d0b8  2026-10-11T17:06:15.287Z  553       1149
```

Snapshots, catalog and history come back with the graph.

| Situation | Result |
| --- | --- |
| `--from` missing | exit 2, `--from <backup> is required` |
| backup file does not exist | exit 2, `backup not found: <path>` |
| target is a `postgres…` URL | exit 2, `restore targets a local sqlite store; set --db to a file path` |
| backup file is not a SQLite database | exit 1, `file is not a database`; the target is left untouched |

### Common mistakes

- Restoring from an **empty** file. Opening it as a graph store creates an empty schema inside that file, so the check passes, the target is replaced with an empty store, and the empty source file is modified. Check the backup's size (or run `vogoban repositories --db <backup>`) before restoring. This is a known defect in 0.18.0.
- Restoring a live store file instead of a `backup` output. `restore` copies only the main file; data still in the source's `-wal` file is lost. Always restore from a file written by `vogoban backup`.
- Expecting `restore` to bring back AI audit records or sessions. They live in files next to the store, not in it.
- Restoring into the default store from the wrong directory. Without `--db` the target is `./.vogoban/graph.db` relative to the current directory.

## Related

- [Backup and restore operations](../advanced/backup-restore.md)
- [metagraph.md](metagraph.md#metagraph-export) for MetaGraph export
- [Privacy](../advanced/privacy.md): what the store contains
