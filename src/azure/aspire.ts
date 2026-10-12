import type { Metadata } from "../graph/model.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { methodName, semanticIndex, type SemanticIndex } from "../dotnet/frameworks/shared.ts";
import type { ArgValue, ReceiverFact } from "../dotnet/semantic-facts.ts";
import type { DotnetProject } from "../dotnet/artifacts.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { azureKeys, resourceTypeInfo, roleName } from "./catalog.ts";
import { azProv, azRelate, azUnresolved } from "./common.ts";
import { AZURE_SOURCE_HASH } from "./source-hash.ts";

export const ASPIRE_PLUGIN = "azure.aspire";
export const ASPIRE_VERSION = `1+${AZURE_SOURCE_HASH}`;

interface ResourceKind {
  armType: string;
  /** Argument holding the Azure-side name when it differs from the Aspire resource name. */
  azureNameParam?: string;
}

/** Aspire hosting integration methods → Azure resource type (Aspire.Hosting.Azure.*). */
const RESOURCES: Record<string, ResourceKind> = {
  AddAzureStorage: { armType: "Microsoft.Storage/storageAccounts" },
  AddBlobs: { armType: "Microsoft.Storage/storageAccounts/blobServices" },
  AddBlobContainer: { armType: "Microsoft.Storage/storageAccounts/blobServices/containers", azureNameParam: "blobContainerName" },
  AddQueues: { armType: "Microsoft.Storage/storageAccounts/queueServices" },
  AddTables: { armType: "Microsoft.Storage/storageAccounts/tableServices" },
  AddAzureServiceBus: { armType: "Microsoft.ServiceBus/namespaces" },
  AddServiceBusQueue: { armType: "Microsoft.ServiceBus/namespaces/queues", azureNameParam: "queueName" },
  AddServiceBusTopic: { armType: "Microsoft.ServiceBus/namespaces/topics", azureNameParam: "topicName" },
  AddServiceBusSubscription: { armType: "Microsoft.ServiceBus/namespaces/topics/subscriptions", azureNameParam: "subscriptionName" },
  AddAzureEventHubs: { armType: "Microsoft.EventHub/namespaces" },
  AddHub: { armType: "Microsoft.EventHub/namespaces/eventhubs", azureNameParam: "hubName" },
  AddEventHub: { armType: "Microsoft.EventHub/namespaces/eventhubs", azureNameParam: "hubName" },
  AddConsumerGroup: { armType: "Microsoft.EventHub/namespaces/eventhubs/consumergroups", azureNameParam: "groupName" },
  AddAzureCosmosDB: { armType: "Microsoft.DocumentDB/databaseAccounts" },
  AddCosmosDatabase: { armType: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases", azureNameParam: "databaseName" },
  AddContainer: { armType: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers", azureNameParam: "containerName" },
  AddAzureSqlServer: { armType: "Microsoft.Sql/servers" },
  AddAzureKeyVault: { armType: "Microsoft.KeyVault/vaults" },
  AddAzureAppConfiguration: { armType: "Microsoft.AppConfiguration/configurationStores" },
  AddAzureApplicationInsights: { armType: "Microsoft.Insights/components" },
  AddAzureLogAnalyticsWorkspace: { armType: "Microsoft.OperationalInsights/workspaces" },
  AddAzureSignalR: { armType: "Microsoft.SignalRService/signalR" },
  AddAzureRedis: { armType: "Microsoft.Cache/redis" },
  AddAzureManagedRedis: { armType: "Microsoft.Cache/redisEnterprise" },
  AddAzurePostgresFlexibleServer: { armType: "Microsoft.DBforPostgreSQL/flexibleServers" },
  AddAzureContainerAppEnvironment: { armType: "Microsoft.App/managedEnvironments" },
  AddAzureAppServiceEnvironment: { armType: "Microsoft.Web/serverfarms" },
  AddAzureContainerRegistry: { armType: "Microsoft.ContainerRegistry/registries" },
  AddAzureUserAssignedIdentity: { armType: "Microsoft.ManagedIdentity/userAssignedIdentities" },
  AddAzureSearch: { armType: "Microsoft.Search/searchServices" },
  AddAzureOpenAI: { armType: "Microsoft.CognitiveServices/accounts" },
  AddAzureWebPubSub: { armType: "Microsoft.SignalRService/webPubSub" },
};
const SQL_DATABASE = "Microsoft.Sql/servers/databases";
const COMPUTE = /^(AddProject|AddAzureFunctionsProject)$/;

export interface AspireResource {
  name: string;
  entityId: string;
  armType: string;
  azureName: string | null;
  appHostProjectId: string;
  parent: AspireResource | null;
}

export interface AspireFacts {
  resources: Map<string, AspireResource>;
  /** Compute project → connection name → referenced Aspire resource. */
  references: Map<string, Map<string, AspireResource>>;
}

export const AZURE_ASPIRE = artifactKey<AspireFacts>("azure.aspire");

const str = (a: ArgValue | undefined) => (a?.kind === "string" ? (a.value ?? null) : null);
const argNamed = (args: ArgValue[] | undefined, ...names: string[]) => (args ?? []).find((a) => names.includes(a.parameter ?? a.name ?? ""));

function isAppHost(p: DotnetProject): boolean {
  return /Aspire\.AppHost\.Sdk/i.test(p.sdk ?? "") || p.packages.some((x) => /^Aspire\.Hosting\.AppHost$/i.test(x.name));
}

/** `Projects.My_Service` (Aspire's generated project metadata type) → the project whose name maps to it. */
function projectFor(index: SemanticIndex, typeName: string | undefined): DotnetProject | null {
  if (!typeName?.startsWith("Projects.")) return null;
  const id = typeName.slice("Projects.".length);
  const matches = [...index.projects.values()].filter((p) => p.name.replace(/[^A-Za-z0-9_]/g, "_") === id);
  return matches.length === 1 ? matches[0]! : null;
}

/** The innermost Aspire `Add*` call a builder chain applies to, as (method, resource name). */
function creationOf(r: ReceiverFact | undefined): { method: string; name: string | null; typeArgument?: string } | null {
  for (let cur = r; cur; cur = cur.receiver) {
    const m = methodName(cur.invocationTarget);
    if (!cur.invocationTarget || !/^Add/.test(m)) continue;
    return { method: m, name: str(argNamed(cur.invocationArguments, "name") ?? cur.invocationArguments?.[0]), typeArgument: cur.invocationTypeArguments?.[0]?.qualifiedName };
  }
  return null;
}

function argResource(a: ArgValue | undefined): string | null {
  if (!a || a.kind !== "invocation") return null;
  const m = methodName(a.symbol);
  if (/^Add/.test(m)) return str(argNamed(a.items, "name") ?? a.items?.[0]);
  return null;
}

export const azureAspirePlugin: AnalysisPlugin = {
  id: ASPIRE_PLUGIN,
  version: ASPIRE_VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const facts: AspireFacts = { resources: new Map(), references: new Map() };
    ctx.artifacts.set(AZURE_ASPIRE, facts);
    const index = semanticIndex(ctx);
    if (!index) return;
    const apps = ctx.artifacts.get(APPLICATIONS);
    const repoId = ctx.repository.id;
    const appHosts = new Set([...index.projects.values()].filter(isAppHost).map((p) => p.entityId));
    if (!appHosts.size) return;
    const hostInvocations = index.invocations.filter((i) => appHosts.has(i.project.entityId) && /^Aspire\.Hosting\./.test(i.owner ?? ""));
    const compute = new Map<string, DotnetProject>();
    const parentOf = new Map<string, string>();

    for (const { invocation, method, project } of hostInvocations) {
      const p = azProv(ctx, ASPIRE_PLUGIN, ASPIRE_VERSION, "ASPIRE_RESOURCE", "roslyn-semantic-model+aspire-rules", invocation.location);
      const name = str(argNamed(invocation.arguments, "name") ?? invocation.arguments[0]);
      if (COMPUTE.test(method)) {
        const target = projectFor(index, invocation.typeArguments[0]?.qualifiedName);
        if (name && target) compute.set(`${project.entityId}|${name}`, target);
        else if (name) azUnresolved(ctx, ASPIRE_PLUGIN, { type: "DEPLOYED_TO", sourceId: project.entityId, display: `${method}("${name}")`, reason: "the project resource does not map to exactly one project of the repository", category: "aspire-project-unresolved", provenance: p });
        continue;
      }
      const parentCreation = creationOf(invocation.receiver);
      let kind = RESOURCES[method];
      if (method === "AddDatabase") kind = parentCreation?.method === "AddAzureSqlServer" ? { armType: SQL_DATABASE, azureNameParam: "databaseName" } : parentCreation?.method === "AddAzureCosmosDB" ? RESOURCES.AddCosmosDatabase : undefined;
      if (method === "AddQueue") kind = parentCreation?.method === "AddAzureServiceBus" ? RESOURCES.AddServiceBusQueue : parentCreation?.method === "AddQueues" || parentCreation?.method === "AddAzureStorage" ? { armType: "Microsoft.Storage/storageAccounts/queueServices/queues", azureNameParam: "queueName" } : undefined;
      if (method === "AddTopic") kind = RESOURCES.AddServiceBusTopic;
      if (method === "AddSubscription") kind = RESOURCES.AddServiceBusSubscription;
      if (!kind || !name) continue;
      const azureName = kind.azureNameParam ? (str(argNamed(invocation.arguments, kind.azureNameParam)) ?? name) : null;
      const entityKey = azureKeys.aspire(repoId, project.entityId, name);
      const info = resourceTypeInfo(kind.armType);
      const entityId = ctx.graph.entity({
        key: entityKey, kind: "AzureResource", layer: "infrastructure", name, qualifiedName: `aspire:${name}`, repositoryId: repoId, projectId: project.entityId,
        location: { file: invocation.location.file, startLine: invocation.location.line, startColumn: invocation.location.column },
        metadata: { armType: kind.armType, azureKind: info.kind, service: info.service, resourceLabel: info.label, declaredIn: ["aspire"], declaredState: "DECLARED", aspireMethod: method, aspireResource: name, azureName, nameState: azureName ? "exact" : "aspire-logical-name", provisionedName: "generated at publish time" },
        provenance: p,
      });
      const resource: AspireResource = { name, entityId, armType: kind.armType, azureName, appHostProjectId: project.entityId, parent: null };
      facts.resources.set(`${project.entityId}|${name}`, resource);
      azRelate(ctx, "CREATES", project.entityId, entityId, "COMPILER_RESOLVED", p, { declaredBy: "aspire-apphost", method });
      if (parentCreation?.name) parentOf.set(`${project.entityId}|${name}`, `${project.entityId}|${parentCreation.name}`);
    }
    for (const [child, parent] of parentOf) {
      const c = facts.resources.get(child);
      const pr = facts.resources.get(parent);
      if (c && pr) c.parent = pr;
      if (c && pr) azRelate(ctx, "CONTAINS_RESOURCE", pr.entityId, c.entityId, "COMPILER_RESOLVED", azProv(ctx, ASPIRE_PLUGIN, ASPIRE_VERSION, "ASPIRE_CHILD_RESOURCE", "roslyn-semantic-model+aspire-rules", null), { relation: "child-resource" });
    }
    const environmentOf = (appHost: string) => [...facts.resources.values()].find((r) => r.appHostProjectId === appHost && (r.armType === "Microsoft.App/managedEnvironments" || r.armType === "Microsoft.Web/serverfarms"));

    const computeTarget = (name: string) => {
      const project = compute.get(name);
      return project ? { project, id: apps?.byProject.get(project.entityId)?.entityId ?? project.entityId } : null;
    };
    const external = new Set<string>();
    for (const { invocation, method, project: host } of hostInvocations) {
      const creation = creationOf(invocation.receiver);
      if (method === "WithExternalHttpEndpoints" && creation?.name) external.add(`${host.entityId}|${creation.name}`);
      if (!creation?.name || !COMPUTE.test(creation.method)) continue;
      const target = computeTarget(`${host.entityId}|${creation.name}`);
      const lookup = (n: string | null) => (n ? facts.resources.get(`${host.entityId}|${n}`) : undefined);
      if (!target) continue;
      const p = azProv(ctx, ASPIRE_PLUGIN, ASPIRE_VERSION, `ASPIRE_${method.toUpperCase()}`, "roslyn-semantic-model+aspire-rules", invocation.location);
      if (method === "WithReference") {
        const refName = argResource(argNamed(invocation.arguments, "source") ?? invocation.arguments[0]);
        const connectionName = str(argNamed(invocation.arguments, "connectionName")) ?? refName;
        const resource = lookup(refName);
        if (resource && connectionName) {
          const refs = facts.references.get(target.project.entityId) ?? new Map<string, AspireResource>();
          refs.set(connectionName, resource);
          facts.references.set(target.project.entityId, refs);
          azRelate(ctx, "CONNECTS_TO", target.id, resource.entityId, "COMPILER_RESOLVED", p, { connectionName, via: "aspire WithReference" });
        } else if (!refName) azUnresolved(ctx, ASPIRE_PLUGIN, { type: "CONNECTS_TO", sourceId: target.id, display: "WithReference(?)", reason: "referenced resource is not a statically identifiable Aspire resource", category: "aspire-reference-unresolved", provenance: p });
      }
      if (method === "WithRoleAssignments") {
        const scopeName = argResource(argNamed(invocation.arguments, "target") ?? invocation.arguments[0]);
        const scope = lookup(scopeName);
        const roles = invocation.arguments.slice(1).map((a) => a.value ?? "").map((v) => v.split(".").pop() ?? v).filter(Boolean);
        if (scope) for (const role of roles.length ? roles : ["(roles)"]) azRelate(ctx, "HAS_ROLE_ON", target.id, scope.entityId, "COMPILER_RESOLVED", p, { role: roleName(role.replace(/([a-z])([A-Z])/g, "$1 $2")) ?? role, via: "aspire WithRoleAssignments" } as Metadata);
      }
      if (method === "WithHostStorage") {
        const storage = argResource(invocation.arguments[0]);
        const resource = lookup(storage);
        if (resource) azRelate(ctx, "CONNECTS_TO", target.id, resource.entityId, "COMPILER_RESOLVED", p, { connectionName: "AzureWebJobsStorage", via: "aspire WithHostStorage" });
      }
    }
    for (const [key, project] of compute) {
      const [hostId, name] = key.split("|") as [string, string];
      const environment = environmentOf(hostId);
      if (!environment) continue;
      const appId = apps?.byProject.get(project.entityId)?.entityId ?? project.entityId;
      azRelate(ctx, "DEPLOYED_TO", appId, environment.entityId, "DECLARED", azProv(ctx, ASPIRE_PLUGIN, ASPIRE_VERSION, "ASPIRE_COMPUTE_ENVIRONMENT", "roslyn-semantic-model+aspire-rules", null), { aspireResource: name, external: external.has(key), rule: "aspire-compute-environment: every compute resource is published into the declared environment" });
    }
    ctx.log.info("azure.aspire", { appHosts: appHosts.size, resources: facts.resources.size, compute: compute.size, references: [...facts.references.values()].reduce((n, m) => n + m.size, 0), environments: [...facts.resources.values()].filter((r) => r.armType === "Microsoft.App/managedEnvironments").length });
  },
};
