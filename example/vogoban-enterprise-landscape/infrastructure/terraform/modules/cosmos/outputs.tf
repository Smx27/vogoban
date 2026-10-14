output "account_id" {
  description = "Full ARM resource id of the Cosmos DB account."
  value       = azurerm_cosmosdb_account.this.id
}

output "account_name" {
  description = "Logical account name, vg-enterprise-cosmos."
  value       = azurerm_cosmosdb_account.this.name
}

output "account_endpoint" {
  description = "Account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/."
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "database_id" {
  description = "Full ARM resource id of the vg-enterprise database."
  value       = azurerm_cosmosdb_sql_database.this.id
}

output "database_name" {
  description = "Logical database name, vg-enterprise."
  value       = azurerm_cosmosdb_sql_database.this.name
}

output "orders_container_id" {
  description = "Full ARM resource id of the vg-orders container."
  value       = azurerm_cosmosdb_sql_container.orders.id
}

output "customers_container_id" {
  description = "Full ARM resource id of the vg-customers container."
  value       = azurerm_cosmosdb_sql_container.customers.id
}

output "reports_container_id" {
  description = "Full ARM resource id of the vg-reports container."
  value       = azurerm_cosmosdb_sql_container.reports.id
}
