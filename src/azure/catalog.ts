/**
 * Azure resource vocabulary shared by every Azure analyzer: canonical ARM types, their normalized
 * resource kind, and the Azure Verified Module (AVM) conventions used to read registry modules
 * without fetching them. Identity keys for Azure entities are built only here.
 */

export type AzureService =
  | "functions" | "app-service" | "container-apps" | "aks" | "service-bus" | "event-hubs" | "event-grid" | "storage" | "cosmos-db" | "sql"
  | "key-vault" | "api-management" | "monitor" | "identity" | "network" | "front-door" | "app-gateway" | "app-configuration" | "signalr"
  | "redis" | "postgresql" | "mysql" | "container-registry" | "resources" | "authorization" | "durable-task" | "static-web-apps" | "other";

export interface ResourceTypeInfo {
  /** Normalized kind used in queries and metadata (e.g. "service-bus-topic"). */
  kind: string;
  service: AzureService;
  label: string;
  /** Hosting resources run application code (HOSTED_ON targets). */
  hosting?: boolean;
  /** Data/messaging leaf resources that code reads, writes, publishes to or is triggered by. */
  dataPlane?: "queue" | "topic" | "subscription" | "event-hub" | "event-grid-topic" | "blob-container" | "storage-queue" | "table" | "cosmos-database" | "cosmos-container" | "sql-database" | "key-vault" | "storage-account" | "service-bus-namespace" | "event-hubs-namespace" | "cosmos-account" | "sql-server";
}

const T: Record<string, ResourceTypeInfo> = {
  "microsoft.web/sites": { kind: "app-service", service: "app-service", label: "App Service / Function App", hosting: true },
  "microsoft.web/sites/slots": { kind: "app-service-slot", service: "app-service", label: "Deployment slot", hosting: true },
  "microsoft.web/sites/config": { kind: "app-service-config", service: "app-service", label: "App Service configuration" },
  "microsoft.web/sites/functions": { kind: "function", service: "functions", label: "Function" },
  "microsoft.web/serverfarms": { kind: "app-service-plan", service: "app-service", label: "App Service plan" },
  "microsoft.web/staticsites": { kind: "static-web-app", service: "static-web-apps", label: "Static Web App", hosting: true },
  "microsoft.app/containerapps": { kind: "container-app", service: "container-apps", label: "Container App", hosting: true },
  "microsoft.app/jobs": { kind: "container-app-job", service: "container-apps", label: "Container Apps job", hosting: true },
  "microsoft.app/managedenvironments": { kind: "container-apps-environment", service: "container-apps", label: "Container Apps environment" },
  "microsoft.containerservice/managedclusters": { kind: "aks-cluster", service: "aks", label: "AKS cluster", hosting: true },
  "microsoft.containerregistry/registries": { kind: "container-registry", service: "container-registry", label: "Container registry" },
  "microsoft.servicebus/namespaces": { kind: "service-bus-namespace", service: "service-bus", label: "Service Bus namespace", dataPlane: "service-bus-namespace" },
  "microsoft.servicebus/namespaces/queues": { kind: "service-bus-queue", service: "service-bus", label: "Service Bus queue", dataPlane: "queue" },
  "microsoft.servicebus/namespaces/topics": { kind: "service-bus-topic", service: "service-bus", label: "Service Bus topic", dataPlane: "topic" },
  "microsoft.servicebus/namespaces/topics/subscriptions": { kind: "service-bus-subscription", service: "service-bus", label: "Service Bus subscription", dataPlane: "subscription" },
  "microsoft.servicebus/namespaces/topics/subscriptions/rules": { kind: "service-bus-rule", service: "service-bus", label: "Service Bus subscription rule" },
  "microsoft.eventhub/namespaces": { kind: "event-hubs-namespace", service: "event-hubs", label: "Event Hubs namespace", dataPlane: "event-hubs-namespace" },
  "microsoft.eventhub/namespaces/eventhubs": { kind: "event-hub", service: "event-hubs", label: "Event Hub", dataPlane: "event-hub" },
  "microsoft.eventhub/namespaces/eventhubs/consumergroups": { kind: "event-hub-consumer-group", service: "event-hubs", label: "Event Hub consumer group" },
  "microsoft.eventgrid/topics": { kind: "event-grid-topic", service: "event-grid", label: "Event Grid topic", dataPlane: "event-grid-topic" },
  "microsoft.eventgrid/systemtopics": { kind: "event-grid-system-topic", service: "event-grid", label: "Event Grid system topic", dataPlane: "event-grid-topic" },
  "microsoft.eventgrid/domains": { kind: "event-grid-domain", service: "event-grid", label: "Event Grid domain", dataPlane: "event-grid-topic" },
  "microsoft.eventgrid/eventsubscriptions": { kind: "event-grid-subscription", service: "event-grid", label: "Event Grid subscription" },
  "microsoft.eventgrid/topics/eventsubscriptions": { kind: "event-grid-subscription", service: "event-grid", label: "Event Grid subscription" },
  "microsoft.eventgrid/systemtopics/eventsubscriptions": { kind: "event-grid-subscription", service: "event-grid", label: "Event Grid subscription" },
  "microsoft.eventgrid/domains/topics": { kind: "event-grid-domain-topic", service: "event-grid", label: "Event Grid domain topic", dataPlane: "event-grid-topic" },
  "microsoft.storage/storageaccounts": { kind: "storage-account", service: "storage", label: "Storage account", dataPlane: "storage-account" },
  "microsoft.storage/storageaccounts/blobservices": { kind: "blob-service", service: "storage", label: "Blob service" },
  "microsoft.storage/storageaccounts/blobservices/containers": { kind: "blob-container", service: "storage", label: "Blob container", dataPlane: "blob-container" },
  "microsoft.storage/storageaccounts/queueservices": { kind: "queue-service", service: "storage", label: "Queue service" },
  "microsoft.storage/storageaccounts/queueservices/queues": { kind: "storage-queue", service: "storage", label: "Storage queue", dataPlane: "storage-queue" },
  "microsoft.storage/storageaccounts/tableservices": { kind: "table-service", service: "storage", label: "Table service" },
  "microsoft.storage/storageaccounts/tableservices/tables": { kind: "storage-table", service: "storage", label: "Storage table", dataPlane: "table" },
  "microsoft.storage/storageaccounts/fileservices/shares": { kind: "file-share", service: "storage", label: "File share" },
  "microsoft.documentdb/databaseaccounts": { kind: "cosmos-account", service: "cosmos-db", label: "Cosmos DB account", dataPlane: "cosmos-account" },
  "microsoft.documentdb/databaseaccounts/sqldatabases": { kind: "cosmos-database", service: "cosmos-db", label: "Cosmos DB database", dataPlane: "cosmos-database" },
  "microsoft.documentdb/databaseaccounts/sqldatabases/containers": { kind: "cosmos-container", service: "cosmos-db", label: "Cosmos DB container", dataPlane: "cosmos-container" },
  "microsoft.documentdb/databaseaccounts/mongodbdatabases": { kind: "cosmos-mongo-database", service: "cosmos-db", label: "Cosmos DB Mongo database", dataPlane: "cosmos-database" },
  "microsoft.documentdb/databaseaccounts/mongodbdatabases/collections": { kind: "cosmos-mongo-collection", service: "cosmos-db", label: "Cosmos DB Mongo collection", dataPlane: "cosmos-container" },
  "microsoft.documentdb/databaseaccounts/sqlroleassignments": { kind: "cosmos-role-assignment", service: "authorization", label: "Cosmos DB data-plane role assignment" },
  "microsoft.sql/servers": { kind: "sql-server", service: "sql", label: "Azure SQL server", dataPlane: "sql-server" },
  "microsoft.sql/servers/databases": { kind: "sql-database", service: "sql", label: "Azure SQL database", dataPlane: "sql-database" },
  "microsoft.sql/servers/firewallrules": { kind: "sql-firewall-rule", service: "sql", label: "SQL firewall rule" },
  "microsoft.dbforpostgresql/flexibleservers": { kind: "postgresql-server", service: "postgresql", label: "PostgreSQL flexible server" },
  "microsoft.dbforpostgresql/flexibleservers/databases": { kind: "postgresql-database", service: "postgresql", label: "PostgreSQL database" },
  "microsoft.dbformysql/flexibleservers": { kind: "mysql-server", service: "mysql", label: "MySQL flexible server" },
  "microsoft.cache/redis": { kind: "redis-cache", service: "redis", label: "Azure Cache for Redis" },
  "microsoft.keyvault/vaults": { kind: "key-vault", service: "key-vault", label: "Key Vault", dataPlane: "key-vault" },
  "microsoft.keyvault/vaults/secrets": { kind: "key-vault-secret", service: "key-vault", label: "Key Vault secret" },
  "microsoft.keyvault/vaults/keys": { kind: "key-vault-key", service: "key-vault", label: "Key Vault key" },
  "microsoft.keyvault/vaults/accesspolicies": { kind: "key-vault-access-policy", service: "key-vault", label: "Key Vault access policy" },
  "microsoft.apimanagement/service": { kind: "api-management", service: "api-management", label: "API Management" },
  "microsoft.apimanagement/service/apis": { kind: "apim-api", service: "api-management", label: "APIM API" },
  "microsoft.apimanagement/service/apis/operations": { kind: "apim-operation", service: "api-management", label: "APIM operation" },
  "microsoft.apimanagement/service/apis/policies": { kind: "apim-policy", service: "api-management", label: "APIM API policy" },
  "microsoft.apimanagement/service/apis/operations/policies": { kind: "apim-policy", service: "api-management", label: "APIM operation policy" },
  "microsoft.apimanagement/service/backends": { kind: "apim-backend", service: "api-management", label: "APIM backend" },
  "microsoft.apimanagement/service/products": { kind: "apim-product", service: "api-management", label: "APIM product" },
  "microsoft.apimanagement/service/namedvalues": { kind: "apim-named-value", service: "api-management", label: "APIM named value" },
  "microsoft.apimanagement/service/subscriptions": { kind: "apim-subscription", service: "api-management", label: "APIM subscription" },
  "microsoft.insights/components": { kind: "application-insights", service: "monitor", label: "Application Insights" },
  "microsoft.operationalinsights/workspaces": { kind: "log-analytics-workspace", service: "monitor", label: "Log Analytics workspace" },
  "microsoft.insights/diagnosticsettings": { kind: "diagnostic-setting", service: "monitor", label: "Diagnostic setting" },
  "microsoft.managedidentity/userassignedidentities": { kind: "managed-identity", service: "identity", label: "User-assigned managed identity" },
  "microsoft.authorization/roleassignments": { kind: "role-assignment", service: "authorization", label: "Role assignment" },
  "microsoft.authorization/roledefinitions": { kind: "role-definition", service: "authorization", label: "Role definition" },
  "microsoft.network/virtualnetworks": { kind: "vnet", service: "network", label: "Virtual network" },
  "microsoft.network/virtualnetworks/subnets": { kind: "subnet", service: "network", label: "Subnet" },
  "microsoft.network/privateendpoints": { kind: "private-endpoint", service: "network", label: "Private endpoint" },
  "microsoft.network/privatednszones": { kind: "private-dns-zone", service: "network", label: "Private DNS zone" },
  "microsoft.network/privatednszones/virtualnetworklinks": { kind: "private-dns-zone-link", service: "network", label: "Private DNS zone link" },
  "microsoft.network/networksecuritygroups": { kind: "nsg", service: "network", label: "Network security group" },
  "microsoft.network/publicipaddresses": { kind: "public-ip", service: "network", label: "Public IP address" },
  "microsoft.network/applicationgateways": { kind: "application-gateway", service: "app-gateway", label: "Application Gateway" },
  "microsoft.network/frontdoors": { kind: "front-door", service: "front-door", label: "Front Door (classic)" },
  "microsoft.cdn/profiles": { kind: "front-door", service: "front-door", label: "Front Door / CDN profile" },
  "microsoft.cdn/profiles/afdendpoints": { kind: "front-door-endpoint", service: "front-door", label: "Front Door endpoint" },
  "microsoft.cdn/profiles/origingroups": { kind: "front-door-origin-group", service: "front-door", label: "Front Door origin group" },
  "microsoft.cdn/profiles/origingroups/origins": { kind: "front-door-origin", service: "front-door", label: "Front Door origin" },
  "microsoft.cdn/profiles/afdendpoints/routes": { kind: "front-door-route", service: "front-door", label: "Front Door route" },
  "microsoft.appconfiguration/configurationstores": { kind: "app-configuration", service: "app-configuration", label: "App Configuration store" },
  "microsoft.appconfiguration/configurationstores/keyvalues": { kind: "app-configuration-key", service: "app-configuration", label: "App Configuration key-value" },
  "microsoft.signalrservice/signalr": { kind: "signalr", service: "signalr", label: "SignalR Service" },
  "microsoft.durabletask/schedulers": { kind: "durable-task-scheduler", service: "durable-task", label: "Durable Task Scheduler" },
  "microsoft.durabletask/schedulers/taskhubs": { kind: "durable-task-hub", service: "durable-task", label: "Durable Task hub" },
  "microsoft.resources/resourcegroups": { kind: "resource-group", service: "resources", label: "Resource group" },
  "microsoft.resources/deploymentscripts": { kind: "deployment-script", service: "resources", label: "Deployment script" },
};

export function resourceTypeInfo(armType: string): ResourceTypeInfo {
  const key = armType.toLowerCase();
  return T[key] ?? { kind: key.split("/").slice(1).join("-") || key, service: "other", label: armType };
}

export const KNOWN_ARM_TYPES = Object.keys(T);

/** Function App vs web app vs container host: Microsoft.Web/sites `kind` decides. */
export function siteKind(kind: string | null): "function-app" | "web-app" | "logic-app" | "app-service" {
  if (!kind) return "app-service";
  const k = kind.toLowerCase();
  if (k.includes("workflowapp")) return "logic-app";
  if (k.includes("functionapp")) return "function-app";
  if (k.includes("app")) return "web-app";
  return "app-service";
}

/** Well-known built-in role definition ids that matter for data access and blast radius. */
export const BUILT_IN_ROLES: Record<string, string> = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "acdd72a7-3385-48ef-bd42-f606fba81ae7": "Reader",
  "090c5cfd-751d-490a-894a-3ce6f1109419": "Azure Service Bus Data Owner",
  "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39": "Azure Service Bus Data Sender",
  "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0": "Azure Service Bus Data Receiver",
  "f526a384-b230-433a-b45c-95f59c4a2dec": "Azure Event Hubs Data Owner",
  "2b629674-e913-4c01-ae53-ef4638d8f975": "Azure Event Hubs Data Sender",
  "a638d3c7-ab3a-418d-83e6-5f17a39d4fde": "Azure Event Hubs Data Receiver",
  "d5a91429-5739-47e2-a06b-3470a27159e7": "EventGrid Data Sender",
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe": "Storage Blob Data Contributor",
  "b7e6dc6d-f1e8-4753-8033-0f276bb0955b": "Storage Blob Data Owner",
  "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": "Storage Blob Data Reader",
  "974c5e8b-45b9-4653-ba55-5f855dd0fb88": "Storage Queue Data Contributor",
  "19e7f393-937e-4f77-808e-94535e297925": "Storage Queue Data Reader",
  "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a": "Storage Queue Data Message Sender",
  "8a0f0c08-91a1-4084-bc3d-661d67233fed": "Storage Queue Data Message Processor",
  "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3": "Storage Table Data Contributor",
  "17d1049b-9a84-46fb-8f53-869881c3d3ab": "Storage Account Contributor",
  "4633458b-17de-408a-b874-0445c86b69e6": "Key Vault Secrets User",
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": "Key Vault Secrets Officer",
  "00482a5a-887f-4fb3-b363-3b7fe8e74483": "Key Vault Administrator",
  "3913510d-42f4-4e42-8a64-420c390055eb": "Monitoring Metrics Publisher",
  "00000000-0000-0000-0000-000000000002": "Cosmos DB Built-in Data Contributor",
  "00000000-0000-0000-0000-000000000001": "Cosmos DB Built-in Data Reader",
  "7f951dda-4ed3-4680-a7ca-43fe172d538d": "AcrPull",
  "8311e382-0749-4cb8-b61a-304f252e45ec": "AcrPush",
  "0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8": "Durable Task Data Contributor",
};

export const HIGH_RISK_ROLES = new Set(["Owner", "Contributor", "User Access Administrator"]);

export function roleName(roleRef: string | null): string | null {
  if (!roleRef) return null;
  const guid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(roleRef)?.[1]?.toLowerCase();
  if (guid) return BUILT_IN_ROLES[guid] ?? null;
  const byName = Object.values(BUILT_IN_ROLES).find((n) => n.toLowerCase() === roleRef.toLowerCase());
  return byName ?? null;
}

/**
 * Azure Verified Module conventions: `br/public:avm/res/<module>` deploys one resource of a fixed
 * type; child resources are declared through well-known array parameters. This reads the module
 * call site only; the registry is never contacted.
 */
export interface AvmChild {
  /** Parameter path on the parent's params object (e.g. "queues", "blobServices.containers"). */
  param: string;
  armType: string;
  children?: AvmChild[];
}

export interface AvmModule {
  armType: string;
  children: AvmChild[];
  /** Params that carry the site `kind` for Microsoft.Web/sites. */
  kindParam?: string;
}

export const AVM_MODULES: Record<string, AvmModule> = {
  "avm/res/service-bus/namespace": {
    armType: "Microsoft.ServiceBus/namespaces",
    children: [
      { param: "queues", armType: "Microsoft.ServiceBus/namespaces/queues" },
      { param: "topics", armType: "Microsoft.ServiceBus/namespaces/topics", children: [{ param: "subscriptions", armType: "Microsoft.ServiceBus/namespaces/topics/subscriptions" }] },
    ],
  },
  "avm/res/event-hub/namespace": {
    armType: "Microsoft.EventHub/namespaces",
    children: [{ param: "eventhubs", armType: "Microsoft.EventHub/namespaces/eventhubs", children: [{ param: "consumergroups", armType: "Microsoft.EventHub/namespaces/eventhubs/consumergroups" }] }],
  },
  "avm/res/event-grid/topic": { armType: "Microsoft.EventGrid/topics", children: [{ param: "eventSubscriptions", armType: "Microsoft.EventGrid/topics/eventSubscriptions" }] },
  "avm/res/event-grid/system-topic": { armType: "Microsoft.EventGrid/systemTopics", children: [{ param: "eventSubscriptions", armType: "Microsoft.EventGrid/systemTopics/eventSubscriptions" }] },
  "avm/res/storage/storage-account": {
    armType: "Microsoft.Storage/storageAccounts",
    children: [
      { param: "blobServices.containers", armType: "Microsoft.Storage/storageAccounts/blobServices/containers" },
      { param: "queueServices.queues", armType: "Microsoft.Storage/storageAccounts/queueServices/queues" },
      { param: "tableServices.tables", armType: "Microsoft.Storage/storageAccounts/tableServices/tables" },
      { param: "fileServices.shares", armType: "Microsoft.Storage/storageAccounts/fileServices/shares" },
    ],
  },
  "avm/res/document-db/database-account": {
    armType: "Microsoft.DocumentDB/databaseAccounts",
    children: [
      { param: "sqlDatabases", armType: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases", children: [{ param: "containers", armType: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers" }] },
      { param: "mongodbDatabases", armType: "Microsoft.DocumentDB/databaseAccounts/mongodbDatabases", children: [{ param: "collections", armType: "Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections" }] },
    ],
  },
  "avm/res/sql/server": { armType: "Microsoft.Sql/servers", children: [{ param: "databases", armType: "Microsoft.Sql/servers/databases" }] },
  "avm/res/key-vault/vault": { armType: "Microsoft.KeyVault/vaults", children: [{ param: "secrets", armType: "Microsoft.KeyVault/vaults/secrets" }, { param: "keys", armType: "Microsoft.KeyVault/vaults/keys" }] },
  "avm/res/web/site": { armType: "Microsoft.Web/sites", children: [], kindParam: "kind" },
  "avm/res/web/serverfarm": { armType: "Microsoft.Web/serverfarms", children: [] },
  "avm/res/web/static-site": { armType: "Microsoft.Web/staticSites", children: [] },
  "avm/res/app/container-app": { armType: "Microsoft.App/containerApps", children: [] },
  "avm/res/app/managed-environment": { armType: "Microsoft.App/managedEnvironments", children: [] },
  "avm/res/app/job": { armType: "Microsoft.App/jobs", children: [] },
  "avm/res/container-service/managed-cluster": { armType: "Microsoft.ContainerService/managedClusters", children: [] },
  "avm/res/container-registry/registry": { armType: "Microsoft.ContainerRegistry/registries", children: [] },
  "avm/res/api-management/service": {
    armType: "Microsoft.ApiManagement/service",
    children: [
      { param: "apis", armType: "Microsoft.ApiManagement/service/apis" },
      { param: "backends", armType: "Microsoft.ApiManagement/service/backends" },
      { param: "products", armType: "Microsoft.ApiManagement/service/products" },
      { param: "namedValues", armType: "Microsoft.ApiManagement/service/namedValues" },
    ],
  },
  "avm/res/insights/component": { armType: "Microsoft.Insights/components", children: [] },
  "avm/res/operational-insights/workspace": { armType: "Microsoft.OperationalInsights/workspaces", children: [] },
  "avm/res/managed-identity/user-assigned-identity": { armType: "Microsoft.ManagedIdentity/userAssignedIdentities", children: [] },
  "avm/res/network/virtual-network": { armType: "Microsoft.Network/virtualNetworks", children: [{ param: "subnets", armType: "Microsoft.Network/virtualNetworks/subnets" }] },
  "avm/res/network/private-endpoint": { armType: "Microsoft.Network/privateEndpoints", children: [] },
  "avm/res/network/private-dns-zone": { armType: "Microsoft.Network/privateDnsZones", children: [] },
  "avm/res/network/network-security-group": { armType: "Microsoft.Network/networkSecurityGroups", children: [] },
  "avm/res/network/public-ip-address": { armType: "Microsoft.Network/publicIPAddresses", children: [] },
  "avm/res/network/application-gateway": { armType: "Microsoft.Network/applicationGateways", children: [] },
  "avm/res/cdn/profile": { armType: "Microsoft.Cdn/profiles", children: [] },
  "avm/res/app-configuration/configuration-store": { armType: "Microsoft.AppConfiguration/configurationStores", children: [{ param: "keyValues", armType: "Microsoft.AppConfiguration/configurationStores/keyValues" }] },
  "avm/res/signal-r-service/signal-r": { armType: "Microsoft.SignalRService/signalR", children: [] },
  "avm/res/cache/redis": { armType: "Microsoft.Cache/redis", children: [] },
  "avm/res/db-for-postgre-sql/flexible-server": { armType: "Microsoft.DBforPostgreSQL/flexibleServers", children: [{ param: "databases", armType: "Microsoft.DBforPostgreSQL/flexibleServers/databases" }] },
  "avm/res/resources/deployment-script": { armType: "Microsoft.Resources/deploymentScripts", children: [] },
};

/** `br/public:avm/res/service-bus/namespace:0.9.0` → AVM module spec (registry module ids are matched exactly, never fuzzily). */
export function avmModule(source: string): { id: string; version: string | null; spec: AvmModule } | null {
  const m = /^br(?:\/public|:mcr\.microsoft\.com\/bicep)[:/](avm\/res\/[a-z0-9-]+\/[a-z0-9-]+)(?::([\w.-]+))?$/i.exec(source.trim());
  if (!m) return null;
  const spec = AVM_MODULES[m[1]!.toLowerCase()];
  return spec ? { id: m[1]!.toLowerCase(), version: m[2] ?? null, spec } : null;
}

export const azureKeys = {
  /** A declared Azure resource (IaC or Aspire), by canonical type and canonical full name path. */
  resource: (repositoryId: string, armType: string, namePath: string) => `azure-resource|${repositoryId}|${armType.toLowerCase()}|${namePath.toLowerCase()}`,
  /** An Aspire AppHost resource, by AppHost project and resource name. */
  aspire: (repositoryId: string, projectId: string, name: string) => `azure-aspire|${repositoryId}|${projectId}|${name.toLowerCase()}`,
  function: (repositoryId: string, projectId: string, name: string) => `azure-function|${repositoryId}|${projectId}|${name}`,
  /** Code-side data-plane resource named by code; `path` is `<account>/<leaf path>` when the parent is statically known, the bare leaf path (a partial identity, never matched by name) otherwise. */
  logical: (repositoryId: string, kind: string, path: string) => `azure-logical|${repositoryId}|${kind}|${path.toLowerCase()}`,
  /** Messaging transports share the identity used by the messaging plugins (transport|repo|broker|kind|name); `name` is `<namespace>/<entity>` when the namespace is statically known. */
  transport: (repositoryId: string, broker: string, kind: string, name: string) => `transport|${repositoryId}|${broker}|${kind}|${name}`,
  trigger: (repositoryId: string, functionKey: string, kind: string) => `azure-trigger|${repositoryId}|${functionKey}|${kind}`,
  entraId: () => "azure-entra-id|global",
};
