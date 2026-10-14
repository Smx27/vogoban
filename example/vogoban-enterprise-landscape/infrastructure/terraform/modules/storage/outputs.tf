output "account_id" {
  description = "Full ARM resource id of the storage account."
  value       = azurerm_storage_account.this.id
}

output "account_name" {
  description = "Logical storage account name, vgentstorage."
  value       = azurerm_storage_account.this.name
}

output "primary_access_key" {
  description = "Primary key the function app storage binding uses."
  value       = azurerm_storage_account.this.primary_access_key
  sensitive   = true
}

output "blob_service_uri" {
  description = "Blob service URI, https://vgentstorage.blob.core.windows.net/."
  value       = azurerm_storage_account.this.primary_blob_endpoint
}

output "notification_payloads_container_id" {
  description = "Full ARM resource id of the vg-notification-payloads container."
  value       = azurerm_storage_container.notification_payloads.id
}

output "report_artifacts_container_id" {
  description = "Full ARM resource id of the vg-report-artifacts container."
  value       = azurerm_storage_container.report_artifacts.id
}
