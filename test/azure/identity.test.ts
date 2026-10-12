import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseBicep } from "../../src/azure/iac/bicep.ts";
import { evaluateDeployments, isBlankName, nameState } from "../../src/azure/iac/evaluate.ts";
import { analyzeFixtures, type Harness } from "./identity-harness.ts";

describe("empty logical names are not identities (D-09)", () => {
  test("null, empty and whitespace-only names are unresolved, never exact", () => {
    expect(nameState({ k: "lit", v: "" })).toBe("unresolved");
    expect(nameState({ k: "lit", v: "   " })).toBe("unresolved");
    expect(nameState({ k: "lit", v: null })).toBe("unresolved");
    expect(nameState({ k: "lit", v: "orders" })).toBe("exact");
    expect(isBlankName(null)).toBe(true);
    expect(isBlankName(undefined)).toBe(true);
    expect(isBlankName({ k: "lit", v: 0 })).toBe(false);
    const d = evaluateDeployments([parseBicep("main.bicep", `resource a 'Microsoft.Storage/storageAccounts@2023-01-01' = { name: '' }`)], new Map(), []);
    expect(nameState(d.resources[0]!.name)).toBe("unresolved");
  });

  let h: Harness;
  beforeAll(async () => {
    h = await analyzeFixtures(["bicep-two-namespaces", "consumer-unknown-namespace", "infra-two-namespaces"]);
  });
  afterAll(() => h.close());

  test("two declarations with empty names stay two entities with no relationship between them", () => {
    const blank = h.declared("bicep-two-namespaces").filter((e) => String(e.metadata.armType).endsWith("/containers"));
    expect(blank.map((e) => e.metadata.nameState)).toEqual(["unresolved", "unresolved"]);
    expect(new Set(blank.map((e) => e.id)).size).toBe(2);
    const ids = new Set(blank.map((e) => e.id));
    for (const type of ["CONTAINS_RESOURCE", "DECLARED_BY", "SHARES_RESOURCE"] as const) expect(h.relationships("bicep-two-namespaces", type).filter((r) => ids.has(r.sourceId) || ids.has(r.targetId))).toEqual([]);
  });

  test("unnamed Terraform resources do not merge into one entity", () => {
    const roles = h.declared("infra-two-namespaces").filter((e) => String(e.metadata.armType).toLowerCase() === "microsoft.authorization/roleassignments");
    expect(roles).toHaveLength(2);
    expect(roles.every((e) => e.metadata.nameState === "unresolved")).toBe(true);
  });

  test("bindings whose resource name is empty or whitespace produce no logical resource and no edge", () => {
    const repo = "consumer-unknown-namespace";
    expect(h.logical(repo).map((e) => `${e.metadata.azureKind}:${e.name}`)).toEqual(["service-bus-entity:orders"]);
    expect(h.relationships(repo, "WRITES_TO")).toEqual([]);
    expect(h.relationships(repo, "PUBLISHES_TO")).toEqual([]);
    const unresolved = h.unresolved(repo).filter((u) => u.metadata.category === "dynamic-resource-name").map((u) => u.targetDisplay).sort();
    expect(unresolved).toEqual(["blob-container ?", "service-bus-entity ?"]);
  });
});

describe("resource identity includes the parent (D-03)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await analyzeFixtures(["bicep-two-namespaces"]);
  });
  afterAll(() => h.close());
  const repo = "bicep-two-namespaces";

  test("two namespaces each declaring queue 'orders' are two distinct declared entities under their own namespace", () => {
    const queues = h.declared(repo).filter((e) => String(e.metadata.armType).endsWith("/queues")).map((e) => e.name).sort();
    expect(queues).toEqual(["sb-alpha/orders", "sb-beta/orders"]);
    const contains = h.relationships(repo, "CONTAINS_RESOURCE").map((r) => `${h.name(r.sourceId)} -> ${h.name(r.targetId)}`).sort();
    expect(contains).toEqual(["AzureResource:sb-alpha -> AzureResource:sb-alpha/orders", "AzureResource:sb-beta -> AzureResource:sb-beta/orders"]);
  });

  test("a consumer whose namespace is known is keyed namespace/queue and declared by that namespace's queue only", () => {
    const known = h.logical(repo).find((e) => e.name === "sb-beta/orders")!;
    expect(known).toBeDefined();
    expect(known.metadata.resolution).toBe("exact");
    expect(known.metadata.account).toBe("sb-beta");
    expect(known.metadata.accountSource).toBe("iac");
    expect(String(known.key)).toBe(`transport|${h.repo(repo)}|azure-service-bus|queue-or-topic|sb-beta/orders`);
    const declaredBy = h.relationships(repo, "DECLARED_BY").filter((r) => r.sourceId === known.id).map((r) => h.name(r.targetId));
    expect(declaredBy).toEqual(["AzureResource:sb-beta/orders"]);
  });

  test("a consumer whose namespace is unknown is partially resolved and declared by neither namespace", () => {
    const unknown = h.logical(repo).find((e) => e.name === "orders")!;
    expect(unknown).toBeDefined();
    expect(unknown.metadata.resolution).toBe("partially-resolved");
    expect(unknown.metadata.account).toBeNull();
    expect(unknown.metadata.accountSource).toBeNull();
    expect(unknown.metadata.nameEvidence).toBe("INFERRED");
    expect(h.relationships(repo, "DECLARED_BY").filter((r) => r.sourceId === unknown.id)).toEqual([]);
    const reasons = h.unresolved(repo).filter((u) => u.sourceId === unknown.id || /orders/.test(u.targetDisplay ?? ""));
    expect(reasons.map((u) => u.metadata.category)).toEqual(["ambiguous-azure-resource"]);
    expect(reasons[0]!.metadata.candidates).toEqual(["sb-alpha/orders", "sb-beta/orders"]);
  });

  test("a single declaration with the same leaf name is not matched when the namespace is unknown", async () => {
    const single = await analyzeFixtures(["consumer-unknown-namespace"]);
    try {
      expect(single.relationships("consumer-unknown-namespace", "DECLARED_BY")).toEqual([]);
    } finally {
      single.close();
    }
    const one = await analyzeFixtures(["single-namespace-unknown-consumer"]);
    try {
      const repo = "single-namespace-unknown-consumer";
      expect(one.declared(repo).map((e) => e.name).sort()).toEqual(["sb-only", "sb-only/orders"]);
      expect(one.relationships(repo, "DECLARED_BY")).toEqual([]);
      const logical = one.logical(repo);
      expect(logical.map((e) => `${e.name}:${e.metadata.resolution}`)).toEqual(["orders:partially-resolved"]);
      const u = one.unresolved(repo).filter((x) => x.metadata.category === "unresolved-azure-account");
      expect(u).toHaveLength(1);
      expect(u[0]!.metadata.candidates).toEqual(["sb-only/orders"]);
    } finally {
      one.close();
    }
  });
});
