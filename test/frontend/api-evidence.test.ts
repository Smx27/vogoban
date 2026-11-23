import { expect, test } from "bun:test";
import { apiResolver, type ApiInputs, type ConsumerCall } from "../../src/metagraph/apis.ts";
import { MetaEmitter, type RepoView } from "../../src/metagraph/emitter.ts";
import { hostOf, isPlaceholderHost, type Fact, type Link } from "../../src/metagraph/resolver.ts";
import type { InfraInputs } from "../../src/metagraph/infrastructure.ts";

const fact = (id: string, kind: Fact["kind"], metadata: Fact["metadata"] = {}): Fact => ({ id, name: id, qualifiedName: id, kind, repositoryId: "provider", projectId: null, assembly: null, symbolKey: null, metadata, provenance: [] });
const link = (type: Link["type"], sourceId: string, targetId: string, metadata: Link["metadata"] = {}): Link => ({ id: `${type}:${sourceId}:${targetId}`, type, sourceId, targetId, evidence: "DECLARED", metadata, provenance: [] });
const infra = (): InfraInputs => ({ images: [], builds: [], packagedAs: [], runsImage: [], containers: [], workloads: [], environments: [], services: [], ingresses: [], routes: [], runs: [] });
const input = (): ApiInputs => ({ infra: infra(), applications: [], apis: [], operations: [], contains: [], implemented: [], payloads: [], calls: [], configUrls: [], packageNames: [] });
const call = (values: Partial<ConsumerCall> = {}): ConsumerCall => ({ sourceId: "caller", verb: "GET", url: "/api/orders", category: "no-matching-operation", baseAddress: null, configurationKeys: [], requestType: null, responseType: null, provenance: [], ...values });
const repo = (repositoryId: string): RepoView => ({ repositoryEntityId: `repo:${repositoryId}`, status: "READY", entry: { repositoryId, identity: repositoryId, name: repositoryId, url: null, provider: null, organization: null, defaultBranch: null, localPath: null, status: "READY", registeredAt: "", analyzedCommit: null, analyzedDirty: false, analyzedRun: null, analyzedAt: null, graphVersion: "1", analyzerVersion: "1", semantic: true, lastError: null } });

function resolve(consumer: ApiInputs, providers: ApiInputs[] = [provider()]) {
  const inputs = new Map([["consumer", consumer], ...providers.map((p, i): [string, ApiInputs] => [i ? `provider${i}` : "provider", p])]);
  const emit = new MetaEmitter("api", "apis", apiResolver.version, "snapshot", new Map([...inputs.keys()].map((id) => [id, repo(id)])));
  apiResolver.resolve(inputs, emit, null!);
  return emit.batch();
}

function provider(): ApiInputs {
  const p = input();
  p.applications = ["app"];
  p.apis = [fact("api", "Api")];
  p.operations = [fact("op", "ApiOperation", { method: "GET", path: "/api/orders" })];
  p.contains = [link("CONTAINS", "app", "api", { role: "api-provider" }), link("CONTAINS", "api", "op")];
  p.infra.workloads = [fact("workload", "Deployment")];
  p.infra.services = [fact("orders", "KubernetesService")];
  p.infra.ingresses = [fact("ingress", "KubernetesIngress", { hosts: ["orders.internal.dev"] })];
  p.infra.routes = [link("ROUTES_TO", "ingress", "orders"), link("ROUTES_TO", "orders", "workload")];
  p.infra.runs = [link("RUNS", "workload", "app")];
  return p;
}

test("only declared host ownership and the matching method/route resolve a provider", () => {
  const c = input();
  c.calls = [call({ url: "https://orders.internal.dev/api/orders" })];
  const result = resolve(c);
  expect(result.relationships.filter((r) => r.type === "CALLS_ENDPOINT").map((r) => [r.targetId, r.targetRepositoryId])).toEqual([["op", "provider"]]);
  expect(result.unresolved).toEqual([]);
});

test("declared configuration hosts resolve with their base path and environment", () => {
  const c = input();
  c.calls = [call({ url: "orders", category: "configured-url", configurationKeys: ["Gateway__BaseUrl"] })];
  c.configUrls = [{ id: "config", key: "Gateway:BaseUrl", value: "https://orders.internal.dev/api/", valueKind: "url", environment: "production", provenance: [] }];
  const result = resolve(c);
  const edge = result.relationships.find((r) => r.type === "CALLS_ENDPOINT")!;
  expect(edge.targetId).toBe("op");
  expect(edge.environment).toBe("production");
  expect(edge.metadata.path).toBe("/api/orders");
  expect(edge.metadata.evidenceKinds).toContain("configuration:Gateway:BaseUrl");
});

test("root-relative and absolute configured URLs do not append the base prefix twice", () => {
  for (const url of ["/api/orders", "https://orders.internal.dev/api/orders", "orders"]) {
    const c = input();
    c.calls = [call({ url, baseAddress: "https://orders.internal.dev/api/", configurationKeys: ["Gateway:BaseUrl"] })];
    c.configUrls = [{ id: "config", key: "Gateway:BaseUrl", value: "https://orders.internal.dev/api/", valueKind: "url", environment: null, provenance: [] }];
    const result = resolve(c);
    const operations = result.relationships.filter((r) => r.type === "CALLS_ENDPOINT");
    expect(operations).toHaveLength(1);
    expect(operations[0]?.metadata.path).toBe("/api/orders");
    expect(result.unresolved).toEqual([]);
  }
});

test("same-origin frontend URLs cannot be assigned to another repository by route or contract type", () => {
  const c = input();
  c.calls = [call({ api: "fetch", applications: ["own-app"], responseType: "Order", requestType: "Order" })];
  c.packageNames = ["contracts"];
  const p = provider();
  p.payloads = [{ operationId: "op", type: "Order", assembly: "contracts" }];
  const result = resolve(c, [p]);
  expect(result.relationships.filter((r) => ["CALLS_REPOSITORY", "CALLS_ENDPOINT", "CONSUMES_API"].includes(r.type))).toEqual([]);
  expect(result.unresolved[0]?.metadata.category).toBe("same-origin-operation-not-found");
});

test("localhost, missing configured values, and dynamic hosts remain explicitly unresolved", () => {
  const c = input();
  c.calls = [call({ sourceId: "development", url: "http://localhost:5180/api/orders" }), call({ sourceId: "missing", configurationKeys: ["GATEWAY_BASE_URL"], category: "configured-url" }), call({ sourceId: "dynamic", api: "fetch", baseExpression: "remoteBase" })];
  const result = resolve(c);
  expect(result.relationships.filter((r) => r.type === "CALLS_ENDPOINT" || r.type === "CALLS_REPOSITORY")).toEqual([]);
  expect(result.unresolved.map((u) => u.metadata.category).sort()).toEqual(["configuration-value-missing", "development-host-unresolved", "dynamic-host-unresolved"]);
});

test("shared contract payloads cannot override development, placeholder, or dynamic host evidence", () => {
  const p = provider();
  p.payloads = [{ operationId: "op", type: "Order", assembly: "contracts" }];
  for (const origin of [
    { url: "http://localhost:5180/api/orders" },
    { url: "http://localhost./api/orders" },
    { url: "http://portal.localhost/api/orders" },
    { url: "http://portal.localhost./api/orders" },
    { url: "http://[::1]/api/orders" },
    { url: "http://[::]/api/orders" },
    { url: "http://[0:0:0:0:0:0:0:1]/api/orders" },
    { url: "http://[not-ip]/api/orders" },
    { url: "http://${API_HOST}/api/orders" },
    { url: "http://{API_HOST}/api/orders" },
    { baseAddress: "http://127.0.0.1:5180" },
    { url: "http://your-service/api/orders" },
    { url: "https://example.com/api/orders" },
    { baseExpression: "remoteBase" },
    { category: "dynamic-url" },
  ]) {
    const c = input();
    c.calls = [call({ responseType: "Order", ...origin })];
    c.packageNames = ["contracts"];
    const result = resolve(c, [p]);
    expect(result.relationships.filter((r) => ["CALLS_REPOSITORY", "CALLS_ENDPOINT", "CONSUMES_API"].includes(r.type))).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  }
});

test("absolute host parsing handles IPv6 without network access and preserves template conservatism", () => {
  expect(hostOf("http://[::1]:5180/api/orders")).toBe("[::1]");
  expect(hostOf("http://[0:0:0:0:0:0:0:0]/api/orders")).toBe("[::]");
  expect(hostOf("https://ORDERS.internal.dev/api/{id}")).toBe("orders.internal.dev");
  expect(hostOf("/api/orders")).toBeNull();
  expect(hostOf("http://[not-ip]/api/orders")).toBeNull();
  for (const host of ["[::1]", "[::]", "localhost.", "portal.localhost", "portal.localhost.", "${API_HOST}", "{API_HOST}"]) expect(isPlaceholderHost(host)).toBe(true);
  expect(isPlaceholderHost("localhost.internal.dev")).toBe(false);
});

test("the legacy hostless shared-contract tier still requires the matching payload assembly", () => {
  const p = provider();
  p.payloads = [{ operationId: "op", type: "Order", assembly: "contracts" }];
  const c = input();
  c.calls = [call({ responseType: "Order" })];
  c.packageNames = ["contracts"];
  expect(resolve(c, [p]).relationships.filter((r) => r.type === "CALLS_ENDPOINT").map((r) => r.targetId)).toEqual(["op"]);
  c.packageNames = ["other-contracts"];
  expect(resolve(c, [p]).relationships.filter((r) => r.type === "CALLS_ENDPOINT")).toEqual([]);
});

test("an undeclared production hostname never falls back to matching routes", () => {
  const c = input();
  c.calls = [call({ url: "https://other.internal.dev/api/orders" })];
  expect(resolve(c).relationships.filter((r) => r.type === "CALLS_ENDPOINT" || r.type === "CALLS_REPOSITORY")).toEqual([]);
});

test("a declared parameterized configuration remains a placeholder, not a missing value or provider guess", () => {
  const c = input();
  c.calls = [call({ configurationKeys: ["GATEWAY_BASE_URL"], category: "configured-url" })];
  c.configUrls = [{ id: "placeholder", key: "GATEWAY_BASE_URL", value: "${GATEWAY_HOST}", valueKind: "parameterized", environment: "production", provenance: [] }];
  const result = resolve(c);
  expect(result.relationships.filter((r) => r.type === "CALLS_ENDPOINT" || r.type === "CALLS_REPOSITORY")).toEqual([]);
  expect(result.unresolved.map((u) => u.metadata.category)).toEqual(["service-url-placeholder", "service-url-placeholder"]);
});

test("conflicting host declarations and wrong methods do not resolve operation edges", () => {
  const c = input();
  c.calls = [call({ url: "https://orders.internal.dev/api/orders" })];
  const second = provider();
  second.applications = ["app2"];
  second.contains[0]!.sourceId = "app2";
  second.infra.runs[0]!.targetId = "app2";
  const conflicting = resolve(c, [provider(), second]);
  expect(conflicting.conflicts).toHaveLength(1);
  expect(conflicting.relationships.filter((r) => r.type === "CALLS_ENDPOINT")).toEqual([]);
  c.calls = [call({ verb: "DELETE", url: "https://orders.internal.dev/api/orders" })];
  const wrongMethod = resolve(c);
  expect(wrongMethod.relationships.filter((r) => r.type === "CALLS_ENDPOINT")).toEqual([]);
  expect(wrongMethod.unresolved[0]?.metadata.category).toBe("operation-not-found-at-provider");
});
