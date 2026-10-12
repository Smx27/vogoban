import { captureMetaSnapshot } from "../analysis/diff.ts";
import { hashOf } from "../graph/identity.ts";
import { ids, keys } from "../graph/identity.ts";
import { GRAPH_SCHEMA_VERSION, type MetaSnapshot } from "../graph/model.ts";
import type { Logger } from "../log.ts";
import type { GraphStore } from "../store/store.ts";
import { apiResolver } from "./apis.ts";
import { azureResourceResolver } from "./azure.ts";
import { catalogStatus, usableForMetaGraph } from "./catalog.ts";
import { MetaEmitter, type RepoView } from "./emitter.ts";
import { externalSystemResolver } from "./external.ts";
import { deploymentResolver } from "./infrastructure.ts";
import { messageResolver } from "./messages.ts";
import { packageResolver } from "./packages.ts";
import type { CrossRepositoryResolver } from "./resolver.ts";

export const CROSS_REPOSITORY_RESOLVERS: CrossRepositoryResolver<unknown>[] = [
  packageResolver as CrossRepositoryResolver<unknown>,
  messageResolver as CrossRepositoryResolver<unknown>,
  deploymentResolver as CrossRepositoryResolver<unknown>,
  apiResolver as CrossRepositoryResolver<unknown>,
  externalSystemResolver as CrossRepositoryResolver<unknown>,
  azureResourceResolver as CrossRepositoryResolver<unknown>,
];

export function repositoryViews(store: GraphStore): { views: Map<string, RepoView>; excluded: { name: string; status: string; reason: string | null }[] } {
  const views = new Map<string, RepoView>();
  const excluded: { name: string; status: string; reason: string | null }[] = [];
  for (const s of store.listCatalog().map(catalogStatus)) {
    if (!usableForMetaGraph(s)) {
      excluded.push({ name: s.entry.name, status: s.status, reason: s.reason ?? "repository has not been analyzed" });
      continue;
    }
    views.set(s.entry.repositoryId, { entry: s.entry, status: s.status, repositoryEntityId: ids.entity(keys.repository(s.entry.identity)) });
  }
  return { views, excluded };
}

export function buildMetaGraph(store: GraphStore, log: Logger, force = false): { snapshot: MetaSnapshot; excluded: { name: string; status: string; reason: string | null }[] } {
  return store.transaction(() => buildMetaGraphUnlocked(store, log, force));
}

function buildMetaGraphUnlocked(store: GraphStore, log: Logger, force: boolean): { snapshot: MetaSnapshot; excluded: { name: string; status: string; reason: string | null }[] } {
  const { views, excluded } = repositoryViews(store);
  const ordered = [...views.values()].sort((a, b) => a.entry.repositoryId.localeCompare(b.entry.repositoryId));
  const resolverVersions = Object.fromEntries(CROSS_REPOSITORY_RESOLVERS.map((r) => [r.id, r.version]));
  const snapshotId = `snap_${hashOf(String(GRAPH_SCHEMA_VERSION), JSON.stringify(resolverVersions), ...ordered.map((v) => `${v.entry.repositoryId}@${v.entry.graphVersion}`)).slice(0, 24)}`;
  const snapshot: MetaSnapshot = {
    id: snapshotId,
    createdAt: new Date().toISOString(),
    schemaVersion: GRAPH_SCHEMA_VERSION,
    resolverVersions,
    repositories: ordered.map((v) => ({ repositoryId: v.entry.repositoryId, name: v.entry.name, commit: v.entry.analyzedCommit, graphVersion: v.entry.graphVersion, status: v.status })),
    categories: {},
  };
  for (const resolver of CROSS_REPOSITORY_RESOLVERS) {
    const t0 = performance.now();
    const inputs = new Map<string, unknown>();
    const digests: string[] = [];
    for (const view of ordered) {
      const scope = `meta-input|${resolver.id}@${resolver.version}|${view.entry.repositoryId}`;
      let digest = store.getCachedFacts(scope, view.entry.graphVersion!);
      if (!digest) {
        const collected = resolver.collect(store, view);
        inputs.set(view.entry.repositoryId, collected);
        digest = hashOf(JSON.stringify(collected));
        store.putCachedFacts(scope, view.entry.graphVersion!, digest);
      }
      digests.push(`${view.entry.repositoryId}:${digest}`);
    }
    const fingerprint = hashOf(resolver.id, resolver.version, ...digests);
    if (!force && store.metaFingerprint(resolver.category) === fingerprint) {
      const kept = store.findMetaRelationships({ categories: [resolver.category] });
      snapshot.categories[resolver.category] = { fingerprint, recomputed: false, relationships: kept.length, unresolved: store.findMetaUnresolved({ category: resolver.category }).length, conflicts: store.findMetaConflicts({ category: resolver.category }).length };
      log.info("metagraph.category.unchanged", { category: resolver.category });
      continue;
    }
    for (const view of ordered) if (!inputs.has(view.entry.repositoryId)) inputs.set(view.entry.repositoryId, resolver.collect(store, view));
    const emitter = new MetaEmitter(resolver.category, resolver.id, resolver.version, snapshotId, views);
    resolver.resolve(inputs, emitter, store);
    const batch = emitter.batch();
    store.replaceMetaCategory(resolver.category, fingerprint, batch);
    snapshot.categories[resolver.category] = { fingerprint, recomputed: true, relationships: batch.relationships.length, unresolved: batch.unresolved.length, conflicts: batch.conflicts.length };
    log.info("metagraph.category.resolved", { category: resolver.category, relationships: batch.relationships.length, unresolved: batch.unresolved.length, conflicts: batch.conflicts.length, ms: Math.round(performance.now() - t0) });
  }
  store.saveMetaSnapshot(snapshot);
  captureMetaSnapshot(store, snapshot.id);
  return { snapshot, excluded };
}
