import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/log.ts";
import { buildMetaGraph } from "../../src/metagraph/build.ts";
import { analyzeRepository } from "../../src/pipeline/analyze.ts";
import { defaultPlugins } from "../../src/plugins/registry.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";
import type { Entity, MetaRelationship, Relationship, UnresolvedReference } from "../../src/graph/model.ts";

export const FIXTURES = join(import.meta.dir, "fixtures", "identity");

/** Analyzes copies of identity fixtures (outside any git checkout) into one store and builds the MetaGraph over them. */
export async function analyzeFixtures(names: string[]): Promise<Harness> {
  const work = mkdtempSync(join(tmpdir(), "vogoban-identity-"));
  const store = new SqliteGraphStore(join(work, "graph.db"));
  const log = createLogger({ level: "error" });
  const repos = new Map<string, string>();
  for (const name of names) {
    const dir = join(work, name);
    cpSync(join(FIXTURES, name), dir, { recursive: true });
    const { repositoryId } = await analyzeRepository(dir, store, defaultPlugins(), { semantic: false }, log);
    repos.set(name, repositoryId);
  }
  if (names.length > 1) buildMetaGraph(store, log, true);
  return new Harness(store, repos, () => rmSync(work, { recursive: true, force: true }));
}

export class Harness {
  constructor(readonly store: SqliteGraphStore, readonly repos: Map<string, string>, private readonly cleanup: () => void) {}
  repo(name: string): string {
    return this.repos.get(name)!;
  }
  entities(repo: string, kind: Entity["kind"]): Entity[] {
    return this.store.findEntities({ repositoryId: this.repo(repo), kinds: [kind], limit: 100000 });
  }
  declared(repo: string): Entity[] {
    return this.entities(repo, "AzureResource").filter((e) => String(e.key).startsWith("azure-resource|"));
  }
  logical(repo: string): Entity[] {
    return [...this.store.iterateEntities(this.repo(repo))].filter((e) => e.metadata.declaredIn === "code" && typeof e.metadata.azureKind === "string");
  }
  relationships(repo: string, type: Relationship["type"]): Relationship[] {
    return this.store.findRelationships({ repositoryId: this.repo(repo), types: [type], limit: 100000 });
  }
  unresolved(repo: string): UnresolvedReference[] {
    return this.store.findUnresolved({ repositoryId: this.repo(repo), limit: 100000 });
  }
  meta(type: MetaRelationship["type"]): MetaRelationship[] {
    return this.store.findMetaRelationships({ types: [type] });
  }
  name(id: string): string {
    const e = this.store.getEntity(id) ?? this.store.findMetaEntities({ ids: [id] })[0];
    return e ? `${e.kind}:${e.name}` : id;
  }
  close() {
    this.store.close();
    this.cleanup();
  }
}
