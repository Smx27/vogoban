resource "azurerm_servicebus_namespace" "only" {
  name                = "sb-only"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "orders" {
  name         = "orders"
  namespace_id = azurerm_servicebus_namespace.only.id
}
