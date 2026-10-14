output "resource_group_id" {
  description = "Full ARM resource id of the resource group every other id is rooted in."
  value       = azurerm_resource_group.enterprise.id
}

output "resource_group_name" {
  description = "Resource group name, rg-vg-enterprise."
  value       = azurerm_resource_group.enterprise.name
}

output "service_bus_namespace_id" {
  description = "Full ARM resource id of the vg-enterprise-servicebus namespace."
  value       = module.servicebus.namespace_id
}

output "service_bus_fully_qualified_namespace" {
  description = "Fully qualified namespace, vg-enterprise-servicebus.servicebus.windows.net."
  value       = module.servicebus.fully_qualified_namespace
}

output "order_events_topic_id" {
  description = "Full ARM resource id of the vg-order-events topic."
  value       = module.servicebus.order_events_topic_id
}

output "order_processor_subscription_id" {
  description = "Full ARM resource id of the vg-order-processor subscription."
  value       = module.servicebus.order_processor_subscription_id
}

output "notifications_subscription_id" {
  description = "Full ARM resource id of the vg-notifications subscription."
  value       = module.servicebus.notifications_subscription_id
}

output "notification_requests_queue_id" {
  description = "Full ARM resource id of the vg-notification-requests queue."
  value       = module.servicebus.notification_requests_queue_id
}

output "report_jobs_queue_id" {
  description = "Full ARM resource id of the vg-report-jobs queue."
  value       = module.servicebus.report_jobs_queue_id
}

output "cosmos_account_id" {
  description = "Full ARM resource id of the vg-enterprise-cosmos account."
  value       = module.cosmos.account_id
}

output "cosmos_account_endpoint" {
  description = "Cosmos DB account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/."
  value       = module.cosmos.account_endpoint
}

output "cosmos_database_id" {
  description = "Full ARM resource id of the vg-enterprise database."
  value       = module.cosmos.database_id
}

output "cosmos_orders_container_id" {
  description = "Full ARM resource id of the vg-orders container."
  value       = module.cosmos.orders_container_id
}

output "cosmos_customers_container_id" {
  description = "Full ARM resource id of the vg-customers container."
  value       = module.cosmos.customers_container_id
}

output "cosmos_reports_container_id" {
  description = "Full ARM resource id of the vg-reports container."
  value       = module.cosmos.reports_container_id
}

output "storage_account_id" {
  description = "Full ARM resource id of the vgentstorage account."
  value       = module.storage.account_id
}

output "storage_blob_service_uri" {
  description = "Blob service URI, https://vgentstorage.blob.core.windows.net/."
  value       = module.storage.blob_service_uri
}

output "notification_payloads_container_id" {
  description = "Full ARM resource id of the vg-notification-payloads container."
  value       = module.storage.notification_payloads_container_id
}

output "report_artifacts_container_id" {
  description = "Full ARM resource id of the vg-report-artifacts container."
  value       = module.storage.report_artifacts_container_id
}

output "key_vault_id" {
  description = "Full ARM resource id of the vg-enterprise-kv vault."
  value       = module.keyvault.vault_id
}

output "key_vault_uri" {
  description = "Vault URI, https://vg-enterprise-kv.vault.azure.net/."
  value       = module.keyvault.vault_uri
}

output "key_vault_secret_ids" {
  description = "Full ARM resource ids of the three vault secrets, keyed by secret name."
  value       = module.keyvault.secret_ids
}

output "managed_identity_id" {
  description = "Full ARM resource id of the vg-enterprise-identity user-assigned identity."
  value       = module.identity.identity_id
}

output "managed_identity_principal_id" {
  description = "Principal id the five role assignments grant to."
  value       = module.identity.principal_id
}

output "managed_identity_client_id" {
  description = "Client id the workloads present as AZURE_CLIENT_ID."
  value       = module.identity.client_id
}

output "role_assignment_ids" {
  description = "Full ARM resource ids of the role assignments on the identity."
  value       = module.identity.role_assignment_ids
}

output "log_analytics_workspace_id" {
  description = "Full ARM resource id of the vg-enterprise-logs workspace."
  value       = azurerm_log_analytics_workspace.this.id
}

output "app_insights_id" {
  description = "Full ARM resource id of the vg-enterprise-appinsights component."
  value       = azurerm_application_insights.this.id
}

output "app_insights_connection_string" {
  description = "Connection string the deployed services write telemetry with."
  value       = azurerm_application_insights.this.connection_string
  sensitive   = true
}

output "app_service_plan_id" {
  description = "Full ARM resource id of the vg-enterprise-plan."
  value       = module.functionapp.plan_id
}

output "function_app_id" {
  description = "Full ARM resource id of the vg-order-processor-function app."
  value       = module.functionapp.function_app_id
}

output "function_app_default_hostname" {
  description = "Default host name of the function app."
  value       = module.functionapp.function_app_default_hostname
}

output "container_apps_environment_id" {
  description = "Full ARM resource id of the vg-enterprise-aca-env environment."
  value       = azurerm_container_app_environment.this.id
}

output "container_app_ids" {
  description = "Full ARM resource ids of the four container apps, keyed by deployment unit name."
  value       = { for name, app in azurerm_container_app.this : name => app.id }
}
