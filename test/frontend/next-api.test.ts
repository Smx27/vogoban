import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../../src/log.ts";
import { analyzeRepository } from "../../src/pipeline/analyze.ts";
import { defaultPlugins } from "../../src/plugins/registry.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";
import { apiResolver } from "../../src/metagraph/apis.ts";
import { repositoryViews } from "../../src/metagraph/build.ts";

let work: string;
let store: SqliteGraphStore;
let repositoryId: string;
const put = (path: string, text: string) => {
  const file = join(work, "repo", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "vogoban-next-api-"));
  for (const name of ["portal", "other"]) {
    put(`${name}/package.json`, JSON.stringify({ name, dependencies: { next: "15.0.0", react: "19.0.0" } }));
    put(`${name}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src/**/*.ts"] }));
    put(`${name}/src/app/api/orders/route.ts`, "export async function GET() { return Response.json([]); }\nexport const POST = async () => Response.json({});\nconst DELETE = () => Response.json({});\nexport const PATCH = 'not a handler';\n");
  }
  put("portal/src/app/(group)/api/orders/[id]/route.ts", "const read = async () => Response.json({});\nexport { read as GET };\n");
  put("portal/src/app/api/alias/route.ts", "export { GET } from '../orders/route';\n");
  put("portal/src/lib/route.ts", "export function GET() { return Response.json({}); }\n");
  put("portal/src/app/api/notroute.ts", "export function GET() { return Response.json({}); }\n");
  put("other/src/app/api/foreign/route.ts", "export function GET() { return Response.json({}); }\n");
  put("portal/src/client.ts", "'use client';\nexport const refresh = () => fetch('/api/orders');\nexport const detail = () => fetch('/api/orders/123');\nexport const foreign = () => fetch('/api/foreign');\nexport const dev = () => fetch('http://localhost:5180/api/orders');\nconst base = process.env.GATEWAY_BASE_URL;\nexport const configured = () => fetch(`${base}/api/orders`);\nconst unknown = globalThis.remoteBase;\nexport const dynamic = () => fetch(`${unknown}/api/orders`);\n");
  put("other/src/client.ts", "export const refresh = () => fetch('/api/orders');\n");
  put("portal/.env.production", "SERVER_HOST_URL=https://orders.internal.dev/\n");
  put("portal/src/server.ts", "const serverBase = process.env.SERVER_HOST_URL ?? 'https://fallback.internal.dev';\nexport const serverBound = () => fetch(`${serverBase}/api/orders`);\n");
  store = new SqliteGraphStore(join(work, "graph.db"));
  ({ repositoryId } = await analyzeRepository(join(work, "repo"), store, defaultPlugins(), { semantic: true }, createLogger({ level: "error" })));
}, 120_000);

afterAll(() => {
  store?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

test("Next app handlers declare implemented operations, including exported aliases and grouped dynamic routes", () => {
  const ops = store.findEntities({ repositoryId, kinds: ["ApiOperation"] });
  expect(ops.map((o) => o.qualifiedName).sort()).toEqual(["other:GET /api/foreign", "other:GET /api/orders", "other:POST /api/orders", "portal:GET /api/alias", "portal:GET /api/orders", "portal:GET /api/orders/{id}", "portal:POST /api/orders"]);
  for (const op of ops) {
    expect(op.metadata.contractSource).toBe("nextjs-app-router");
    expect(store.findRelationships({ repositoryId, types: ["IMPLEMENTED_BY"], sourceIds: [op.id] })).toHaveLength(1);
  }
  expect(store.findEntities({ repositoryId, kinds: ["FrontendRoute"] })).toEqual([]);
});

test("same-origin fetch links only to the caller's own declared Next provider", () => {
  const calls = store.findRelationships({ repositoryId, types: ["CALLS_ENDPOINT"] });
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    const source = store.getEntity(call.sourceId)!;
    const target = store.getEntity(call.targetId)!;
    const own = source.location!.file.split("/")[0]!;
    expect(target.qualifiedName!.startsWith(`${own}:`)).toBe(true);
    expect(call.metadata.matchStage).toBe("same-origin+application+method+route");
    expect(call.evidence).toBe("STRUCTURALLY_RESOLVED");
  }
});

test("another application's route and an unbound base do not establish same origin", () => {
  const unresolved = store.findUnresolved({ repositoryId }).filter((u) => u.type === "CALLS_ENDPOINT");
  const byCaller = new Map(unresolved.map((u) => [store.getEntity(u.sourceId)!.name, u]));
  expect(byCaller.get("foreign")?.metadata.category).toBe("same-origin-operation-not-found");
  expect(byCaller.get("dev")?.metadata.category).toBe("no-matching-operation");
  expect(byCaller.get("configured")?.metadata).toMatchObject({ category: "configured-url", baseConfigurationKey: "GATEWAY_BASE_URL", verb: "GET", url: "/api/orders" });
  expect(byCaller.get("dynamic")?.metadata.category).toBe("dynamic-url");
});

test("external fallback URLs retain their declared configuration binding and call provenance for the MetaGraph", () => {
  const view = repositoryViews(store).views.get(repositoryId)!;
  const collected = apiResolver.collect(store, view);
  const bound = collected.calls.find((c) => store.getEntity(c.sourceId)?.name === "serverBound")!;
  expect(bound).toMatchObject({ api: "fetch", verb: "GET", url: "/api/orders", baseAddress: "https://fallback.internal.dev", configurationKeys: ["SERVER_HOST_URL"] });
  expect(bound.provenance[0]?.location?.file).toBe("portal/src/server.ts");
  expect(collected.configUrls.find((c) => c.key === "SERVER_HOST_URL")).toMatchObject({ value: "https://orders.internal.dev/", environment: "production" });
});
