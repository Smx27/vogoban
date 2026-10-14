resource "azurerm_user_assigned_identity" "main" {
  name                = var.identity_name
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_role_assignment" "service_bus_data_sender" {
  scope              = var.service_bus_namespace_id
  role_definition_id = "${local.role_definition_prefix}/${local.service_bus_data_sender_role_id}"
  principal_id       = azurerm_user_assigned_identity.main.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "service_bus_data_receiver" {
  scope              = var.service_bus_namespace_id
  role_definition_id = "${local.role_definition_prefix}/${local.service_bus_data_receiver_role_id}"
  principal_id       = azurerm_user_assigned_identity.main.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "cosmos_db_data_contributor" {
  scope              = var.cosmos_account_id
  role_definition_id = "${local.role_definition_prefix}/${local.cosmos_db_data_contributor_role_id}"
  principal_id       = azurerm_user_assigned_identity.main.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "storage_blob_data_contributor" {
  scope              = var.storage_account_id
  role_definition_id = "${local.role_definition_prefix}/${local.storage_blob_data_contributor_role_id}"
  principal_id       = azurerm_user_assigned_identity.main.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "key_vault_secrets_user" {
  scope              = var.key_vault_id
  role_definition_id = "${local.role_definition_prefix}/${local.key_vault_secrets_user_role_id}"
  principal_id       = azurerm_user_assigned_identity.main.principal_id
  principal_type     = "ServicePrincipal"
}

locals {
  role_definition_prefix = "/subscriptions/${var.subscription_id}/providers/Microsoft.Authorization/roleDefinitions"

  service_bus_data_sender_role_id       = "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39"
  service_bus_data_receiver_role_id     = "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0"
  cosmos_db_data_contributor_role_id    = "00000000-0000-0000-0000-000000000002"
  storage_blob_data_contributor_role_id = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"
  key_vault_secrets_user_role_id        = "4633458b-17de-408a-b874-0445c86b69e6"
}
