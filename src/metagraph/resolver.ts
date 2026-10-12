import type { Entity, EntityKind, Provenance, Relationship, RelationshipType } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import type { MetaEmitter, RepoView } from "./emitter.ts";

export interface CrossRepositoryResolver<T> {
  readonly id: string;
  readonly version: string;
  readonly category: string;
  collect(store: GraphStore, repo: RepoView): T;
  resolve(inputs: Map<string, T>, emit: MetaEmitter, store: GraphStore): void;
}

export interface Fact {
  id: string;
  name: string;
  qualifiedName: string | null;
  kind: EntityKind;
  repositoryId: string | null;
  projectId: string | null;
  assembly: string | null;
  symbolKey: string | null;
  metadata: Entity["metadata"];
  provenance: Provenance[];
}

export interface Link {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  evidence: Relationship["evidence"];
  metadata: Relationship["metadata"];
  provenance: Provenance[];
}

export const fact = (e: Entity): Fact => ({
  id: e.id, name: e.name, qualifiedName: e.qualifiedName, kind: e.kind, repositoryId: e.repositoryId, projectId: e.projectId, assembly: e.assembly, symbolKey: e.symbolKey,
  metadata: e.metadata, provenance: e.location ? [{ ...(e.provenance[0] ?? ({} as Provenance)), location: e.location }] : e.provenance.slice(0, 1),
});

export const link = (r: Relationship): Link => ({ id: r.id, type: r.type, sourceId: r.sourceId, targetId: r.targetId, evidence: r.evidence, metadata: r.metadata, provenance: r.provenance.slice(0, 2) });

export function facts(store: GraphStore, repositoryId: string, kinds: EntityKind[]): Fact[] {
  return store.findEntities({ kinds, repositoryId }).map(fact);
}

export function links(store: GraphStore, repositoryId: string, types: RelationshipType[]): Link[] {
  return store.findRelationships({ types, repositoryId }).map(link);
}

export function groupBy<T>(items: Iterable<T>, key: (t: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  const m = /^[a-z][\w+.-]*:\/\/([^/:?#]*)/i.exec(url.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

export const isPlaceholderHost = (host: string) => /\$|\{|\}|^your|^x+$|example\.(com|org)$|^localhost$|^127\.|^0\.0\.0\.0$|^\+$|^\*$/i.test(host);
const PUBLIC_SUFFIX = /\.([a-z]{2}|com|net|org|io|dev|app|cloud|ai|biz|info|gov|edu|mil|int|tech|online|site|xyz|live|services)$/i;
export const isFqdn = (host: string) => PUBLIC_SUFFIX.test(host) && !/\.(db|sqlite3?|mdf|ldf|sdf)$/i.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPlaceholderHost(host);
