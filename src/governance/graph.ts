import type { EntityKind, GraphSnapshotRecord, Metadata, RelationshipType } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export interface GEntity {
  id: string;
  kind: EntityKind;
  name: string;
  qualifiedName: string | null;
  file: string | null;
  metadata: Metadata;
  projectId: string | null;
  repositoryId: string | null;
  line?: number | null;
  virtual?: boolean;
}

export interface GRel {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  evidence: string;
  metadata: Metadata;
  location: string | null;
  scope: "repository" | "meta" | "enterprise";
  snapshot: string;
}

export interface SnapshotSet {
  repositories: { repositoryId: string; name: string; snapshot: string; commit: string | null; graphVersion: string; createdAt: string }[];
  meta: { snapshot: string; metaSnapshot: string; createdAt: string } | null;
}

export function snapshotSet(store: GraphStore, options: { repositories?: string[]; repositorySnapshots?: Record<string, string>; metaSnapshot?: string | null; includeMeta: boolean }): SnapshotSet {
  const catalog = store.listCatalog();
  const repoIds = options.repositories ?? catalog.map((c) => c.repositoryId);
  const repositories: SnapshotSet["repositories"] = [];
  for (const id of [...repoIds].sort()) {
    const list = store.listGraphSnapshots({ scope: "repository", repositoryId: id });
    const wanted = options.repositorySnapshots?.[id];
    const pick = wanted ? [...list].reverse().find((s) => s.id === wanted || s.graphVersion.startsWith(wanted) || s.commit?.startsWith(wanted)) : (list.find((s) => s.graphVersion === catalog.find((c) => c.repositoryId === id)?.graphVersion) ?? list[list.length - 1]);
    if (!pick) {
      if (wanted) throw new Error(`snapshot ${wanted} not found for repository ${id}`);
      continue;
    }
    repositories.push({ repositoryId: id, name: catalog.find((c) => c.repositoryId === id)?.name ?? id, snapshot: pick.id, commit: pick.commit, graphVersion: pick.graphVersion, createdAt: pick.createdAt });
  }
  let meta: SnapshotSet["meta"] = null;
  if (options.includeMeta) {
    const list = store.listGraphSnapshots({ scope: "meta" });
    const wanted = options.metaSnapshot;
    const latestMeta = store.listMetaSnapshots()[0]?.id;
    const pick: GraphSnapshotRecord | undefined = wanted ? list.find((s) => s.id === wanted || s.graphVersion.startsWith(wanted)) : (list.find((s) => s.graphVersion === latestMeta) ?? list[list.length - 1]);
    if (wanted && !pick) throw new Error(`MetaGraph snapshot ${wanted} not found`);
    if (pick) meta = { snapshot: pick.id, metaSnapshot: pick.graphVersion, createdAt: pick.createdAt };
  }
  return { repositories, meta };
}

export class GovernanceGraph {
  readonly entities = new Map<string, GEntity>();
  readonly byKind = new Map<EntityKind, GEntity[]>();
  readonly out = new Map<string, GRel[]>();
  readonly in = new Map<string, GRel[]>();
  readonly byType = new Map<RelationshipType, GRel[]>();
  readonly repoNames = new Map<string, string>();
  readonly facts = new Map<string, Record<string, string[]>>();
  private readonly envCache = new Map<string, string[]>();
  private readonly appCache = new Map<string, GEntity[]>();

  constructor(store: GraphStore, readonly set: SnapshotSet) {
    for (const c of store.listCatalog()) {
      this.repoNames.set(c.repositoryId, c.name);
      this.repoNames.set(c.identity, c.name);
    }
    const ids = [...set.repositories.map((r) => r.snapshot), ...(set.meta ? [set.meta.snapshot] : [])];
    for (const id of ids) {
      const snap = store.getGraphSnapshot(id)!;
      const scope = snap.record.scope;
      for (const [eid, kind, name, qualifiedName, file, , metadata, projectId, repositoryId, line] of snap.payload.entities) {
        if (this.entities.has(eid) && (scope === "meta" || this.entities.get(eid)!.repositoryId)) continue;
        this.entities.set(eid, { id: eid, kind: kind as EntityKind, name, qualifiedName, file, metadata: metadata ?? {}, projectId: projectId ?? null, repositoryId: repositoryId ?? null, line: line ?? null });
      }
      for (const [rid, type, sourceId, targetId, evidence, , metadata, location] of snap.payload.relationships) {
        const rel: GRel = { id: rid, type: type as RelationshipType, sourceId, targetId, evidence, metadata: metadata ?? {}, location: location ?? null, scope, snapshot: id };
        this.push(this.out, sourceId, rel);
        this.push(this.in, targetId, rel);
        this.push(this.byType, rel.type, rel);
      }
    }
    for (const e of [...this.entities.values()].sort((a, b) => a.id.localeCompare(b.id))) this.push(this.byKind, e.kind, e);
  }

  invalidateEnvironments() {
    this.envCache.clear();
  }

  addVirtualEntity(e: GEntity) {
    if (this.entities.has(e.id)) return;
    this.entities.set(e.id, { ...e, virtual: true });
    this.push(this.byKind, e.kind, e);
  }

  addVirtualRelationship(rel: GRel) {
    if ((this.out.get(rel.sourceId) ?? []).some((r) => r.id === rel.id)) return;
    this.push(this.out, rel.sourceId, rel);
    this.push(this.in, rel.targetId, rel);
    this.push(this.byType, rel.type, rel);
  }

  private push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const l = map.get(key);
    if (l) l.push(value);
    else map.set(key, [value]);
  }

  outgoing(id: string, types?: RelationshipType[]): GRel[] {
    return (this.out.get(id) ?? []).filter((r) => !types || types.includes(r.type));
  }

  incoming(id: string, types?: RelationshipType[]): GRel[] {
    return (this.in.get(id) ?? []).filter((r) => !types || types.includes(r.type));
  }

  environments(e: GEntity): string[] {
    const cached = this.envCache.get(e.id);
    if (cached) return cached;
    const envs = new Set<string>();
    if (typeof e.metadata.environment === "string" && e.metadata.environment) envs.add(e.metadata.environment.toLowerCase());
    for (const env of this.facts.get(e.id)?.environment ?? []) envs.add(env.toLowerCase());
    for (const r of this.outgoing(e.id, ["IN_ENVIRONMENT"])) {
      const env = this.entities.get(r.targetId);
      if (env) envs.add(env.name.toLowerCase());
    }
    const out = [...envs].sort();
    this.envCache.set(e.id, out);
    return out;
  }

  relEnvironments(r: GRel): string[] {
    const own = typeof r.metadata.environment === "string" && r.metadata.environment ? [r.metadata.environment.toLowerCase()] : [];
    const s = this.entities.get(r.sourceId);
    const t = this.entities.get(r.targetId);
    return [...new Set([...own, ...(s ? this.environments(s) : []), ...(t ? this.environments(t) : [])])].sort();
  }

  private projectDirs: { dir: string; repositoryId: string | null; project: GEntity }[] | null = null;

  project(e: GEntity): GEntity | null {
    if (e.kind === "Project") return e;
    if (e.projectId) return this.entities.get(e.projectId) ?? null;
    if (!e.file) return null;
    this.projectDirs ??= (this.byKind.get("Project") ?? [])
      .map((p) => ({ dir: (p.qualifiedName ?? "").replace(/[^/]*$/, ""), repositoryId: p.repositoryId, project: p }))
      .sort((a, b) => b.dir.length - a.dir.length || a.project.id.localeCompare(b.project.id));
    return this.projectDirs.find((d) => d.repositoryId === e.repositoryId && e.file!.startsWith(d.dir))?.project ?? null;
  }

  applications(e: GEntity): GEntity[] {
    if (e.kind === "Application") return [e];
    const cached = this.appCache.get(e.id);
    if (cached) return cached;
    let apps: GEntity[] = [];
    if (e.kind === "ApiOperation") apps = this.incoming(e.id, ["CONTAINS"]).flatMap((r) => this.applications(this.entities.get(r.sourceId)!)).filter(Boolean);
    else if (e.kind === "Api") apps = this.incoming(e.id, ["CONTAINS"]).map((r) => this.entities.get(r.sourceId)!).filter((x) => x?.kind === "Application");
    else if (e.kind === "Deployment") apps = this.outgoing(e.id, ["RUNS"]).map((r) => this.entities.get(r.targetId)!).filter((x) => x?.kind === "Application");
    else {
      const project = this.project(e);
      if (project) apps = this.outgoing(project.id, ["DEFINES_APPLICATION"]).map((r) => this.entities.get(r.targetId)!).filter(Boolean);
    }
    apps = [...new Map(apps.map((a) => [a.id, a])).values()].sort((a, b) => a.id.localeCompare(b.id));
    this.appCache.set(e.id, apps);
    return apps;
  }

  repository(e: GEntity): GEntity | null {
    if (e.kind === "Repository") return e;
    if (!e.repositoryId) return null;
    return (this.byKind.get("Repository") ?? []).find((r) => r.repositoryId === e.repositoryId) ?? null;
  }

  repositoryName(id: string | null): string | null {
    return id ? (this.repoNames.get(id) ?? id) : null;
  }
}
