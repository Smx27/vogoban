export interface AzurermParent {
  attribute: string;
  form: "id" | "name";
  armType: string;
}

export interface AzurermMapping {
  armType: string;
  nameAttribute: string | null;
  parents: AzurermParent[];
  /** e.g. kind for web apps: "functionapp,linux" */
  kind?: string;
}

const id = (attribute: string, armType: string): AzurermParent => ({ attribute, form: "id", armType });
const byName = (attribute: string, armType: string): AzurermParent => ({ attribute, form: "name", armType });
const top = (armType: string, kind?: string): AzurermMapping => (kind ? { armType, nameAttribute: "name", parents: [], kind } : { armType, nameAttribute: "name", parents: [] });
const child = (armType: string, parents: AzurermParent[], nameAttribute: string | null = "name", kind?: string): AzurermMapping =>
  kind ? { armType, nameAttribute, parents, kind } : { armType, nameAttribute, parents };

const SB = "Microsoft.ServiceBus/namespaces";
const EH = "Microsoft.EventHub/namespaces";
const ST = "Microsoft.Storage/storageAccounts";
const COSMOS = "Microsoft.DocumentDB/databaseAccounts";
const APIM = "Microsoft.ApiManagement/service";
const SITES = "Microsoft.Web/sites";
const CDN = "Microsoft.Cdn/profiles";
const storageParents = [byName("storage_account_name", ST), id("storage_account_id", ST)];

/** azurerm (3.x/4.x) resource type → canonical ARM type, name attribute and parent-identifying attributes. */
export const AZURERM_TYPES: Readonly<Record<string, AzurermMapping>> = Object.freeze({
  azurerm_resource_group: top("Microsoft.Resources/resourceGroups"),
  azurerm_servicebus_namespace: top(SB),
  azurerm_servicebus_namespace_authorization_rule: child(`${SB}/AuthorizationRules`, [id("namespace_id", SB)]),
  azurerm_servicebus_queue: child(`${SB}/queues`, [id("namespace_id", SB)]),
  azurerm_servicebus_queue_authorization_rule: child(`${SB}/queues/authorizationRules`, [id("queue_id", `${SB}/queues`)]),
  azurerm_servicebus_topic: child(`${SB}/topics`, [id("namespace_id", SB)]),
  azurerm_servicebus_topic_authorization_rule: child(`${SB}/topics/authorizationRules`, [id("topic_id", `${SB}/topics`)]),
  azurerm_servicebus_subscription: child(`${SB}/topics/subscriptions`, [id("topic_id", `${SB}/topics`)]),
  azurerm_servicebus_subscription_rule: child(`${SB}/topics/subscriptions/rules`, [id("subscription_id", `${SB}/topics/subscriptions`)]),
  azurerm_eventhub_namespace: top(EH),
  azurerm_eventhub_namespace_authorization_rule: child(`${EH}/authorizationRules`, [byName("namespace_name", EH)]),
  azurerm_eventhub: child(`${EH}/eventhubs`, [byName("namespace_name", EH), id("namespace_id", EH)]),
  azurerm_eventhub_authorization_rule: child(`${EH}/eventhubs/authorizationRules`, [byName("namespace_name", EH), byName("eventhub_name", `${EH}/eventhubs`)]),
  azurerm_eventhub_consumer_group: child(`${EH}/eventhubs/consumergroups`, [byName("namespace_name", EH), byName("eventhub_name", `${EH}/eventhubs`)]),
  azurerm_eventgrid_topic: top("Microsoft.EventGrid/topics"),
  azurerm_eventgrid_domain: top("Microsoft.EventGrid/domains"),
  azurerm_eventgrid_domain_topic: child("Microsoft.EventGrid/domains/topics", [byName("domain_name", "Microsoft.EventGrid/domains")]),
  azurerm_eventgrid_system_topic: top("Microsoft.EventGrid/systemTopics"),
  azurerm_eventgrid_event_subscription: top("Microsoft.EventGrid/eventSubscriptions"),
  azurerm_eventgrid_system_topic_event_subscription: child("Microsoft.EventGrid/systemTopics/eventSubscriptions", [byName("system_topic", "Microsoft.EventGrid/systemTopics")]),
  azurerm_storage_account: top(ST),
  azurerm_storage_container: child(`${ST}/blobServices/containers`, storageParents),
  azurerm_storage_queue: child(`${ST}/queueServices/queues`, storageParents),
  azurerm_storage_table: child(`${ST}/tableServices/tables`, storageParents),
  azurerm_storage_share: child(`${ST}/fileServices/shares`, storageParents),
  azurerm_cosmosdb_account: top(COSMOS),
  azurerm_cosmosdb_sql_database: child(`${COSMOS}/sqlDatabases`, [byName("account_name", COSMOS)]),
  azurerm_cosmosdb_sql_container: child(`${COSMOS}/sqlDatabases/containers`, [byName("account_name", COSMOS), byName("database_name", `${COSMOS}/sqlDatabases`)]),
  azurerm_cosmosdb_mongo_database: child(`${COSMOS}/mongodbDatabases`, [byName("account_name", COSMOS)]),
  azurerm_cosmosdb_mongo_collection: child(`${COSMOS}/mongodbDatabases/collections`, [byName("account_name", COSMOS), byName("database_name", `${COSMOS}/mongodbDatabases`)]),
  azurerm_mssql_server: top("Microsoft.Sql/servers"),
  azurerm_mssql_database: child("Microsoft.Sql/servers/databases", [id("server_id", "Microsoft.Sql/servers")]),
  azurerm_sql_server: top("Microsoft.Sql/servers"),
  azurerm_sql_database: child("Microsoft.Sql/servers/databases", [byName("server_name", "Microsoft.Sql/servers")]),
  azurerm_postgresql_flexible_server: top("Microsoft.DBforPostgreSQL/flexibleServers"),
  azurerm_postgresql_flexible_server_database: child("Microsoft.DBforPostgreSQL/flexibleServers/databases", [id("server_id", "Microsoft.DBforPostgreSQL/flexibleServers")]),
  azurerm_mysql_flexible_server: top("Microsoft.DBforMySQL/flexibleServers"),
  azurerm_mysql_flexible_database: child("Microsoft.DBforMySQL/flexibleServers/databases", [byName("server_name", "Microsoft.DBforMySQL/flexibleServers")]),
  azurerm_redis_cache: top("Microsoft.Cache/redis"),
  azurerm_key_vault: top("Microsoft.KeyVault/vaults"),
  azurerm_key_vault_secret: child("Microsoft.KeyVault/vaults/secrets", [id("key_vault_id", "Microsoft.KeyVault/vaults")]),
  azurerm_key_vault_key: child("Microsoft.KeyVault/vaults/keys", [id("key_vault_id", "Microsoft.KeyVault/vaults")]),
  azurerm_key_vault_certificate: child("Microsoft.KeyVault/vaults/certificates", [id("key_vault_id", "Microsoft.KeyVault/vaults")]),
  azurerm_key_vault_access_policy: child("Microsoft.KeyVault/vaults/accessPolicies", [id("key_vault_id", "Microsoft.KeyVault/vaults")], null),
  azurerm_service_plan: top("Microsoft.Web/serverfarms"),
  azurerm_app_service_plan: top("Microsoft.Web/serverfarms"),
  azurerm_linux_function_app: top(SITES, "functionapp,linux"),
  azurerm_windows_function_app: top(SITES, "functionapp"),
  azurerm_function_app: top(SITES, "functionapp"),
  azurerm_function_app_flex_consumption: top(SITES, "functionapp,linux"),
  azurerm_linux_function_app_slot: child(`${SITES}/slots`, [id("function_app_id", SITES)], "name", "functionapp,linux"),
  azurerm_windows_function_app_slot: child(`${SITES}/slots`, [id("function_app_id", SITES)], "name", "functionapp"),
  azurerm_linux_web_app: top(SITES, "app,linux"),
  azurerm_windows_web_app: top(SITES, "app"),
  azurerm_app_service: top(SITES, "app"),
  azurerm_linux_web_app_slot: child(`${SITES}/slots`, [id("app_service_id", SITES)], "name", "app,linux"),
  azurerm_windows_web_app_slot: child(`${SITES}/slots`, [id("app_service_id", SITES)], "name", "app"),
  azurerm_logic_app_standard: top(SITES, "functionapp,workflowapp"),
  azurerm_static_web_app: top("Microsoft.Web/staticSites"),
  azurerm_container_app: top("Microsoft.App/containerApps"),
  azurerm_container_app_environment: top("Microsoft.App/managedEnvironments"),
  azurerm_container_app_job: top("Microsoft.App/jobs"),
  azurerm_container_registry: top("Microsoft.ContainerRegistry/registries"),
  azurerm_kubernetes_cluster: top("Microsoft.ContainerService/managedClusters"),
  azurerm_api_management: top(APIM),
  azurerm_api_management_api: child(`${APIM}/apis`, [byName("api_management_name", APIM)]),
  azurerm_api_management_api_operation: child(`${APIM}/apis/operations`, [byName("api_management_name", APIM), byName("api_name", `${APIM}/apis`)], "operation_id"),
  azurerm_api_management_api_policy: child(`${APIM}/apis/policies`, [byName("api_management_name", APIM), byName("api_name", `${APIM}/apis`)], null),
  azurerm_api_management_backend: child(`${APIM}/backends`, [byName("api_management_name", APIM)]),
  azurerm_api_management_product: child(`${APIM}/products`, [byName("api_management_name", APIM)], "product_id"),
  azurerm_api_management_named_value: child(`${APIM}/namedValues`, [byName("api_management_name", APIM)]),
  azurerm_api_management_subscription: child(`${APIM}/subscriptions`, [byName("api_management_name", APIM)], "subscription_id"),
  azurerm_application_insights: top("Microsoft.Insights/components"),
  azurerm_log_analytics_workspace: top("Microsoft.OperationalInsights/workspaces"),
  azurerm_monitor_diagnostic_setting: top("Microsoft.Insights/diagnosticSettings"),
  azurerm_user_assigned_identity: top("Microsoft.ManagedIdentity/userAssignedIdentities"),
  azurerm_role_assignment: top("Microsoft.Authorization/roleAssignments"),
  azurerm_role_definition: child("Microsoft.Authorization/roleDefinitions", [], "role_definition_id"),
  azurerm_virtual_network: top("Microsoft.Network/virtualNetworks"),
  azurerm_subnet: child("Microsoft.Network/virtualNetworks/subnets", [byName("virtual_network_name", "Microsoft.Network/virtualNetworks")]),
  azurerm_private_endpoint: top("Microsoft.Network/privateEndpoints"),
  azurerm_private_dns_zone: top("Microsoft.Network/privateDnsZones"),
  azurerm_private_dns_zone_virtual_network_link: child("Microsoft.Network/privateDnsZones/virtualNetworkLinks", [byName("private_dns_zone_name", "Microsoft.Network/privateDnsZones"), id("private_dns_zone_id", "Microsoft.Network/privateDnsZones")]),
  azurerm_private_dns_a_record: child("Microsoft.Network/privateDnsZones/A", [byName("zone_name", "Microsoft.Network/privateDnsZones")]),
  azurerm_network_security_group: top("Microsoft.Network/networkSecurityGroups"),
  azurerm_public_ip: top("Microsoft.Network/publicIPAddresses"),
  azurerm_application_gateway: top("Microsoft.Network/applicationGateways"),
  azurerm_frontdoor: top("Microsoft.Network/frontDoors"),
  azurerm_cdn_frontdoor_profile: top(CDN),
  azurerm_cdn_frontdoor_endpoint: child(`${CDN}/afdEndpoints`, [id("cdn_frontdoor_profile_id", CDN)]),
  azurerm_cdn_frontdoor_origin_group: child(`${CDN}/originGroups`, [id("cdn_frontdoor_profile_id", CDN)]),
  azurerm_cdn_frontdoor_origin: child(`${CDN}/originGroups/origins`, [id("cdn_frontdoor_origin_group_id", `${CDN}/originGroups`)]),
  azurerm_cdn_frontdoor_route: child(`${CDN}/afdEndpoints/routes`, [id("cdn_frontdoor_endpoint_id", `${CDN}/afdEndpoints`)]),
  azurerm_app_configuration: top("Microsoft.AppConfiguration/configurationStores"),
  azurerm_app_configuration_key: child("Microsoft.AppConfiguration/configurationStores/keyValues", [id("configuration_store_id", "Microsoft.AppConfiguration/configurationStores")], "key"),
  azurerm_signalr_service: top("Microsoft.SignalRService/signalR"),
  azurerm_web_pubsub: top("Microsoft.SignalRService/webPubSub"),
  azurerm_logic_app_workflow: top("Microsoft.Logic/workflows"),
  azurerm_cognitive_account: top("Microsoft.CognitiveServices/accounts"),
  azurerm_search_service: top("Microsoft.Search/searchServices"),
});

/** Mapping for an azurerm resource type, or null when the type is not in the table. */
export function azurermMapping(type: string): AzurermMapping | null {
  return Object.hasOwn(AZURERM_TYPES, type) ? AZURERM_TYPES[type]! : null;
}
