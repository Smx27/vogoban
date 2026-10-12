import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { analyzeFixtureInto, bearer, call, rpc, startPlatform, tenantWithToken, type Platform } from "./helpers.ts";

const AZURE_TOOLS = ["get_azure_functions", "get_azure_resources", "trace_azure_flow"];
const T = "/api/v1/t/acme";

let p: Platform;
let admin: string;
let tenantId: string;

beforeAll(async () => {
  p = await startPlatform();
  const t = await tenantWithToken(p, "acme", "org_admin");
  admin = t.secret;
  tenantId = t.tenant.id;
  analyzeFixtureInto(p, tenantId);
  await tenantWithToken(p, "other", "org_admin");
});

afterAll(async () => {
  await p.stop();
});

const mcp = (body: string, token: string | null = admin, tenant = "acme") => call(p, "POST", `/api/v1/t/${tenant}/mcp`, { headers: token ? bearer(token) : { "content-type": "application/json" }, body });
const query = (tool: string, body: string, token: string | null = admin, qs = "") => call(p, "POST", `${T}/query/${tool}${qs}`, { headers: token ? bearer(token) : { "content-type": "application/json" }, body });

describe("MCP over HTTP: Azure tools (F-01)", () => {
  test("tools/list contains the Azure tools and GET /mcp advertises them", async () => {
    const r = await mcp(rpc(1, "tools/list"));
    expect(r.status).toBe(200);
    const names = r.json.result.tools.map((t: { name: string }) => t.name);
    for (const n of AZURE_TOOLS) expect(names).toContain(n);
    const info = await call(p, "GET", `${T}/mcp`, { headers: bearer(admin) });
    expect(info.status).toBe(200);
    for (const n of AZURE_TOOLS) expect(info.json.tools).toContain(n);
  });

  test("tools/call returns graph-backed data for functions and resources", async () => {
    const f = await mcp(rpc(2, "tools/call", { name: "get_azure_functions", arguments: {} }));
    expect(f.status).toBe(200);
    expect(f.json.result.isError).toBe(false);
    expect(f.json.result.structuredContent.status).toBe("OK");
    expect(f.json.result.structuredContent.data.functions.length).toBeGreaterThan(0);
    const r = await mcp(rpc(3, "tools/call", { name: "get_azure_resources", arguments: {} }));
    expect(r.json.result.structuredContent.status).toBe("OK");
    expect(r.json.result.structuredContent.data.resources.length).toBeGreaterThan(0);
    const fn = f.json.result.structuredContent.data.functions[0].function.id as string;
    const flow = await mcp(rpc(4, "tools/call", { name: "trace_azure_flow", arguments: { entity: fn } }));
    expect(["OK", "EMPTY"]).toContain(flow.json.result.structuredContent.status);
  });

  test("malformed arguments and unknown repository are structured errors", async () => {
    const bad = await mcp(rpc(5, "tools/call", { name: "get_azure_functions", arguments: { limit: "x" } }));
    expect(bad.status).toBe(200);
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.structuredContent.error).toMatch(/invalid input/);
    const str = await mcp(rpc(6, "tools/call", { name: "get_azure_functions", arguments: "x" }));
    expect(str.json.result.isError).toBe(true);
    const repo = await mcp(rpc(7, "tools/call", { name: "get_azure_resources", arguments: { repository: "nope" } }));
    expect(repo.status).toBe(200);
    expect(repo.json.result.structuredContent.status).toBe("OUT_OF_SCOPE");
  });

  test("JSON-RPC protocol errors", async () => {
    expect((await mcp("{nope")).status).toBe(400);
    for (const body of ["[1,2]", "\"x\"", "null", "42", JSON.stringify({ jsonrpc: "2.0", id: 1 }), JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 })]) {
      const r = await mcp(body);
      expect(r.status).toBe(200);
      expect(r.json.error.code).toBe(-32600);
    }
    for (const params of [{ name: "get_azure_nonexistent" }, { name: 5 }, "x", [1], null]) {
      const r = await mcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }));
      expect(r.status).toBe(200);
      expect(r.json.error.code).toBe(-32602);
    }
    expect((await mcp(rpc(1, "nope/method"))).json.error.code).toBe(-32601);
    expect((await mcp(rpc(1, "resources/read", { uri: 5 }))).json.error.code).toBe(-32602);
    expect((await mcp(rpc(1, "prompts/get", { name: "azure-architecture-flow", arguments: "x" }))).json.error.code).toBe(-32602);
    expect((await mcp(JSON.stringify({ jsonrpc: "2.0", method: "ping" }))).status).toBe(202);
  });

  test("authentication and tenancy", async () => {
    expect((await mcp(rpc(1, "tools/list"), null)).status).toBe(401);
    expect((await mcp(rpc(1, "tools/list"), "vgb_" + "0".repeat(40))).status).toBe(401);
    expect((await mcp(rpc(1, "tools/list"), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARY")).status).toBe(401);
    const expired = await p.store.createToken(tenantId, "expired", "service", null, "test", new Date(Date.now() - 60_000).toISOString());
    expect((await mcp(rpc(1, "tools/list"), expired.secret)).status).toBe(401);
    const revoked = await p.store.createToken(tenantId, "revoked", "service", null, "test", null);
    await p.store.revokeToken(tenantId, revoked.id);
    expect((await mcp(rpc(1, "tools/list"), revoked.secret)).status).toBe(401);
    const wrongTenant = await mcp(rpc(1, "tools/list"), admin, "other");
    expect(wrongTenant.status).toBe(404);
    const unknownTenant = await mcp(rpc(1, "tools/list"), admin, "nope");
    expect(unknownTenant.status).toBe(404);
    const noGraph = await mcp(rpc(1, "tools/list"), (await tenantWithToken(p, "other")).secret, "other");
    expect(noGraph.status).toBe(409);
    expect(noGraph.json.error.code).toBe("GRAPH_NOT_ANALYZED");
  });

  test("authorization: roles, environments and repository scopes", async () => {
    const viewer = (await tenantWithToken(p, "acme", "viewer")).secret;
    const v = await mcp(rpc(1, "tools/list"), viewer);
    expect(v.status).toBe(403);
    expect(v.json.error.code).toBe("FORBIDDEN");
    const analyst = (await tenantWithToken(p, "acme", "repository_analyst")).secret;
    const denied = await mcp(rpc(1, "tools/call", { name: "get_security_findings", arguments: {} }), analyst);
    expect(denied.status).toBe(200);
    expect(denied.json.result.structuredContent.status).toBe("OUT_OF_SCOPE");
    const allowed = await mcp(rpc(1, "tools/call", { name: "get_azure_functions", arguments: {} }), analyst);
    expect(allowed.json.result.structuredContent.status).toBe("OK");
    const prod = (await tenantWithToken(p, "acme", "org_admin", { environments: ["prod"] })).secret;
    const unknownArg = await mcp(rpc(1, "tools/call", { name: "get_azure_functions", arguments: { environment: "dev" } }), prod);
    expect(unknownArg.json.result.isError).toBe(true);
    const env = await mcp(rpc(1, "tools/call", { name: "get_deployments", arguments: { entity: "contoso-orders", environment: "dev" } }), prod);
    expect(env.status).toBe(200);
    expect(env.json.result.structuredContent.status).toBe("OUT_OF_SCOPE");
    const repo = await p.store.createRepository({ tenantId, name: "unanalyzed", provider: "git", url: "https://github.com/contoso/unanalyzed", identity: "github.com/contoso/unanalyzed", organization: null, project: null, branch: "main", credentialRef: null, webhookSecretRef: null, teamId: null, createdBy: "test" });
    const scoped = (await tenantWithToken(p, "acme", "org_admin", { repositoryId: repo.id })).secret;
    const hidden = await mcp(rpc(1, "tools/call", { name: "get_azure_functions", arguments: {} }), scoped);
    expect(hidden.status).toBe(200);
    expect(hidden.json.result.structuredContent.status).toBe("EMPTY");
    expect(hidden.json.result.structuredContent.data.functions).toEqual([]);
    const named = await mcp(rpc(1, "tools/call", { name: "get_azure_functions", arguments: { repository: "contoso-orders" } }), scoped);
    expect(named.json.result.structuredContent.status).toBe("OUT_OF_SCOPE");
  });
});

describe("REST /query/{tool}: Azure tools (F-01)", () => {
  test("catalog lists the Azure tools", async () => {
    const r = await call(p, "GET", `${T}/query`, { headers: bearer(admin) });
    expect(r.status).toBe(200);
    const names = r.json.items.map((t: { name: string }) => t.name);
    for (const n of AZURE_TOOLS) expect(names).toContain(n);
  });

  test("valid calls return graph-backed data", async () => {
    const f = await query("get_azure_functions", "{}");
    expect(f.status).toBe(200);
    expect(f.json.status).toBe("OK");
    expect(f.json.data.functions.length).toBeGreaterThan(0);
    const r = await query("get_azure_resources", JSON.stringify({ limit: 5 }));
    expect(r.json.status).toBe("OK");
    expect(r.json.data.resources.length).toBeGreaterThan(0);
    expect(r.json.data.resources.length).toBeLessThanOrEqual(5);
    const flow = await query("trace_azure_flow", JSON.stringify({ entity: f.json.data.functions[0].function.id }));
    expect(flow.status).toBe(200);
    expect(["OK", "EMPTY"]).toContain(flow.json.status);
  });

  test("malformed input, unknown tool, unknown repository and wrong environment", async () => {
    const bad = await query("get_azure_functions", JSON.stringify({ limit: "x" }));
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_FAILED");
    expect((await query("get_azure_functions", "[1]")).status).toBe(400);
    expect((await query("get_azure_functions", "{nope")).status).toBe(400);
    const unknown = await query("get_azure_nonexistent", "{}");
    expect(unknown.status).toBe(404);
    const repo = await query("get_azure_functions", JSON.stringify({ repository: "nope" }));
    expect(repo.status).toBe(403);
    expect(repo.json.error.code).toBe("FORBIDDEN");
    const prod = (await tenantWithToken(p, "acme", "org_admin", { environments: ["prod"] })).secret;
    const env = await query("get_azure_functions", "{}", prod, "?environment=dev");
    expect(env.status).toBe(403);
    const longEnv = await query("get_azure_functions", "{}", admin, `?environment=${"x".repeat(100)}`);
    expect(longEnv.status).toBe(400);
  });

  test("authentication and authorization", async () => {
    expect((await query("get_azure_functions", "{}", null)).status).toBe(401);
    expect((await query("get_azure_functions", "{}", "vgb_CANARY")).status).toBe(401);
    const viewer = (await tenantWithToken(p, "acme", "viewer")).secret;
    expect((await query("get_azure_functions", "{}", viewer)).status).toBe(200);
    const impact = await query("find_impact", JSON.stringify({ entity: "x" }), viewer);
    expect(impact.status).toBe(403);
    const other = (await tenantWithToken(p, "other")).secret;
    expect((await query("get_azure_functions", "{}", other)).status).toBe(404);
  });
});
