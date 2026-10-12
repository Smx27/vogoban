import type { GraphStore } from "../store/store.ts";
import type { RepoView } from "./emitter.ts";
import { facts, groupBy, links, str, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

/**
 * Cross-repository Azure resources. Code in one repository and code or infrastructure in another
 * refer to the same Azure data-plane resource only when the resource identity is exact on both
 * sides: the same broker/service, the same kind, the same statically known parent (namespace, account,
 * vault, server) and the same literal leaf name (and, for IaC, the same declared account + leaf path).
 * Partially resolved, setting-based, computed or empty names, and leaf names whose parent is unknown,
 * never link; an identity declared more than once in different forms is reported as ambiguous instead of guessed.
 */

interface AzureInputs {
  logical: Fact[];
  declared: Fact[];
  producers: Link[];
  consumers: Link[];
}

/** Code-side logical kind → declared ARM leaf types. */
const LEAF_TYPES: Record<string, string[]> = {
  "service-bus-entity": ["microsoft.servicebus/namespaces/queues", "microsoft.servicebus/namespaces/topics"],
  "service-bus-subscription": ["microsoft.servicebus/namespaces/topics/subscriptions"],
  "event-hub": ["microsoft.eventhub/namespaces/eventhubs"],
  "event-grid-topic": ["microsoft.eventgrid/topics"],
  "blob-container": ["microsoft.storage/storageaccounts/blobservices/containers"],
  "storage-queue": ["microsoft.storage/storageaccounts/queueservices/queues"],
  "storage-table": ["microsoft.storage/storageaccounts/tableservices/tables"],
  "cosmos-container": ["microsoft.documentdb/databaseaccounts/sqldatabases/containers"],
  "cosmos-database": ["microsoft.documentdb/databaseaccounts/sqldatabases"],
  "sql-database": ["microsoft.sql/servers/databases"],
};

const blank = (s: string) => s.trim() === "";
/** A code-side identity is usable only when its parent (namespace/account) and every leaf segment are exact and non-empty. */
const exactName = (f: Fact) => (f.metadata.resolution === "exact" || f.metadata.resolution === "statically-derived") && !/[%{}$<>?]/.test(f.name) && typeof f.metadata.account === "string" && !blank(f.metadata.account) && f.metadata.accountSource !== "aspire" && f.name.toLowerCase().startsWith(`${f.metadata.account.toLowerCase()}/`) && f.name.split("/").every((s) => !blank(s));
const leafPath = (f: Fact): string[] => String(f.metadata.name ?? f.name).split("/");
/** Declared identity comparable with a code-side one: the root account plus the trailing leaf segments (intermediate service segments such as blobServices/default are not part of the code-side path). */
const declaredIdentity = (f: Fact, leafSegments: number): string | null => {
  const path = leafPath(f);
  if (path.length < leafSegments + 1 || path.some(blank)) return null;
  return [path[0]!, ...path.slice(-leafSegments)].join("/").toLowerCase();
};

export const azureResourceResolver: CrossRepositoryResolver<AzureInputs> = {
  id: "azure-resources",
  version: "3",
  category: "azure",
  collect(store: GraphStore, repo: RepoView): AzureInputs {
    const repoId = repo.entry.repositoryId;
    const logical = facts(store, repoId, ["Topic", "Queue", "Database", "Storage"]).filter((f) => typeof f.metadata.azureKind === "string" && f.metadata.declaredIn === "code" && exactName(f));
    const declared = facts(store, repoId, ["AzureResource"]).filter((f) => f.metadata.nameState === "exact" && f.metadata.declaredState === "DECLARED" && Array.isArray(f.metadata.declaredIn) && (f.metadata.declaredIn as string[]).some((l) => l !== "aspire") && Object.values(LEAF_TYPES).flat().includes(String(f.metadata.armType ?? "").toLowerCase()) && leafPath(f).length > 1 && !leafPath(f).some(blank));
    const ids = new Set(logical.map((l) => l.id));
    return {
      logical,
      declared,
      producers: links(store, repoId, ["PUBLISHES_TO", "SENDS_TO", "SENDS_MESSAGE", "PUBLISHES_EVENT", "WRITES_TO"]).filter((l) => ids.has(l.targetId)),
      consumers: [...links(store, repoId, ["TRIGGERS", "CHANGE_FEED", "CONSUMED_BY", "ROUTES_TO", "SUBSCRIBES_TO"]).filter((l) => ids.has(l.sourceId)), ...links(store, repoId, ["CONSUMES_FROM", "RECEIVES_MESSAGE", "READS_FROM"]).filter((l) => ids.has(l.targetId))],
    };
  },
  resolve(inputs, emit) {
    const members = [...inputs].flatMap(([repoId, input]) => input.logical.map((fact) => ({ repoId, fact, input })));
    const declarations = [...inputs].flatMap(([repoId, input]) => input.declared.map((fact) => ({ repoId, fact })));
    const groupKey = (m: (typeof members)[number]) => `${m.fact.metadata.azureKind}|${m.fact.name.toLowerCase()}`;

    for (const [key, group] of [...groupBy(members, groupKey)].sort(([a], [b]) => a.localeCompare(b))) {
      const [kind, name] = key.split("|") as [string, string];
      const repos = [...new Set(group.map((m) => m.repoId))].sort();
      const leafSegments = name.split("/").length - 1;
      const candidates = declarations.filter((d) => (LEAF_TYPES[kind] ?? []).includes(String(d.fact.metadata.armType ?? "").toLowerCase()) && declaredIdentity(d.fact, leafSegments) === name);
      const distinct = [...groupBy(candidates, (c) => String(c.fact.metadata.name ?? c.fact.name).toLowerCase())];
      if (repos.length < 2 && !candidates.some((c) => !repos.includes(c.repoId))) continue;
      const contractId = emit.entity({ key: `shared-contract|azure|${key}`, kind: "SharedContract", name: name, qualifiedName: `azure:${kind}:${name}`, metadata: { contractKind: "azure-resource", azureKind: kind, repositories: repos.map((r) => emit.repos.get(r)!.entry.name) }, extractor: "AZURE_RESOURCE_IDENTITY" });
      const contract = { id: contractId, repositoryId: null };
      for (const m of group) emit.relate({ type: "CONTAINS", source: contract, target: { id: m.fact.id, repositoryId: m.repoId, provenance: m.fact.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["exact-resource-name", "same-azure-service"], extractor: "AZURE_RESOURCE_MEMBER", metadata: { azureKind: kind } });

      const producersOf = (m: (typeof members)[number]) => m.input.producers.filter((p) => p.targetId === m.fact.id);
      const consumersOf = (m: (typeof members)[number]) => m.input.consumers.filter((c) => c.sourceId === m.fact.id || c.targetId === m.fact.id);
      for (const from of group) for (const to of group) {
        if (from.repoId === to.repoId || !producersOf(from).length || !consumersOf(to).length) continue;
        emit.relate({ type: "SHARES_RESOURCE", source: { id: from.fact.id, repositoryId: from.repoId, provenance: from.fact.provenance }, target: { id: to.fact.id, repositoryId: to.repoId, provenance: to.fact.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["exact-resource-name", "same-azure-service", "producer-consumer"], extractor: "AZURE_CROSS_REPOSITORY_FLOW", metadata: { azureKind: kind, resource: name } });
        emit.relate({ type: "CONSUMES_REPOSITORY_CONTRACT", source: emit.repositoryEntity(to.repoId), target: emit.repositoryEntity(from.repoId), evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["exact-resource-name", "producer-consumer"], extractor: "AZURE_REPOSITORY_LINK", metadata: { azureResources: [`${kind}:${name}`] } });
      }

      if (distinct.length > 1) {
        for (const m of group) emit.unresolved({ type: "DECLARED_BY", source: { id: m.fact.id, repositoryId: m.repoId, provenance: m.fact.provenance }, display: `${kind} ${name}`, reason: `${distinct.length} differently-qualified declarations of ${name} exist (${distinct.map(([n]) => n).join(", ")}); the account/namespace is not statically known`, category: "ambiguous-azure-declaration", extractor: "AZURE_DECLARATION_AMBIGUOUS", metadata: { candidates: distinct.map(([n]) => n) } });
        continue;
      }
      for (const d of candidates) {
        emit.relate({ type: "CONTAINS", source: contract, target: { id: d.fact.id, repositoryId: d.repoId, provenance: d.fact.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["exact-resource-name", "infrastructure-declaration"], extractor: "AZURE_DECLARATION_MEMBER", metadata: { armType: str(d.fact.metadata.armType) } });
        for (const m of group) {
          if (m.repoId === d.repoId) continue;
          emit.relate({ type: "DECLARED_BY", source: { id: m.fact.id, repositoryId: m.repoId, provenance: m.fact.provenance }, target: { id: d.fact.id, repositoryId: d.repoId, provenance: d.fact.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["exact-resource-name", "single-declaration"], extractor: "AZURE_CROSS_REPOSITORY_DECLARATION", metadata: { armType: str(d.fact.metadata.armType), declaredName: str(d.fact.metadata.name) } });
          emit.relate({ type: "DEPENDS_ON_REPOSITORY", source: emit.repositoryEntity(m.repoId), target: emit.repositoryEntity(d.repoId), evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["infrastructure-declaration"], extractor: "AZURE_INFRASTRUCTURE_REPOSITORY", metadata: { azureResources: [`${kind}:${name}`] } });
        }
      }
    }
  },
};
