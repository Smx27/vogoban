import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { analyzeFixtureInto, bearer, call, startPlatform, tenantWithToken, type Platform } from "./helpers.ts";

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
});

afterAll(async () => {
  await p.stop();
});

const get = (path: string, token = admin) => call(p, "GET", path, { headers: bearer(token) });
const post = (path: string, body: string, headers: Record<string, string> = bearer(admin)) => call(p, "POST", path, { headers, body });

const expectClientError = (r: { status: number; json: any }, codes: number[] = []) => {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  if (codes.length) expect(codes).toContain(r.status);
  if (r.json) {
    expect(typeof r.json.error.code).toBe("string");
    expect(typeof r.json.error.correlationId).toBe("string");
  }
};

describe("request size limits", () => {
  test("413 for a body over the configured limit (content-length and streamed)", async () => {
    const limit = p.cfg.limits.maxBodyBytes;
    const r = await post(`${T}/query/get_azure_functions`, JSON.stringify({ repository: "a".repeat(limit + 10) }));
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    const res = await fetch(`${p.base}${T}/query/get_azure_functions`, { method: "POST", headers: bearer(admin), body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"repository":"${"a".repeat(limit * 2 + 10)}"}`)); c.close(); } }) });
    expect(res.status).toBe(413);
  });

  test("431 or 400 for oversized headers, never 500", async () => {
    const r = await get(`${T}/repositories`, admin).then(() => call(p, "GET", `${T}/repositories`, { headers: bearer(admin, { "x-big": "a".repeat(70_000) }) }));
    expect([431, 400]).toContain(r.status);
  });
});

describe("pagination boundaries", () => {
  for (const path of [`${T}/repositories`, `${T}/jobs`, `${T}/graph-versions`, `${T}/entities`]) {
    test(`${path} rejects bad limits and tolerates junk cursors`, async () => {
      for (const limit of ["0", "-1", "99999999999999999999", "x", "1.5", "NaN", "1e3"]) {
        const r = await get(`${path}?limit=${encodeURIComponent(limit)}`);
        expect(r.status, `${path}?limit=${limit}`).toBe(400);
        expect(r.json.error.code).toBe("VALIDATION_FAILED");
      }
      const max = await get(`${path}?limit=${p.cfg.limits.maxPageSize}`);
      expect(max.status).toBe(200);
      for (const cursor of ["junk", "%00", "AAAA====", "{\"a\":1}", "../../etc", "x".repeat(400)]) {
        const r = await get(`${path}?cursor=${encodeURIComponent(cursor)}`);
        expect(r.status, `${path}?cursor=${cursor}`).toBeLessThan(500);
        if (r.status === 200) expect(Array.isArray(r.json.items)).toBe(true);
      }
      const long = await get(`${path}?cursor=${"x".repeat(401)}`);
      expect(long.status).toBe(400);
    });
  }
});

describe("malformed bodies", () => {
  test("invalid JSON, wrong content-type, non-object bodies", async () => {
    for (const body of ["{nope", "{\"a\":", "\u0000", "[1]", "\"s\"", "42", "true"]) {
      const r = await post(`${T}/query/get_azure_functions`, body);
      expectClientError(r, [400]);
    }
    const ct = await post(`${T}/query/get_azure_functions`, "{}", { authorization: `Bearer ${admin}`, "content-type": "text/plain" });
    expect(ct.status).toBe(400);
    const repoCreate = await post(`${T}/repositories`, "[1]");
    expectClientError(repoCreate, [400]);
  });

  test("wrong field types and invalid enum values", async () => {
    const types = await post(`${T}/repositories`, JSON.stringify({ name: 5, url: [], provider: {} }));
    expect(types.status).toBe(400);
    expect(types.json.error.details.errors.length).toBeGreaterThan(0);
    const provider = await post(`${T}/repositories`, JSON.stringify({ name: "x", url: "https://github.com/a/b", provider: "nope" }));
    expect(provider.status).toBe(400);
    const nested = await post(`${T}/repositories`, JSON.stringify({ name: { $gt: "" }, url: null, provider: ["github"] }));
    expect(nested.status).toBe(400);
    const limit = await post(`${T}/query/get_azure_functions`, JSON.stringify({ limit: "x" }));
    expect(limit.status).toBe(400);
    const huge = await post(`${T}/query/get_azure_functions`, JSON.stringify({ limit: 1e12 }));
    expect(huge.status).toBe(400);
    const extra = await post(`${T}/query/get_azure_functions`, JSON.stringify({ unknownField: 1 }));
    expect(extra.status).toBe(400);
    const direction = await post(`${T}/query/trace_azure_flow`, JSON.stringify({ entity: "x", direction: "sideways" }));
    expect(direction.status).toBe(400);
    const exportFormat = await post(`${T}/exports`, JSON.stringify({ kind: "graph", format: "exe" }));
    expect(exportFormat.status).toBe(400);
    const settings = await call(p, "PATCH", `${T}/settings`, { headers: bearer(admin), body: JSON.stringify({ features: "{bad", environments: 5 }) });
    expect(settings.status).toBe(400);
    const settingsList = await call(p, "PATCH", `${T}/settings`, { headers: bearer(admin), body: JSON.stringify({ features: "[1]" }) });
    expect(settingsList.status).toBe(400);
    const retention = await call(p, "PATCH", `${T}/settings`, { headers: bearer(admin), body: JSON.stringify({ retention: "{\"jobsDays\":\"x\"}" }) });
    expect(retention.status).toBe(400);
  });

  test("invalid query enums and strings", async () => {
    expectClientError(await get(`${T}/jobs?status=NOPE`), [400]);
    expectClientError(await get(`${T}/entities?kind=Nope`), [400]);
    expectClientError(await get(`${T}/search?q=`), [400]);
    expectClientError(await get(`${T}/search?q=a&limit=abc`), [400]);
    expectClientError(await get(`${T}/search?q=${"a".repeat(300)}`), [400]);
    expectClientError(await get(`${T}/entities?repository=nope`), [400, 404]);
  });
});

describe("identifiers, tenants and routing", () => {
  test("invalid or hostile ids are 4xx", async () => {
    for (const id of ["nope", "%00", "'; DROP TABLE jobs; --", "../..", "%E0%A4%A", "%ff", "x".repeat(2000), "<script>"]) {
      expectClientError(await get(`${T}/repositories/${id}`), [400, 404]);
      expectClientError(await get(`${T}/jobs/${id}`), [400, 404]);
      expectClientError(await get(`${T}/graph-versions/${id}/entities`), [400, 404]);
      expectClientError(await get(`${T}/entities/${id}`), [400, 404]);
    }
  });

  test("tenant, environment and repository combinations", async () => {
    for (const tenant of ["nope", "%00", "%ff", "..", "x".repeat(300), "ACME"]) {
      expectClientError(await get(`/api/v1/t/${tenant}/repositories`), [400, 404]);
    }
    const other = await tenantWithToken(p, "other", "org_admin");
    expectClientError(await get(`${T}/repositories`, other.secret), [403, 404]);
    expectClientError(await get(`/api/v1/t/other/query`, admin), [403, 404]);
    const noGraph = await post(`/api/v1/t/other/query/get_azure_functions`, "{}", bearer(other.secret));
    expect(noGraph.status).toBe(409);
    const envScoped = await tenantWithToken(p, "acme", "org_admin", { environments: ["prod"] });
    expectClientError(await post(`${T}/query/get_azure_functions?environment=dev`, "{}", bearer(envScoped.secret)), [403]);
    expectClientError(await post(`${T}/query/get_azure_functions?environment=${"x".repeat(61)}`, "{}"), [400]);
    expectClientError(await post(`${T}/query/get_azure_functions`, JSON.stringify({ repository: "nope" })), [403]);
    const repo = await p.store.createRepository({ tenantId, name: "unanalyzed", provider: "git", url: "https://github.com/contoso/unanalyzed", identity: "github.com/contoso/unanalyzed", organization: null, project: null, branch: "main", credentialRef: null, webhookSecretRef: null, teamId: null, createdBy: "test" });
    const repoScoped = await tenantWithToken(p, "acme", "org_admin", { repositoryId: repo.id });
    expectClientError(await post(`${T}/query/get_azure_functions`, JSON.stringify({ repository: "contoso-orders" }), bearer(repoScoped.secret)), [403]);
  });

  test("unknown endpoints, wrong methods and unknown tools", async () => {
    expectClientError(await get(`/api/v1/nope`), [404]);
    expectClientError(await call(p, "DELETE", `${T}/mcp`, { headers: bearer(admin) }), [405]);
    expectClientError(await call(p, "PUT", `${T}/query/get_azure_functions`, { headers: bearer(admin), body: "{}" }), [405]);
    expectClientError(await post(`${T}/query/get_azure_nonexistent`, "{}"), [404]);
    expectClientError(await post(`${T}/query/..%2f..`, "{}"), [400, 404]);
    expectClientError(await post(`/api/v1/hooks/%ff`, "{}"), [400, 404]);
    expectClientError(await post(`/api/v1/hooks/nope`, "{}"), [404]);
  });

  test("hostile correlation ids and auth headers never break the request", async () => {
    const r = await call(p, "GET", `${T}/repositories`, { headers: bearer(admin, { "x-correlation-id": "<bad id>; " + "x".repeat(500) }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-correlation-id")).toMatch(/^cor_/);
    for (const auth of ["Bearer", "Bearer ", "Basic abc", "Bearer vgb_", "Bearer " + "x".repeat(10_000), "Bearer ey.CANARY"]) {
      const a = await call(p, "GET", `${T}/repositories`, { headers: { authorization: auth } });
      expectClientError(a, [401]);
    }
  });
});
