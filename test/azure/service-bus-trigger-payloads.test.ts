import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeFixture, rows } from "./analyze-helper.ts";

const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(homedir(), ".capy/work/dotnet/dotnet")].find((p): p is string => !!p && existsSync(p));
const packages = process.env.NUGET_PACKAGES ?? join(homedir(), ".nuget/packages");
const available = !!dotnet && ["microsoft.azure.functions.worker/2.52.0", "microsoft.azure.functions.worker.extensions.servicebus/5.24.0", "newtonsoft.json/13.0.4"].every((p) => existsSync(join(packages, p)));

describe.skipIf(!available)("Service Bus trigger parameter deserialization", () => {
  const fx = available ? analyzeFixture("service-bus-trigger-payloads", (dir) => {
    const restore = Bun.spawnSync([dotnet!, "restore", "--source", packages, "--ignore-failed-sources", "--nologo", "-v", "q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (restore.exitCode !== 0) throw new Error(restore.stdout.toString() + restore.stderr.toString());
  }, { VOGOBAN_DOTNET: dotnet! }) : null;
  afterAll(() => fx?.cleanup());

  test("bound Newtonsoft and System.Text.Json deserializers consume the concrete trigger contract", () => {
    const edges = rows(fx!.db, "SELECT s.qualified_name AS source,t.qualified_name AS target,r.evidence FROM relationships r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id WHERE r.type='CONSUMED_BY'");
    for (const method of ["Direct", "Alias", "SystemJson"]) expect(edges.some((e) => e.source === "TriggerEvidence.OrderCreated" && String(e.target).startsWith(`TriggerEvidence.Functions.${method}(`) && e.evidence === "COMPILER_RESOLVED")).toBe(true);
    expect(rows(fx!.db, "SELECT qualified_name FROM entities WHERE kind='Message' ORDER BY qualified_name").map((e) => e.qualified_name)).toEqual(["TriggerEvidence.OrderCreated"]);
  });

  test("CARRIES uses the exact leaf that triggers each proven function", () => {
    for (const name of ["Direct", "Alias", "SystemJson"]) {
      const trigger = rows(fx!.db, "SELECT r.source_id FROM relationships r JOIN entities f ON f.id=r.target_id WHERE r.type='TRIGGERS' AND f.kind='AzureFunction' AND f.name=?", name);
      expect(trigger).toHaveLength(1);
      const carries = rows(fx!.db, "SELECT m.qualified_name FROM relationships r JOIN entities m ON m.id=r.target_id WHERE r.type='CARRIES' AND r.source_id=?", String(trigger[0]!.source_id));
      expect(carries.map((e) => e.qualified_name)).toContain("TriggerEvidence.OrderCreated");
    }
  });

  test("unrelated, overwritten and nested parameters, arbitrary serializers and non-functions do not consume a trigger contract", () => {
    const edges = rows(fx!.db, "SELECT t.qualified_name AS target FROM relationships r JOIN entities t ON t.id=r.target_id WHERE r.type='CONSUMED_BY'");
    for (const method of ["UnrelatedParameter", "ReassignedAlias", "ReassignedParameter", "NestedParameter", "ArbitrarySerializer", "NotAFunction"]) expect(edges.some((e) => String(e.target).startsWith(`TriggerEvidence.Functions.${method}(`))).toBe(false);
  });
});
