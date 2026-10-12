import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeFixture, rows, storedText } from "./analyze-helper.ts";

// D-02: Cosmos SDK clients held in fields/properties: field initializers, property initializers, constructor assignments,
// readonly and static readonly fields, several clients in one class. Every data-plane call must resolve to its container
// (Function → service → field → CosmosClient → Cosmos container); no construction site may be reported as ambiguous.
//
// Semantic analysis needs the Roslyn analyzer and the fixture's NuGet packages bound as metadata (in-source stubs are not
// treated as SDK types). The restore runs offline from the NuGet global packages folder only; when the packages are not
// cached locally the suite is skipped with the reason below instead of touching the network.
const FIXTURE_PROJECT = "src/Contoso.Catalog.Functions";
const PACKAGES = join(process.env.NUGET_PACKAGES ?? join(homedir(), ".nuget", "packages"));
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(homedir(), ".capy", "work", "dotnet", "dotnet"), join(homedir(), ".dotnet", "dotnet")].find((c): c is string => !!c && existsSync(c)) ?? null;

function restoreOffline(dir: string): string | null {
  if (!dotnet) return "dotnet SDK not found (VOGOBAN_DOTNET, PATH, ~/.capy/work/dotnet or ~/.dotnet)";
  for (const pkg of ["microsoft.azure.cosmos/3.46.0", "microsoft.azure.functions.worker/2.0.0", "azure.identity/1.13.2", "newtonsoft.json/13.0.3"]) {
    if (!existsSync(join(PACKAGES, pkg))) return `NuGet package ${pkg} is not in the offline cache ${PACKAGES}; restore test/azure/fixtures/cosmos-initializers once with network access`;
  }
  const r = Bun.spawnSync([dotnet, "restore", "--source", PACKAGES, "--ignore-failed-sources", "--nologo", "-v", "q"], { cwd: join(dir, FIXTURE_PROJECT), stdout: "pipe", stderr: "pipe", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" } });
  return r.exitCode === 0 ? null : `offline dotnet restore failed: ${r.stdout.toString()}${r.stderr.toString()}`.slice(0, 600);
}

let skipReason: string | null = null;
let fx: ReturnType<typeof analyzeFixture> | null = null;
try {
  fx = analyzeFixture("cosmos-initializers", (dir) => {
    const reason = restoreOffline(dir);
    if (reason) throw new Error(reason);
  }, { VOGOBAN_DOTNET: dotnet ?? "" });
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error);
  console.warn(`sdk-initializers: skipped (${skipReason})`);
}

describe.skipIf(skipReason !== null)("Cosmos SDK clients in field/property initializers and constructor assignments (D-02)", () => {
  const edges = () => rows(fx!.db, "SELECT r.type AS type, s.qualified_name AS source, t.qualified_name AS target, r.evidence AS evidence, r.metadata AS metadata FROM relationships r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id WHERE t.kind = 'Database' ORDER BY s.qualified_name, r.type");
  const edge = (method: string) => {
    const e = edges().find((r) => String(r.source).startsWith(`Contoso.Catalog.Functions.${method}(`));
    expect(e, method).toBeDefined();
    return { ...e!, meta: JSON.parse(String(e!.metadata)) as Record<string, unknown> };
  };

  beforeAll(() => {
    expect(rows(fx!.db, "SELECT name FROM entities WHERE kind = 'AzureFunction' ORDER BY name").map((r) => r.name)).toEqual(["AddReview", "GetProduct", "GetStock"]);
  });
  afterAll(() => fx?.cleanup());

  test("no SDK usage is left unresolved as ambiguous or injected", () => {
    expect(rows(fx!.db, "SELECT target_display, reason FROM unresolved WHERE resolver = 'azure.sdk'")).toEqual([]);
  });

  test("field initializer `private CosmosClient client = new CosmosClient(...)` + ctor `_products = client.GetContainer(...)` (receiver chain through the invocation)", () => {
    const read = edge("ProductService.GetAsync");
    expect(read.type).toBe("READS_FROM");
    expect(read.target).toBe("azure:cosmos-container:cosmos-catalog/catalogdb/products");
    expect(read.evidence).toBe("COMPILER_RESOLVED");
    expect(read.meta.credential).toBe("default-azure-credential");
    expect(String(read.meta.derivation)).toContain("ProductService._products assigned from");
    expect(String(read.meta.derivation)).toContain("ProductService.client assigned from new CosmosClient(...)");
    const write = edge("ProductService.SaveAsync");
    expect([write.type, write.target]).toEqual(["WRITES_TO", "azure:cosmos-container:cosmos-catalog/catalogdb/products"]);
  });

  test("property initializer `public CosmosClient Client { get; } = new CosmosClient(...)` and a second `static readonly` key client in the same class", () => {
    const add = edge("ReviewService.AddAsync");
    expect([add.type, add.target, add.meta.credential]).toEqual(["WRITES_TO", "azure:cosmos-container:cosmos-reviews/reviewsdb/reviews", "managed-identity"]);
    const archive = edge("ReviewService.ArchiveAsync");
    expect([archive.type, archive.target, archive.meta.credential]).toEqual(["WRITES_TO", "azure:cosmos-container:cosmos-archive/archivedb/reviews", "key"]);
  });

  test("readonly field assigned in the constructor", () => {
    const read = edge("InventoryService.ReadAsync");
    expect([read.type, read.target, read.meta.credential]).toEqual(["READS_FROM", "azure:cosmos-container:cosmos-inventory/inventorydb/stock", "default-azure-credential"]);
  });

  test("Function → service → container is a stored path, and the account key literal is never persisted", () => {
    const fn = rows(fx!.db, "SELECT id FROM entities WHERE kind = 'AzureFunction' AND name = 'GetProduct'")[0]!;
    const impl = rows(fx!.db, "SELECT target_id FROM relationships WHERE type = 'IMPLEMENTED_BY' AND source_id = ?", String(fn.id))[0]!;
    const calls = rows(fx!.db, "SELECT t.qualified_name AS qn FROM relationships r JOIN entities t ON t.id = r.target_id WHERE r.type = 'CALLS' AND r.source_id = ?", String(impl.target_id)).map((r) => String(r.qn));
    expect(calls.some((c) => c.startsWith("Contoso.Catalog.Functions.ProductService.GetAsync("))).toBe(true);
    const cosmosAccounts = rows(fx!.db, "SELECT qualified_name FROM entities WHERE kind = 'Database' ORDER BY qualified_name").map((r) => r.qualified_name);
    expect(cosmosAccounts).toEqual(["azure:cosmos-container:cosmos-archive/archivedb/reviews", "azure:cosmos-container:cosmos-catalog/catalogdb/products", "azure:cosmos-container:cosmos-inventory/inventorydb/stock", "azure:cosmos-container:cosmos-reviews/reviewsdb/reviews"]);
    expect(storedText(fx!.db)).not.toContain("CANARY-COSMOS-KEY");
  });
});
