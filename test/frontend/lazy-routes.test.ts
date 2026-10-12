import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "main.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "lazy-routes");

let work: string;
let db: Database;

interface Edge { type: string; targetKind: string; targetName: string; via: string | null; evidence: string }

const routeId = (qualifiedName: string): string => {
  const row = db.query<{ id: string }, [string]>("select id from entities where kind = 'FrontendRoute' and qualified_name = ?").get(qualifiedName);
  if (!row) throw new Error(`no route ${qualifiedName}`);
  return row.id;
};
const edges = (qualifiedName: string): Edge[] =>
  db
    .query<Edge, [string]>("select r.type as type, t.kind as targetKind, t.name as targetName, json_extract(r.metadata, '$.via') as via, r.evidence as evidence from relationships r join entities t on t.id = r.target_id where r.source_id = ? and r.type in ('ROUTES_TO_COMPONENT', 'LOADS_COMPONENT', 'LOADS_MODULE') order by r.type, t.name")
    .all(routeId(qualifiedName));
const components = (qualifiedName: string) => edges(qualifiedName).filter((e) => e.type !== "LOADS_MODULE").map((e) => `${e.targetKind}:${e.targetName}`);
const unresolved = (qualifiedName: string) => db.query<{ type: string; target: string; reason: string }, [string]>("select type, target_display as target, reason from unresolved where source_id = ?").all(routeId(qualifiedName));
const operations = (qualifiedName: string): string[] => {
  const p = Bun.spawnSync(["bun", CLI, "frontend-chain", routeId(qualifiedName), "--db", join(work, "graph.db"), "--json"], { cwd: ROOT, env: process.env });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  const chain = JSON.parse(p.stdout.toString()) as { operations: { operation: { name: string } }[] };
  return chain.operations.map((o) => o.operation.name).sort();
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "vogoban-lazy-routes-"));
  cpSync(FIXTURE, join(work, "repo"), { recursive: true });
  const p = Bun.spawnSync(["bun", CLI, "analyze", join(work, "repo"), "--db", join(work, "graph.db")], { cwd: ROOT, env: { ...process.env, PATH: `${process.env.HOME}/.capy/work/dotnet:${process.env.PATH}` } });
  if (p.exitCode !== 0) throw new Error(`analyze failed: ${p.stderr.toString()}\n${p.stdout.toString()}`);
  db = new Database(join(work, "graph.db"), { readonly: true });
}, 300_000);

afterAll(() => {
  db?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("Angular lazy routes (C-02)", () => {
  test("named export `.then(m => m.X)` loads the component and the chain reaches the API operation", () => {
    expect(components("lazy-angular:/orders")).toEqual(["Type:OrdersComponent"]);
    expect(edges("lazy-angular:/orders").find((e) => e.type === "LOADS_COMPONENT")).toMatchObject({ via: "named-export", evidence: "COMPILER_RESOLVED" });
    expect(edges("lazy-angular:/orders").some((e) => e.type === "LOADS_MODULE" && e.targetName === "orders.component.ts")).toBe(true);
    expect(unresolved("lazy-angular:/orders")).toEqual([]);
    expect(operations("lazy-angular:/orders")).toEqual(["GET /api/orders"]);
  });

  test("default export via `m => m.default` and via bare import()", () => {
    expect(components("lazy-angular:/reports")).toEqual(["Type:ReportsComponent"]);
    expect(operations("lazy-angular:/reports")).toEqual(["GET /api/reports"]);
    expect(components("lazy-angular:/profile")).toEqual(["Type:ProfileComponent"]);
    expect(edges("lazy-angular:/profile").find((e) => e.type === "LOADS_COMPONENT")?.via).toBe("default-export");
    expect(operations("lazy-angular:/profile")).toEqual(["GET /api/profile"]);
  });

  test("aliased named export (`export { A as B }`) in a multi-line arrow resolves to the declaration", () => {
    expect(components("lazy-angular:/settings")).toEqual(["Type:SettingsComponent"]);
    expect(operations("lazy-angular:/settings")).toEqual(["GET /api/settings"]);
  });

  test("async arrow with `(await import(...)).X` resolves", () => {
    expect(components("lazy-angular:/catalog")).toEqual(["Type:CatalogComponent"]);
    expect(operations("lazy-angular:/catalog")).toEqual(["GET /api/catalog"]);
  });

  test("loadChildren with a named routes export and with a default export walk the child routes", () => {
    expect(components("lazy-angular:/admin/users")).toEqual(["Type:UsersComponent"]);
    expect(operations("lazy-angular:/admin/users")).toEqual(["GET /api/admin/users"]);
    expect(components("lazy-angular:/legacy/users")).toEqual(["Type:UsersComponent"]);
    expect(db.query<{ n: number }, [string, string]>("select count(*) as n from relationships where type = 'CONTAINS' and source_id = ? and target_id = ?").get(routeId("lazy-angular:/admin"), routeId("lazy-angular:/admin/users"))?.n).toBe(1);
  });

  test("non-literal import() and element-access selection stay unresolved, never guessed", () => {
    expect(components("lazy-angular:/dynamic")).toEqual([]);
    expect(edges("lazy-angular:/dynamic")).toEqual([]);
    expect(unresolved("lazy-angular:/dynamic")).toMatchObject([{ type: "LOADS_COMPONENT", reason: expect.stringContaining("not a static import()") }]);
    expect(components("lazy-angular:/lookup")).toEqual([]);
    expect(edges("lazy-angular:/lookup").map((e) => e.type)).toEqual(["LOADS_MODULE"]);
    expect(unresolved("lazy-angular:/lookup")).toMatchObject([{ type: "LOADS_COMPONENT", reason: expect.stringContaining("unsupported expression") }]);
  });
});

describe("React lazy routes (C-03/C-04)", () => {
  test("`lazy(() => import('./Page'))` with `element: <Page/>` routes to the default-exported component, not the wrapper", () => {
    expect(components("lazy-react:/orders")).toEqual(["Method:OrdersPage"]);
    expect(edges("lazy-react:/orders")).toMatchObject([{ type: "LOADS_MODULE", targetKind: "File", targetName: "OrdersPage.tsx", via: "react-lazy" }, { type: "ROUTES_TO_COMPONENT", targetKind: "Method", via: "react-lazy", evidence: "COMPILER_RESOLVED" }]);
    expect(db.query<{ file: string }, [string]>("select t.file as file from relationships r join entities t on t.id = r.target_id where r.source_id = ? and r.type = 'ROUTES_TO_COMPONENT'").get(routeId("lazy-react:/orders"))?.file).toContain("pages/OrdersPage.tsx");
    expect(operations("lazy-react:/orders")).toEqual(["GET /api/orders"]);
  });

  test("`React.lazy(() => import('./x').then(m => ({ default: m.X })))` resolves the named export", () => {
    expect(components("lazy-react:/reports")).toEqual(["Method:ReportsPage"]);
    expect(operations("lazy-react:/reports")).toEqual(["GET /api/reports"]);
  });

  test("`Component: Page`, parenthesized elements, async loaders and JSX <Route element> all resolve", () => {
    expect(components("lazy-react:/profile")).toEqual(["Method:ProfilePage"]);
    expect(operations("lazy-react:/profile")).toEqual(["GET /api/profile"]);
    expect(components("lazy-react:/settings")).toEqual(["Method:SettingsPage"]);
    expect(operations("lazy-react:/settings")).toEqual(["GET /api/settings"]);
    expect(components("lazy-react:/jsx/catalog")).toEqual(["Method:CatalogPage"]);
    expect(operations("lazy-react:/jsx/catalog")).toEqual(["GET /api/catalog"]);
  });

  test("wrapper route <Protected><Page/></Protected> links the wrapper and the wrapped page (C-04)", () => {
    expect(components("lazy-react:/users")).toEqual(["Method:Protected", "Method:UsersPage"]);
    expect(operations("lazy-react:/users")).toEqual(["GET /api/admin/users"]);
  });

  test("a lazy loader with a non-literal import() is unresolved and gets no component edge", () => {
    expect(edges("lazy-react:/dynamic")).toEqual([]);
    expect(unresolved("lazy-react:/dynamic")).toMatchObject([{ type: "ROUTES_TO_COMPONENT", reason: expect.stringContaining("not a static import()") }]);
  });

  test("eager routes keep their direct component edges", () => {
    expect(components("lazy-angular:/legacy/users")).toEqual(["Type:UsersComponent"]);
  });
});
