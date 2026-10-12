import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { analyzeFixture, edgesFrom, rows, storedText, type Row } from "./analyze-helper.ts";

// Node.js Azure Functions discovery: v4 programming model in CommonJS (`require('@azure/functions')`), ESM (`"type": "module"` / .mjs),
// a mixed package (.cjs + .mjs) and the legacy v3 function.json model whose scriptFile points at a CommonJS .js file.
describe("Node Azure Functions: CommonJS, ESM, mixed and function.json", () => {
  let fx: ReturnType<typeof analyzeFixture>;
  let functions: Map<string, Row>;
  beforeAll(() => {
    fx = analyzeFixture("node-functions");
    functions = new Map(rows(fx.db, "SELECT id, name, qualified_name, file, start_line, metadata FROM entities WHERE kind = 'AzureFunction'").map((r) => [String(r.qualified_name), r]));
  });
  afterAll(() => fx.cleanup());

  const meta = (qn: string) => JSON.parse(String(functions.get(qn)!.metadata)) as Record<string, unknown>;

  test("CommonJS `const { app } = require('@azure/functions')` and `functions.app.<trigger>` register functions", () => {
    expect([...functions.keys()].filter((k) => k.startsWith("contoso-commonjs-functions:")).sort()).toEqual([
      "contoso-commonjs-functions:CreateOrder",
      "contoso-commonjs-functions:NightlyReport",
      "contoso-commonjs-functions:ProcessOrder",
    ]);
    const create = meta("contoso-commonjs-functions:CreateOrder");
    expect(create.programmingModel).toBe("node-v4");
    expect(create.triggerType).toBe("http");
    expect(create.handler).toBe("createOrder");
    expect(functions.get("contoso-commonjs-functions:CreateOrder")!.file).toBe("commonjs/src/functions/orders.js");
    expect(meta("contoso-commonjs-functions:ProcessOrder").triggerType).toBe("serviceBus");
    expect(meta("contoso-commonjs-functions:NightlyReport")).toMatchObject({ triggerType: "timer", handler: "nightlyReport", triggerAttribute: "app.timer" });
  });

  test("CommonJS handler and bindings are linked: implemented-by, extraOutputs from a const `output.storageQueue(...)`, trigger queue", () => {
    const create = edgesFrom(fx.db, String(functions.get("contoso-commonjs-functions:CreateOrder")!.id));
    expect(create).toContainEqual(["IMPLEMENTED_BY", "Method", "commonjs/src/functions/orders.js:createOrder"]);
    expect(create).toContainEqual(["PUBLISHES_TO", "Queue", "azure-storage-queue:storage-queue:orders-out"]);
    expect(meta("contoso-commonjs-functions:CreateOrder").bindings).toEqual(["trigger:http:trigger", "output:queue:extraOutputs"]);
    const process = edgesFrom(fx.db, String(functions.get("contoso-commonjs-functions:ProcessOrder")!.id));
    expect(process).toContainEqual(["REFERENCES_CONFIG", "ConfigurationReference", "configuration:ServiceBus"]);
    expect(rows(fx.db, "SELECT qualified_name FROM entities WHERE kind = 'Queue' AND qualified_name LIKE '%:orders'").length).toBe(1);
  });

  test("CommonJS SDK usage from a handler resolves through a connection-string client without storing the key", () => {
    const sender = rows(fx.db, "SELECT r.metadata AS metadata, t.qualified_name AS qn FROM relationships r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id WHERE r.type = 'PUBLISHES_TO' AND s.qualified_name = 'commonjs/src/functions/orders.js:createOrder'");
    expect(sender.map((r) => r.qn)).toEqual(["azure-service-bus:service-bus-entity:orders-audit"]);
    expect(JSON.parse(String(sender[0]!.metadata)).credential).toBe("connection-string");
    const stored = storedText(fx.db);
    expect(stored).not.toContain("CANARY-CJS");
    expect(stored).not.toContain("CANARY-COSMOS");
    expect(stored).not.toContain("SharedAccessKey=");
    expect(stored).toContain("redacted connection string");
  });

  test("ESM named import and `import * as functions` namespace keep working", () => {
    expect([...functions.keys()].filter((k) => k.startsWith("contoso-esm-functions:")).sort()).toEqual(["contoso-esm-functions:ListImages", "contoso-esm-functions:ResizeImage"]);
    expect(meta("contoso-esm-functions:ListImages")).toMatchObject({ triggerType: "http", handler: "listImages", authLevel: "anonymous" });
    expect(meta("contoso-esm-functions:ResizeImage")).toMatchObject({ triggerType: "blob", handler: "resize" });
    expect(edgesFrom(fx.db, String(functions.get("contoso-esm-functions:ResizeImage")!.id))).toContainEqual(["IMPLEMENTED_BY", "Method", "esm/src/functions/images.mjs:resize"]);
    const blobWrite = rows(fx.db, "SELECT t.qualified_name AS qn FROM relationships r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id WHERE r.type = 'WRITES_TO' AND s.qualified_name = 'esm/src/functions/images.mjs:resize'");
    expect(blobWrite.map((r) => r.qn)).toEqual(["azure:blob-container:thumbnails"]);
  });

  test("mixed package: .cjs require() and .mjs import in one app, plus a v3 function.json whose scriptFile is a CommonJS .js file", () => {
    expect(meta("contoso-mixed-functions:GetProduct")).toMatchObject({ triggerType: "http", handler: "(inline handler)" });
    expect(functions.get("contoso-mixed-functions:GetProduct")!.file).toBe("mixed/src/functions/catalog.cjs");
    expect(meta("contoso-mixed-functions:OnCatalogEvent")).toMatchObject({ triggerType: "eventGrid", handler: "onEvent" });
    const legacy = functions.get("mixed:LegacyQueue")!;
    expect(JSON.parse(String(legacy.metadata))).toMatchObject({ programmingModel: "function.json", triggerType: "queue" });
    expect(edgesFrom(fx.db, String(legacy.id))).toContainEqual(["IMPLEMENTED_BY", "File", "mixed/legacy/queue.js"]);
  });

  test("the v4 facts are cached per package, not under one shared scope", () => {
    const scopes = rows(fx.db, "SELECT scope FROM fact_cache WHERE scope LIKE 'azure-typescript%' ORDER BY scope").map((r) => String(r.scope));
    expect(scopes.length).toBe(3);
    expect(scopes.every((s) => /\|(commonjs|esm|mixed)\/package\.json$/.test(s))).toBe(true);
  });
});
