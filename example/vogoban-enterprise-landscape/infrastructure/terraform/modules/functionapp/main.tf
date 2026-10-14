locals {
  key_vault_service_bus_reference = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/${var.service_bus_connection_secret_name}/)"
  key_vault_cosmos_reference      = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/${var.cosmos_connection_secret_name}/)"
  key_vault_storage_reference     = "@Microsoft.KeyVault(SecretUri=${var.key_vault_uri}secrets/${var.storage_connection_secret_name}/)"
}

resource "azurerm_service_plan" "this" {
  name                = var.plan_name
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = var.plan_sku_name
  tags                = var.tags
}

resource "azurerm_linux_function_app" "this" {
  name                       = var.function_app_name
  resource_group_name        = var.resource_group_name
  location                   = var.location
  service_plan_id            = azurerm_service_plan.this.id
  storage_account_name       = var.storage_account_name
  storage_account_access_key = var.storage_account_access_key
  https_only                 = true
  tags                       = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  site_config {
    ftps_state          = "Disabled"
    minimum_tls_version = "1.2"
    http2_enabled       = true

    application_stack {
      dotnet_version              = "8.0"
      use_dotnet_isolated_runtime = true
    }
  }

  app_settings = {
    FUNCTIONS_WORKER_RUNTIME                   = "dotnet-isolated"
    AzureWebJobsStorage                        = local.key_vault_storage_reference
    AZURE_CLIENT_ID                            = var.identity_client_id
    APPLICATIONINSIGHTS_CONNECTION_STRING      = var.app_insights_connection_string
    ConnectionStrings__ServiceBus              = local.key_vault_service_bus_reference
    ConnectionStrings__Cosmos                  = local.key_vault_cosmos_reference
    ConnectionStrings__Storage                 = local.key_vault_storage_reference
    Azure__ServiceBus__FullyQualifiedNamespace = var.service_bus_fully_qualified_namespace
    Azure__Cosmos__AccountEndpoint             = var.cosmos_account_endpoint
    Azure__Storage__BlobServiceUri             = var.storage_blob_service_uri
    Azure__KeyVault__VaultUri                  = var.key_vault_uri
    Azure__Identity__ManagedIdentityClientId   = var.identity_client_id
  }
}
