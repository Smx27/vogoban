import { expect, test } from "bun:test";
import type { MetaRelationship } from "../../src/graph/model.ts";
import { MetaQuery, repositoryEdgeFact } from "../../src/query/meta-query.ts";
import type { GraphStore } from "../../src/store/store.ts";

const rel = (type: string, source: string, target: string) =>
  ({ id: `${type}|${source}|${target}`, type, sourceId: `repo-${source}`, targetId: `repo-${target}`, sourceRepositoryId: source, targetRepositoryId: target }) as unknown as MetaRelationship;

const RELATIONSHIPS = [
  rel("CONSUMES_REPOSITORY_CONTRACT", "orders", "contracts"),
  rel("CALLS_REPOSITORY", "gateway", "orders"),
  rel("SHARES_CONTRACT_WITH", "billing", "orders"),
];

const fakeStore = new Proxy({} as GraphStore, {
  get: (_target, method) =>
    method === "findMetaRelationships"
      ? (filter: { types?: string[]; repositoryId?: string }) =>
          RELATIONSHIPS.filter((r) => (!filter.types || filter.types.includes(r.type)) && (!filter.repositoryId || r.sourceRepositoryId === filter.repositoryId || r.targetRepositoryId === filter.repositoryId))
      : () => [],
});

const walk = (repo: string, reverse: boolean) => new MetaQuery(fakeStore).topology(repo, reverse, 5).steps.map((s) => [s.depth, s.repository, s.from]);

test("repository edge facts are phrased from the stored direction", () => {
  expect(repositoryEdgeFact("CONSUMES_REPOSITORY_CONTRACT", "orders", "contracts")).toBe("orders consumes contracts published by contracts");
  expect(repositoryEdgeFact("CALLS_REPOSITORY", "gateway", "orders")).toBe("gateway calls orders");
  expect(repositoryEdgeFact("DEPENDS_ON_REPOSITORY", "a", "b")).toBe("a depends on b");
  expect(repositoryEdgeFact("DEPLOYS_REPOSITORY", "infra", "orders")).toBe("infra deploys orders");
  expect(repositoryEdgeFact("SHARES_CONTRACT_WITH", "billing", "orders")).toBe("billing shares a contract with orders");
});

test("downstream topology follows contract consumers and shared contracts in both directions", () => {
  expect(walk("contracts", false)).toEqual([
    [1, "orders", "contracts"],
    [2, "billing", "orders"],
  ]);
  expect(walk("billing", false)).toEqual([[1, "orders", "billing"]]);
});

test("upstream topology reverses calls and contract consumption and does not treat shared contracts as upstream", () => {
  expect(walk("orders", true)).toEqual([
    [1, "contracts", "orders"],
    [1, "gateway", "orders"],
  ]);
});
