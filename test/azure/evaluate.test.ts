import { describe, expect, test } from "bun:test";
import { parseBicep } from "../../src/azure/iac/bicep.ts";
import { parseTerraform } from "../../src/azure/iac/terraform.ts";
import { canon, display, evaluateDeployments, fullName, get, litString, nameState, referencedResources } from "../../src/azure/iac/evaluate.ts";
import { redactFacts } from "../../src/azure/infrastructure.ts";
import { avmModule, resourceTypeInfo, roleName } from "../../src/azure/catalog.ts";
import { bindingValue, hostOf, resourceFromHost } from "../../src/azure/values.ts";

const names = (d: ReturnType<typeof evaluateDeployments>) => d.resources.map((r) => `${r.armType}:${fullName(r).map(display).join("/")}`).sort();

describe("bicep evaluation", () => {
  test("module params bind to call-site expressions and outputs flow back", () => {
    const main = parseBicep("infra/main.bicep", `
param env string = 'prod'
module bus './bus.bicep' = { name: 'bus', params: { namespaceName: 'sb-\${env}' } }
resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-\${env}'
  properties: { siteConfig: { appSettings: [ { name: 'Bus__fullyQualifiedNamespace', value: '\${bus.outputs.ns}.servicebus.windows.net' } ] } }
}`);
    const bus = parseBicep("infra/bus.bicep", `
param namespaceName string
resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  resource orders 'topics' = { name: 'orders' }
}
output ns string = sb.name`);
    const d = evaluateDeployments([main, bus], new Map(), []);
    expect(d.roots).toEqual(["infra/main.bicep"]);
    expect(names(d)).toEqual(["Microsoft.ServiceBus/namespaces/topics:sb-prod/orders", "Microsoft.ServiceBus/namespaces:sb-prod", "Microsoft.Web/sites:func-prod"]);
    const site = d.resources.find((r) => r.armType === "Microsoft.Web/sites")!;
    const setting = get(site.body(), "properties", "siteConfig", "appSettings", "0", "value")!;
    const refs = [...referencedResources(setting)];
    expect(refs.map((r) => r.armType)).toEqual(["Microsoft.ServiceBus/namespaces"]);
    expect(litString(setting)).toBeNull();
  });

  test("identical expressions are symbolically identical; runtime functions stay opaque", () => {
    const main = parseBicep("main.bicep", `
param env string
var token = uniqueString(subscription().id, env)
resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = { name: 'sb-\${token}' }
resource q 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = { parent: sb, name: 'q-\${token}' }
resource site 'Microsoft.Web/sites@2023-12-01' = { name: 'x', properties: { siteConfig: { appSettings: [ { name: 'QueueName', value: 'q-\${token}' } ] } } }`);
    const d = evaluateDeployments([main], new Map(), []);
    const q = d.resources.find((r) => r.armType.endsWith("/queues"))!;
    const site = d.resources.find((r) => r.armType === "Microsoft.Web/sites")!;
    const value = get(site.body(), "properties", "siteConfig", "appSettings", "0", "value")!;
    expect(canon(value)).toBe(canon(q.name));
    expect(nameState(q.name)).toBe("partially-resolved");
    expect(display(q.name)).toContain("q-");
  });

  test("AVM registry modules expand to their resource and child resources without fetching", () => {
    const main = parseBicep("main.bicep", `
module bus 'br/public:avm/res/service-bus/namespace:0.9.0' = {
  name: 'bus'
  params: { name: 'sb-avm', topics: [ { name: 'orders', subscriptions: [ { name: 'billing' } ] } ], queues: [ { name: 'jobs' } ] }
}`);
    expect(avmModule("br/public:avm/res/service-bus/namespace:0.9.0")?.spec.armType).toBe("Microsoft.ServiceBus/namespaces");
    expect(names(evaluateDeployments([main], new Map(), []))).toEqual([
      "Microsoft.ServiceBus/namespaces/queues:sb-avm/jobs",
      "Microsoft.ServiceBus/namespaces/topics/subscriptions:sb-avm/orders/billing",
      "Microsoft.ServiceBus/namespaces/topics:sb-avm/orders",
      "Microsoft.ServiceBus/namespaces:sb-avm",
    ]);
  });

  test("loadJsonContent reads only supplied repository files", () => {
    const main = parseBicep("infra/main.bicep", `
var abbrs = loadJsonContent('./abbreviations.json')
resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = { name: '\${abbrs.sb}orders' }`);
    expect(names(evaluateDeployments([main], new Map([["infra/abbreviations.json", '{"sb":"sb-"}']]), []))).toEqual(["Microsoft.ServiceBus/namespaces:sb-orders"]);
    expect(nameState(evaluateDeployments([main], new Map(), []).resources[0]!.name)).toBe("partially-resolved");
  });
});

describe("terraform evaluation", () => {
  test("azurerm parents come from *_id references and local modules are instantiated", () => {
    const root = parseTerraform("tf/main.tf", `
resource "azurerm_servicebus_namespace" "ns" { name = "sb-tf" }
resource "azurerm_servicebus_topic" "t" {
  name         = "shipments"
  namespace_id = azurerm_servicebus_namespace.ns.id
}
module "db" {
  source  = "./cosmos"
  account = "cosmos-tf"
}`);
    const mod = parseTerraform("tf/cosmos/main.tf", `
variable "account" { type = string }
resource "azurerm_cosmosdb_account" "a" { name = var.account }
resource "azurerm_cosmosdb_sql_database" "d" {
  name         = "db"
  account_name = azurerm_cosmosdb_account.a.name
}`);
    expect(names(evaluateDeployments([root, mod], new Map(), []))).toEqual([
      "Microsoft.DocumentDB/databaseAccounts/sqlDatabases:cosmos-tf/db",
      "Microsoft.DocumentDB/databaseAccounts:cosmos-tf",
      "Microsoft.ServiceBus/namespaces/topics:sb-tf/shipments",
      "Microsoft.ServiceBus/namespaces:sb-tf",
    ]);
  });
});

describe("secret handling", () => {
  test("secret literals are redacted before facts are cached", () => {
    const facts = parseBicep("main.bicep", `
@secure()
param pwd string = 'SuperSecret-123'
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = { name: 'kv' }
resource s 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = { parent: kv, name: 'db', properties: { value: 'Hunter2-Literal' } }
resource site 'Microsoft.Web/sites@2023-12-01' = { name: 'x', properties: { siteConfig: { appSettings: [ { name: 'ApiPassword', value: 'Inline-Pass-9' }, { name: 'Bus__credential', value: 'managedidentity' } ] } } }`);
    const json = JSON.stringify(redactFacts(facts));
    for (const secret of ["SuperSecret-123", "Hunter2-Literal", "Inline-Pass-9"]) expect(json).not.toContain(secret);
    expect(json).toContain("managedidentity");
  });
});

describe("vocabulary", () => {
  test("types, roles, hosts and binding expressions", () => {
    expect(resourceTypeInfo("Microsoft.ServiceBus/namespaces/topics").kind).toBe("service-bus-topic");
    expect(roleName("/providers/Microsoft.Authorization/roleDefinitions/090c5cfd-751d-490a-894a-3ce6f1109419")).toBe("Azure Service Bus Data Owner");
    expect(resourceFromHost(hostOf("sb://sb-orders.servicebus.windows.net/")!, "service-bus-namespace")).toBe("sb-orders");
    expect(resourceFromHost(hostOf("https://kv-x.vault.azure.net/")!, "key-vault")).toBe("kv-x");
    expect(bindingValue("%Queue%")).toEqual({ kind: "setting", name: "Queue", via: "functions-binding-expression" });
    expect(bindingValue("orders")).toEqual({ kind: "literal", value: "orders" });
    expect(bindingValue("%Prefix%-orders")?.kind).toBe("template");
  });
});
