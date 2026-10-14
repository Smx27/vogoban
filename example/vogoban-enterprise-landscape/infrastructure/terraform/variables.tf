variable "subscription_id" {
  type        = string
  description = "Subscription every ARM resource id in this configuration is rooted in. Placeholder value, never a real subscription."
  default     = "00000000-0000-0000-0000-000000000000"
}

variable "tenant_id" {
  type        = string
  description = "Azure AD tenant owning the vault and the identities. Placeholder value, never a real tenant."
  default     = "00000000-0000-0000-0000-000000000000"
}

variable "environment" {
  type        = string
  description = "Environment layer this configuration represents. Resource names are identical in every environment; only sizing and this label change."
  default     = "dev"
}

variable "location" {
  type        = string
  description = "Azure region."
  default     = "westeurope"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group holding the whole estate."
  default     = "rg-vg-enterprise"
}

variable "service_bus_namespace_name" {
  type        = string
  description = "Service Bus namespace name."
  default     = "vg-enterprise-servicebus"
}

variable "order_events_topic_name" {
  type        = string
  description = "Topic carrying order lifecycle events."
  default     = "vg-order-events"
}

variable "order_processor_subscription_name" {
  type        = string
  description = "Subscription on the topic consumed by the order-processing function."
  default     = "vg-order-processor"
}

variable "notifications_subscription_name" {
  type        = string
  description = "Subscription on the topic consumed by the notification service."
  default     = "vg-notifications"
}

variable "notification_requests_queue_name" {
  type        = string
  description = "Queue the notification service consumes and KEDA scales on."
  default     = "vg-notification-requests"
}

variable "report_jobs_queue_name" {
  type        = string
  description = "Queue the reporting platform consumes."
  default     = "vg-report-jobs"
}

variable "service_bus_sku" {
  type        = string
  description = "Service Bus tier."
  default     = "Standard"
}

variable "cosmos_account_name" {
  type        = string
  description = "Cosmos DB account name."
  default     = "vg-enterprise-cosmos"
}

variable "cosmos_database_name" {
  type        = string
  description = "SQL database shared by every service."
  default     = "vg-enterprise"
}

variable "cosmos_orders_container_name" {
  type        = string
  description = "Container holding orders, partitioned by /customerId."
  default     = "vg-orders"
}

variable "cosmos_customers_container_name" {
  type        = string
  description = "Container holding customers, partitioned by /id."
  default     = "vg-customers"
}

variable "cosmos_reports_container_name" {
  type        = string
  description = "Container holding reports, partitioned by /reportType."
  default     = "vg-reports"
}

variable "cosmos_max_autoscale_throughput" {
  type        = number
  description = "Autoscale ceiling in RU/s applied to every Cosmos container."
  default     = 4000
}

variable "storage_account_name" {
  type        = string
  description = "Storage account name."
  default     = "vgentstorage"
}

variable "storage_replication_type" {
  type        = string
  description = "Replication of the storage account, LRS, ZRS or GRS."
  default     = "LRS"
}

variable "notification_payloads_container_name" {
  type        = string
  description = "Blob container holding notification payloads."
  default     = "vg-notification-payloads"
}

variable "report_artifacts_container_name" {
  type        = string
  description = "Blob container holding report artifacts."
  default     = "vg-report-artifacts"
}

variable "key_vault_name" {
  type        = string
  description = "Key Vault name."
  default     = "vg-enterprise-kv"
}

variable "service_bus_connection_secret_name" {
  type        = string
  description = "Secret holding the Service Bus connection string."
  default     = "vg-servicebus-connection"
}

variable "cosmos_connection_secret_name" {
  type        = string
  description = "Secret holding the Cosmos DB connection string."
  default     = "vg-cosmos-connection"
}

variable "storage_connection_secret_name" {
  type        = string
  description = "Secret holding the storage connection string."
  default     = "vg-storage-connection"
}

variable "identity_name" {
  type        = string
  description = "User-assigned managed identity every workload runs as."
  default     = "vg-enterprise-identity"
}

variable "log_analytics_workspace_name" {
  type        = string
  description = "Log Analytics workspace name."
  default     = "vg-enterprise-logs"
}

variable "log_analytics_retention_in_days" {
  type        = number
  description = "Log Analytics retention in days."
  default     = 30
}

variable "app_insights_name" {
  type        = string
  description = "Application Insights component name."
  default     = "vg-enterprise-appinsights"
}

variable "app_service_plan_name" {
  type        = string
  description = "App Service plan name."
  default     = "vg-enterprise-plan"
}

variable "function_app_plan_sku_name" {
  type        = string
  description = "App Service plan SKU of the function app, Y1 being the consumption plan."
  default     = "Y1"
}

variable "function_app_name" {
  type        = string
  description = "Linux function app name."
  default     = "vg-order-processor-function"
}

variable "container_apps_environment_name" {
  type        = string
  description = "Container Apps environment name."
  default     = "vg-enterprise-aca-env"
}

variable "platform_gateway_app_name" {
  type        = string
  description = "Deployment unit served by the gateway container app."
  default     = "vg-platform-gateway"
}

variable "orders_api_app_name" {
  type        = string
  description = "Deployment unit served by the orders container app."
  default     = "vg-orders-api"
}

variable "customers_api_app_name" {
  type        = string
  description = "Deployment unit served by the customers container app."
  default     = "vg-customers-api"
}

variable "notification_service_app_name" {
  type        = string
  description = "Deployment unit served by the notification container app."
  default     = "vg-notification-service"
}

variable "container_image_registry" {
  type        = string
  description = "Registry the container app images are pulled from."
  default     = "vgentacr.azurecr.io"
}

variable "container_image_tag" {
  type        = string
  description = "Image tag deployed to every container app."
  default     = "1.0.0"
}

variable "container_app_min_replicas" {
  type        = number
  description = "Minimum replica count of every container app."
  default     = 1
}

variable "container_app_max_replicas" {
  type        = number
  description = "Maximum replica count of the gateway, orders and customers apps."
  default     = 3
}

variable "notification_service_max_replicas" {
  type        = number
  description = "Maximum replica count of the notification service, which scales on the Service Bus queue."
  default     = 10
}

variable "queue_message_count_threshold" {
  type        = number
  description = "Queue length the service bus scale rule scales on."
  default     = 10
}
