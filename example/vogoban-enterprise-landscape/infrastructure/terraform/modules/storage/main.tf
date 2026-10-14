resource "azurerm_storage_account" "this" {
  name                            = var.account_name
  location                        = var.location
  resource_group_name             = var.resource_group_name
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = var.replication_type
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  tags                            = var.tags

  blob_properties {
    delete_retention_policy {
      days = 7
    }
  }
}

resource "azurerm_storage_container" "notification_payloads" {
  name                  = var.notification_payloads_container_name
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "report_artifacts" {
  name                  = var.report_artifacts_container_name
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}
