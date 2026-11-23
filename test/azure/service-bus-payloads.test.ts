import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyzeFixture, rows } from "./analyze-helper.ts";
import { payloadType } from "../../src/dotnet/frameworks/messaging/azure-service-bus.ts";

const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(homedir(), ".capy/work/dotnet/dotnet")].find((p): p is string => !!p && existsSync(p));
const packages = process.env.NUGET_PACKAGES ?? join(homedir(), ".nuget/packages");
const available = !!dotnet && existsSync(join(packages, "azure.messaging.servicebus/7.18.2"));

test("payload extraction rejects arbitrary type and serializer name guesses", () => {
  const type = { key: "event", qualifiedName: "Evidence.OrderCreated", display: "OrderCreated", kind: "Record", external: false };
  expect(payloadType({ kind: "expression", type })).toBeNull();
  expect(payloadType({ kind: "invocation", symbol: { ...type, qualifiedName: "Fake.Serialize<T>(T)" }, items: [{ kind: "expression", type }] })).toBeNull();
  const serializer = { ...type, kind: "Method", qualifiedName: "System.Text.Json.JsonSerializer.Serialize<T>(T)", containingType: { ...type, qualifiedName: "System.Text.Json.JsonSerializer" } };
  expect(payloadType({ kind: "invocation", symbol: serializer, items: [{ kind: "expression", type: { ...type, kind: "Unknown" } }] })).toBeNull();
});

describe.skipIf(!available)("compiler-proven Service Bus payload flow", () => {
  const fx = available ? analyzeFixture("service-bus-payloads", (dir) => {
    const restored = Bun.spawnSync([dotnet!, "restore", "--source", packages, "--ignore-failed-sources", "--nologo", "-v", "q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (restored.exitCode !== 0) throw new Error(restored.stdout.toString() + restored.stderr.toString());
  }, { VOGOBAN_DOTNET: dotnet! }) : null;
  afterAll(() => fx?.cleanup());
  const edges = (type: string) => rows(fx!.db, "SELECT s.qualified_name AS source, t.qualified_name AS target FROM relationships r JOIN entities s ON s.id=r.source_id JOIN entities t ON t.id=r.target_id WHERE r.type=?", type);

  test("local message + BinaryData.FromString + generic serializer binds concrete helper call types", () => {
    expect(rows(fx!.db, "SELECT qualified_name FROM entities WHERE kind='Message' ORDER BY qualified_name").map((r) => r.qualified_name)).toEqual(["Evidence.OrderCreated", "Evidence.OrderUpdated"]);
    for (const [method, contract] of [["Created", "OrderCreated"], ["Updated", "OrderUpdated"]]) {
      expect(edges("PUBLISHES").some((e) => String(e.source).startsWith(`Evidence.Publisher.${method}(`) && e.target === `Evidence.${contract}`)).toBe(true);
      expect(edges("CARRIES").some((e) => e.source === "azure-service-bus:queue-or-topic:orders" && e.target === `Evidence.${contract}`)).toBe(true);
    }
  });

  test("SDK body deserialization attaches the concrete contract to the registered handler", () => {
    expect(edges("CONSUMED_BY").some((e) => e.source === "Evidence.OrderCreated" && String(e.target).startsWith("Evidence.Consumer.Handle("))).toBe(true);
    expect(edges("CONSUMED_BY").some((e) => String(e.target).includes("NotServiceBus"))).toBe(false);
    expect(edges("ROUTES_TO").some((e) => e.source === "azure-service-bus:queue-or-topic:orders" && String(e.target).startsWith("Evidence.Consumer.Handle("))).toBe(true);
  });

  test("unknown, overwritten and mutated message locals do not acquire contract edges", () => {
    for (const method of ["Unknown", "Reassigned", "Mutated", "FakeSerializer"]) expect(edges("PUBLISHES").some((e) => String(e.source).startsWith(`Evidence.Publisher.${method}(`))).toBe(false);
  });

  test("competing sender assignments preserve the contract but reject a guessed transport", () => {
    expect(edges("PUBLISHES").some((e) => String(e.source).startsWith("Evidence.AmbiguousPublisher.Send(") && e.target === "Evidence.OrderUpdated")).toBe(true);
    expect(edges("SENDS_TO").some((e) => String(e.source).startsWith("Evidence.AmbiguousPublisher.Send("))).toBe(false);
  });

  test("declared options config resolves constructor sender and consumer field aliases", () => {
    expect(edges("SENDS_TO").some((e) => String(e.source).startsWith("Evidence.ConfiguredPublisher.Send(") && e.target === "azure-service-bus:queue-or-topic:configured-orders")).toBe(true);
    expect(edges("SENDS_TO").some((e) => String(e.source).startsWith("Evidence.OptionsLocals.FromLocal(") && e.target === "azure-service-bus:queue-or-topic:configured-orders")).toBe(true);
    expect(edges("ROUTES_TO").some((e) => e.source === "azure-service-bus:queue-or-topic:configured-orders" && String(e.target).startsWith("Evidence.ConfiguredConsumer.Handle("))).toBe(true);
    expect(edges("CARRIES").some((e) => e.source === "azure-service-bus:queue-or-topic:configured-orders" && e.target === "Evidence.OrderCreated")).toBe(true);
  });

  test("ambiguous options aliases and unrelated instances do not inherit a declared binding", () => {
    for (const method of ["Evidence.AmbiguousOptions.Send(", "Evidence.OptionsLocals.UnrelatedInstance("]) {
      expect(edges("PUBLISHES").some((e) => String(e.source).startsWith(method) && e.target === "Evidence.OrderCreated")).toBe(true);
      expect(edges("SENDS_TO").some((e) => String(e.source).startsWith(method))).toBe(false);
    }
    expect(rows(fx!.db, "SELECT name FROM entities WHERE kind IN ('Queue','Topic')").some((e) => String(e.name).startsWith("not-declared"))).toBe(false);
  });
});
