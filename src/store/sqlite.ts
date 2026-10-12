import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AnalysisRun,
  CatalogEntry,
  EntityKind,
  GraphSnapshotPayload,
  GraphSnapshotRecord,
  RelationshipType,
  MetaBatch,
  MetaConflict,
  MetaRelationship,
  MetaSnapshot,
  MetaUnresolved,
  Conflict,
  Diagnostic,
  Entity,
  FileRecord,
  GraphBatch,
  Relationship,
  RepositoryRecord,
  UnresolvedReference,
} from "../graph/model.ts";
import { GRAPH_SCHEMA_VERSION } from "../graph/model.ts";
import { FACT_CACHE_GENERATION } from "../infrastructure/common.ts";
import type { EntityFilter, GraphStats, GraphStore, MetaRelationshipFilter, RelationshipFilter, TemporalInfo } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, remote_url TEXT,
  branch TEXT, commit_sha TEXT, dirty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, commit_sha TEXT, started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL, schema_version INTEGER NOT NULL, analyzer_version TEXT NOT NULL,
  plugin_versions TEXT NOT NULL, stats TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_runs_repo ON runs(repository_id, started_at);
CREATE TABLE IF NOT EXISTS files (
  repository_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
  category TEXT NOT NULL, language TEXT, PRIMARY KEY (repository_id, path)
);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, layer TEXT NOT NULL, name TEXT NOT NULL,
  qualified_name TEXT, repository_id TEXT, project_id TEXT, assembly TEXT, language TEXT, symbol_key TEXT,
  file TEXT, start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  external INTEGER NOT NULL, metadata TEXT NOT NULL, provenance TEXT NOT NULL,
  first_seen_commit TEXT, last_seen_commit TEXT, first_seen_run TEXT NOT NULL, last_seen_run TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entities_repo ON entities(repository_id);
CREATE INDEX IF NOT EXISTS ix_entities_project ON entities(project_id);
CREATE INDEX IF NOT EXISTS ix_entities_symbol ON entities(symbol_key);
CREATE INDEX IF NOT EXISTS ix_entities_qname ON entities(qualified_name);
CREATE INDEX IF NOT EXISTS ix_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS ix_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS ix_entities_file ON entities(file);
CREATE INDEX IF NOT EXISTS ix_entities_commit ON entities(last_seen_commit);
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  repository_id TEXT, evidence TEXT NOT NULL, confidence REAL NOT NULL, metadata TEXT NOT NULL,
  provenance TEXT NOT NULL, file TEXT,
  first_seen_commit TEXT, last_seen_commit TEXT, first_seen_run TEXT NOT NULL, last_seen_run TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rel_source ON relationships(source_id, type);
CREATE INDEX IF NOT EXISTS ix_rel_target ON relationships(target_id, type);
CREATE INDEX IF NOT EXISTS ix_rel_type ON relationships(type);
CREATE INDEX IF NOT EXISTS ix_rel_repo ON relationships(repository_id);
CREATE INDEX IF NOT EXISTS ix_rel_file ON relationships(file);
CREATE INDEX IF NOT EXISTS ix_rel_commit ON relationships(last_seen_commit);
CREATE TABLE IF NOT EXISTS unresolved (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, source_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  target_display TEXT NOT NULL, resolver TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL NOT NULL,
  metadata TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_unresolved_repo ON unresolved(repository_id);
CREATE INDEX IF NOT EXISTS ix_unresolved_source ON unresolved(source_id);
CREATE TABLE IF NOT EXISTS diagnostics (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, category TEXT NOT NULL, plugin TEXT NOT NULL, file TEXT,
  severity TEXT NOT NULL, recoverable INTEGER NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_diag_repo ON diagnostics(repository_id);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY, repository_id TEXT, kind TEXT NOT NULL, subject TEXT NOT NULL, fact_ids TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conflicts_repo ON conflicts(repository_id);
CREATE TABLE IF NOT EXISTS catalog (
  repository_id TEXT PRIMARY KEY, identity TEXT NOT NULL, name TEXT NOT NULL, url TEXT, provider TEXT, organization TEXT,
  default_branch TEXT, local_path TEXT, status TEXT NOT NULL, registered_at TEXT NOT NULL, analyzed_commit TEXT, analyzed_dirty INTEGER NOT NULL DEFAULT 0,
  analyzed_run TEXT, analyzed_at TEXT, graph_version TEXT, analyzer_version TEXT, semantic INTEGER NOT NULL DEFAULT 1, last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_catalog_identity ON catalog(identity);
CREATE TABLE IF NOT EXISTS meta_inputs (category TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta_snapshots (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL, resolver_versions TEXT NOT NULL, repositories TEXT NOT NULL, categories TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta_entities (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT, metadata TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_meta_entities_kind ON meta_entities(kind);
CREATE INDEX IF NOT EXISTS ix_meta_entities_category ON meta_entities(category);
CREATE TABLE IF NOT EXISTS meta_relationships (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, type TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  source_repository_id TEXT, target_repository_id TEXT, environment TEXT, evidence TEXT NOT NULL, confidence REAL NOT NULL,
  metadata TEXT NOT NULL, provenance TEXT NOT NULL, snapshot_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_meta_rel_source ON meta_relationships(source_id, type);
CREATE INDEX IF NOT EXISTS ix_meta_rel_target ON meta_relationships(target_id, type);
CREATE INDEX IF NOT EXISTS ix_meta_rel_category ON meta_relationships(category);
CREATE INDEX IF NOT EXISTS ix_meta_rel_source_repo ON meta_relationships(source_repository_id);
CREATE INDEX IF NOT EXISTS ix_meta_rel_target_repo ON meta_relationships(target_repository_id);
CREATE INDEX IF NOT EXISTS ix_meta_rel_env ON meta_relationships(environment);
CREATE INDEX IF NOT EXISTS ix_meta_rel_evidence ON meta_relationships(evidence);
CREATE TABLE IF NOT EXISTS meta_unresolved (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, type TEXT NOT NULL, source_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  target_display TEXT NOT NULL, resolver TEXT NOT NULL, reason TEXT NOT NULL, confidence REAL NOT NULL, metadata TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_meta_unresolved_category ON meta_unresolved(category);
CREATE INDEX IF NOT EXISTS ix_meta_unresolved_repo ON meta_unresolved(repository_id);
CREATE TABLE IF NOT EXISTS meta_conflicts (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, fact_ids TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL, description TEXT NOT NULL, provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entities_kind_repo ON entities(kind, repository_id);
CREATE TABLE IF NOT EXISTS graph_snapshots (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, repository_id TEXT, commit_sha TEXT, graph_version TEXT NOT NULL, created_at TEXT NOT NULL,
  entity_count INTEGER NOT NULL, relationship_count INTEGER NOT NULL, payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_graph_snapshots_repo ON graph_snapshots(scope, repository_id, created_at);
CREATE TABLE IF NOT EXISTS governance_baselines (name TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fact_cache (scope TEXT PRIMARY KEY, cache_key TEXT NOT NULL, payload TEXT NOT NULL);
`;

type Row = Record<string, string | number | null>;

const str = (v: string | number | null | undefined) => (v == null ? null : String(v));
const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

function rowToEntity(r: Row): Entity {
  const file = str(r.file);
  return {
    id: String(r.id),
    key: String(r.key),
    kind: String(r.kind) as Entity["kind"],
    layer: String(r.layer) as Entity["layer"],
    name: String(r.name),
    qualifiedName: str(r.qualified_name),
    repositoryId: str(r.repository_id),
    projectId: str(r.project_id),
    assembly: str(r.assembly),
    language: str(r.language),
    symbolKey: str(r.symbol_key),
    location: file
      ? {
          file,
          startLine: Number(r.start_line),
          startColumn: Number(r.start_col),
          ...(r.end_line != null ? { endLine: Number(r.end_line), endColumn: Number(r.end_col) } : {}),
        }
      : null,
    external: Number(r.external) === 1,
    metadata: JSON.parse(String(r.metadata)),
    provenance: JSON.parse(String(r.provenance)),
  };
}

function rowToRelationship(r: Row): Relationship {
  return {
    id: String(r.id),
    type: String(r.type) as Relationship["type"],
    sourceId: String(r.source_id),
    targetId: String(r.target_id),
    repositoryId: str(r.repository_id),
    evidence: String(r.evidence) as Relationship["evidence"],
    confidence: Number(r.confidence),
    metadata: JSON.parse(String(r.metadata)),
    provenance: JSON.parse(String(r.provenance)),
  };
}

function inList(column: string, values: readonly string[], params: SQLQueryBindings[]): string {
  params.push(...values);
  return `${column} IN (${values.map(() => "?").join(",")})`;
}

function rowToSnapshot(r: Row): GraphSnapshotRecord {
  return {
    id: String(r.id), scope: String(r.scope) as GraphSnapshotRecord["scope"], repositoryId: str(r.repository_id), commit: str(r.commit_sha), graphVersion: String(r.graph_version),
    createdAt: String(r.created_at), entities: Number(r.entity_count), relationships: Number(r.relationship_count),
  };
}

function rowToCatalog(r: Row): CatalogEntry {
  return {
    repositoryId: String(r.repository_id),
    identity: String(r.identity),
    name: String(r.name),
    url: str(r.url),
    provider: str(r.provider),
    organization: str(r.organization),
    defaultBranch: str(r.default_branch),
    localPath: str(r.local_path),
    status: String(r.status) as CatalogEntry["status"],
    registeredAt: String(r.registered_at),
    analyzedCommit: str(r.analyzed_commit),
    analyzedDirty: Number(r.analyzed_dirty) === 1,
    analyzedRun: str(r.analyzed_run),
    analyzedAt: str(r.analyzed_at),
    graphVersion: str(r.graph_version),
    analyzerVersion: str(r.analyzer_version),
    semantic: Number(r.semantic) === 1,
    lastError: str(r.last_error),
  };
}

export class SqliteGraphStore implements GraphStore {
  private readonly db: Database;
  /** True when a stale fact cache could not be purged (read-only store): cached facts are then never served. */
  private cacheUnavailable = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout = 60000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;");
    this.db.exec(SCHEMA);
    const version = this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | null;
    if (!version) {
      this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(GRAPH_SCHEMA_VERSION));
    } else if (Number(version.value) !== GRAPH_SCHEMA_VERSION) {
      throw new Error(`Graph store schema v${version.value} does not match engine schema v${GRAPH_SCHEMA_VERSION}`);
    }
    const generation = this.db.query("SELECT value FROM meta WHERE key = 'fact_cache_generation'").get() as Row | null;
    if (generation?.value !== FACT_CACHE_GENERATION) {
      try {
        this.db.transaction(() => {
          this.db.query("DELETE FROM fact_cache").run();
          this.db.query("INSERT INTO meta (key, value) VALUES ('fact_cache_generation', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(FACT_CACHE_GENERATION);
        })();
      } catch {
        this.cacheUnavailable = true;
      }
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  saveRepositoryGraph(repository: RepositoryRecord, run: AnalysisRun, files: FileRecord[], batch: GraphBatch): void {
    const db = this.db;
    const tx = db.transaction(() => {
      db.query(
        `INSERT INTO repositories (id, name, root_path, remote_url, branch, commit_sha, dirty) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path, remote_url=excluded.remote_url,
         branch=excluded.branch, commit_sha=excluded.commit_sha, dirty=excluded.dirty`,
      ).run(repository.id, repository.name, repository.rootPath, repository.remoteUrl, repository.branch, repository.commit, repository.dirty ? 1 : 0);

      db.query(
        `INSERT INTO runs (id, repository_id, commit_sha, started_at, finished_at, schema_version, analyzer_version, plugin_versions, stats)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(run.id, run.repositoryId, run.commit, run.startedAt, run.finishedAt, run.schemaVersion, run.analyzerVersion, JSON.stringify(run.pluginVersions), JSON.stringify(run.stats));

      db.query("DELETE FROM files WHERE repository_id = ?").run(repository.id);
      const insertFile = db.query("INSERT INTO files (repository_id, path, hash, size, category, language) VALUES (?,?,?,?,?,?)");
      for (const f of files) insertFile.run(f.repositoryId, f.path, f.hash, f.size, f.category, f.language);

      const upsertEntity = db.query(
        `INSERT INTO entities (id, key, kind, layer, name, qualified_name, repository_id, project_id, assembly, language, symbol_key,
          file, start_line, start_col, end_line, end_col, external, metadata, provenance,
          first_seen_commit, last_seen_commit, first_seen_run, last_seen_run)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, layer=excluded.layer, name=excluded.name,
          qualified_name=excluded.qualified_name, repository_id=excluded.repository_id, project_id=excluded.project_id,
          assembly=excluded.assembly, language=excluded.language, symbol_key=excluded.symbol_key, file=excluded.file,
          start_line=excluded.start_line, start_col=excluded.start_col, end_line=excluded.end_line, end_col=excluded.end_col,
          external=excluded.external, metadata=excluded.metadata, provenance=excluded.provenance,
          last_seen_commit=excluded.last_seen_commit, last_seen_run=excluded.last_seen_run`,
      );
      for (const e of batch.entities) {
        const l = e.location;
        upsertEntity.run(
          e.id, e.key, e.kind, e.layer, e.name, e.qualifiedName, e.repositoryId, e.projectId, e.assembly, e.language, e.symbolKey,
          l?.file ?? null, l?.startLine ?? null, l?.startColumn ?? null, l?.endLine ?? null, l?.endColumn ?? null,
          e.external ? 1 : 0, JSON.stringify(e.metadata), JSON.stringify(e.provenance),
          run.commit, run.commit, run.id, run.id,
        );
      }

      const upsertRel = db.query(
        `INSERT INTO relationships (id, type, source_id, target_id, repository_id, evidence, confidence, metadata, provenance, file,
          first_seen_commit, last_seen_commit, first_seen_run, last_seen_run)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET evidence=excluded.evidence, confidence=excluded.confidence, metadata=excluded.metadata,
          provenance=excluded.provenance, file=excluded.file, repository_id=excluded.repository_id,
          last_seen_commit=excluded.last_seen_commit, last_seen_run=excluded.last_seen_run`,
      );
      for (const r of batch.relationships) {
        upsertRel.run(
          r.id, r.type, r.sourceId, r.targetId, r.repositoryId, r.evidence, r.confidence, JSON.stringify(r.metadata),
          JSON.stringify(r.provenance), r.provenance[0]?.location?.file ?? null, run.commit, run.commit, run.id, run.id,
        );
      }

      db.query("DELETE FROM entities WHERE repository_id = ? AND last_seen_run != ?").run(repository.id, run.id);
      db.query("DELETE FROM relationships WHERE repository_id = ? AND last_seen_run != ?").run(repository.id, run.id);
      db.exec(
        `DELETE FROM entities WHERE repository_id IS NULL AND id NOT IN (SELECT source_id FROM relationships)
         AND id NOT IN (SELECT target_id FROM relationships)`,
      );

      for (const table of ["unresolved", "diagnostics", "conflicts"]) {
        db.query(`DELETE FROM ${table} WHERE repository_id = ?`).run(repository.id);
      }
      const insertUnresolved = db.query(
        `INSERT INTO unresolved (id, type, source_id, repository_id, target_display, resolver, reason, confidence, metadata, provenance)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const u of batch.unresolved) {
        insertUnresolved.run(u.id, u.type, u.sourceId, u.repositoryId, u.targetDisplay, u.resolver, u.reason, u.confidence, JSON.stringify(u.metadata), JSON.stringify(u.provenance));
      }
      const insertDiag = db.query(
        `INSERT INTO diagnostics (id, repository_id, category, plugin, file, severity, recoverable, code, message) VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const d of batch.diagnostics) {
        insertDiag.run(d.id, d.repositoryId, d.category, d.plugin, d.file, d.severity, d.recoverable ? 1 : 0, d.code, d.message);
      }
      const insertConflict = db.query(
        `INSERT INTO conflicts (id, repository_id, kind, subject, fact_ids, severity, status, description, provenance) VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const c of batch.conflicts) {
        insertConflict.run(c.id, c.repositoryId, c.kind, c.subject, JSON.stringify(c.factIds), c.severity, c.status, c.description, JSON.stringify(c.provenance));
      }
    });
    tx();
  }

  listRepositories(): RepositoryRecord[] {
    return (this.db.query("SELECT * FROM repositories ORDER BY name").all() as Row[]).map(rowToRepository);
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.db.query("SELECT * FROM repositories WHERE id = ? OR name = ?").get(id, id) as Row | null;
    return row ? rowToRepository(row) : null;
  }

  listRuns(repositoryId: string): AnalysisRun[] {
    return (this.db.query("SELECT * FROM runs WHERE repository_id = ? ORDER BY started_at DESC").all(repositoryId) as Row[]).map((r) => ({
      id: String(r.id),
      repositoryId: String(r.repository_id),
      commit: str(r.commit_sha),
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
      schemaVersion: Number(r.schema_version),
      analyzerVersion: String(r.analyzer_version),
      pluginVersions: JSON.parse(String(r.plugin_versions)),
      stats: JSON.parse(String(r.stats)),
    }));
  }

  listFiles(repositoryId: string): FileRecord[] {
    return (this.db.query("SELECT * FROM files WHERE repository_id = ? ORDER BY path").all(repositoryId) as Row[]).map((r) => ({
      repositoryId: String(r.repository_id),
      path: String(r.path),
      hash: String(r.hash),
      size: Number(r.size),
      category: String(r.category) as FileRecord["category"],
      language: str(r.language),
    }));
  }

  getEntity(id: string): Entity | null {
    const row = this.db.query("SELECT * FROM entities WHERE id = ?").get(id) as Row | null;
    return row ? rowToEntity(row) : null;
  }

  findEntities(filter: EntityFilter): Entity[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.ids) {
      if (filter.ids.length === 0) return [];
      where.push(inList("id", filter.ids, params));
    }
    if (filter.kinds?.length) where.push(inList("kind", filter.kinds, params));
    if (filter.repositoryId) (where.push("repository_id = ?"), params.push(filter.repositoryId));
    if (filter.projectId) (where.push("project_id = ?"), params.push(filter.projectId));
    if (filter.symbolKey) (where.push("symbol_key = ?"), params.push(filter.symbolKey));
    if (filter.qualifiedName) (where.push("qualified_name = ?"), params.push(filter.qualifiedName));
    if (filter.file) (where.push("file = ?"), params.push(filter.file));
    if (filter.external !== undefined) (where.push("external = ?"), params.push(filter.external ? 1 : 0));
    if (filter.nameLike) {
      where.push("(name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')");
      const pattern = `%${filter.nameLike.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(pattern, pattern);
    }
    if (filter.repositoryIds) {
      if (filter.repositoryIds.length === 0) return [];
      where.push(inList("repository_id", filter.repositoryIds, params));
    }
    if (filter.afterId !== undefined) (where.push("id > ?"), params.push(filter.afterId));
    const sql = `SELECT * FROM entities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${filter.afterId !== undefined ? "id" : "kind, qualified_name, name, id"} ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.query(sql).all(...params) as Row[]).map(rowToEntity);
  }

  *iterateEntities(repositoryId?: string): Iterable<Entity> {
    const stmt = repositoryId
      ? this.db.query(
          `SELECT * FROM entities WHERE repository_id = ? OR (repository_id IS NULL AND id IN
            (SELECT target_id FROM relationships WHERE repository_id = ?1 UNION SELECT source_id FROM relationships WHERE repository_id = ?1)) ORDER BY id`,
        )
      : this.db.query("SELECT * FROM entities ORDER BY id");
    const rows = (repositoryId ? stmt.iterate(repositoryId) : stmt.iterate()) as IterableIterator<Row>;
    for (const row of rows) yield rowToEntity(row);
  }

  temporal(id: string): TemporalInfo | null {
    const row = (this.db.query("SELECT first_seen_commit, last_seen_commit, first_seen_run, last_seen_run FROM entities WHERE id = ?").get(id) ??
      this.db.query("SELECT first_seen_commit, last_seen_commit, first_seen_run, last_seen_run FROM relationships WHERE id = ?").get(id)) as Row | null;
    if (!row) return null;
    return {
      firstSeenCommit: str(row.first_seen_commit),
      lastSeenCommit: str(row.last_seen_commit),
      firstSeenRun: String(row.first_seen_run),
      lastSeenRun: String(row.last_seen_run),
    };
  }

  getRelationship(id: string): Relationship | null {
    const row = this.db.query("SELECT * FROM relationships WHERE id = ?").get(id) as Row | null;
    return row ? rowToRelationship(row) : null;
  }

  findRelationships(filter: RelationshipFilter): Relationship[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.sourceIds) {
      if (filter.sourceIds.length === 0) return [];
      where.push(inList("source_id", filter.sourceIds, params));
    }
    if (filter.targetIds) {
      if (filter.targetIds.length === 0) return [];
      where.push(inList("target_id", filter.targetIds, params));
    }
    if (filter.types?.length) where.push(inList("type", filter.types, params));
    if (filter.repositoryId) (where.push("repository_id = ?"), params.push(filter.repositoryId));
    if (filter.afterId !== undefined) (where.push("id > ?"), params.push(filter.afterId));
    const sql = `SELECT * FROM relationships ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${filter.afterId !== undefined ? "id" : "type, id"} ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.query(sql).all(...params) as Row[]).map(rowToRelationship);
  }

  *iterateRelationships(repositoryId?: string): Iterable<Relationship> {
    const rows = (repositoryId
      ? this.db.query("SELECT * FROM relationships WHERE repository_id = ? ORDER BY id").iterate(repositoryId)
      : this.db.query("SELECT * FROM relationships ORDER BY id").iterate()) as IterableIterator<Row>;
    for (const row of rows) yield rowToRelationship(row);
  }

  findUnresolved(filter: { repositoryId?: string; sourceIds?: string[]; limit?: number }): UnresolvedReference[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.repositoryId) (where.push("repository_id = ?"), params.push(filter.repositoryId));
    if (filter.sourceIds) {
      if (filter.sourceIds.length === 0) return [];
      where.push(inList("source_id", filter.sourceIds, params));
    }
    const sql = `SELECT * FROM unresolved ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY target_display, id ${
      filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""
    }`;
    return (this.db.query(sql).all(...params) as Row[]).map((r) => ({
      id: String(r.id),
      type: String(r.type) as UnresolvedReference["type"],
      sourceId: String(r.source_id),
      repositoryId: String(r.repository_id),
      targetDisplay: String(r.target_display),
      resolver: String(r.resolver),
      reason: String(r.reason),
      confidence: Number(r.confidence),
      metadata: JSON.parse(String(r.metadata)),
      provenance: JSON.parse(String(r.provenance)),
    }));
  }

  findDiagnostics(filter: { repositoryId?: string; limit?: number }): Diagnostic[] {
    const rows = (filter.repositoryId
      ? this.db.query(`SELECT * FROM diagnostics WHERE repository_id = ? ORDER BY severity, category, file, id ${filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""}`).all(filter.repositoryId)
      : this.db.query(`SELECT * FROM diagnostics ORDER BY severity, category, file, id ${filter.limit ? `LIMIT ${Math.floor(filter.limit)}` : ""}`).all()) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      repositoryId: String(r.repository_id),
      category: String(r.category) as Diagnostic["category"],
      plugin: String(r.plugin),
      file: str(r.file),
      severity: String(r.severity) as Diagnostic["severity"],
      recoverable: Number(r.recoverable) === 1,
      code: String(r.code),
      message: String(r.message),
    }));
  }

  findConflicts(filter: { repositoryId?: string }): Conflict[] {
    const rows = (filter.repositoryId
      ? this.db.query("SELECT * FROM conflicts WHERE repository_id = ? ORDER BY kind, subject").all(filter.repositoryId)
      : this.db.query("SELECT * FROM conflicts ORDER BY kind, subject").all()) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      repositoryId: str(r.repository_id),
      kind: String(r.kind),
      subject: String(r.subject),
      factIds: JSON.parse(String(r.fact_ids)),
      severity: String(r.severity) as Conflict["severity"],
      status: String(r.status) as Conflict["status"],
      description: String(r.description),
      provenance: JSON.parse(String(r.provenance)),
    }));
  }

  stats(repositoryId?: string): GraphStats {
    const scope = repositoryId ? "WHERE repository_id = ?" : "";
    const args: SQLQueryBindings[] = repositoryId ? [repositoryId] : [];
    const group = (sql: string) =>
      Object.fromEntries((this.db.query(sql).all(...args) as Row[]).map((r) => [String(r.k), Number(r.n)]));
    const count = (table: string) => Number((this.db.query(`SELECT COUNT(*) AS n FROM ${table} ${scope}`).get(...args) as Row).n);
    const entitiesByKind = group(`SELECT kind AS k, COUNT(*) AS n FROM entities ${scope} GROUP BY kind ORDER BY kind`);
    if (repositoryId) {
      const external = Number(
        (this.db.query("SELECT COUNT(DISTINCT target_id) AS n FROM relationships r JOIN entities e ON e.id = r.target_id WHERE r.repository_id = ? AND e.repository_id IS NULL").get(repositoryId) as Row).n,
      );
      if (external) entitiesByKind["(external)"] = external;
    }
    return {
      entitiesByKind,
      relationshipsByType: group(`SELECT type AS k, COUNT(*) AS n FROM relationships ${scope} GROUP BY type ORDER BY type`),
      relationshipsByEvidence: group(`SELECT evidence AS k, COUNT(*) AS n FROM relationships ${scope} GROUP BY evidence ORDER BY evidence`),
      typesBySymbolKind: group(
        `SELECT json_extract(metadata, '$.symbolKind') AS k, COUNT(*) AS n FROM entities ${scope ? `${scope} AND` : "WHERE"} kind = 'Type' AND external = 0 GROUP BY k ORDER BY k`,
      ),
      diagnosticsByCategory: group(`SELECT category AS k, COUNT(*) AS n FROM diagnostics ${scope} GROUP BY category ORDER BY category`),
      unresolvedByCategory: group(`SELECT COALESCE(json_extract(metadata, '$.category'), 'uncategorized') AS k, COUNT(*) AS n FROM unresolved ${scope} GROUP BY k ORDER BY k`),
      unresolved: count("unresolved"),
      diagnostics: count("diagnostics"),
      conflicts: count("conflicts"),
      files: count("files"),
    };
  }

  upsertCatalog(e: CatalogEntry): void {
    this.db.query(
      `INSERT INTO catalog (repository_id, identity, name, url, provider, organization, default_branch, local_path, status, registered_at,
        analyzed_commit, analyzed_dirty, analyzed_run, analyzed_at, graph_version, analyzer_version, semantic, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repository_id) DO UPDATE SET identity=excluded.identity, name=excluded.name, url=excluded.url, provider=excluded.provider,
        organization=excluded.organization, default_branch=excluded.default_branch, local_path=excluded.local_path, status=excluded.status,
        analyzed_commit=excluded.analyzed_commit, analyzed_dirty=excluded.analyzed_dirty, analyzed_run=excluded.analyzed_run, analyzed_at=excluded.analyzed_at,
        graph_version=excluded.graph_version, analyzer_version=excluded.analyzer_version, semantic=excluded.semantic, last_error=excluded.last_error`,
    ).run(
      e.repositoryId, e.identity, e.name, e.url, e.provider, e.organization, e.defaultBranch, e.localPath, e.status, e.registeredAt,
      e.analyzedCommit, e.analyzedDirty ? 1 : 0, e.analyzedRun, e.analyzedAt, e.graphVersion, e.analyzerVersion, e.semantic ? 1 : 0, e.lastError,
    );
  }

  getCatalog(ref: string): CatalogEntry | null {
    const row = this.db.query("SELECT * FROM catalog WHERE repository_id = ? OR identity = ? OR name = ? ORDER BY repository_id LIMIT 1").get(ref, ref, ref) as Row | null;
    return row ? rowToCatalog(row) : null;
  }

  listCatalog(): CatalogEntry[] {
    return (this.db.query("SELECT * FROM catalog ORDER BY name, repository_id").all() as Row[]).map(rowToCatalog);
  }

  metaFingerprint(category: string): string | null {
    const row = this.db.query("SELECT fingerprint FROM meta_inputs WHERE category = ?").get(category) as Row | null;
    return row ? String(row.fingerprint) : null;
  }

  replaceMetaCategory(category: string, fingerprint: string, batch: MetaBatch): void {
    const db = this.db;
    db.transaction(() => {
      for (const table of ["meta_entities", "meta_relationships", "meta_unresolved", "meta_conflicts"]) db.query(`DELETE FROM ${table} WHERE category = ?`).run(category);
      const e = db.query("INSERT OR REPLACE INTO meta_entities (id, category, key, kind, name, qualified_name, metadata, provenance) VALUES (?,?,?,?,?,?,?,?)");
      for (const x of batch.entities) e.run(x.id, category, x.key, x.kind, x.name, x.qualifiedName, JSON.stringify(x.metadata), JSON.stringify(x.provenance));
      const r = db.query(
        `INSERT OR REPLACE INTO meta_relationships (id, category, type, source_id, target_id, source_repository_id, target_repository_id, environment, evidence, confidence, metadata, provenance, snapshot_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const x of batch.relationships) r.run(x.id, category, x.type, x.sourceId, x.targetId, x.sourceRepositoryId, x.targetRepositoryId, x.environment, x.evidence, x.confidence, JSON.stringify(x.metadata), JSON.stringify(x.provenance), x.snapshotId);
      const u = db.query(
        "INSERT OR REPLACE INTO meta_unresolved (id, category, type, source_id, repository_id, target_display, resolver, reason, confidence, metadata, provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const x of batch.unresolved) u.run(x.id, category, x.type, x.sourceId, x.repositoryId, x.targetDisplay, x.resolver, x.reason, x.confidence, JSON.stringify(x.metadata), JSON.stringify(x.provenance));
      const c = db.query("INSERT OR REPLACE INTO meta_conflicts (id, category, kind, subject, fact_ids, severity, status, description, provenance) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const x of batch.conflicts) c.run(x.id, category, x.kind, x.subject, JSON.stringify(x.factIds), x.severity, x.status, x.description, JSON.stringify(x.provenance));
      db.query("INSERT INTO meta_inputs (category, fingerprint) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET fingerprint=excluded.fingerprint").run(category, fingerprint);
    })();
  }

  saveMetaSnapshot(s: MetaSnapshot): void {
    this.db.query(
      `INSERT INTO meta_snapshots (id, created_at, schema_version, resolver_versions, repositories, categories) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET categories=excluded.categories, created_at=excluded.created_at, repositories=excluded.repositories`,
    ).run(s.id, s.createdAt, s.schemaVersion, JSON.stringify(s.resolverVersions), JSON.stringify(s.repositories), JSON.stringify(s.categories));
  }

  listMetaSnapshots(): MetaSnapshot[] {
    return (this.db.query("SELECT * FROM meta_snapshots ORDER BY created_at DESC").all() as Row[]).map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      schemaVersion: Number(r.schema_version),
      resolverVersions: JSON.parse(String(r.resolver_versions)),
      repositories: JSON.parse(String(r.repositories)),
      categories: JSON.parse(String(r.categories)),
    }));
  }

  findMetaEntities(filter: { ids?: string[]; kinds?: EntityKind[]; nameLike?: string }): Entity[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.ids) where.push(filter.ids.length ? inList("id", filter.ids, params) : "0");
    if (filter.kinds?.length) where.push(inList("kind", filter.kinds, params));
    if (filter.nameLike) {
      where.push("(name LIKE ? OR qualified_name LIKE ?)");
      params.push(`%${filter.nameLike}%`, `%${filter.nameLike}%`);
    }
    const rows = this.db.query(`SELECT * FROM meta_entities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY kind, name, id`).all(...params) as Row[];
    return rows.map((r) => ({
      id: String(r.id), key: String(r.key), kind: String(r.kind) as Entity["kind"], layer: "meta", name: String(r.name), qualifiedName: str(r.qualified_name),
      repositoryId: null, projectId: null, assembly: null, language: null, symbolKey: null, location: null, external: false,
      metadata: JSON.parse(String(r.metadata)), provenance: JSON.parse(String(r.provenance)),
    }));
  }

  findMetaRelationships(filter: MetaRelationshipFilter): MetaRelationship[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.sourceIds) where.push(filter.sourceIds.length ? inList("source_id", filter.sourceIds, params) : "0");
    if (filter.targetIds) where.push(filter.targetIds.length ? inList("target_id", filter.targetIds, params) : "0");
    if (filter.types?.length) where.push(inList("type", filter.types, params));
    if (filter.categories?.length) where.push(inList("category", filter.categories, params));
    if (filter.repositoryId) {
      where.push("(source_repository_id = ? OR target_repository_id = ?)");
      params.push(filter.repositoryId, filter.repositoryId);
    }
    if (filter.environment) {
      where.push("(environment = ? OR environment IS NULL)");
      params.push(filter.environment);
    }
    const rows = this.db.query(`SELECT * FROM meta_relationships ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY category, type, id`).all(...params) as Row[];
    return rows.map((r) => ({
      ...rowToRelationship({ ...r, repository_id: null }),
      category: String(r.category),
      sourceRepositoryId: str(r.source_repository_id),
      targetRepositoryId: str(r.target_repository_id),
      environment: str(r.environment),
      snapshotId: String(r.snapshot_id),
    }));
  }

  findMetaUnresolved(filter: { category?: string; repositoryId?: string }): MetaUnresolved[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.category) {
      where.push("category = ?");
      params.push(filter.category);
    }
    if (filter.repositoryId) {
      where.push("repository_id = ?");
      params.push(filter.repositoryId);
    }
    const rows = this.db.query(`SELECT * FROM meta_unresolved ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY category, id`).all(...params) as Row[];
    return rows.map((r) => ({
      id: String(r.id), category: String(r.category), type: String(r.type) as MetaUnresolved["type"], sourceId: String(r.source_id), repositoryId: String(r.repository_id),
      targetDisplay: String(r.target_display), resolver: String(r.resolver), reason: String(r.reason), confidence: Number(r.confidence),
      metadata: JSON.parse(String(r.metadata)), provenance: JSON.parse(String(r.provenance)),
    }));
  }

  findMetaConflicts(filter: { category?: string }): MetaConflict[] {
    const rows = (filter.category ? this.db.query("SELECT * FROM meta_conflicts WHERE category = ? ORDER BY kind, subject").all(filter.category) : this.db.query("SELECT * FROM meta_conflicts ORDER BY kind, subject").all()) as Row[];
    return rows.map((r) => ({
      id: String(r.id), category: String(r.category), repositoryId: null, kind: String(r.kind), subject: String(r.subject), factIds: JSON.parse(String(r.fact_ids)),
      severity: String(r.severity) as MetaConflict["severity"], status: String(r.status) as MetaConflict["status"], description: String(r.description), provenance: JSON.parse(String(r.provenance)),
    }));
  }

  saveGraphSnapshot(r: GraphSnapshotRecord, payload: GraphSnapshotPayload): void {
    this.db.query(
      `INSERT INTO graph_snapshots (id, scope, repository_id, commit_sha, graph_version, created_at, entity_count, relationship_count, payload)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entity_count=excluded.entity_count, relationship_count=excluded.relationship_count, payload=excluded.payload`,
    ).run(r.id, r.scope, r.repositoryId, r.commit, r.graphVersion, r.createdAt, r.entities, r.relationships, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload))));
  }

  deleteGraphSnapshots(ids: string[]): void {
    const del = this.db.query("DELETE FROM graph_snapshots WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => del.run(id)))();
  }

  listGraphSnapshots(filter: { scope?: "repository" | "meta"; repositoryId?: string }): GraphSnapshotRecord[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.scope) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter.repositoryId) {
      where.push("repository_id = ?");
      params.push(filter.repositoryId);
    }
    const rows = this.db.query(`SELECT id, scope, repository_id, commit_sha, graph_version, created_at, entity_count, relationship_count FROM graph_snapshots ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`).all(...params) as Row[];
    return rows.map(rowToSnapshot);
  }

  getGraphSnapshot(id: string): { record: GraphSnapshotRecord; payload: GraphSnapshotPayload } | null {
    const row = this.db.query("SELECT * FROM graph_snapshots WHERE id = ?").get(id) as (Row & { payload: Uint8Array }) | null;
    if (!row) return null;
    return { record: rowToSnapshot(row), payload: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.payload as Uint8Array<ArrayBuffer>))) };
  }

  crossProjectUsage(repositoryId: string, types: RelationshipType[]): { sourceProjectId: string; targetProjectId: string | null; targetAssembly: string | null; count: number }[] {
    const params: SQLQueryBindings[] = [repositoryId];
    const rows = this.db.query(
      `SELECT s.project_id AS sp, t.project_id AS tp, t.assembly AS ta, COUNT(*) AS n FROM relationships r
       JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
       WHERE r.repository_id = ? AND ${inList("r.type", types, params)} AND s.project_id IS NOT NULL AND (t.project_id IS NULL OR s.project_id <> t.project_id)
       GROUP BY s.project_id, t.project_id, t.assembly ORDER BY s.project_id, t.project_id, t.assembly`,
    ).all(...params) as Row[];
    return rows.map((r) => ({ sourceProjectId: String(r.sp), targetProjectId: str(r.tp), targetAssembly: str(r.ta), count: Number(r.n) }));
  }

  saveBaseline(name: string, data: unknown): void {
    this.db.query("INSERT INTO governance_baselines (name, created_at, data) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET created_at=excluded.created_at, data=excluded.data").run(name, new Date().toISOString(), JSON.stringify(data));
  }

  getBaseline(name: string): { name: string; createdAt: string; data: unknown } | null {
    const row = this.db.query("SELECT * FROM governance_baselines WHERE name = ?").get(name) as Row | null;
    return row ? { name: String(row.name), createdAt: String(row.created_at), data: JSON.parse(String(row.data)) } : null;
  }

  listBaselines(): { name: string; createdAt: string }[] {
    return (this.db.query("SELECT name, created_at FROM governance_baselines ORDER BY name").all() as Row[]).map((r) => ({ name: String(r.name), createdAt: String(r.created_at) }));
  }

  getCachedFacts(scope: string, cacheKey: string): string | null {
    if (this.cacheUnavailable) return null;
    const row = this.db.query("SELECT payload FROM fact_cache WHERE scope = ? AND cache_key = ?").get(scope, cacheKey) as Row | null;
    return row ? String(row.payload) : null;
  }

  putCachedFacts(scope: string, cacheKey: string, payload: string): void {
    this.db
      .query("INSERT INTO fact_cache (scope, cache_key, payload) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET cache_key=excluded.cache_key, payload=excluded.payload")
      .run(scope, cacheKey, payload);
  }

  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    const partial = `${destination}.partial-${process.pid}`;
    rmSync(partial, { force: true });
    try {
      this.db.exec("VACUUM INTO ?", [partial]);
      renameSync(partial, destination);
    } finally {
      for (const f of [partial, `${partial}-journal`]) rmSync(f, { force: true });
    }
  }

  private closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function rowToRepository(r: Row): RepositoryRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    rootPath: String(r.root_path),
    remoteUrl: str(r.remote_url),
    branch: str(r.branch),
    commit: str(r.commit_sha),
    dirty: num(r.dirty) === 1,
  };
}
