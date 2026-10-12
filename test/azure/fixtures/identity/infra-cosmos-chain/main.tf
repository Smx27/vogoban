resource "azurerm_cosmosdb_account" "shop" {
  name                = "cosmos-shop"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  offer_type          = "Standard"
}

resource "azurerm_cosmosdb_sql_database" "orders" {
  name                = "ordersdb"
  resource_group_name = "rg-identity"
  account_name        = azurerm_cosmosdb_account.shop.name
}

resource "azurerm_cosmosdb_sql_container" "orders" {
  name                = "orders"
  resource_group_name = "rg-identity"
  account_name        = azurerm_cosmosdb_account.shop.name
  database_name       = azurerm_cosmosdb_sql_database.orders.name
  partition_key_path  = "/id"
}

resource "azurerm_cosmosdb_sql_container" "by_literal_names" {
  name                = "audit"
  resource_group_name = "rg-identity"
  account_name        = "cosmos-external"
  database_name       = "auditdb"
  partition_key_path  = "/id"
}

resource "azurerm_eventhub_namespace" "telemetry" {
  name                = "evh-telemetry"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  sku                 = "Standard"
}

resource "azurerm_eventhub" "clicks" {
  name                = "clicks"
  namespace_name      = azurerm_eventhub_namespace.telemetry.name
  resource_group_name = "rg-identity"
  partition_count     = 2
  message_retention   = 1
}

resource "azurerm_eventhub_consumer_group" "analytics" {
  name                = "analytics"
  namespace_name      = azurerm_eventhub_namespace.telemetry.name
  eventhub_name       = azurerm_eventhub.clicks.name
  resource_group_name = "rg-identity"
}

resource "azurerm_storage_account" "files" {
  name                     = "stidentityfiles"
  location                 = "westeurope"
  resource_group_name      = "rg-identity"
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "uploads" {
  name                 = "uploads"
  storage_account_name = azurerm_storage_account.files.name
}

resource "azurerm_storage_queue" "jobs" {
  name                 = "jobs"
  storage_account_name = azurerm_storage_account.files.name
}

resource "azurerm_storage_table" "audit" {
  name                 = "audit"
  storage_account_name = azurerm_storage_account.files.name
}

resource "azurerm_key_vault" "secrets" {
  name                = "kv-identity"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  tenant_id           = "00000000-0000-0000-0000-000000000000"
  sku_name            = "standard"
}

resource "azurerm_key_vault_secret" "db_password" {
  name         = "DbPassword"
  value        = "CANARY-NOT-A-REAL-SECRET"
  key_vault_id = azurerm_key_vault.secrets.id
}
