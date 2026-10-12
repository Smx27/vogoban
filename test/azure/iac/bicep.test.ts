import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { parseBicep, repoPath } from "../../../src/azure/iac/bicep.ts";
import { IAC_LIMITS, type IacExpr, type IacFileFacts } from "../../../src/azure/iac/model.ts";

const parse = (text: string, file = "infra/main.bicep") => parseBicep(file, text);
const ok = (text: string, file?: string): IacFileFacts => {
  const facts = parse(text, file);
  expect(facts.errors).toEqual([]);
  return facts;
};
const value = (expr: string): IacExpr => ok(`param p string\nvar loopItems = []\nresource res 'A.B/c@1' = { name: 'r' }\nmodule mod './m.bicep' = { name: 'm' }\nvar v = ${expr}\n`).variables.find((v) => v.name === "v")!.value;
const ref = (kind: string, name: string, path: string[] = []) => ({ kind: "reference", target: { kind, name }, path });

describe("bicep declarations", () => {
  test("targetScope, metadata and skipped statements keep parsing", () => {
    const facts = ok(`metadata description = 'x'
targetScope = 'subscription'
import { foo, bar as baz } from './types.bicep'
import * as ns from 'br/public:avm/utl/types:0.1.0'
extension microsoftGraphV1
provider 'kubernetes@1.0.0' with {
  namespace: 'default'
}
type pair = {
  @description('first')
  a: string
  b: int?
}
type choice = 'a' | 'b'
func greet(name string) string => 'hi \${name}'
assert positive = 1 > 0
var after = 1
`);
    expect(facts.targetScope).toBe("subscription");
    expect(facts.variables.map((v) => v.name)).toEqual(["after"]);
    expect(facts.fileKind).toBe("template");
    expect(facts.language).toBe("bicep");
  });

  test("params with types, defaults and decorators", () => {
    const facts = ok(`@minLength(1)
@description('The env')
param env string
@secure()
param password string = 'not-kept'
@allowed([
  'eastus'
  'westus'
])
@sys.description('Region')
@metadata({ azd: { type: 'location' } })
param location string = resourceGroup().location
param count int = -3
param flags object?
param pair {
  a: string
  b: int
} = { a: 'x', b: 1 }
param names string[] = []
@sys.secure()
param token object
`);
    const [env, password, location, count, flags, pair, names, token] = facts.parameters;
    expect(env).toMatchObject({ name: "env", type: "string", defaultValue: null, secure: false, description: "The env", allowed: null });
    expect(env!.location).toEqual({ line: 3, column: 1, endLine: 3, endColumn: 17 });
    expect(password).toMatchObject({ name: "password", secure: true, defaultValue: null });
    expect(location).toMatchObject({ description: "Region", allowed: [{ kind: "string", value: "eastus" }, { kind: "string", value: "westus" }] });
    expect(location!.defaultValue).toEqual({ kind: "call", name: "resourceGroup", args: [], path: ["location"] });
    expect(count!.defaultValue).toEqual({ kind: "number", value: -3 });
    expect(flags!.type).toBe("object?");
    expect(pair!.type).toBe("{\n  a: string\n  b: int\n}");
    expect(pair!.defaultValue!.kind).toBe("object");
    expect(names).toMatchObject({ type: "string[]", defaultValue: { kind: "array", items: [] } });
    expect(token).toMatchObject({ secure: true, type: "object" });
  });

  test("vars, typed vars and outputs", () => {
    const facts = ok(`var a = 'x'
var b string = a
output o string = b
@secure()
output s object = { k: a }
output r resource 'A.B/c@1' = res
resource res 'A.B/c@1' = { name: 'n' }
`);
    expect(facts.variables.map((v) => [v.name, v.value])).toEqual([
      ["a", { kind: "string", value: "x" }],
      ["b", ref("variable", "a")],
    ]);
    expect(facts.outputs.map((o) => [o.name, o.type, o.secure])).toEqual([
      ["o", "string", false],
      ["s", "object", true],
      ["r", "resource 'A.B/c@1'", false],
    ]);
    expect(facts.outputs[2]!.value).toEqual(ref("resource", "res"));
  });

  test("resources: type split, existing, condition, dependsOn", () => {
    const facts = ok(`param deploy bool
resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: 'acct'
}
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = if (deploy && true) {
  name: 'kv'
  dependsOn: [
    sa
    plan
  ]
}
module plan './plan.bicep' = { name: 'plan' }
resource noVersion 'Microsoft.Foo/bars' = { name: 'b' }
`);
    const [sa, kv, noVersion] = facts.resources;
    expect(sa).toMatchObject({ symbol: "sa", type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", existing: true, condition: null, loop: false, parent: null, name: { kind: "string", value: "acct" } });
    expect(kv!.condition).toEqual({ kind: "unknown", text: "deploy && true", references: [{ target: { kind: "parameter", name: "deploy" }, path: [] }] });
    expect(kv!.dependsOn).toEqual(["sa", "plan"]);
    expect(kv!.body.kind).toBe("object");
    expect(noVersion).toMatchObject({ type: "Microsoft.Foo/bars", apiVersion: null });
  });

  test("resource loops with index, filter and loop variable classification", () => {
    const facts = ok(`param names array
resource a 'A.B/c@1' = [for name in names: {
  name: name
}]
resource b 'A.B/c@1' = [for (item, i) in names: if (i > 0) {
  name: '\${item.name}-\${i}'
}]
resource c 'A.B/c@1' = [
  for x in range(0, 2): {
    name: string(x)
  }
]
`);
    const [a, b, c] = facts.resources;
    expect(a).toMatchObject({ loop: true, loopSource: ref("parameter", "names"), condition: null });
    expect(a!.name).toEqual(ref("loop", "name"));
    expect(b!.condition).toEqual({ kind: "unknown", text: "i > 0", references: [{ target: { kind: "loop", name: "i" }, path: [] }] });
    expect(b!.name).toEqual({ kind: "interpolation", parts: [ref("loop", "item", ["name"]), "-", ref("loop", "i")] });
    expect(c!.loopSource).toEqual({ kind: "call", name: "range", args: [{ kind: "number", value: 0 }, { kind: "number", value: 2 }] });
  });

  test("nested child resources and parent property", () => {
    const facts = ok(`resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb'
  resource topic 'topics' = {
    name: 'orders'
    @batchSize(1)
    resource sub 'subscriptions@2021-11-01' = [for s in ['a', 'b']: {
      name: s
    }]
  }
  resource rule 'Microsoft.ServiceBus/namespaces/AuthorizationRules@2022-01-01' = {
    name: 'listen'
  }
}
resource queue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'q'
}
output topicId string = sb::topic.id
output subName string = sb::topic::sub[0].name
`);
    expect(facts.resources.map((r) => [r.symbol, r.type, r.apiVersion, r.parent, r.loop])).toEqual([
      ["sb", "Microsoft.ServiceBus/namespaces", "2022-10-01-preview", null, false],
      ["sb::topic", "Microsoft.ServiceBus/namespaces/topics", "2022-10-01-preview", "sb", false],
      ["sb::topic::sub", "Microsoft.ServiceBus/namespaces/topics/subscriptions", "2021-11-01", "sb::topic", true],
      ["sb::rule", "Microsoft.ServiceBus/namespaces/AuthorizationRules", "2022-01-01", "sb", false],
      ["queue", "Microsoft.ServiceBus/namespaces/queues", "2022-10-01-preview", "sb", false],
    ]);
    expect(facts.resources[0]!.body).toEqual({ kind: "object", entries: [{ key: "name", value: { kind: "string", value: "sb" }, location: { line: 2, column: 3, endLine: 2, endColumn: 13 } }] });
    expect(facts.outputs[0]!.value).toEqual(ref("resource", "sb::topic", ["id"]));
    expect(facts.outputs[1]!.value).toEqual(ref("resource", "sb::topic::sub", ["0", "name"]));
  });

  test("modules: local, registry, template spec, loops, conditions, scope", () => {
    const facts = ok(
      `param on bool
module a './app/api.bicep' = {
  name: 'api'
  scope: resourceGroup('rg')
  params: {
    x: 1
  }
  dependsOn: [ b ]
}
module b '../shared/../core/db.bicep' = if (on) {
  name: 'db'
}
module c 'br/public:avm/res/web/site:0.1.0' = [for i in range(0, 2): {
  name: 'site\${i}'
}]
module d 'br:contoso.azurecr.io/bicep/mod:v1' = { name: 'd' }
module e 'ts:00000000-0000-0000-0000-000000000000/rg/spec:1.0' = { name: 'e' }
module f '../../../outside.bicep' = { name: 'f' }
module g 'nested/x.json' = { name: 'g' }
`,
      "repo/infra/main.bicep",
    );
    expect(facts.modules.map((m) => [m.symbol, m.source, m.localPath, m.loop, m.condition !== null])).toEqual([
      ["a", "./app/api.bicep", "repo/infra/app/api.bicep", false, false],
      ["b", "../shared/../core/db.bicep", "repo/core/db.bicep", false, true],
      ["c", "br/public:avm/res/web/site:0.1.0", null, true, false],
      ["d", "br:contoso.azurecr.io/bicep/mod:v1", null, false, false],
      ["e", "ts:00000000-0000-0000-0000-000000000000/rg/spec:1.0", null, false, false],
      ["f", "../../../outside.bicep", null, false, false],
      ["g", "nested/x.json", "repo/infra/nested/x.json", false, false],
    ]);
    const [a] = facts.modules;
    expect(a!.name).toEqual({ kind: "string", value: "api" });
    expect(a!.scope).toEqual({ kind: "call", name: "resourceGroup", args: [{ kind: "string", value: "rg" }] });
    expect(a!.params).toMatchObject({ kind: "object", entries: [{ key: "x", value: { kind: "number", value: 1 } }] });
    expect(a!.dependsOn).toEqual(["b"]);
    expect(facts.modules[3]!.params).toEqual({ kind: "object", entries: [] });
  });

  test("repoPath", () => {
    expect(repoPath("main.bicep", "./a.bicep")).toBe("a.bicep");
    expect(repoPath("main.bicep", "../a.bicep")).toBeNull();
    expect(repoPath("x/main.bicep", "/abs.bicep")).toBeNull();
    expect(repoPath("x/main.bicep", "..\\a.bicep")).toBeNull();
    expect(repoPath("x/y/main.bicep", "../../z/a.bicep")).toBe("z/a.bicep");
  });
});

describe("bicep expressions", () => {
  test("literals and strings", () => {
    expect(value("'a\\'b\\\\c\\n\\t\\r\\${x}\\u{1F600}'")).toEqual({ kind: "string", value: "a'b\\c\n\t\r${x}\u{1F600}" });
    expect(value("'''\nline1\n  'quoted' \\n ${x}\n'''")).toEqual({ kind: "string", value: "line1\n  'quoted' \\n ${x}\n" });
    expect(value("42")).toEqual({ kind: "number", value: 42 });
    expect(value("-7")).toEqual({ kind: "number", value: -7 });
    expect(value("true")).toEqual({ kind: "bool", value: true });
    expect(value("false")).toEqual({ kind: "bool", value: false });
    expect(value("null")).toEqual({ kind: "null" });
    expect(value("''")).toEqual({ kind: "string", value: "" });
  });

  test("interpolation, including nested strings", () => {
    expect(value("'${p}-x-${toLower('${p}')}'")).toEqual({
      kind: "interpolation",
      parts: [ref("parameter", "p"), "-x-", { kind: "call", name: "toLower", args: [{ kind: "interpolation", parts: [ref("parameter", "p")] }] }],
    });
    expect(value("'${{ a: 1 }.a}'")).toMatchObject({ kind: "interpolation" });
  });

  test("objects and arrays with newlines, commas and quoted keys", () => {
    const e = value(`{
  'quoted-key': 1, plain: 'x'

  resource: [
    1
    2, 3
  ]
  nested: { a: true, b: [] }
}`);
    expect(e.kind).toBe("object");
    if (e.kind !== "object") return;
    expect(e.entries.map((x) => x.key)).toEqual(["quoted-key", "plain", "resource", "nested"]);
    expect(e.entries[2]!.value).toEqual({ kind: "array", items: [1, 2, 3].map((n) => ({ kind: "number", value: n })) });
    expect(e.entries[0]!.location).toEqual({ line: 6, column: 3, endLine: 6, endColumn: 18 });
    expect(value("[]")).toEqual({ kind: "array", items: [] });
    expect(value("{}")).toEqual({ kind: "object", entries: [] });
    expect(value("['a', 'b']")).toEqual({ kind: "array", items: [{ kind: "string", value: "a" }, { kind: "string", value: "b" }] });
  });

  test("member access, safe dereference, index and non-null assertion", () => {
    expect(value("res.properties.primaryEndpoints.blob")).toEqual(ref("resource", "res", ["properties", "primaryEndpoints", "blob"]));
    expect(value("mod.outputs.?id")).toEqual(ref("module", "mod", ["outputs", "id"]));
    expect(value("mod.?outputs.id!")).toEqual(ref("module", "mod", ["outputs", "id"]));
    expect(value("p[0]['key']")).toEqual(ref("parameter", "p", ["0", "key"]));
    expect(value("p[?0]")).toEqual(ref("parameter", "p", ["0"]));
    expect(value("loopItems[length(loopItems) - 1].name")).toEqual(ref("variable", "loopItems", ["*", "name"]));
    expect(value("(p).x")).toEqual(ref("parameter", "p", ["x"]));
    expect(value("undeclared.x")).toEqual(ref("unknown", "undeclared", ["x"]));
  });

  test("function calls, namespaces and resource functions", () => {
    expect(value("az.resourceGroup().location")).toEqual({ kind: "call", name: "az.resourceGroup", args: [], path: ["location"] });
    expect(value("sys.concat('a', p)")).toEqual({ kind: "call", name: "sys.concat", args: [{ kind: "string", value: "a" }, ref("parameter", "p")] });
    expect(value("environment().suffixes['storage']")).toEqual({ kind: "call", name: "environment", args: [], path: ["suffixes", "storage"] });
    expect(value(`union(
  { a: 1 }
  , { b: 2 }
)`)).toMatchObject({ kind: "call", name: "union", args: [{ kind: "object" }, { kind: "object" }] });
    expect(value("res.listKeys().keys[0].value")).toEqual({ kind: "unknown", text: "res.listKeys().keys[0].value", references: [{ target: { kind: "resource", name: "res" }, path: [] }] });
    expect(value("'x'.length")).toEqual({ kind: "unknown", text: "'x'.length", references: [] });
  });

  test("ternary, including multi-line", () => {
    expect(value("p == 'a' ? mod.outputs.x : null")).toEqual({
      kind: "conditional",
      condition: { kind: "unknown", text: "p == 'a'", references: [{ target: { kind: "parameter", name: "p" }, path: [] }] },
      whenTrue: ref("module", "mod", ["outputs", "x"]),
      whenFalse: { kind: "null" },
    });
    expect(value("empty(p)\n  ? 'a'\n  : (p ?? 'b')")).toMatchObject({ kind: "conditional", whenTrue: { kind: "string", value: "a" }, whenFalse: { kind: "unknown", text: "p ?? 'b'" } });
    expect(value("p ? {\n  a: 1\n} : {\n  b: 2\n}")).toMatchObject({ kind: "conditional", whenTrue: { kind: "object" }, whenFalse: { kind: "object" } });
  });

  test("operators become unknown with references", () => {
    expect(value("!empty(p) && length(loopItems) > 2 || res.id =~ 'x'")).toEqual({
      kind: "unknown",
      text: "!empty(p) && length(loopItems) > 2 || res.id =~ 'x'",
      references: [
        { target: { kind: "parameter", name: "p" }, path: [] },
        { target: { kind: "variable", name: "loopItems" }, path: [] },
        { target: { kind: "resource", name: "res" }, path: ["id"] },
      ],
    });
    expect(value("1 + 2 * 3 % 4 / 5 - 6")).toMatchObject({ kind: "unknown", references: [] });
    expect(value("-p")).toEqual({ kind: "unknown", text: "-p", references: [{ target: { kind: "parameter", name: "p" }, path: [] }] });
    expect(value("!!true")).toMatchObject({ kind: "unknown", text: "!!true" });
  });

  test("lambdas and for-expressions become unknown", () => {
    expect(value("map(loopItems, item => item.name)")).toEqual({
      kind: "call",
      name: "map",
      args: [ref("variable", "loopItems"), { kind: "unknown", text: "item => item.name", references: [{ target: { kind: "unknown", name: "item" }, path: ["name"] }] }],
    });
    expect(value("reduce(loopItems, 0, (acc, x) => acc + x)")).toMatchObject({ kind: "call", args: [{}, {}, { kind: "unknown", text: "(acc, x) => acc + x" }] });
    expect(value("[for (x, i) in loopItems: if (i > 0) { name: x, p: p }]")).toEqual({
      kind: "unknown",
      text: "[for (x, i) in loopItems: if (i > 0) { name: x, p: p }]",
      references: [
        { target: { kind: "variable", name: "loopItems" }, path: [] },
        { target: { kind: "loop", name: "i" }, path: [] },
        { target: { kind: "loop", name: "x" }, path: [] },
        { target: { kind: "parameter", name: "p" }, path: [] },
      ],
    });
  });

  test("spread and interpolated keys become unknown", () => {
    expect(value("{ ...p, a: 1 }")).toMatchObject({ kind: "unknown", references: [{ target: { kind: "parameter", name: "p" } }] });
    expect(value("[...loopItems, 1]")).toMatchObject({ kind: "unknown", references: [{ target: { kind: "variable", name: "loopItems" } }] });
    expect(value("{\n  '${p}': {}\n}")).toMatchObject({ kind: "unknown", references: [{ target: { kind: "parameter", name: "p" } }] });
  });

  test("comments and windows line endings", () => {
    const facts = ok("// lead\r\nparam a string /* inline */ = 'x' // trailing\r\n/* multi\r\nline */\r\nvar b = {\r\n  // inside\r\n  k: a /* c */\r\n  'j': '//not a comment'\r\n}\r\n");
    expect(facts.parameters[0]).toMatchObject({ name: "a", defaultValue: { kind: "string", value: "x" }, location: { line: 2, column: 1 } });
    expect(facts.variables[0]!.value).toMatchObject({ kind: "object", entries: [{ key: "k", value: ref("parameter", "a") }, { key: "j", value: { kind: "string", value: "//not a comment" } }] });
  });
});

describe("bicepparam", () => {
  test("using and parameter values", () => {
    const facts = ok(
      `using './main.bicep'

param env = 'dev'
param size = 3
param name = '\${env}-app'
param secret = readEnvironmentVariable('SECRET', '')
var shared = { a: 1 }
param obj = shared
`,
      "infra/main.bicepparam",
    );
    expect(facts.fileKind).toBe("parameters");
    expect(facts.usingTemplate).toBe("infra/main.bicep");
    expect(facts.parameters.map((p) => [p.name, p.type, p.defaultValue])).toEqual([
      ["env", null, { kind: "string", value: "dev" }],
      ["size", null, { kind: "number", value: 3 }],
      ["name", null, { kind: "interpolation", parts: [ref("parameter", "env"), "-app"] }],
      ["secret", null, { kind: "call", name: "readEnvironmentVariable", args: [{ kind: "string", value: "SECRET" }, { kind: "string", value: "" }] }],
      ["obj", null, ref("variable", "shared")],
    ]);
  });

  test("using outside the repository or from a registry is null", () => {
    expect(ok("using '../../main.bicep'\n", "infra/x.bicepparam").usingTemplate).toBeNull();
    expect(ok("using 'br/public:avm/res/x:1.0.0'\n", "x.bicepparam").usingTemplate).toBeNull();
    expect(ok("using none\nparam a = 1\n", "x.bicepparam").parameters).toHaveLength(1);
  });
});

describe("bicep robustness", () => {
  test("syntax errors are reported with positions and parsing recovers", () => {
    const facts = parse(`param a string
var broken = {
  key 'missing colon'
}
resource ok 'A.B/c@1' = {
  name: 'fine'
}
var bad = (1 +
output o string = a
`);
    expect(facts.errors.map((e) => [e.line, e.column])).toEqual([[3, 7], [9, 8]]);
    expect(facts.parameters.map((p) => p.name)).toEqual(["a"]);
    expect(facts.resources.map((r) => r.symbol)).toEqual(["ok"]);
    expect(facts.variables).toEqual([]);
    expect(facts.outputs.map((o) => o.name)).toEqual(["o"]);
  });

  test("errors inside a parent drop its nested children too", () => {
    const facts = parse("resource p 'A.B/c@1' = {\n  resource c 'd' = { name: 'x' }\n  name: = \n}\nvar ok = 1\n");
    expect(facts.resources).toEqual([]);
    expect(facts.variables.map((v) => v.name)).toEqual(["ok"]);
    expect(facts.errors).toHaveLength(1);
  });

  test("unterminated strings and comments", () => {
    expect(parse("var a = 'abc\nvar b = 1\n").errors[0]).toMatchObject({ message: "unterminated string", line: 1, column: 9 });
    expect(parse("var a = 1\n/* never closed").errors[0]).toMatchObject({ message: "unterminated comment", line: 2, column: 1 });
    expect(parse("var a = '''abc").errors[0]).toMatchObject({ message: "unterminated multi-line string" });
    expect(parse("var a = '${b").errors.length).toBeGreaterThan(0);
    expect(parse("var a = 'x\\q'").errors[0]).toMatchObject({ message: "invalid escape sequence '\\q'" });
  });

  test("files larger than the limit are rejected", () => {
    const facts = parse("var a = 1\n" + " ".repeat(IAC_LIMITS.maxBytes));
    expect(facts.errors).toEqual([{ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 }]);
    expect(facts.variables).toEqual([]);
  });

  test("deep nesting becomes unknown without overflowing", () => {
    const depth = 100_000;
    for (const [open, close] of [["[", "]"], ["(", ")"], ["{a:", "}"], ["'${", "}'"]] as const) {
      const facts = parse(`var deep = ${open.repeat(depth)}p${close.repeat(depth)}\nparam p string\nvar after = 1\n`);
      expect(facts.errors).toEqual([]);
      expect(facts.variables.map((v) => v.name)).toEqual(["deep", "after"]);
      expect(JSON.stringify(facts.variables[0]!.value)).toContain('"kind":"unknown"');
      expect(JSON.stringify(facts.variables[0]!.value)).toContain('{"target":{"kind":"parameter","name":"p"},"path":[]}');
    }
    const ternary = parse(`var t = ${"p ? 1 : ".repeat(depth)}0\nparam p bool\n`);
    expect(ternary.errors).toEqual([]);
    const unary = parse(`var u = ${"!".repeat(depth)}true\n`);
    expect(unary.variables[0]!.value).toMatchObject({ kind: "unknown" });
  });

  test("long chains, huge strings and many declarations stay fast", () => {
    const start = performance.now();
    const chain = parse(`var c = ${Array.from({ length: 50_000 }, (_, i) => `v${i}`).join(" + ")}\n`);
    expect(chain.variables[0]!.value).toMatchObject({ kind: "unknown" });
    const huge = parse(`var s = '${"x".repeat(3_000_000)}'\n`);
    expect(huge.variables[0]!.value).toMatchObject({ kind: "string" });
    const wide = parse(`param p bool\nvar w = !contains([${Array.from({ length: 300_000 }, (_, i) => i).join(", ")}], p)\n`);
    expect(wide.variables[0]!.value).toMatchObject({ kind: "unknown", references: [{ target: { kind: "parameter", name: "p" } }] });
    const many = parse(Array.from({ length: 20_000 }, (_, i) => `var v${i} = v${i ? i - 1 : 0}`).join("\n"));
    expect(many.variables).toHaveLength(20_000);
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  test("random input never throws and is deterministic", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ["param ", "var ", "resource ", "module ", "output ", "x", "'", "'''", "${", "}", "{", "[", "(", ")", "]", ":", "=", "?", "\n", "\r\n", "//", "/*", "*/", "@", ".", "::", "for ", "in ", "if ", "=>", "!", "1", ",", "\\", " "];
    for (let n = 0; n < 300; n++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 80) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
      const a = JSON.stringify(parse(text));
      expect(JSON.stringify(parse(text))).toBe(a);
    }
  });
});

const REPOS = join(homedir(), ".capy/work/repos");

describe.skipIf(!existsSync(REPOS))("bicep corpus", () => {
  const files = (existsSync(REPOS) ? [...new Glob("**/*.{bicep,bicepparam}").scanSync({ cwd: REPOS })] : []).filter((f) => !f.includes("node_modules")).sort();

  test("every bicep and bicepparam file parses without errors", async () => {
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const file of files) {
      const text = await Bun.file(join(REPOS, file)).text();
      const facts = parseBicep(file, text);
      for (const e of facts.errors) failures.push(`${file}:${e.line}:${e.column} ${e.message}`);
      expect(JSON.stringify(parseBicep(file, text))).toBe(JSON.stringify(facts));
    }
    expect(failures).toEqual([]);
  });

  test("service bus quickstart main.bicep", async () => {
    const file = "functions-quickstart-dotnet-azd-service-bus/infra/main.bicep";
    if (!files.includes(file)) return;
    const facts = parseBicep(file, await Bun.file(join(REPOS, file)).text());
    expect(facts.targetScope).toBe("subscription");
    expect(facts.resources.map((r) => r.symbol)).toContain("rg");
    const processor = facts.modules.find((m) => m.symbol === "processor")!;
    expect(processor.localPath).toBe("functions-quickstart-dotnet-azd-service-bus/infra/app/processor.bicep");
    expect(processor.scope).toEqual(ref("resource", "rg"));
    expect(facts.modules.find((m) => m.symbol === "serviceBus")!.localPath).toBeNull();
    expect(facts.modules.find((m) => m.symbol === "storageBlobDataOwnerRoleDefinitionApi")!.loop).toBe(true);
    expect(facts.parameters.find((p) => p.name === "location")!.allowed?.length).toBeGreaterThan(3);
  });

  test("serverless reference architecture cosmosdb module", async () => {
    const file = "serverless-microservices-reference-architecture/bicep/modules/cosmosdb.bicep";
    if (!files.includes(file)) return;
    const facts = parseBicep(file, await Bun.file(join(REPOS, file)).text());
    const containers = facts.resources.find((r) => r.symbol === "containers")!;
    expect(containers).toMatchObject({ type: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers", parent: "cosmosDB", loop: true, loopSource: ref("variable", "containerNames") });
    expect(containers.name).toEqual(ref("loop", "cotainerName"));
  });
});
