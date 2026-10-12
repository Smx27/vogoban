import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphAccess, readOnlyStore } from "../../src/ai/access.ts";
import { ask } from "../../src/ai/assistant.ts";
import { DEFAULT_LIMITS } from "../../src/ai/model.ts";
import { explicitPlan, validatePlan, type QueryPlan } from "../../src/ai/plan.ts";
import { loadAiConfig } from "../../src/ai/provider.ts";
import { runTool, TOOL_INDEX, TOOLS, toolCatalog } from "../../src/ai/tools.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
const FIXTURE = join(ROOT, "test/azure/fixtures/contoso-orders");
const AZURE_TOOLS = ["get_azure_functions", "get_azure_resources", "get_azure_triggers", "get_azure_messaging", "get_azure_infrastructure", "trace_azure_flow"];

let dir: string;
let dbPath: string;
let store: SqliteGraphStore;

const access = (repositories: string[] | null = null) =>
  new GraphAccess(readOnlyStore(store), { graph: "all", repositories, environment: null, snapshots: { repositories: {}, meta: null } }, DEFAULT_LIMITS, { policyPaths: null, enterprisePath: null, aliases: {} });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vogoban-azure-tools-"));
  cpSync(FIXTURE, join(dir, "contoso-orders"), { recursive: true });
  dbPath = join(dir, "graph.db");
  const r = Bun.spawnSync(["bun", CLI, "analyze", join(dir, "contoso-orders"), "--db", dbPath, "--log-level", "error"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_OFFLINE: "1" } });
  if (r.exitCode !== 0) throw new Error(`fixture analysis failed: ${r.stderr.toString()}`);
  store = new SqliteGraphStore(dbPath);
});

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Azure tool registration (F-01)", () => {
  test("every Azure tool is in TOOLS, TOOL_INDEX and the catalog", () => {
    for (const name of AZURE_TOOLS) {
      expect(TOOL_INDEX.has(name)).toBe(true);
      expect(TOOLS.some((t) => t.name === name)).toBe(true);
      expect(toolCatalog().some((t) => t.name === name)).toBe(true);
    }
    expect(TOOL_INDEX.size).toBe(TOOLS.length);
  });

  test("get_azure_functions returns graph-backed functions from the fixture", () => {
    const r = runTool(access(), "get_azure_functions", {});
    expect(r.status).toBe("OK");
    const data = r.data as { functions: { function: { id: string }; trigger: string | null }[] };
    expect(data.functions.length).toBeGreaterThan(0);
    expect(r.evidence.length).toBeGreaterThan(0);
    for (const f of data.functions) expect(store.getEntity(f.function.id)).not.toBeNull();
  });

  test("get_azure_triggers, get_azure_messaging and get_azure_infrastructure return graph-backed data", () => {
    const triggers = runTool(access(), "get_azure_triggers", {});
    expect(triggers.status).toBe("OK");
    const t = triggers.data as { triggers: { function: { id: string }; source: { id: string } | null; evidence: string }[] };
    expect(t.triggers.length).toBeGreaterThan(0);
    for (const x of t.triggers) expect(store.getEntity(x.function.id)).not.toBeNull();
    const messaging = runTool(access(), "get_azure_messaging", {});
    expect(messaging.status).toBe("OK");
    const m = messaging.data as { transports: { transport: { id: string; name: string }; publishers: unknown[]; consumers: unknown[] }[] };
    expect(m.transports.length).toBeGreaterThan(0);
    for (const x of m.transports) expect(store.getEntity(x.transport.id)).not.toBeNull();
    const infrastructure = runTool(access(), "get_azure_infrastructure", {});
    expect(infrastructure.status).toBe("OK");
    const i = infrastructure.data as { files: { file: { id: string }; creates: unknown[] }[]; hosting: unknown[] };
    expect(i.files.length).toBeGreaterThan(0);
    expect(i.files.some((f) => f.creates.length > 0)).toBe(true);
    for (const name of ["get_azure_triggers", "get_azure_messaging", "get_azure_infrastructure"]) {
      expect(runTool(access(), name, { limit: "x" }).status).not.toBe("OK");
      expect(runTool(access(), name, { repository: "nope" }).status).not.toBe("OK");
      expect(runTool(access([]), name, {}).status).not.toBe("OK");
    }
  });

  test("get_azure_resources returns declared resources from the fixture", () => {
    const r = runTool(access(), "get_azure_resources", {});
    expect(r.status).toBe("OK");
    const data = r.data as { resources: { resource: { id: string } }[] };
    expect(data.resources.length).toBeGreaterThan(0);
    for (const x of data.resources) expect(store.getEntity(x.resource.id)).not.toBeNull();
  });

  test("trace_azure_flow follows stored relationships from a function", () => {
    const fn = (runTool(access(), "get_azure_functions", {}).data as { functions: { function: { id: string } }[] }).functions[0]!;
    const r = runTool(access(), "trace_azure_flow", { entity: fn.function.id, direction: "downstream" });
    expect(["OK", "EMPTY"]).toContain(r.status);
    expect(r.error).toBeUndefined();
  });

  test("malformed arguments produce a structured ERROR, never a throw", () => {
    for (const [name, args] of [
      ["get_azure_functions", { limit: "x" }],
      ["get_azure_functions", { trigger: 5 }],
      ["get_azure_resources", { kind: "a".repeat(500) }],
      ["trace_azure_flow", {}],
      ["trace_azure_flow", { entity: "x", direction: "sideways" }],
      ["trace_azure_flow", { entity: "x", depth: -1 }],
      ["get_azure_functions", "not an object"],
      ["get_azure_functions", [1, 2]],
    ] as const) {
      const r = runTool(access(), name, args);
      expect(r.status).toBe("ERROR");
      expect(r.error).toMatch(/invalid input/);
      expect(r.tool).toBe(name);
    }
  });

  test("unknown repository is OUT_OF_SCOPE, never a guessed match", () => {
    for (const name of ["get_azure_functions", "get_azure_resources"]) {
      const r = runTool(access(), name, { repository: "does-not-exist" });
      expect(r.status).toBe("OUT_OF_SCOPE");
      expect(r.error).toMatch(/not in catalog/);
    }
    const r = runTool(access(), "trace_azure_flow", { entity: "does-not-exist" });
    expect(r.status).toBe("NOT_FOUND");
  });

  test("a scope naming an unknown repository is refused at construction, never widened", () => {
    expect(() => access(["r_not_in_scope"])).toThrow(/not in catalog/);
  });

  test("denied tools stay denied for Azure tools", () => {
    const a = new GraphAccess(readOnlyStore(store), { graph: "all", repositories: null, environment: null, snapshots: { repositories: {}, meta: null } }, DEFAULT_LIMITS, { policyPaths: null, enterprisePath: null, aliases: {}, deniedTools: ["get_azure_functions"] });
    expect(runTool(a, "get_azure_functions", {}).status).toBe("OUT_OF_SCOPE");
  });
});

describe("planner dispatch of Azure tools", () => {
  test("validatePlan accepts a step naming get_azure_functions and ask() executes it", async () => {
    const a = access();
    const plan: QueryPlan = explicitPlan(a, "azure functions", [], [{ tool: "get_azure_functions", args: {} }, { tool: "get_azure_resources", args: { limit: 5 } }]);
    const v = validatePlan(plan, a);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    const answer = await ask(a, { question: "azure functions", scope: a.scope, limits: DEFAULT_LIMITS, conversation: [], llm: "off", llmPlanning: false }, { config: loadAiConfig(null), provider: null, auditPath: null }, plan);
    expect(answer.status).toBe("ANSWERED");
    expect(answer.tools.map((t) => t.tool)).toEqual(["get_azure_functions", "get_azure_resources"]);
    expect(answer.tools.every((t) => t.status === "OK")).toBe(true);
  });

  test("validatePlan still rejects an unknown tool", () => {
    const a = access();
    const v = validatePlan(explicitPlan(a, "q", [], [{ tool: "get_azure_nonexistent", args: {} }]), a);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/unsupported operation 'get_azure_nonexistent'/);
  });
});

describe("MCP stdio exposes Azure tools", () => {
  const session = (lines: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, "mcp", "--db", dbPath], { cwd: ROOT, stdin: Buffer.from(lines.map((l) => `${l}\n`).join("")), stdout: "pipe", stderr: "pipe", env: { ...process.env, VOGOBAN_OFFLINE: "1" } });
    return r.stdout.toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: unknown; result?: any; error?: { code: number; message: string } });
  };

  test("tools/list contains them and tools/call runs them", () => {
    const out = session([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_azure_functions", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_azure_resources", arguments: { limit: "x" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_azure_functions", arguments: { repository: "nope" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_azure_nonexistent", arguments: {} } }),
      "{not json",
      JSON.stringify({ jsonrpc: "2.0", id: 7 }),
    ]);
    const by = (id: number) => out.find((m) => m.id === id)!;
    const names = by(1).result.tools.map((t: { name: string }) => t.name);
    for (const n of AZURE_TOOLS) expect(names).toContain(n);
    expect(by(2).result.structuredContent.status).toBe("OK");
    expect(by(2).result.structuredContent.data.functions.length).toBeGreaterThan(0);
    expect(by(3).result.isError).toBe(true);
    expect(by(3).result.structuredContent.error).toMatch(/invalid input/);
    expect(by(4).result.structuredContent.status).toBe("OUT_OF_SCOPE");
    expect(by(5).error?.code).toBe(-32602);
    expect(out.find((m) => m.error?.code === -32700)).toBeDefined();
    expect(by(7).error?.code).toBe(-32600);
  });
});
