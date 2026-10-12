import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { isArmTemplate, parseArm } from "../../../src/azure/iac/arm.ts";
import { IAC_LIMITS, type IacExpr, type IacFileFacts } from "../../../src/azure/iac/model.ts";

const SCHEMA = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#";
const PARAMS_SCHEMA = "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#";
const ok = (text: string, file = "arm/template.json"): IacFileFacts => {
  const facts = parseArm(file, text);
  expect(facts.errors).toEqual([]);
  return facts;
};
const template = (body: object) => ok(JSON.stringify({ $schema: SCHEMA, contentVersion: "1.0.0.0", ...body }, null, 2));
const value = (expr: unknown): IacExpr => template({ variables: { v: expr } }).variables[0]!.value;
const ref = (kind: string, name: string, path: string[] = []) => ({ kind: "reference", target: { kind, name }, path });
const str = (v: string) => ({ kind: "string", value: v });

describe("arm detection and header", () => {
  test("isArmTemplate", () => {
    expect(isArmTemplate(`{ "$schema": "${SCHEMA}" }`)).toBe("template");
    expect(isArmTemplate(`{"$schema":"https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#"}`)).toBe("template");
    expect(isArmTemplate(`{ "$schema" : "${PARAMS_SCHEMA}" }`)).toBe("parameters");
    expect(isArmTemplate(`{ "$schema": "https://json.schemastore.org/package.json" }`)).toBeNull();
    expect(isArmTemplate(`{ "name": "x" }`)).toBeNull();
    expect(isArmTemplate("not json at all")).toBeNull();
  });

  test("target scope from $schema and generator", () => {
    const scope = (s: string) => ok(`{"$schema": "https://schema.management.azure.com/schemas/2019-08-01/${s}.json#"}`).targetScope;
    expect(scope("deploymentTemplate")).toBe("resourceGroup");
    expect(scope("subscriptionDeploymentTemplate")).toBe("subscription");
    expect(scope("managementGroupDeploymentTemplate")).toBe("managementGroup");
    expect(scope("tenantDeploymentTemplate")).toBe("tenant");
    const facts = template({ metadata: { _generator: { name: "bicep", version: "0.38" } } });
    expect(facts).toMatchObject({ language: "arm", fileKind: "template", generatedBy: "bicep", usingTemplate: null, file: "arm/template.json" });
    expect(template({}).generatedBy).toBeNull();
  });

  test("comments and trailing commas, respecting strings", () => {
    const facts = ok(`// leading comment
{
  /* block
     comment */
  "$schema": "${SCHEMA}",
  "variables": {
    "url": "https://example.com/*not-a-comment*/", // trailing
    "list": [1, 2, 3,],
    "quote": "say \\"hi\\" // still string",
  },
}`);
    expect(facts.variables.map((v) => [v.name, v.value])).toEqual([
      ["url", str("https://example.com/*not-a-comment*/")],
      ["list", { kind: "array", items: [1, 2, 3].map((n) => ({ kind: "number", value: n })) }],
      ["quote", str('say "hi" // still string')],
    ]);
    expect(facts.variables[0]!.location).toEqual({ line: 7, column: 5, endLine: 7, endColumn: 50 });
  });
});

describe("arm declarations", () => {
  test("parameters", () => {
    const facts = template({
      parameters: {
        name: { type: "string", defaultValue: "[resourceGroup().name]", metadata: { description: "The name" } },
        sku: { type: "string", allowedValues: ["S1", "P1"], defaultValue: "S1" },
        password: { type: "securestring", defaultValue: "do-not-keep" },
        conn: { type: "secureObject" },
        count: { type: "int", defaultValue: 2 },
      },
    });
    expect(facts.parameters.map((p) => [p.name, p.type, p.secure, p.defaultValue, p.description])).toEqual([
      ["name", "string", false, { kind: "call", name: "resourceGroup", args: [], path: ["name"] }, "The name"],
      ["sku", "string", false, str("S1"), null],
      ["password", "securestring", true, null, null],
      ["conn", "secureObject", true, null, null],
      ["count", "int", false, { kind: "number", value: 2 }, null],
    ]);
    expect(facts.parameters[1]!.allowed).toEqual([str("S1"), str("P1")]);
    expect(facts.parameters[0]!.location.line).toBe(5);
  });

  test("variables including copy variables", () => {
    const facts = template({
      variables: {
        prefix: "[toLower(parameters('name'))]",
        copy: [{ name: "disks", count: 3, input: { name: "[concat('disk', copyIndex('disks'))]" } }],
      },
    });
    expect(facts.variables[0]).toMatchObject({ name: "prefix", value: { kind: "call", name: "toLower", args: [ref("parameter", "name")] } });
    expect(facts.variables[1]).toMatchObject({ name: "disks", value: { kind: "unknown", references: [{ target: { kind: "loop", name: "disks" }, path: [] }] } });
    expect((facts.variables[1]!.value as { text: string }).text).toContain('"count": 3');
  });

  test("resources, nested children, condition, copy, dependsOn, existing", () => {
    const facts = template({
      resources: [
        {
          type: "Microsoft.ServiceBus/namespaces",
          apiVersion: "2021-11-01",
          name: "[parameters('ns')]",
          condition: "[parameters('deploy')]",
          resources: [
            { type: "topics", apiVersion: "2021-11-01", name: "orders", dependsOn: ["[resourceId('Microsoft.ServiceBus/namespaces', parameters('ns'))]"], resources: [{ type: "subscriptions", apiVersion: "2021-11-01", name: "all" }] },
            { type: "Microsoft.ServiceBus/namespaces/queues", apiVersion: "2021-11-01", name: "[concat(parameters('ns'), '/q')]" },
          ],
        },
        { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "[concat('st', copyIndex())]", copy: { name: "stLoop", count: "[length(variables('names'))]" }, dependsOn: ["ns1", "[variables('x')]"] },
        { type: "Microsoft.KeyVault/vaults", apiVersion: "2023-07-01", name: "kv", existing: true },
      ],
    });
    expect(facts.resources.map((r) => [r.symbol, r.type, r.parent])).toEqual([
      ["/resources/0", "Microsoft.ServiceBus/namespaces", null],
      ["/resources/0/resources/0", "Microsoft.ServiceBus/namespaces/topics", "/resources/0"],
      ["/resources/0/resources/0/resources/0", "Microsoft.ServiceBus/namespaces/topics/subscriptions", "/resources/0/resources/0"],
      ["/resources/0/resources/1", "Microsoft.ServiceBus/namespaces/queues", "/resources/0"],
      ["/resources/1", "Microsoft.Storage/storageAccounts", null],
      ["/resources/2", "Microsoft.KeyVault/vaults", null],
    ]);
    const [ns, topic, , queue, st, kv] = facts.resources;
    expect(ns!.condition).toEqual(ref("parameter", "deploy"));
    expect(ns!.body.kind === "object" && ns!.body.entries.map((e) => e.key)).toEqual(["type", "apiVersion", "name", "condition"]);
    expect(topic!.dependsOn).toEqual(["[resourceId('Microsoft.ServiceBus/namespaces', parameters('ns'))]"]);
    expect(queue!.name).toEqual({ kind: "interpolation", parts: [ref("parameter", "ns"), "/q"] });
    expect(st).toMatchObject({ loop: true, loopSource: { kind: "call", name: "length", args: [ref("variable", "names")] }, dependsOn: ["ns1", "[variables('x')]"] });
    expect(st!.name).toEqual({ kind: "interpolation", parts: ["st", ref("loop", "copyIndex")] });
    expect(kv).toMatchObject({ existing: true, condition: null, loop: false, loopSource: null, apiVersion: "2023-07-01" });
    expect(ns!.location).toMatchObject({ line: 5, column: 5 });
  });

  test("symbolic-name resources (languageVersion 2.0)", () => {
    const facts = template({ languageVersion: "2.0", resources: { "my/sa~1": { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "sa", dependsOn: ["other"] } } });
    expect(facts.resources[0]).toMatchObject({ symbol: "/resources/my~1sa~01", dependsOn: ["other"] });
  });

  test("inline nested deployments become modules and inner resources are parsed", () => {
    const facts = template({
      resources: [
        {
          type: "Microsoft.Resources/deployments",
          apiVersion: "2022-09-01",
          name: "inner",
          condition: "[parameters('on')]",
          dependsOn: ["[resourceId('Microsoft.Web/sites', 'x')]"],
          properties: {
            mode: "Incremental",
            parameters: {
              name: { value: "[parameters('name')]" },
              secret: { reference: { keyVault: { id: "/subscriptions/x/vaults/kv" }, secretName: "s" } },
              computed: "[if(parameters('on'), createObject('value', 1), createObject('value', 2))]",
            },
            template: {
              $schema: SCHEMA,
              parameters: { name: { type: "string" } },
              resources: [{ type: "Microsoft.Web/sites", apiVersion: "2022-03-01", name: "[parameters('name')]", resources: [{ type: "config", apiVersion: "2022-03-01", name: "web" }] }],
            },
          },
        },
        { type: "Microsoft.Resources/deployments", apiVersion: "2022-09-01", name: "linked", copy: { name: "l", count: 2 }, properties: { templateLink: { uri: "[uri(deployment().properties.templateLink.uri, 'nested.json')]" }, parameters: {} } },
        { type: "Microsoft.Resources/deployments", apiVersion: "2022-09-01", name: "spec", properties: { templateLink: { id: "[resourceId('Microsoft.Resources/templateSpecs/versions', 'spec', '1.0')]" } } },
      ],
    });
    const [inner, linked, spec] = facts.modules;
    expect(inner).toMatchObject({ symbol: "/resources/0", source: "inline:/resources/0/properties/template", localPath: null, name: null, scope: null, loop: false, dependsOn: ["[resourceId('Microsoft.Web/sites', 'x')]"], condition: ref("parameter", "on") });
    expect(inner!.params.kind === "object" && inner!.params.entries.map((e) => [e.key, e.value])).toEqual([
      ["name", ref("parameter", "name")],
      ["secret", { kind: "unknown", text: "keyvault-reference", references: [] }],
      ["computed", { kind: "unknown", text: "[if(parameters('on'), createObject('value', 1), createObject('value', 2))]", references: [{ target: { kind: "parameter", name: "on" }, path: [] }] }],
    ]);
    expect(linked).toMatchObject({ source: "[uri(deployment().properties.templateLink.uri, 'nested.json')]", loop: true, params: { kind: "object", entries: [] } });
    expect(spec!.source).toBe("[resourceId('Microsoft.Resources/templateSpecs/versions', 'spec', '1.0')]");
    expect(facts.resources.map((r) => [r.symbol, r.type, r.parent])).toEqual([
      ["/resources/0/properties/template/resources/0", "Microsoft.Web/sites", null],
      ["/resources/0/properties/template/resources/0/resources/0", "Microsoft.Web/sites/config", "/resources/0/properties/template/resources/0"],
    ]);
    expect(facts.parameters).toEqual([]);
  });

  test("outputs", () => {
    const facts = template({
      outputs: {
        id: { type: "string", value: "[resourceId('Microsoft.Web/sites', parameters('name'))]" },
        key: { type: "securestring", value: "[listKeys(variables('id'), '2019-06-01').keys[0].value]" },
        many: { type: "array", copy: { count: 2, input: "[copyIndex()]" } },
      },
    });
    expect(facts.outputs.map((o) => [o.name, o.type, o.secure])).toEqual([
      ["id", "string", false],
      ["key", "securestring", true],
      ["many", "array", false],
    ]);
    expect(facts.outputs[1]!.value).toEqual({ kind: "call", name: "listKeys", args: [ref("variable", "id"), str("2019-06-01")], path: ["keys", "0", "value"] });
    expect(facts.outputs[2]!.value).toMatchObject({ kind: "unknown", references: [{ target: { kind: "loop", name: "copyIndex" } }] });
  });

  test("parameters files keep literal values", () => {
    const facts = ok(
      JSON.stringify({
        $schema: PARAMS_SCHEMA,
        contentVersion: "1.0.0.0",
        parameters: {
          env: { value: "${AZURE_ENV_NAME}" },
          expr: { value: "[not-evaluated()]" },
          obj: { value: { a: [1, true, null] } },
          secret: { reference: { keyVault: { id: "/subscriptions/x" }, secretName: "pw" } },
          empty: {},
        },
      }),
      "arm/parameters.json",
    );
    expect(facts.fileKind).toBe("parameters");
    expect(facts.targetScope).toBeNull();
    expect(facts.parameters.map((p) => [p.name, p.defaultValue])).toEqual([
      ["env", str("${AZURE_ENV_NAME}")],
      ["expr", str("[not-evaluated()]")],
      ["obj", { kind: "object", entries: [{ key: "a", value: { kind: "array", items: [{ kind: "number", value: 1 }, { kind: "bool", value: true }, { kind: "null" }] }, location: { line: 1, column: 226, endLine: 1, endColumn: 243 } }] }],
      ["secret", { kind: "unknown", text: "keyvault-reference", references: [] }],
      ["empty", null],
    ]);
  });
});

describe("arm expressions", () => {
  test("references, literals and escapes", () => {
    expect(value("[parameters('a')]")).toEqual(ref("parameter", "a"));
    expect(value("[variables('cfg').endpoints[0]['primary']]")).toEqual(ref("variable", "cfg", ["endpoints", "0", "primary"]));
    expect(value("[parameters('list')[copyIndex()]]")).toEqual(ref("parameter", "list", ["*"]));
    expect(value("[[not an expression]")).toEqual(str("[not an expression]"));
    expect(value("[not closed")).toEqual(str("[not closed"));
    expect(value("plain")).toEqual(str("plain"));
    expect(value("['it''s']")).toEqual(str("it's"));
    expect(value("[-1.5]")).toEqual({ kind: "number", value: -1.5 });
    expect(value("[true]")).toEqual({ kind: "bool", value: true });
    expect(value("[null()]")).toEqual({ kind: "null" });
    expect(value("[ copyIndex() ]")).toEqual(ref("loop", "copyIndex"));
    expect(value("[copyIndex('vms')]")).toEqual(ref("loop", "vms"));
    expect(value("[copyIndex(1)]")).toEqual({ kind: "call", name: "copyIndex", args: [{ kind: "number", value: 1 }] });
  });

  test("concat and format", () => {
    expect(value("[concat('a', parameters('b'), 'c', 'd')]")).toEqual({ kind: "interpolation", parts: ["a", ref("parameter", "b"), "cd"] });
    expect(value("[concat('a', 'b')]")).toEqual(str("ab"));
    expect(value("[concat(parameters('x'), variables('y'))]")).toEqual({ kind: "call", name: "concat", args: [ref("parameter", "x"), ref("variable", "y")] });
    expect(value("[concat('x-', concat(parameters('a'), '-y'))]")).toEqual({ kind: "interpolation", parts: ["x-", ref("parameter", "a"), "-y"] });
    expect(value("[format('{0}-{1}{{x}}', parameters('a'), uniqueString(resourceGroup().id))]")).toEqual({
      kind: "interpolation",
      parts: [ref("parameter", "a"), "-", { kind: "call", name: "uniqueString", args: [{ kind: "call", name: "resourceGroup", args: [], path: ["id"] }] }, "{x}"],
    });
    expect(value("[format('{0:D2}', 1)]")).toMatchObject({ kind: "call", name: "format" });
    expect(value("[format('{3}', 1)]")).toMatchObject({ kind: "call", name: "format" });
    expect(value("[format(variables('f'), 1)]")).toMatchObject({ kind: "call", name: "format" });
  });

  test("calls, member access and user functions", () => {
    expect(value("[reference(resourceId('Microsoft.Web/sites', 'x'), '2022-03-01').defaultHostName]")).toEqual({
      kind: "call",
      name: "reference",
      args: [{ kind: "call", name: "resourceId", args: [str("Microsoft.Web/sites"), str("x")] }, str("2022-03-01")],
      path: ["defaultHostName"],
    });
    expect(value("[contoso.uniqueName(parameters('p'))]")).toEqual({ kind: "call", name: "contoso.uniqueName", args: [ref("parameter", "p")] });
    expect(value("[if(equals(parameters('a'), 'x'), 1, 2)]")).toMatchObject({ kind: "call", name: "if" });
    expect(value("[createArray(1, 2)[0]]")).toEqual({ kind: "call", name: "createArray", args: [{ kind: "number", value: 1 }, { kind: "number", value: 2 }], path: ["0"] });
    expect(value("[concat('a', parameters('b')).length]")).toEqual({ kind: "unknown", text: "concat('a', parameters('b')).length", references: [{ target: { kind: "parameter", name: "b" }, path: [] }] });
  });

  test("invalid expressions become unknown with an error", () => {
    const facts = parseArm("t.json", `{"$schema": "${SCHEMA}",\n "variables": { "bad": "[concat('a',)", "worse": "[foo(]", "str": "['open]" }}`);
    expect(facts.variables[0]!.value).toEqual(str("[concat('a',)"));
    expect(facts.variables[1]!.value).toEqual({ kind: "unknown", text: "[foo(]", references: [] });
    expect(facts.variables[2]!.value).toEqual({ kind: "unknown", text: "['open]", references: [] });
    expect(facts.errors.map((e) => [e.line, e.column])).toEqual([[2, 50], [2, 67]]);
  });
});

describe("arm robustness", () => {
  test("invalid JSON reports a position and never throws", () => {
    expect(parseArm("x.json", '{\n  "a": tru\n}').errors).toEqual([{ message: "unexpected character 't'", line: 2, column: 8 }]);
    expect(parseArm("x.json", '{ "a": "unterminated }').errors[0]).toMatchObject({ message: "unterminated string" });
    expect(parseArm("x.json", '{ "a": 1 } /* open').errors[0]).toMatchObject({ message: "unterminated comment" });
    expect(parseArm("x.json", "").errors[0]).toMatchObject({ message: "unexpected end of input" });
    expect(parseArm("x.json", "[1, 2]").errors[0]).toMatchObject({ message: "ARM file must be a JSON object" });
    expect(parseArm("x.json", '{"a": 1} trailing').errors[0]).toMatchObject({ message: "unexpected content after JSON value" });
    expect(parseArm("x.json", '{"resources": [{"name": "x"}]}').errors[0]).toMatchObject({ message: "resource without a string 'type'" });
  });

  test("files larger than the limit are rejected", () => {
    const facts = parseArm("big.json", `{"$schema": "${SCHEMA}", "x": "${"a".repeat(IAC_LIMITS.maxBytes)}"}`);
    expect(facts.errors).toEqual([{ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 }]);
  });

  test("deep JSON and deep expressions become unknown without overflowing", () => {
    const depth = 200_000;
    const deepJson = parseArm("d.json", `{"$schema": "${SCHEMA}", "variables": {"v": ${"[".repeat(depth)}"[parameters('p')]"${"]".repeat(depth)}}}`);
    expect(deepJson.errors).toEqual([]);
    expect(JSON.stringify(deepJson.variables[0]!.value)).toContain('"kind":"unknown"');
    expect(JSON.stringify(deepJson.variables[0]!.value)).toContain('"name":"p"');
    const deepExpr = parseArm("e.json", JSON.stringify({ $schema: SCHEMA, variables: { v: `[${"concat(".repeat(depth)}parameters('p')${")".repeat(depth)}]` } }));
    expect(deepExpr.errors).toEqual([]);
    expect(JSON.stringify(deepExpr.variables[0]!.value)).toContain('"kind":"unknown"');
    const wide = parseArm("w.json", JSON.stringify({ $schema: SCHEMA, variables: { copy: [{ name: "w", count: 1, input: Array.from({ length: 150_000 }, () => "[parameters('p')]") }] } }));
    expect(wide.variables[0]!.value).toMatchObject({ kind: "unknown", references: [{ target: { kind: "parameter", name: "p" }, path: [] }] });
    const unbalanced = parseArm("u.json", `{"a": ${"{\"b\": ".repeat(depth)}`);
    expect(unbalanced.errors.length).toBe(1);
  });

  test("random input never throws and is deterministic", () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['{"$schema": "deploymentTemplate.json"', '"resources"', '"type"', '"[concat(', "'", ")]", '"', ":", ",", "{", "}", "[", "]", "//", "/*", "*/", "\n", "1", "true", '"name"', "\\"];
    for (let n = 0; n < 300; n++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
      const a = JSON.stringify(parseArm("r.json", text));
      expect(JSON.stringify(parseArm("r.json", text))).toBe(a);
    }
  });
});

const REPOS = join(homedir(), ".capy/work/repos");

describe.skipIf(!existsSync(REPOS))("arm corpus", () => {
  const files = (existsSync(REPOS) ? [...new Glob("**/*.json").scanSync({ cwd: REPOS })] : []).filter((f) => !f.includes("node_modules")).sort();

  test("every ARM template and parameters file parses without errors", async () => {
    const failures: string[] = [];
    let parsed = 0;
    for (const file of files) {
      const text = await Bun.file(join(REPOS, file)).text();
      const kind = isArmTemplate(text);
      if (!kind) continue;
      parsed++;
      const facts = parseArm(file, text);
      expect(facts.fileKind).toBe(kind);
      for (const e of facts.errors) failures.push(`${file}:${e.line}:${e.column} ${e.message}`);
      expect(JSON.stringify(parseArm(file, text))).toBe(JSON.stringify(facts));
    }
    expect(parsed).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  test("serverless reference architecture template.json", async () => {
    const file = "serverless-microservices-reference-architecture/arm/template.json";
    if (!files.includes(file)) return;
    const facts = parseArm(file, await Bun.file(join(REPOS, file)).text());
    expect(facts.targetScope).toBe("resourceGroup");
    expect(facts.generatedBy).toBeNull();
    expect(facts.resources.length).toBeGreaterThan(20);
    expect(facts.resources[0]).toMatchObject({ symbol: "/resources/0", type: "Microsoft.DocumentDB/databaseAccounts", name: ref("parameter", "databaseAccounts_ridesharedb_name") });
    expect(facts.resources.every((r) => r.location.line > 1)).toBe(true);
  });

  test("bicep-generated service bus main.json", async () => {
    const file = "functions-quickstart-dotnet-azd-service-bus/infra/main.json";
    if (!files.includes(file)) return;
    const facts = parseArm(file, await Bun.file(join(REPOS, file)).text());
    expect(facts).toMatchObject({ targetScope: "subscription", generatedBy: "bicep", fileKind: "template" });
    expect(facts.resources[0]).toMatchObject({ symbol: "/resources/0", type: "Microsoft.Resources/resourceGroups", name: { kind: "call", name: "if" } });
    const processor = facts.modules.find((m) => m.symbol === "/resources/2")!;
    expect(processor.source).toBe("inline:/resources/2/properties/template");
    expect(facts.resources.some((r) => r.symbol.startsWith("/resources/2/properties/template/resources/"))).toBe(true);
    expect(facts.parameters.find((p) => p.name === "environmentName")).toMatchObject({ type: "string", secure: false });
  });

  test("bicep-generated languageVersion 2.0 main.json", async () => {
    const file = "functions-e2e-sb-vnet/infra/main.json";
    if (!files.includes(file)) return;
    const facts = parseArm(file, await Bun.file(join(REPOS, file)).text());
    expect(facts.resources.find((r) => r.symbol === "/resources/rg")).toMatchObject({ type: "Microsoft.Resources/resourceGroups" });
    const monitoring = facts.modules.find((m) => m.symbol === "/resources/monitoring")!;
    expect(monitoring.source).toBe("inline:/resources/monitoring/properties/template");
    expect(facts.resources.some((r) => r.symbol.startsWith("/resources/monitoring/properties/template/resources/"))).toBe(true);
  });
});
