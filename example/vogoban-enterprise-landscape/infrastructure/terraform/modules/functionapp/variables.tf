variable "plan_name" {
  type        = string
  description = "App Service plan name, vg-enterprise-plan."
}

variable "plan_sku_name" {
  type        = string
  description = "App Service plan SKU, for example Y1 for the consumption plan."
  default     = "Y1"
}

variable "function_app_name" {
  type        = string
  description = "Linux function app name, vg-order-processor-function."
}

variable "storage_account_name" {
  type        = string
  description = "Storage account backing the function app, vgentstorage."
}

variable "storage_account_access_key" {
  type        = string
  description = "Access key of that storage account."
  sensitive   = true
}

variable "identity_id" {
  type        = string
  description = "Full ARM resource id of the user-assigned managed identity the app runs as."
}

variable "identity_client_id" {
  type        = string
  description = "Client id of that identity, exported as AZURE_CLIENT_ID."
}

variable "key_vault_uri" {
  type        = string
  description = "Vault URI every Key Vault reference in app_settings is built from."
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

variable "service_bus_fully_qualified_namespace" {
  type        = string
  description = "Fully qualified Service Bus namespace, vg-enterprise-servicebus.servicebus.windows.net."
}

variable "cosmos_account_endpoint" {
  type        = string
  description = "Cosmos DB account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/."
}

variable "storage_blob_service_uri" {
  type        = string
  description = "Blob service URI, https://vgentstorage.blob.core.windows.net/."
}

variable "app_insights_connection_string" {
  type        = string
  description = "Application Insights connection string."
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the plan and the app live in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
