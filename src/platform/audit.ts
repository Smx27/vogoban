import type { Db, Param } from "./db.ts";
import { decodeCursor, encodeCursor, newId, now, sha256 } from "./store.ts";

export interface AuditInput {
  tenantId: string | null;
  actorType: "user" | "token" | "system" | "anonymous" | "webhook";
  actorId: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome: "success" | "denied" | "failure";
  correlationId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

const SECRET_KEYS = /(secret|token|password|passwd|apikey|api_key|authorization|cookie|credential(?!_?ref))/i;

/** Metadata is recursively scrubbed of secret-like keys before it is stored; references (…Ref) are kept. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) && !/ref$/i.test(k) ? "[redacted]" : scrub(v, depth + 1)]));
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  return value;
}

/**
 * Append-only audit log with a per-tenant hash chain: each record's hash covers its content and the previous hash,
 * so removal or modification of historical records is detectable. Updates are rejected by database triggers.
 */
export class AuditLog {
  constructor(private readonly db: Db) {}

  async append(e: AuditInput): Promise<string> {
    const scope = e.tenantId ?? "platform";
    const id = newId("aud");
    const at = now();
    const metadata = JSON.stringify(scrub(e.metadata ?? {}));
    await this.db.tx(async (tx) => {
      const head = await tx.get<{ hash: string; seq: number }>(`SELECT hash, seq FROM audit_heads WHERE scope = ?${tx.dialect === "postgres" ? " FOR UPDATE" : ""}`, [scope]);
      const prev = head?.hash ?? "genesis";
      const hash = sha256([prev, id, at, e.tenantId ?? "", e.actorType, e.actorId ?? "", e.action, e.resourceType ?? "", e.resourceId ?? "", e.outcome, e.correlationId ?? "", metadata].join("\u0000"));
      await tx.run("INSERT INTO audit_events (id, tenant_id, at, actor_type, actor_id, action, resource_type, resource_id, outcome, correlation_id, ip, metadata, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, e.tenantId, at, e.actorType, e.actorId, e.action, e.resourceType ?? null, e.resourceId ?? null, e.outcome, e.correlationId ?? null, e.ip ?? null, metadata, prev, hash]);
      if (head) await tx.run("UPDATE audit_heads SET hash = ?, seq = seq + 1 WHERE scope = ?", [hash, scope]);
      else await tx.run("INSERT INTO audit_heads (scope, hash, seq) VALUES (?, ?, 1)", [scope, hash]);
    });
    return id;
  }

  async list(tenantId: string | null, filter: { action?: string; actorId?: string; resourceType?: string; resourceId?: string; outcome?: string; from?: string; to?: string; cursor?: string | null; limit: number }) {
    const params: Param[] = [];
    let where = tenantId ? "tenant_id = ?" : "tenant_id IS NULL";
    if (tenantId) params.push(tenantId);
    if (filter.action) (where += " AND action LIKE ?"), params.push(`${filter.action.replace(/[%_]/g, "")}%`);
    if (filter.actorId) (where += " AND actor_id = ?"), params.push(filter.actorId);
    if (filter.resourceType) (where += " AND resource_type = ?"), params.push(filter.resourceType);
    if (filter.resourceId) (where += " AND resource_id = ?"), params.push(filter.resourceId);
    if (filter.outcome) (where += " AND outcome = ?"), params.push(filter.outcome);
    if (filter.from) (where += " AND at >= ?"), params.push(filter.from);
    if (filter.to) (where += " AND at <= ?"), params.push(filter.to);
    const cursor = decodeCursor(filter.cursor);
    if (cursor) (where += " AND seq < ?"), params.push(Number(cursor));
    const rows = await this.db.all(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq DESC LIMIT ?`, [...params, filter.limit + 1]);
    const items = rows.slice(0, filter.limit).map((r) => ({ seq: Number(r.seq), id: r.id as string, at: r.at as string, actorType: r.actor_type as string, actorId: r.actor_id as string | null, action: r.action as string, resourceType: r.resource_type as string | null, resourceId: r.resource_id as string | null, outcome: r.outcome as string, correlationId: r.correlation_id as string | null, ip: r.ip as string | null, metadata: JSON.parse(r.metadata), hash: r.hash as string }));
    return { items, nextCursor: rows.length > filter.limit ? encodeCursor(String(items[items.length - 1]!.seq)) : null };
  }

  /** Recomputes the chain; reports the first record whose hash or link does not match (tampering or an unrecorded purge). */
  async verify(tenantId: string | null) {
    const head = await this.db.get<{ hash: string }>("SELECT hash FROM audit_heads WHERE scope = ?", [tenantId ?? "platform"]);
    const rows = await this.db.all(`SELECT * FROM audit_events WHERE ${tenantId ? "tenant_id = ?" : "tenant_id IS NULL"} ORDER BY seq`, tenantId ? [tenantId] : []);
    let prev: string | null = null;
    const purges = rows.filter((r) => r.action === "audit.purge").map((r) => JSON.parse(r.metadata) as { anchor?: string });
    const anchors = new Set(purges.map((m) => m.anchor).filter(Boolean));
    const legacyPurge = purges.some((m) => !m.anchor);
    const oldest = rows[0];
    if (oldest && oldest.prev_hash !== "genesis" && !anchors.has(oldest.prev_hash) && !legacyPurge) return { valid: false, records: rows.length, brokenAt: oldest.id as string, reason: "oldest records were removed without a recorded retention purge" };
    for (const r of rows) {
      const expected = sha256([r.prev_hash, r.id, r.at, r.tenant_id ?? "", r.actor_type, r.actor_id ?? "", r.action, r.resource_type ?? "", r.resource_id ?? "", r.outcome, r.correlation_id ?? "", r.metadata].join("\u0000"));
      if (expected !== r.hash) return { valid: false, records: rows.length, brokenAt: r.id as string, reason: "record content does not match its hash" };
      if (prev !== null && r.prev_hash !== prev && !String(r.prev_hash).startsWith("purge:")) return { valid: false, records: rows.length, brokenAt: r.id as string, reason: "chain link does not match the previous record" };
      prev = r.hash;
    }
    if (head && rows.length && !rows.some((r) => r.hash === head.hash)) return { valid: false, records: rows.length, brokenAt: null, reason: "newest records were removed (chain head does not match the last record)" };
    return { valid: true, records: rows.length, brokenAt: null, reason: null };
  }

  /** Explicit retention purge: only records older than the cutoff, recorded as its own audit event. */
  async purge(tenantId: string, before: string, actor: { type: AuditInput["actorType"]; id: string | null }, correlationId: string | null) {
    let anchor: string | null = null;
    const n = await this.db.tx(async (tx) => {
      if (tx.dialect === "postgres") await tx.run("SELECT set_config('vogoban.audit_retention', 'on', true)");
      else await tx.run("INSERT INTO audit_retention (active) VALUES (1)");
      const keep = await tx.get<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM audit_events WHERE tenant_id = ? AND at >= ?", [tenantId, before]);
      const boundary = keep?.seq ?? Number.MAX_SAFE_INTEGER;
      const first = await tx.get<{ prev_hash: string }>("SELECT prev_hash FROM audit_events WHERE tenant_id = ? AND seq >= ? ORDER BY seq LIMIT 1", [tenantId, boundary]);
      anchor = first?.prev_hash ?? null;
      const removed = await tx.run("DELETE FROM audit_events WHERE tenant_id = ? AND seq < ?", [tenantId, boundary]);
      if (tx.dialect === "sqlite") await tx.run("DELETE FROM audit_retention");
      return removed;
    });
    await this.append({ tenantId, actorType: actor.type, actorId: actor.id, action: "audit.purge", resourceType: "audit", outcome: "success", correlationId, metadata: { before, removed: n, anchor } });
    return n;
  }
}
