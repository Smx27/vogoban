import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { analyzeFixtures, type Harness } from "./identity-harness.ts";

/**
 * Cross-repository Azure identity over six small repositories: an infrastructure repository declaring queue
 * `orders` in two namespaces (sb-alpha, sb-beta), a publisher and a consumer on sb-alpha, a consumer on sb-beta,
 * a consumer whose namespace is unknown, and an infrastructure repository with empty-named declarations.
 */
describe("MetaGraph azure-resources identity (D-03 / D-09)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await analyzeFixtures(["infra-two-namespaces", "bicep-two-namespaces", "consumer-unknown-namespace", "publisher-alpha", "consumer-alpha", "consumer-beta"]);
  });
  afterAll(() => h.close());
  const edge = (r: { sourceId: string; targetId: string }) => `${h.name(r.sourceId)} -> ${h.name(r.targetId)}`;
  const repoOf = (id: string) => [...h.repos].find(([, rid]) => h.store.getEntity(id)?.repositoryId === rid)?.[0] ?? null;

  test("SHARES_RESOURCE links only the publisher and consumer of the same namespace/queue", () => {
    expect(h.logical("consumer-alpha").map((e) => [e.name, e.metadata.account, e.metadata.accountSource, e.metadata.resolution])).toEqual([["sb-alpha/orders", "sb-alpha", "literal", "exact"]]);
    const shares = h.meta("SHARES_RESOURCE");
    expect(shares.map(edge)).toEqual(["Queue:sb-alpha/orders -> Queue:sb-alpha/orders"]);
    expect(shares.map((r) => [repoOf(r.sourceId), repoOf(r.targetId)])).toEqual([["publisher-alpha", "consumer-alpha"]]);
    expect(h.meta("CONSUMES_REPOSITORY_CONTRACT").map(edge)).toEqual(["Repository:consumer-alpha -> Repository:publisher-alpha"]);
  });

  test("the consumer on another namespace and the consumer with an unknown namespace are not linked to the publisher", () => {
    const linked = new Set(h.meta("SHARES_RESOURCE").flatMap((r) => [repoOf(r.sourceId), repoOf(r.targetId)]));
    expect(linked.has("consumer-beta")).toBe(false);
    expect(linked.has("consumer-unknown-namespace")).toBe(false);
    const unknownIds = new Set(h.logical("consumer-unknown-namespace").map((e) => e.id));
    for (const type of ["SHARES_RESOURCE", "DECLARED_BY", "CONTAINS"] as const) expect(h.meta(type).filter((r) => unknownIds.has(r.sourceId) || unknownIds.has(r.targetId))).toEqual([]);
    expect(h.meta("DEPENDS_ON_REPOSITORY").map((r) => repoOf(r.sourceId)).includes("consumer-unknown-namespace")).toBe(false);
  });

  test("cross-repository DECLARED_BY targets the queue of the matching namespace only", () => {
    const declared = h.meta("DECLARED_BY").map((r) => `${repoOf(r.sourceId)}: ${edge(r)} [${repoOf(r.targetId)}]`).sort();
    expect(declared).toEqual([
      "bicep-two-namespaces: Queue:sb-beta/orders -> AzureResource:sb-beta/orders [infra-two-namespaces]",
      "consumer-alpha: Queue:sb-alpha/orders -> AzureResource:sb-alpha/orders [bicep-two-namespaces]",
      "consumer-alpha: Queue:sb-alpha/orders -> AzureResource:sb-alpha/orders [infra-two-namespaces]",
      "consumer-beta: Queue:sb-beta/orders -> AzureResource:sb-beta/orders [bicep-two-namespaces]",
      "consumer-beta: Queue:sb-beta/orders -> AzureResource:sb-beta/orders [infra-two-namespaces]",
      "publisher-alpha: Queue:sb-alpha/orders -> AzureResource:sb-alpha/orders [bicep-two-namespaces]",
      "publisher-alpha: Queue:sb-alpha/orders -> AzureResource:sb-alpha/orders [infra-two-namespaces]",
    ]);
    expect(h.store.findMetaUnresolved({}).filter((u) => u.metadata.category === "ambiguous-azure-declaration")).toEqual([]);
  });

  test("declared resources with empty names and the unnamed role assignments never take part in cross-repository links", () => {
    const blank = [...h.declared("bicep-two-namespaces"), ...h.declared("infra-two-namespaces")].filter((e) => e.metadata.nameState !== "exact").map((e) => e.id);
    expect(blank.length).toBe(4);
    const ids = new Set(blank);
    for (const type of ["DECLARED_BY", "CONTAINS", "SHARES_RESOURCE"] as const) expect(h.meta(type).filter((r) => ids.has(r.sourceId) || ids.has(r.targetId))).toEqual([]);
    expect(h.store.findMetaEntities({ kinds: ["SharedContract"] }).filter((e) => e.metadata.contractKind === "azure-resource").map((e) => e.name).sort()).toEqual(["sb-alpha/orders", "sb-beta/orders"]);
  });

  test("the same leaf name declared in two repositories (bicep and terraform) under the same namespace is one shared identity", () => {
    const contains = h.meta("CONTAINS").filter((r) => h.name(r.sourceId) === "SharedContract:sb-alpha/orders").map((r) => `${edge(r)} [${repoOf(r.targetId)}]`).sort();
    expect(contains).toEqual([
      "SharedContract:sb-alpha/orders -> AzureResource:sb-alpha/orders [bicep-two-namespaces]",
      "SharedContract:sb-alpha/orders -> AzureResource:sb-alpha/orders [infra-two-namespaces]",
      "SharedContract:sb-alpha/orders -> Queue:sb-alpha/orders [consumer-alpha]",
      "SharedContract:sb-alpha/orders -> Queue:sb-alpha/orders [publisher-alpha]",
    ]);
  });
});
