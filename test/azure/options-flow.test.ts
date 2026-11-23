import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../../src/log.ts";
import { buildMetaGraph } from "../../src/metagraph/build.ts";
import { SqliteGraphStore } from "../../src/store/sqlite.ts";

const source = join(import.meta.dir, "../..");
const dotnet = [process.env.VOGOBAN_DOTNET, Bun.which("dotnet"), join(process.env.HOME ?? "", ".dotnet/dotnet"), join(process.env.HOME ?? "", ".capy/work/dotnet/dotnet")].find((p) => p && existsSync(p));
const root = mkdtempSync(join(tmpdir(), "vogoban-options-flow-"));
const dbPath = join(root, "graph.db");
let store: SqliteGraphStore;
const ids = new Map<string, string>();

function write(repo: string, path: string, text: string) {
  const full = join(root, repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

const sdk = `namespace Azure.Messaging.ServiceBus {
public class ServiceBusClient {
  public ServiceBusClient(string fullyQualifiedNamespace) {}
  public ServiceBusSender CreateSender(string queueOrTopicName) => new();
  public object CreateProcessor(string queueName) => new();
  public object CreateProcessor(string topicName, string subscriptionName) => new();
}
public class ServiceBusSender { public void SendMessageAsync(string message) {} }
}`;

function project(name: string, mode: "publisher" | "consumer" | "subscriber", binding: string, endpoint: string, extra = "") {
  write(name, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><Reference Include="Fixture.ServiceBus"><HintPath>../sdk/bin/Debug/net8.0/Fixture.ServiceBus.dll</HintPath></Reference></ItemGroup></Project>');
  write(name, "App.cs", `using Azure.Messaging.ServiceBus;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
namespace Demo {
public class BusOptions { public string Namespace { get; set; } = ""; public string Topic { get; set; } = ""; }
public static class Setup {
  public static void Configure(IServiceCollection services, IConfiguration configuration) { ${binding} services.AddSingleton(Create); }
  public static ServiceBusClient Create(System.IServiceProvider provider) { var options = provider.GetRequiredService<IOptions<BusOptions>>(); return new(${endpoint}); }
}
public class Worker {
  private readonly ServiceBusClient client;
  private readonly ServiceBusSender sender;
  public Worker(ServiceBusClient client, IOptions<BusOptions> options) { this.client = client; sender = client.CreateSender(options.Value.Topic); }
  public void Run(IOptions<BusOptions> options) { ${mode === "publisher" ? 'sender.SendMessageAsync("payload");' : mode === "subscriber" ? 'client.CreateProcessor(options.Value.Topic, "events");' : "client.CreateProcessor(options.Value.Topic);"} }
}
}${extra}`);
  write(name, "appsettings.json", JSON.stringify({ Azure: { Bus: { Namespace: "sb-alpha.servicebus.windows.net", Topic: "orders" } } }));
}

function analyze(name: string) {
  const result = Bun.spawnSync(["bun", join(source, "src/cli/main.ts"), "analyze", join(root, name), "--db", dbPath, "--json", "--log-level", "error"], { cwd: source, env: { ...process.env, VOGOBAN_DOTNET: dotnet, VOGOBAN_MSBUILD_EVALUATION: "1" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  ids.set(name, JSON.parse(result.stdout.toString()).repository.id);
}

beforeAll(() => {
  if (!dotnet) return;
  write("sdk", "Sdk.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><AssemblyName>Fixture.ServiceBus</AssemblyName></PropertyGroup></Project>');
  write("sdk", "Sdk.cs", sdk);
  const build = Bun.spawnSync([dotnet!, "build", join(root, "sdk/Sdk.csproj"), "--nologo", "-v", "q"], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(build.stdout.toString() + build.stderr.toString());
  project("publisher", "publisher", 'services.AddOptions<BusOptions>().BindConfiguration("Azure:Bus");', "options.Value.Namespace", 'public class UnusedFactory { public ServiceBusClient Create() => new("unused.servicebus.windows.net"); }');
  project("consumer", "consumer", 'services.AddOptions<BusOptions>().Bind(configuration.GetSection("Azure:Bus"));', "options.Value.Namespace");
  project("nested", "consumer", 'services.AddOptions<BusOptions>().Bind(configuration.GetSection("Azure").GetSection("Bus"));', "options.Value.Namespace");
  project("subscriber", "subscriber", 'services.AddOptions<BusOptions>().BindConfiguration("Azure:Bus");', "options.Value.Namespace");
  project("wrapper-field", "publisher", 'services.AddOptions<BusOptions>().BindConfiguration("Azure:Bus");', "options.Value.Namespace");
  const wrapper = join(root, "wrapper-field/App.cs");
  writeFileSync(wrapper, readFileSync(wrapper, "utf8").replace("private readonly ServiceBusClient client;", "private readonly IOptions<BusOptions> holder; private readonly ServiceBusClient client;").replace("this.client = client;", "holder = options; this.client = client;").replace("CreateSender(options.Value.Topic)", "CreateSender(holder.Value.Topic)"));
  project("unbound", "publisher", "", "options.Value.Namespace");
  project("conflicting", "publisher", 'services.Configure<BusOptions>(configuration.GetSection("Azure:Bus"));', "options.Value.Namespace");
  write("conflicting", "appsettings.Production.json", JSON.stringify({ Azure: { Bus: { Namespace: "sb-beta.servicebus.windows.net", Topic: "orders" } } }));
  project("unrelated", "publisher", 'services.Configure<BusOptions>(configuration.GetSection("Azure:Bus"));', 'Options.Create(new BusOptions { Namespace = "sb-gamma.servicebus.windows.net" }).Value.Namespace');
  project("unknown-section", "publisher", 'services.Configure<BusOptions>(configuration.GetSection("Azure:Bus"));', "options.Value.Namespace");
  const unknown = join(root, "unknown-section/App.cs");
  writeFileSync(unknown, readFileSync(unknown, "utf8").replace("IConfiguration configuration", "IConfigurationSection configuration"));
  project("named", "publisher", 'services.AddOptions<BusOptions>("another-instance").BindConfiguration("Azure:Bus");', "options.Value.Namespace");
  project("ambiguous-sender", "publisher", 'services.AddOptions<BusOptions>().BindConfiguration("Azure:Bus");', "options.Value.Namespace");
  const ambiguousSender = join(root, "ambiguous-sender/App.cs");
  writeFileSync(ambiguousSender, readFileSync(ambiguousSender, "utf8").replace("Worker(ServiceBusClient client, IOptions<BusOptions> options)", "Worker(ServiceBusClient client, IOptions<BusOptions> options, ServiceBusSender alternate)").replace("sender = client.CreateSender(options.Value.Topic);", "sender = client.CreateSender(options.Value.Topic); if (System.Environment.TickCount > 0) sender = alternate;"));
  write("infra", "main.bicep", "resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {\n name: 'sb-alpha'\n location: 'westus'\n}\nresource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' = {\n parent: bus\n name: 'orders'\n}\n");
  for (const name of ["publisher", "consumer", "nested", "subscriber", "wrapper-field", "unbound", "conflicting", "unrelated", "unknown-section", "named", "ambiguous-sender", "infra"]) analyze(name);
  store = new SqliteGraphStore(dbPath);
  buildMetaGraph(store, createLogger({ level: "error" }), true);
});

afterAll(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!dotnet)("all option identity fixtures compile successfully, including negative controls", () => {
  for (const [name, id] of ids) {
    if (name === "infra") continue;
    const project = store.findEntities({ repositoryId: id, kinds: ["Project"] }).find((e) => e.name === "App");
    expect(project?.metadata.compilerErrors).toBe(0);
  }
});

test.skipIf(!dotnet)("bound IOptions properties produce exact scoped Azure identities and cross-repository flow", () => {
  for (const repo of ["publisher", "consumer", "nested", "wrapper-field"]) {
    const logical = [...store.iterateEntities(ids.get(repo)!)].filter((e) => e.metadata.azureKind === "service-bus-entity");
    expect(logical.map((e) => e.name)).toContain("sb-alpha/orders");
    const ref = store.findEntities({ repositoryId: ids.get(repo)!, kinds: ["ConfigurationReference"] }).find((e) => e.name === "Azure:Bus:Namespace");
    expect(ref).toBeDefined();
    expect(store.findRelationships({ types: ["SUPPLIES_CONFIG"], targetId: ref!.id, repositoryId: ids.get(repo)! }).length).toBeGreaterThan(0);
  }
  const shared = store.findMetaRelationships({ types: ["SHARES_RESOURCE"] });
  expect(shared.some((r) => store.getEntity(r.sourceId)?.repositoryId === ids.get("publisher") && store.getEntity(r.targetId)?.repositoryId === ids.get("consumer"))).toBe(true);
  expect(store.findMetaRelationships({ types: ["DECLARED_BY"] }).some((r) => store.getEntity(r.sourceId)?.repositoryId === ids.get("publisher") && store.getEntity(r.targetId)?.repositoryId === ids.get("infra"))).toBe(true);
});

test.skipIf(!dotnet)("unbound options, conflicting environments and manually created wrappers never acquire another instance's identity", () => {
  const bad = new Set(["unbound", "conflicting", "unrelated", "unknown-section", "named", "ambiguous-sender"].map((n) => ids.get(n)));
  for (const type of ["SHARES_RESOURCE", "DECLARED_BY"] as const) {
    expect(store.findMetaRelationships({ types: [type] }).filter((r) => bad.has(store.getEntity(r.sourceId)?.repositoryId ?? ""))).toEqual([]);
  }
});

test.skipIf(!dotnet)("SDK subscription factories retain their topic identity for cross-repository flow", () => {
  const subscriptions = store.findRelationships({ repositoryId: ids.get("subscriber")!, types: ["SUBSCRIBES_TO"] });
  expect(subscriptions.some((r) => store.getEntity(r.sourceId)?.name === "sb-alpha/orders" && store.getEntity(r.targetId)?.name === "sb-alpha/orders/events")).toBe(true);
  expect(store.findMetaRelationships({ types: ["SHARES_RESOURCE"] }).some((r) => store.getEntity(r.sourceId)?.repositoryId === ids.get("publisher") && store.getEntity(r.targetId)?.repositoryId === ids.get("subscriber"))).toBe(true);
});
