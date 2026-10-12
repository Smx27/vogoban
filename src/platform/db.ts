import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashOf } from "../graph/identity.ts";

export type Dialect = "sqlite" | "postgres";
export type Param = string | number | null;
export type Row = Record<string, any>;

export interface Db {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | null>;
  run(sql: string, params?: Param[]): Promise<number>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** SQL is written once with '?' placeholders; Postgres receives $n placeholders. */
const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: Database, private readonly inTx = false) {}

  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inTx) return Promise.resolve().then(fn);
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  all<T>(sql: string, params: Param[] = []) {
    return this.serial(() => this.db.query(sql).all(...params) as T[]);
  }
  get<T>(sql: string, params: Param[] = []) {
    return this.serial(() => (this.db.query(sql).get(...params) as T | null) ?? null);
  }
  run(sql: string, params: Param[] = []) {
    return this.serial(() => this.db.query(sql).run(...params).changes);
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.serial(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(new SqliteDb(this.db, true));
        this.db.exec("COMMIT");
        return out;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async ping() {
    await this.get("SELECT 1 AS ok");
  }
  async close() {
    this.db.close();
  }
}

class PostgresDb implements Db {
  readonly dialect = "postgres" as const;
  constructor(private readonly sql: any) {}
  async all<T>(query: string, params: Param[] = []) {
    return [...(await this.sql.unsafe(toPg(query), params))] as T[];
  }
  async get<T>(query: string, params: Param[] = []) {
    return ((await this.all<T>(query, params))[0] ?? null) as T | null;
  }
  async run(query: string, params: Param[] = []) {
    const r = await this.sql.unsafe(toPg(query), params);
    return Number(r.count ?? 0);
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (typeof this.sql.begin !== "function") return fn(this);
    return this.sql.begin((tx: any) => fn(new PostgresDb(tx)));
  }
  async ping() {
    await this.get("SELECT 1 AS ok");
  }
  async close() {
    await this.sql.close?.();
  }
}

export function openDb(url: string): Db {
  if (url.startsWith("sqlite://")) {
    const path = url.slice("sqlite://".length);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return new SqliteDb(db);
  }
  return new PostgresDb(new SQL(url.replace(/^postgresql:/, "postgres:"), { max: 10, idleTimeout: 30, prepare: false, connection: { statement_timeout: 30_000, lock_timeout: 10_000 } }));
}

interface Migration {
  version: number;
  name: string;
  up: Record<Dialect, string[]>;
  down: Record<Dialect, string[]>;
}

const both = (sql: string[]) => ({ sqlite: sql, postgres: sql });
const AUTO_ID = { sqlite: "INTEGER PRIMARY KEY AUTOINCREMENT", postgres: "BIGSERIAL PRIMARY KEY" };

const core = (d: Dialect) => [
  `CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE users (id TEXT PRIMARY KEY, issuer TEXT, subject TEXT, email TEXT, display_name TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT)`,
  `CREATE UNIQUE INDEX users_identity ON users (issuer, subject)`,
  `CREATE INDEX users_email ON users (email)`,
  `CREATE TABLE memberships (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))`,
  `CREATE TABLE invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, roles TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, accepted_at TEXT, accepted_by TEXT)`,
  `CREATE TABLE teams (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (tenant_id, key))`,
  `CREATE TABLE team_members (team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY (team_id, user_id))`,
  `CREATE TABLE roles (id TEXT PRIMARY KEY, tenant_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, permissions TEXT NOT NULL, builtin INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX roles_key ON roles (COALESCE(tenant_id, ''), key)`,
  `CREATE TABLE role_bindings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id), scope_type TEXT NOT NULL, scope_id TEXT, environments TEXT, created_by TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX role_bindings_principal ON role_bindings (tenant_id, principal_type, principal_id)`,
  `CREATE TABLE api_tokens (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT, revoked_at TEXT)`,
  `CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, ip TEXT, user_agent TEXT)`,
  `CREATE TABLE oidc_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, return_to TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE repositories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, provider TEXT NOT NULL, url TEXT NOT NULL, identity TEXT NOT NULL, organization TEXT, project TEXT, branch TEXT NOT NULL, credential_ref TEXT, webhook_secret_ref TEXT, team_id TEXT, status TEXT NOT NULL, catalog_id TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_analyzed_at TEXT, UNIQUE (tenant_id, identity))`,
  `CREATE TABLE jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), type TEXT NOT NULL, status TEXT NOT NULL, repository_id TEXT, dedupe_key TEXT, params TEXT NOT NULL, result TEXT, error_code TEXT, error_class TEXT, error_message TEXT, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, progress REAL, progress_message TEXT, priority INTEGER NOT NULL, exclusive INTEGER NOT NULL, run_after TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, cancel_requested INTEGER NOT NULL, created_by TEXT, correlation_id TEXT, traceparent TEXT, worker TEXT, graph_version_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE INDEX jobs_claim ON jobs (status, run_after, priority)`,
  `CREATE INDEX jobs_tenant ON jobs (tenant_id, created_at)`,
  `CREATE UNIQUE INDEX jobs_active_dedupe ON jobs (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING')`,
  `CREATE TABLE graph_versions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), repository_id TEXT NOT NULL, catalog_repository_id TEXT NOT NULL, graph_version TEXT NOT NULL, snapshot_id TEXT, commit_sha TEXT, branch TEXT, analyzer_version TEXT NOT NULL, schema_version INTEGER NOT NULL, config_fingerprint TEXT NOT NULL, config TEXT NOT NULL, plugin_versions TEXT NOT NULL, dedupe_key TEXT NOT NULL, job_id TEXT, correlation_id TEXT, status TEXT NOT NULL, entities INTEGER NOT NULL, relationships INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX graph_versions_repo ON graph_versions (tenant_id, repository_id, created_at)`,
  `CREATE INDEX graph_versions_dedupe ON graph_versions (tenant_id, dedupe_key)`,
  `CREATE TABLE documents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, UNIQUE (tenant_id, kind, name, version))`,
  `CREATE TABLE evaluations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), kind TEXT NOT NULL, job_id TEXT, snapshots TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE ai_queries (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT, at TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, provider TEXT, model TEXT, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, latency_ms INTEGER NOT NULL, record TEXT NOT NULL)`,
  `CREATE TABLE ai_usage (tenant_id TEXT NOT NULL, day TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, requests INTEGER NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (tenant_id, day, subject_type, subject_id))`,
  `CREATE TABLE audit_events (seq ${AUTO_ID[d]}, id TEXT NOT NULL UNIQUE, tenant_id TEXT, at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, outcome TEXT NOT NULL, correlation_id TEXT, ip TEXT, metadata TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`,
  `CREATE INDEX audit_tenant ON audit_events (tenant_id, seq)`,
  `CREATE TABLE audit_heads (scope TEXT PRIMARY KEY, hash TEXT NOT NULL, seq INTEGER NOT NULL)`,
  `CREATE TABLE workers (id TEXT PRIMARY KEY, hostname TEXT NOT NULL, pid INTEGER NOT NULL, version TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL, current_jobs TEXT NOT NULL)`,
  `CREATE TABLE locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL)`,
];

const DOWN_TABLES = ["locks", "workers", "audit_heads", "audit_events", "ai_usage", "ai_queries", "evaluations", "documents", "graph_versions", "jobs", "repositories", "oidc_states", "sessions", "api_tokens", "role_bindings", "roles", "team_members", "teams", "invitations", "memberships", "users", "tenants"];

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "platform core", up: { sqlite: core("sqlite"), postgres: core("postgres") }, down: both(DOWN_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`)) },
  {
    version: 2,
    name: "append-only audit log",
    up: {
      sqlite: [
        `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`,
        `CREATE TABLE audit_retention (active INTEGER NOT NULL)`,
        `CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events WHEN (SELECT COUNT(*) FROM audit_retention WHERE active = 1) = 0 BEGIN SELECT RAISE(ABORT, 'audit events can only be removed by an explicit retention purge'); END`,
      ],
      postgres: [
        `CREATE FUNCTION audit_guard() RETURNS trigger AS $$ BEGIN IF TG_OP = 'UPDATE' OR current_setting('vogoban.audit_retention', true) IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'audit events are append-only'; END IF; RETURN OLD; END $$ LANGUAGE plpgsql`,
        `CREATE TRIGGER audit_guard BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_guard()`,
      ],
    },
    down: {
      sqlite: ["DROP TRIGGER IF EXISTS audit_no_update", "DROP TRIGGER IF EXISTS audit_no_delete", "DROP TABLE IF EXISTS audit_retention"],
      postgres: ["DROP TRIGGER IF EXISTS audit_guard ON audit_events", "DROP FUNCTION IF EXISTS audit_guard()"],
    },
  },
];

const checksum = (m: Migration, d: Dialect) => hashOf(m.up[d].join(";\n")).slice(0, 16);

async function ensureTable(db: Db) {
  await db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
}

export async function migrationStatus(db: Db) {
  await ensureTable(db);
  const applied = await db.all<{ version: number; name: string; checksum: string; applied_at: string }>("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
  return MIGRATIONS.map((m) => {
    const a = applied.find((x) => Number(x.version) === m.version);
    return { version: m.version, name: m.name, applied: !!a, appliedAt: a?.applied_at ?? null, checksumMatches: a ? a.checksum === checksum(m, db.dialect) : null };
  }).concat(applied.filter((a) => !MIGRATIONS.some((m) => m.version === Number(a.version))).map((a) => ({ version: Number(a.version), name: a.name, applied: true, appliedAt: a.applied_at, checksumMatches: false })));
}

/** Applies pending migrations in order, each in its own transaction. Refuses to run when the database is newer than this build. */
export async function migrate(db: Db): Promise<number[]> {
  const status = await migrationStatus(db);
  const unknown = status.filter((s) => !MIGRATIONS.some((m) => m.version === s.version));
  if (unknown.length) throw new Error(`database has migrations unknown to this build (${unknown.map((u) => u.version).join(", ")}); upgrade the platform instead of downgrading`);
  const drift = status.filter((s) => s.applied && s.checksumMatches === false);
  if (drift.length) throw new Error(`applied migration(s) ${drift.map((d) => d.version).join(", ")} differ from this build`);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (status.find((s) => s.version === m.version)?.applied) continue;
    await db.tx(async (tx) => {
      for (const stmt of m.up[db.dialect]) await tx.run(stmt).catch((error) => {
        throw new Error(`migration ${m.version} (${m.name}) failed and was rolled back; the database remains at version ${applied.at(-1) ?? status.filter((s) => s.applied).at(-1)?.version ?? 0}: ${error instanceof Error ? error.message : String(error)}`);
      });
      await tx.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)", [m.version, m.name, checksum(m, db.dialect), new Date().toISOString()]);
    });
    applied.push(m.version);
  }
  return applied;
}

export async function rollback(db: Db, toVersion: number): Promise<number[]> {
  const status = await migrationStatus(db);
  const unknown = status.filter((s) => s.applied && s.version > toVersion && !MIGRATIONS.some((m) => m.version === s.version));
  if (unknown.length) throw new Error(`database has migrations unknown to this build (${unknown.map((u) => u.version).join(", ")}); roll back with the build that applied them`);
  const undone: number[] = [];
  for (const m of [...MIGRATIONS].reverse()) {
    if (m.version <= toVersion || !status.find((s) => s.version === m.version)?.applied) continue;
    await db.tx(async (tx) => {
      for (const stmt of m.down[db.dialect]) await tx.run(stmt);
      await tx.run("DELETE FROM schema_migrations WHERE version = ?", [m.version]);
    });
    undone.push(m.version);
  }
  return undone;
}

export async function pendingMigrations(db: Db): Promise<number> {
  return (await migrationStatus(db)).filter((s) => !s.applied).length;
}
