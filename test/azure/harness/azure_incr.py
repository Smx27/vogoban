#!/usr/bin/env python3
"""Phase 17 incremental-vs-full equivalence harness.

For each scenario: copy a real repository (clean commit, restored), run a full analysis into store A,
apply an uncommitted change, run `vogoban graph sync` (working-tree, incremental) on store A, then run a
clean full analysis of the same tree into a fresh store B and compare both graphs field by field.
Usage: azure_incr.py <repos-dir>|fixtures <work-dir> [scenario-name ...]
(`fixtures` runs only the Phase 18 scenarios over the shipped test fixtures; a repos dir runs both sets.)
"""
import json, os, re, shutil, sqlite3, subprocess, sys, time

VOGOBAN = os.path.join(os.path.dirname(__file__), "..", "..", "..", "src", "cli", "main.ts")
ENV = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1")

def run(args, cwd=None):
    p = subprocess.run(["bun", VOGOBAN, *args], capture_output=True, text=True, env=ENV, cwd=cwd)
    return p.returncode, p.stdout, p.stderr

def edit(path, old, new, count=1):
    text = open(path, encoding="utf-8-sig").read()
    if old not in text:
        raise RuntimeError(f"pattern not found in {path}: {old[:60]}")
    open(path, "w").write(text.replace(old, new, count))

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(text)

SB = "functions-quickstart-dotnet-azd-service-bus"
EH = "functions-quickstart-dotnet-azd-eventhub"
EG = "functions-quickstart-dotnet-azd-eventgrid-blob"
COSMOS = "functions-quickstart-dotnet-azd-cosmosdb"
TF = "functions-quickstart-dotnet-azd-tf"
HTTP = "functions-quickstart-dotnet-azd"
DURABLE = "durable-functions-quickstart-dotnet-azd"
ASPIRE = "aspire-samples"

NEW_FUNCTION = '''using Microsoft.Azure.Functions.Worker;

namespace ServiceBusProcessor;

public class AuditTrigger
{
    [Function("AuditTrigger")]
    public void Run([ServiceBusTrigger("audit", "auditors", Connection = "ServiceBusConnection")] string message) { }
}
'''

SCENARIOS = [
    ("function-add", SB, lambda d: write(f"{d}/src/AuditTrigger.cs", NEW_FUNCTION)),
    ("function-modify", SB, lambda d: edit(f"{d}/src/ServiceBusQueueTrigger.cs", "await Task.Delay(TimeSpan.FromSeconds(30));", "await Task.Delay(TimeSpan.FromSeconds(5));")),
    ("function-delete", EH, lambda d: os.remove(f"{d}/src/NewsGenerator.cs")),
    ("function-rename", SB, lambda d: edit(f"{d}/src/ServiceBusQueueTrigger.cs", '[Function("ServiceBusQueueTrigger")]', '[Function("ServiceBusQueueProcessor")]')),
    ("trigger-modify", SB, lambda d: edit(f"{d}/src/ServiceBusQueueTrigger.cs", '"%ServiceBusQueueName%"', '"orders-literal"')),
    ("queue-modify-bicep", SB, lambda d: edit(f"{d}/infra/main.bicep", "serviceBusQueueName: !empty(serviceBusQueueName) ? serviceBusQueueName : '${abbrs.serviceBusNamespacesQueues}${resourceToken}'", "serviceBusQueueName: 'orders-literal'")),
    ("eventhub-modify", EH, lambda d: edit(f"{d}/src/EventHubsTrigger.cs", '"news"', '"headlines"')),
    ("eventgrid-modify", EG, lambda d: edit(f"{d}/infra/main.bicep", "var unprocessedPdfSystemTopicName = 'eventgridpdftopic'", "var unprocessedPdfSystemTopicName = 'eventgridpdfevents'") or edit(f"{d}/src/ProcessBlobUpload.cs", '"unprocessed-pdf/{name}"', '"incoming-pdf/{name}"')),
    ("cosmos-modify", COSMOS, lambda d: edit_first_regex(f"{d}/CosmosTrigger.cs", r'containerName: "[^"]+"|"documents"', '"documents2"')),
    ("bicep-resource-modify", COSMOS, lambda d: edit_first_regex(f"{d}/infra/app/db.bicep", r"name: '([a-zA-Z0-9-]+)'", "name: 'renamed-resource'")),
    ("terraform-modify", TF, lambda d: edit_first_regex(f"{d}/infra/main.tf", r'"func-api-\$\{local\.resource_token\}"', '"func-renamed-${local.resource_token}"')),
    ("aspire-modify", ASPIRE, lambda d: edit(f"{d}/samples/aspire-with-azure-functions/ImageGallery.AppHost/AppHost.cs", 'storage.AddQueues("queues")', 'storage.AddQueues("jobs")')),
    ("shared-module-modify", SB, lambda d: edit(f"{d}/infra/core/host/functions-flexconsumption.bicep", "AzureWebJobsStorage__credential : 'managedidentity'", "AzureWebJobsStorage__credential : 'managedidentity'\n  ExtraSetting: stg.name")),
    ("configuration-modify", TF, lambda d: edit_first_regex(f"{d}/http/local.settings.json", r'"FUNCTIONS_WORKER_RUNTIME": "[^"]+"', '"FUNCTIONS_WORKER_RUNTIME": "dotnet-isolated", "OrdersQueue": "orders"')),
    ("azd-manifest-modify", SB, lambda d: edit(f"{d}/azure.yaml", "  processor:", "  worker:")),
    ("host-json-modify", HTTP, lambda d: edit_first_regex(f"{d}/http/host.json", r'"version": "2.0"', '"version": "2.0", "extensions": { "http": { "routePrefix": "v2" } }')),
    ("durable-modify", DURABLE, lambda d: edit_first_regex(f"{d}/fanoutfanin/FetchOrchestration.cs", r'nameof\(FetchTitleAsync\)', '"FetchTitle"')),
]

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..")
ORDERS, FULFILL, PLATFORM = "azure/fixtures/contoso-orders", "azure/fixtures/contoso-fulfillment", "azure/fixtures/contoso-platform-infra"
COSMOS_INIT, NODE_CJS, NODE_ESM, NODE_MIXED = "azure/fixtures/cosmos-initializers", "azure/fixtures/node-functions/commonjs", "azure/fixtures/node-functions/esm", "azure/fixtures/node-functions/mixed"
LAZY = "frontend/fixtures/lazy-routes"
ID_TF2, ID_COSMOS, ID_BICEP2, ID_ALPHA, ID_CONSUMER, ID_UNKNOWN = ("azure/fixtures/identity/" + x for x in ("infra-two-namespaces", "infra-cosmos-chain", "bicep-two-namespaces", "publisher-alpha", "consumer-alpha", "consumer-unknown-namespace"))
SECRETS = "security/fixtures/boundary-secrets"

NEW_CS_FUNCTION = '''using Microsoft.Azure.Functions.Worker;

namespace Contoso.Orders.Functions;

public sealed class AuditFunctions
{
    [Function("AuditOrder")]
    public void Run([ServiceBusTrigger("orders", "audit", Connection = "ServiceBus")] string message) { }
}
'''

def remove(path):
    os.remove(path)

def big_cs(path, name, bytes_):
    header = "namespace App.Generated { public static class %s { public static readonly string[] Values = new[] {\n" % name
    line = '"%s",\n' % ("x" * 60)
    write(path, header + line * (bytes_ // len(line) + 1) + '"end" }; } }\n')

# Phase 18 scenarios over the shipped fixtures (test/azure/fixtures, test/frontend/fixtures, test/security/fixtures):
# the repository path is relative to test/, the copy is git-initialised so working-tree change detection applies.
FIXTURE_SCENARIOS = [
    ("f18-orders-api-modify", ORDERS, lambda d: edit_first_regex(f"{d}/src/Contoso.Orders.Api/Services/OrderService.cs", r"\bSubmitAsync\(", "SubmitOrderAsync(")),
    ("f18-orders-function-add", ORDERS, lambda d: write(f"{d}/src/Contoso.Orders.Functions/AuditFunctions.cs", NEW_CS_FUNCTION)),
    ("f18-orders-function-delete", ORDERS, lambda d: remove(f"{d}/src/Contoso.Orders.Functions/OrderProcessor.cs") or edit(f"{d}/src/Contoso.Orders.Functions/OrderFunctions.cs", "OrderProcessor processor", "object processor")),
    ("f18-orders-trigger-subscription", ORDERS, lambda d: edit(f"{d}/src/Contoso.Orders.Functions/OrderFunctions.cs", '[ServiceBusTrigger("orders", "billing"', '[ServiceBusTrigger("orders", "invoicing"')),
    ("f18-orders-bicep-subscription-rename", ORDERS, lambda d: edit(f"{d}/infra/modules/messaging.bicep", "name: 'billing'", "name: 'invoicing'")),
    ("f18-orders-bicep-namespace-rename", ORDERS, lambda d: edit(f"{d}/infra/main.bicep", "namespaceName: 'sb-${prefix}'", "namespaceName: 'sb-${prefix}-v2'")),
    ("f18-orders-node-local-settings-namespace", ORDERS, lambda d: edit(f"{d}/notifications/local.settings.json", "sb-contoso-orders.servicebus.windows.net", "sb-contoso-other.servicebus.windows.net")),
    ("f18-orders-node-function-add", ORDERS, lambda d: edit(f"{d}/notifications/src/functions/notify.ts", 'app.serviceBusTopic("NotifyCustomer"', 'app.http("Ping", { methods: ["GET"], handler: async () => ({ status: 200 }) });\napp.serviceBusTopic("NotifyCustomer"')),
    ("f18-orders-react-route-add", ORDERS, lambda d: edit_first_regex(f"{d}/web/src/routes.tsx", r"\{ path: \"/orders/new\"", '{ path: "/orders/draft", element: <NewOrderPage /> },\n  { path: "/orders/new"')),
    ("f18-orders-web-api-modify", ORDERS, lambda d: edit(f"{d}/web/src/api/orders.ts", 'fetch("/api/orders"', 'fetch("/api/v2/orders"')),
    ("f18-orders-azure-yaml-modify", ORDERS, lambda d: edit(f"{d}/azure.yaml", "  functions:", "  workers:")),
    ("f18-orders-host-json-modify", ORDERS, lambda d: edit_first_regex(f"{d}/src/Contoso.Orders.Functions/host.json", r'"version": "2.0"', '"version": "2.0", "extensions": { "http": { "routePrefix": "v2" } }')),
    ("f18-orders-local-settings-secret", ORDERS, lambda d: edit(f"{d}/src/Contoso.Orders.Functions/local.settings.json", "SharedAccessKey=Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy=", "SharedAccessKey=Q0FOQVJZS0VZMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0=")),
    ("f18-orders-api-and-contract", ORDERS, lambda d: edit(f"{d}/src/Contoso.Orders.Contracts/OrderSubmitted.cs", "OrderSubmitted(", "OrderSubmitted(string Region, ") or edit_first_regex(f"{d}/src/Contoso.Orders.Api/Services/OrderService.cs", r"new OrderSubmitted\(", 'new OrderSubmitted("eu", ')),
    ("f18-orders-symlink-added", ORDERS, lambda d: os.symlink("/etc/hostname", f"{d}/src/Contoso.Orders.Functions/Leak.cs")),
    ("f18-orders-oversized-added", ORDERS, lambda d: big_cs(f"{d}/src/Contoso.Orders.Functions/Huge.cs", "Huge", 9 * 1024 * 1024)),
    ("f18-fulfillment-trigger-modify", FULFILL, lambda d: edit(f"{d}/src/Contoso.Fulfillment.Functions/FulfillmentFunctions.cs", '[ServiceBusTrigger("orders", "fulfillment"', '[ServiceBusTrigger("orders", "shipping"')),
    ("f18-fulfillment-local-settings-modify", FULFILL, lambda d: edit(f"{d}/src/Contoso.Fulfillment.Functions/local.settings.json", "sb-contoso-platform.servicebus.windows.net", "sb-contoso-platform2.servicebus.windows.net")),
    ("f18-fulfillment-field-initializer", FULFILL, lambda d: edit(f"{d}/src/Contoso.Fulfillment.Functions/ShipmentStore.cs", '"fulfillmentdb", "shipments"', '"fulfillmentdb", "shipments-v2"')),
    ("f18-platform-tf-topic-rename", PLATFORM, lambda d: edit(f"{d}/terraform/main.tf", 'name         = "shipments"', 'name         = "shipments-v2"')),
    ("f18-platform-tf-cosmos-module", PLATFORM, lambda d: edit(f"{d}/terraform/main.tf", 'account_name   = "cosmos-contoso-fulfillment"', 'account_name   = "cosmos-contoso-fulfillment2"')),
    ("f18-cosmos-init-container-rename", COSMOS_INIT, lambda d: edit(f"{d}/src/Contoso.Catalog.Functions/ProductService.cs", '"catalogdb", "products"', '"catalogdb", "products-v2"')),
    ("f18-cosmos-init-service-delete", COSMOS_INIT, lambda d: remove(f"{d}/src/Contoso.Catalog.Functions/ReviewService.cs") or edit_first_regex(f"{d}/src/Contoso.Catalog.Functions/CatalogFunctions.cs", r"ReviewService", "object") or edit_first_regex(f"{d}/src/Contoso.Catalog.Functions/Program.cs", r".*ReviewService.*\n", "")),
    ("f18-cosmos-init-account-modify", COSMOS_INIT, lambda d: edit(f"{d}/src/Contoso.Catalog.Functions/ProductService.cs", "https://cosmos-catalog.documents.azure.com:443/", "https://cosmos-catalog-eu.documents.azure.com:443/")),
    ("f18-node-cjs-function-add", NODE_CJS, lambda d: edit(f"{d}/src/functions/orders.js", "app.http('CreateOrder'", "app.http('Health', { methods: ['GET'], handler: async () => ({ status: 200 }) });\napp.http('CreateOrder'")),
    ("f18-node-cjs-trigger-modify", NODE_CJS, lambda d: edit_first_regex(f"{d}/src/functions/orders.js", r"app\.serviceBusQueue\('ProcessOrder'", "app.serviceBusQueue('ProcessOrderV2'")),
    ("f18-node-esm-modify", NODE_ESM, lambda d: edit_first_regex(f"{d}/src/functions/images.mjs", r"app\.(\w+)\(['\"](\w+)['\"]", lambda m: f"app.{m.group(1)}('{m.group(2)}V2'")),
    ("f18-node-mixed-legacy-modify", NODE_MIXED, lambda d: edit_first_regex(f"{d}/LegacyQueue/function.json", r'"queueName": "([^"]+)"', '"queueName": "\\1-v2"')),
    ("f18-lazy-angular-named-export", LAZY, lambda d: edit(f"{d}/angular/src/app/app.routes.ts", 'then((m) => m.OrdersComponent)', 'then((m) => m.default)')),
    ("f18-lazy-angular-route-add", LAZY, lambda d: edit(f"{d}/angular/src/app/app.routes.ts", '{ path: "profile"', '{ path: "orders-archive", loadComponent: () => import("./orders/orders.component").then((m) => m.OrdersComponent) },\n  { path: "profile"')),
    ("f18-lazy-angular-service-modify", LAZY, lambda d: edit_first_regex(f"{d}/angular/src/app/orders/orders.service.ts", r"/api/orders", "/api/v2/orders")),
    ("f18-lazy-react-loader-modify", LAZY, lambda d: edit(f"{d}/react/src/routes.tsx", 'const OrdersPage = lazy(() => import("./pages/OrdersPage"));', 'const OrdersPage = lazy(() => import("./pages/OrdersPage").then((m) => ({ default: m.default })));')),
    ("f18-lazy-react-route-remove", LAZY, lambda d: edit_first_regex(f"{d}/react/src/routes.tsx", r"const CatalogPage = lazy\(\(\) => import\(\"./pages/CatalogPage\"\)\);", 'const CatalogPage = lazy(() => import("./pages/UsersPage"));')),
    ("f18-lazy-api-modify", LAZY, lambda d: edit_first_regex(f"{d}/api/Program.cs", r'"/api/orders"', '"/api/orders/all"')),
    ("f18-identity-tf-second-namespace-rename", ID_TF2, lambda d: edit(f"{d}/main.tf", 'name                = "sb-alpha"', 'name                = "sb-alpha-v2"')),
    ("f18-identity-tf-cosmos-chain-modify", ID_COSMOS, lambda d: edit_first_regex(f"{d}/main.tf", r'azurerm_cosmosdb_sql_container" "(\w+)" \{\n  name\s*= "([^"]+)"', lambda m: f'azurerm_cosmosdb_sql_container" "{m.group(1)}" {{\n  name = "{m.group(2)}-v2"')),
    ("f18-identity-bicep-two-namespaces-modify", ID_BICEP2, lambda d: edit_first_regex(f"{d}/infra/main.bicep", r"name: 'orders'", "name: 'orders-v2'")),
    ("f18-identity-publisher-local-settings", ID_ALPHA, lambda d: edit_first_regex(f"{d}/local.settings.json", r"sb-alpha", "sb-gamma")),
    ("f18-identity-consumer-binding-modify", ID_CONSUMER, lambda d: edit(f"{d}/ProcessOrders/function.json", '"queueName": "orders"', '"queueName": "orders-v2"')),
    ("f18-identity-unknown-consumer-empty-name", ID_UNKNOWN, lambda d: edit_first_regex(f"{d}/ProcessOrders/function.json", r'"queueName": "[^"]*"', '"queueName": ""')),
    ("f18-secrets-literal-modify", SECRETS, lambda d: edit(f"{d}/src/App/Program.cs", "SharedAccessKey=CANARYSBKEY0123456789abcdefghijklmnopqrstuv=", "SharedAccessKey=CANARYSBKEY9876543210abcdefghijklmnopqrstuv=")),
    ("f18-secrets-credential-add", SECRETS, lambda d: edit(f"{d}/src/App/Program.cs", 'var key = new AzureKeyCredential("CANARYKEYSHORT");', 'var key = new AzureKeyCredential("CANARYKEYSHORT");\n        var key2 = new AzureKeyCredential("CANARYKEYSECOND");')),
    ("f18-secrets-nested-add", SECRETS, lambda d: write(f"{d}/src/App/Nested/Extra.cs", "namespace App.Nested { public static class Extra { public const string Url = \"https://x.blob.core.windows.net/c?sig=CANARYNEWSIG\"; } }\n")),
]

def edit_first_regex(path, pattern, repl):
    text = open(path, encoding="utf-8-sig").read()
    new, n = re.subn(pattern, repl, text, count=1)
    if n == 0:
        raise RuntimeError(f"pattern not found in {path}: {pattern}")
    open(path, "w").write(new)

TABLES = {
    "entities": "id, key, kind, layer, name, qualified_name, repository_id, project_id, assembly, language, symbol_key, file, start_line, start_col, end_line, end_col, external, metadata, provenance",
    "relationships": "id, type, source_id, target_id, repository_id, evidence, confidence, metadata, provenance, file",
    "unresolved": "id, type, source_id, repository_id, target_display, resolver, reason, confidence, metadata, provenance",
    "diagnostics": "*",
    "conflicts": "*",
    "files": "*",
}

def dump(db):
    c = sqlite3.connect(db)
    out = {t: sorted(map(tuple, c.execute(f"select {cols} from {t}"))) for t, cols in TABLES.items()}
    out["graph_version"] = [tuple(r) for r in c.execute("select graph_version from catalog")]
    return out

def compare(a, b):
    diffs = {}
    for k in a:
        if a[k] != b[k]:
            sa, sb = set(a[k]), set(b[k])
            diffs[k] = {"only_incremental": len(sa - sb), "only_full": len(sb - sa), "sample_incremental": [str(x)[:300] for x in list(sa - sb)[:2]], "sample_full": [str(x)[:300] for x in list(sb - sa)[:2]]}
    return diffs

def git(d, *args):
    subprocess.run(["git", "-c", "user.name=harness", "-c", "user.email=harness@local", "-C", d, *args], check=True, capture_output=True)

def main():
    repos, work = sys.argv[1], sys.argv[2]
    only = set(sys.argv[3:])
    results = []
    scenarios = SCENARIOS + [(n, os.path.join(FIXTURES, r), m) for n, r, m in FIXTURE_SCENARIOS]
    if repos == "fixtures":
        scenarios = [(n, os.path.join(FIXTURES, r), m) for n, r, m in FIXTURE_SCENARIOS]
    for name, repo, mutate in scenarios:
        if only and name not in only:
            continue
        d = os.path.join(work, name)
        shutil.rmtree(d, ignore_errors=True)
        shutil.copytree(repo if os.path.isabs(repo) else os.path.join(repos, repo), d, symlinks=True, ignore=shutil.ignore_patterns("bin", ".vogoban"))
        if not os.path.isdir(os.path.join(d, ".git")):
            git(d, "init", "-q")
            git(d, "add", "-A")
            git(d, "commit", "-q", "-m", "fixture")
        a, b = os.path.join(work, f"{name}-incremental.db"), os.path.join(work, f"{name}-full.db")
        for f in (a, b):
            for suffix in ("", "-wal", "-shm"):
                if os.path.exists(f + suffix):
                    os.remove(f + suffix)
        rc, _, err = run(["analyze", d, "--db", a])
        if rc != 0:
            results.append({"scenario": name, "status": "BASELINE_FAILED", "error": err[-400:]})
            continue
        mutate(d)
        t0 = time.time()
        rc, out, err = run(["graph", "sync", d, "--db", a, "--json"])
        inc_ms = round((time.time() - t0) * 1000)
        sync = json.loads(out) if out.strip().startswith("{") else {"error": err[-400:]}
        t0 = time.time()
        rc2, _, err2 = run(["analyze", d, "--db", b])
        full_ms = round((time.time() - t0) * 1000)
        diffs = compare(dump(a), dump(b)) if rc == 0 and rc2 == 0 else {"error": (err + err2)[-400:]}
        results.append({
            "scenario": name, "repository": repo, "mode": sync.get("actualMode"), "domains": sync.get("plan", {}).get("affected", {}).get("domains"),
            "widened": sync.get("plan", {}).get("widened"), "changedFiles": sync.get("metrics", {}).get("changedFiles"),
            "incrementalMs": inc_ms, "fullMs": full_ms, "equivalent": not diffs, "diffs": diffs,
        })
        print(json.dumps(results[-1]), flush=True)
    json.dump(results, open(os.path.join(work, "results.json"), "w"), indent=1)
    ok = all(r.get("equivalent") and r.get("mode") == "incremental" for r in results)
    print(json.dumps({"scenarios": len(results), "equivalent": sum(1 for r in results if r.get("equivalent")), "incremental": sum(1 for r in results if r.get("mode") == "incremental"), "pass": ok}))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
