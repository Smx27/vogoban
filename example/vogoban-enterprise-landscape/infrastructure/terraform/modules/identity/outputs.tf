output "identity_id" {
  description = "Full ARM resource id of the user-assigned managed identity."
  value       = azurerm_user_assigned_identity.main.id
}

output "principal_id" {
  description = "Principal id the role assignments grant to."
  value       = azurerm_user_assigned_identity.main.principal_id
}

output "client_id" {
  description = "Client id the workloads present as AZURE_CLIENT_ID."
  value       = azurerm_user_assigned_identity.main.client_id
}

output "role_assignment_ids" {
  description = "Full ARM resource ids of the five role assignments on the identity."
  value = [
    azurerm_role_assignment.service_bus_data_sender.id,
    azurerm_role_assignment.service_bus_data_receiver.id,
    azurerm_role_assignment.cosmos_db_data_contributor.id,
    azurerm_role_assignment.storage_blob_data_contributor.id,
    azurerm_role_assignment.key_vault_secrets_user.id,
  ]
}
