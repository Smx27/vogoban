import type {
  AnalysisRun,
  CatalogEntry,
  GraphSnapshotPayload,
  GraphSnapshotRecord,
  MetaBatch,
  MetaConflict,
  MetaRelationship,
  MetaSnapshot,
  MetaUnresolved,
  Conflict,
  Diagnostic,
  Entity,
  EntityKind,
  FileRecord,
  GraphBatch,
  Relationship,
  RelationshipType,
  RepositoryRecord,
  UnresolvedReference,
} from "../graph/model.ts";

export interface EntityFilter {
  ids?: string[];
  kinds?: EntityKind[];
  repositoryId?: string;
  projectId?: string;
  symbolKey?: string;
  qualifiedName?: string;
  nameLike?: string;
  file?: string;
  external?: boolean;
  limit?: number;
  /** Keyset pagination: only entities with id greater than this, ordered by id. */
  afterId?: string;
  /** Restrict to these repositories (entities without a repository are excluded when set). */
  repositoryIds?: string[];
}

export interface RelationshipFilter {
  sourceIds?: string[];
  targetIds?: string[];
  types?: RelationshipType[];
  repositoryId?: string;
  limit?: number;
  /** Keyset pagination: only relationships with id greater than this, ordered by id. */
  afterId?: string;
}

export interface MetaRelationshipFilter {
  sourceIds?: string[];
  targetIds?: string[];
  types?: RelationshipType[];
  categories?: string[];
  repositoryId?: string;
  environment?: string;
}

export interface TemporalInfo {
  firstSeenCommit: string | null;
  lastSeenCommit: string | null;
  firstSeenRun: string;
  lastSeenRun: string;
}

export interface GraphStats {
  entitiesByKind: Record<string, number>;
  relationshipsByType: Record<string, number>;
  relationshipsByEvidence: Record<string, number>;
  typesBySymbolKind: Record<string, number>;
  diagnosticsByCategory: Record<string, number>;
  unresolvedByCategory: Record<string, number>;
  unresolved: number;
  diagnostics: number;
  conflicts: number;
  files: number;
}

export interface GraphStore {
  saveRepositoryGraph(repository: RepositoryRecord, run: AnalysisRun, files: FileRecord[], batch: GraphBatch): void;
  /** Runs fn atomically (nested calls become savepoints). */
  transaction<T>(fn: () => T): T;

  listRepositories(): RepositoryRecord[];
  getRepository(id: string): RepositoryRecord | null;
  listRuns(repositoryId: string): AnalysisRun[];
  listFiles(repositoryId: string): FileRecord[];

  getEntity(id: string): Entity | null;
  findEntities(filter: EntityFilter): Entity[];
  iterateEntities(repositoryId?: string): Iterable<Entity>;
  temporal(id: string): TemporalInfo | null;

  getRelationship(id: string): Relationship | null;
  findRelationships(filter: RelationshipFilter): Relationship[];
  iterateRelationships(repositoryId?: string): Iterable<Relationship>;

  findUnresolved(filter: { repositoryId?: string; sourceIds?: string[]; limit?: number }): UnresolvedReference[];
  findDiagnostics(filter: { repositoryId?: string; limit?: number }): Diagnostic[];
  findConflicts(filter: { repositoryId?: string }): Conflict[];
  stats(repositoryId?: string): GraphStats;

  upsertCatalog(entry: CatalogEntry): void;
  getCatalog(ref: string): CatalogEntry | null;
  listCatalog(): CatalogEntry[];

  metaFingerprint(category: string): string | null;
  replaceMetaCategory(category: string, fingerprint: string, batch: MetaBatch): void;
  saveMetaSnapshot(snapshot: MetaSnapshot): void;
  listMetaSnapshots(): MetaSnapshot[];
  findMetaEntities(filter: { ids?: string[]; kinds?: EntityKind[]; nameLike?: string }): Entity[];
  findMetaRelationships(filter: MetaRelationshipFilter): MetaRelationship[];
  findMetaUnresolved(filter: { category?: string; repositoryId?: string }): MetaUnresolved[];
  findMetaConflicts(filter: { category?: string }): MetaConflict[];

  saveGraphSnapshot(record: GraphSnapshotRecord, payload: GraphSnapshotPayload): void;
  listGraphSnapshots(filter: { scope?: "repository" | "meta"; repositoryId?: string }): GraphSnapshotRecord[];
  deleteGraphSnapshots(ids: string[]): void;
  getGraphSnapshot(id: string): { record: GraphSnapshotRecord; payload: GraphSnapshotPayload } | null;
  crossProjectUsage(repositoryId: string, types: RelationshipType[]): { sourceProjectId: string; targetProjectId: string | null; targetAssembly: string | null; count: number }[];

  saveBaseline(name: string, data: unknown): void;
  getBaseline(name: string): { name: string; createdAt: string; data: unknown } | null;
  listBaselines(): { name: string; createdAt: string }[];

  getCachedFacts(namespace: string, cacheKey: string): string | null;
  putCachedFacts(namespace: string, cacheKey: string, payload: string): void;

  backup(destination: string): void;
  close(): void;
}
