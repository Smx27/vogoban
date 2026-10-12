variable "account_name" { type = string }
variable "location" { type = string }
variable "resource_group" { type = string }

resource "azurerm_cosmosdb_account" "this" {
  name                          = var.account_name
  location                      = var.location
  resource_group_name           = var.resource_group
  offer_type                    = "Standard"
  public_network_access_enabled = true
  consistency_policy {
    consistency_level = "Session"
  }
  geo_location {
    location          = var.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "fulfillment" {
  name                = "fulfillmentdb"
  resource_group_name = var.resource_group
  account_name        = azurerm_cosmosdb_account.this.name
}

resource "azurerm_cosmosdb_sql_container" "shipments" {
  name                = "shipments"
  resource_group_name = var.resource_group
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.fulfillment.name
  partition_key_paths = ["/orderId"]
}

output "endpoint" {
  value = azurerm_cosmosdb_account.this.endpoint
}
