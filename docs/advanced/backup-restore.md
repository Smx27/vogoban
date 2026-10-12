# Backup and restore

This page covers backing up and restoring a local graph store (SQLite) and a self-hosted platform (PostgreSQL plus the data volume), how to verify a restore, and what happens to incremental analysis afterwards. Command syntax is in the [CLI reference](../cli/backup-restore.md).

## What there is to back up

| Deployment | State | Where |
|---|---|---|
| Local CLI | Graph store: repository graphs, MetaGraph, graph snapshots, sync history, governance baselines, fact cache | `graph.db` (+ `graph.db-wal`, `graph.db-shm`), default `./.vogoban/graph.db` |
| Local CLI | AI audit log and sessions (only if you use `ask`) | `ai-audit.jsonl`, `ai-sessions/` next to the store |
| Local CLI | Your inputs: policies, enterprise metadata, `vogoban.json`, AI configuration | your repositories / files |
| Platform | Tenants, users, RBAC, tokens (hashed), jobs, graph versions, policy and metadata documents, audit log, AI usage | PostgreSQL (or SQLite in local mode) named by `VOGOBAN_DATABASE_URL` |
| Platform | One graph store per tenant, repository checkouts, exports, PR-check scratch graphs, tenant NuGet roots | `VOGOBAN_DATA_DIR` (`/data` in the image) |
| Platform | Configuration and secrets | environment, secret store, `VOGOBAN_PLATFORM_CONFIG` file |

Graph data is derived: re-analyzing the same commit with the same analyzer version and configuration reproduces it. Backups save the time of re-analysis and keep history (snapshots, sync history, baselines) that re-analysis cannot recreate.

## Local graph store (SQLite)

### Back up

```bash
vogoban backup --out ../backups/graph-2026-10-11.db
```

```text
Backup written to ../backups/graph-2026-10-11.db (consistent single-file copy of the local graph; no network, no vendor).
```

`backup` uses SQLite `VACUUM INTO` on the open store, so the copy is consistent even while the store is in WAL mode, and it is one file. It writes to a temporary file and renames it, so a failure never leaves a half-written backup in place of the previous one. It reads the store named by `--db`/`VOGOBAN_DB`, like every other command. No network is involved.

Copying files directly also works, but only when no Vogoban process is writing, and only if you copy `graph.db`, `graph.db-wal` and `graph.db-shm` together. Copying `graph.db` alone can lose the most recent transactions, which live in the WAL file.

### Restore

```bash
vogoban restore --from ../backups/graph-2026-10-11.db
```

```text
Restored .vogoban/graph.db from ../backups/graph-2026-10-11.db. Graph, MetaGraph, analysis and local MCP use the restored store immediately.
```

`restore`:

1. refuses when the backup does not exist ("backup not found: …") or when the target is a `postgres` URL;
2. opens the backup as a graph store to validate it (a backup written by an incompatible engine schema fails here, before anything is replaced);
3. closes the current store, deletes the target's `graph.db`, `-wal` and `-shm`, and copies the backup into place.

The target is `--db`, else `VOGOBAN_DB`, else `./.vogoban/graph.db`. Restoring into a new path (`--db /new/path/graph.db`) is a way to inspect a backup without touching the working store.

Precautions:

- The validation step opens the backup read-write. On a writable backup file this switches it to WAL mode and creates `-wal`/`-shm` files next to it, so its bytes (and checksum) change; its content does not. Make backup files read-only (`chmod a-w`) to keep them byte-identical: a read-only backup restores normally (verified).
- Stop hooks in `background`/`sync` mode, other terminals and MCP servers that use the store before restoring. `restore` replaces files; it does not coordinate with other processes.
- The store also holds the sync history and governance baselines. Restoring an older backup rolls them back too.

### Verify after restore

```bash
vogoban repositories
vogoban graph status
vogoban stats
```

`repositories` shows each catalog entry with its analyzed commit and graph version. `graph status` compares the analyzed commit with the checkout.

### Incremental analysis after a restore

A restored store is a normal store: `graph sync` compares the restored analyzed commit with the checkout and updates incrementally. Real run: back up at commit `052f7df1`, commit a change, sync, restore the backup, sync again:

```bash
vogoban backup --out ../backups/graph-2026-10-11.db
git commit -qam "notify cancellations"
vogoban graph sync
vogoban restore --from ../backups/graph-2026-10-11.db
vogoban graph status
vogoban graph sync
vogoban graph history
```

```text
contoso-orders: INCREMENTAL — 1 file change(s): +0 ~1 -0 renamed 0
  commit 052f7df1e76c -> cbf294b8e907  [working-tree]
  graph version 9872834103a6 -> 202002d689c9
…
Restored .vogoban/graph.db from ../backups/graph-2026-10-11.db. Graph, MetaGraph, analysis and local MCP use the restored store immediately.
contoso-orders: CHANGES_DETECTED
  analyzed commit  052f7df1e76c
  working commit   cbf294b8e907
  up to date       no  ·  changed files 1
  last sync        (none)
contoso-orders: INCREMENTAL — 1 file change(s): +0 ~1 -0 renamed 0
  commit 052f7df1e76c -> cbf294b8e907  [working-tree]
  graph version 9872834103a6 -> 202002d689c9
  changed files 1  ·  analyzed 42  ·  affected projects 2
  reconciled entities +6 ~2 -0  relationships +21 ~0 -0
  duration 2443 ms (baseline full 3099 ms)
…
timestamp                 mode         status   commit        files  ms    fallback
------------------------  -----------  -------  ------------  -----  ----  --------
2026-10-11T17:11:32.029Z  incremental  SUCCESS  cbf294b8e907  1      2443
```

The sync after the restore produced the same graph version (`202002d689c9`) as the sync before it, and the sync history now starts from the backup (the entry written before the restore is gone).

A restored store syncs incrementally as long as the analysis model matches: same analyzer and plugin versions, same `vogoban.json`, same semantic and trust mode. A backup taken with another version or mode is still usable, but the next sync is a full rebuild with the matching `fallbackCode` (`analyzer_version_changed`, `plugin_versions_changed`, `configuration_changed`, `evaluation_mode_changed`, …). A backup from an engine with a different graph schema cannot be opened at all (`Graph store schema vN does not match engine schema vM`); re-analyze instead.

## Platform (PostgreSQL and data volume)

The platform has two pieces of state that must be backed up together: the PostgreSQL database and the `VOGOBAN_DATA_DIR` volume.

### Back up

- **Database**: your standard PostgreSQL tooling: managed backups with point-in-time recovery, or `pg_dump -Fc`. `pg_dump` must be at least the server's major version (a PostgreSQL 16 `pg_dump` refuses a 17 server; run it in the server's container if needed).
- **Data volume**: a volume snapshot. Tenant graph stores are SQLite in WAL mode; a snapshot of the whole volume is consistent per file only if taken atomically or while workers are stopped. Per store, `sqlite3 graph.db ".backup /path/copy.db"` gives a consistent copy.
- **Configuration**: environment, secret store and the YAML file. Policy and enterprise-metadata documents are in the database.

Example (Docker Compose reference deployment, service `postgres`):

```bash
docker compose exec -T postgres pg_dump -U vogoban -Fc vogoban > vogoban.dump
```

### Restore and verify

Stop `platform serve` and `platform worker`, then:

1. Restore the database into the one named by `VOGOBAN_DATABASE_URL`:

   ```bash
   docker compose exec -T postgres pg_restore -U vogoban -d vogoban --exit-on-error < vogoban.dump
   ```

2. Restore the `VOGOBAN_DATA_DIR` volume from the snapshot taken with that dump.
3. Verify:

   ```bash
   vogoban platform migrate status
   vogoban platform audit verify contoso
   ```

   Every migration must show `"applied": true` and `"checksumMatches": true`, and `audit verify` must return `"valid": true` (exit 4 otherwise). Then spot-check `GET /api/v1/t/{tenant}/graph-versions` and an entity search.

4. Start the API and workers. Jobs that were running at backup time have expired leases and are re-queued.

This sequence was run against PostgreSQL 17 with a local-mode platform: back up with `pg_dump -Fc` and a tar of the data directory, drop and recreate the database, delete the data directory, `pg_restore --exit-on-error`, extract the data directory. Afterwards:

```text
[(1, True, True), (2, True, True)]     # platform migrate status: version, applied, checksumMatches
{
  "valid": true,
  "records": 3,
  "brokenAt": null,
  "reason": null
}
```

and the graph versions and entity search returned the data analyzed before the backup.

### When the data volume is missing or older than the database

Graph data is reproducible. Each graph version records the commit, analyzer version and configuration fingerprint, so re-running analysis of a recorded commit rebuilds a missing tenant graph: `POST /api/v1/t/{tenant}/repositories/{id}/analyze` with `{"ref": "<commit>", "force": true}`. History that existed only in the lost store (older snapshots used by `GET …/graph-versions/{id}/entities`) cannot be recreated.

### Upgrades

Take a database backup before every upgrade. Migrations run one per transaction; a failing migration rolls back as a whole. PostgreSQL major upgrades were verified from 16.15 to 17.11 with `pg_dump -Fc` / `pg_restore --exit-on-error`; `pg_upgrade` was not verified. See the [runbook](runbook.md#migrate).

## What is not guaranteed

Vogoban provides consistent single-file local backups and documents a verified restore sequence. It does not provide scheduled backups, retention of backups, off-site replication, or a recovery-time or recovery-point objective. Those come from your PostgreSQL service, volume snapshots and operating procedures.

## Related

- [`backup` / `restore` commands](../cli/backup-restore.md)
- [Runbook](runbook.md)
- [Enterprise platform](enterprise.md)
- [Troubleshooting](troubleshooting.md)
