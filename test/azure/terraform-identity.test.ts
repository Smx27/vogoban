import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { display, evaluateDeployments, fullName, nameState } from "../../src/azure/iac/evaluate.ts";
import { parseTerraform } from "../../src/azure/iac/terraform.ts";
import { analyzeFixtures, FIXTURES, type Harness } from "./identity-harness.ts";

const names = (d: ReturnType<typeof evaluateDeployments>) => d.resources.map((r) => `${r.armType}:${fullName(r).map(display).join("/")}`).sort();
const tf = (dir: string, files: string[]) => files.map((f) => parseTerraform(`${dir}/${f}`, readFileSync(join(FIXTURES, "..", dir, f), "utf8")));

describe("terraform child-resource identity (D-01)", () => {
  test("contoso-platform-infra: Cosmos container keeps account/database/container, subscriptions keep namespace/topic", () => {
    const d = evaluateDeployments(tf("contoso-platform-infra/terraform", ["main.tf", "variables.tf", "providers.tf", "modules/cosmos/main.tf"]), new Map(), []);
    const all = names(d);
    expect(all).toContain("Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosmos-contoso-fulfillment/fulfillmentdb/shipments");
    expect(all).toContain("Microsoft.DocumentDB/databaseAccounts/sqlDatabases:cosmos-contoso-fulfillment/fulfillmentdb");
    expect(all).toContain("Microsoft.ServiceBus/namespaces/topics/subscriptions:sb-contoso-platform/shipments/notifications");
    expect(all).toContain("Microsoft.ServiceBus/namespaces/topics/subscriptions:sb-contoso-orders/orders/fulfillment");
    expect(all.filter((n) => n.includes("/containers:"))).toEqual(["Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosmos-contoso-fulfillment/fulfillmentdb/shipments"]);
    const container = d.resources.find((r) => r.armType.endsWith("/containers"))!;
    expect(container.parent?.armType).toBe("Microsoft.DocumentDB/databaseAccounts/sqlDatabases");
    expect(container.parent?.parent?.armType).toBe("Microsoft.DocumentDB/databaseAccounts");
    expect(container.parent?.parent?.parent ?? null).toBeNull();
  });

  test("every nested azurerm parent is preserved, from references and from literal parent names", () => {
    const d = evaluateDeployments(tf("identity/infra-cosmos-chain", ["main.tf"]), new Map(), []);
    expect(names(d)).toEqual([
      "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosmos-external/auditdb/audit",
      "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers:cosmos-shop/ordersdb/orders",
      "Microsoft.DocumentDB/databaseAccounts/sqlDatabases:cosmos-shop/ordersdb",
      "Microsoft.DocumentDB/databaseAccounts:cosmos-shop",
      "Microsoft.EventHub/namespaces/eventhubs/consumergroups:evh-telemetry/clicks/analytics",
      "Microsoft.EventHub/namespaces/eventhubs:evh-telemetry/clicks",
      "Microsoft.EventHub/namespaces:evh-telemetry",
      "Microsoft.KeyVault/vaults/secrets:kv-identity/DbPassword",
      "Microsoft.KeyVault/vaults:kv-identity",
      "Microsoft.Storage/storageAccounts/blobServices/containers:stidentityfiles/uploads",
      "Microsoft.Storage/storageAccounts/queueServices/queues:stidentityfiles/jobs",
      "Microsoft.Storage/storageAccounts/tableServices/tables:stidentityfiles/audit",
      "Microsoft.Storage/storageAccounts:stidentityfiles",
    ]);
    const literalParents = d.resources.find((r) => display(r.name) === "audit" && r.armType.endsWith("/containers"))!;
    expect(literalParents.parent?.existing).toBe(true);
    expect(`${literalParents.parent!.armType}:${display(literalParents.parent!.name)}`).toBe("Microsoft.DocumentDB/databaseAccounts/sqlDatabases:auditdb");
    expect(`${literalParents.parent!.parent!.armType}:${display(literalParents.parent!.parent!.name)}`).toBe("Microsoft.DocumentDB/databaseAccounts:cosmos-external");
    expect(nameState(literalParents.parent!.name)).toBe("exact");
    expect(nameState(literalParents.parent!.parent!.name)).toBe("exact");
    const group = d.resources.find((r) => r.armType.endsWith("/consumergroups"))!;
    expect(group.parent?.id).toBe(d.resources.find((r) => r.armType === "Microsoft.EventHub/namespaces/eventhubs")!.id);
    expect(group.parent?.parent?.id).toBe(d.resources.find((r) => r.armType === "Microsoft.EventHub/namespaces")!.id);
  });

  test("a parent id reference that is not a declared resource stays opaque and never matches a declared parent by name", () => {
    const main = parseTerraform("main.tf", `
resource "azurerm_servicebus_namespace" "ns" { name = "sb-local" }
resource "azurerm_servicebus_subscription" "s" {
  name     = "audit"
  topic_id = var.external_topic_id
}`);
    const d = evaluateDeployments([main], new Map(), []);
    const sub = d.resources.find((r) => r.armType.endsWith("/subscriptions"))!;
    expect(nameState(sub.parent!.name)).toBe("unresolved");
    expect(sub.parent?.parent ?? null).toBeNull();
    expect(display(sub.parent!.name)).not.toContain("sb-local");
  });
});

describe("CONTAINS_RESOURCE chains from Terraform (D-01)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await analyzeFixtures(["infra-cosmos-chain"]);
  });
  afterAll(() => h.close());

  test("each child is contained by its direct parent only", () => {
    const edges = h.relationships("infra-cosmos-chain", "CONTAINS_RESOURCE").map((r) => `${h.name(r.sourceId)} -> ${h.name(r.targetId)}`).sort();
    expect(edges).toEqual([
      "AzureResource:cosmos-external -> AzureResource:cosmos-external/auditdb",
      "AzureResource:cosmos-external/auditdb -> AzureResource:cosmos-external/auditdb/audit",
      "AzureResource:cosmos-shop -> AzureResource:cosmos-shop/ordersdb",
      "AzureResource:cosmos-shop/ordersdb -> AzureResource:cosmos-shop/ordersdb/orders",
      "AzureResource:evh-telemetry -> AzureResource:evh-telemetry/clicks",
      "AzureResource:evh-telemetry/clicks -> AzureResource:evh-telemetry/clicks/analytics",
      "AzureResource:kv-identity -> AzureResource:kv-identity/DbPassword",
      "AzureResource:stidentityfiles -> AzureResource:stidentityfiles/audit",
      "AzureResource:stidentityfiles -> AzureResource:stidentityfiles/jobs",
      "AzureResource:stidentityfiles -> AzureResource:stidentityfiles/uploads",
    ]);
  });

  test("declared keys carry the full parent path", () => {
    const keys = h.declared("infra-cosmos-chain").map((e) => String(e.key).split("|").slice(2).join("|")).sort();
    expect(keys).toContain("microsoft.documentdb/databaseaccounts/sqldatabases/containers|cosmos-shop/ordersdb/orders");
    expect(keys).toContain("microsoft.eventhub/namespaces/eventhubs/consumergroups|evh-telemetry/clicks/analytics");
    expect(keys).toContain("microsoft.keyvault/vaults/secrets|kv-identity/dbpassword");
    expect(keys.some((k) => k.endsWith("containers|cosmos-shop/orders"))).toBe(false);
    expect(h.declared("infra-cosmos-chain").every((e) => e.metadata.nameState === "exact")).toBe(true);
  });
});
