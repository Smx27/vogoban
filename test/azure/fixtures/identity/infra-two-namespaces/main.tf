resource "azurerm_servicebus_namespace" "alpha" {
  name                = "sb-alpha"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "alpha_orders" {
  name         = "orders"
  namespace_id = azurerm_servicebus_namespace.alpha.id
}

resource "azurerm_servicebus_topic" "alpha_events" {
  name         = "events"
  namespace_id = azurerm_servicebus_namespace.alpha.id
}

resource "azurerm_servicebus_subscription" "alpha_audit" {
  name               = "audit"
  topic_id           = azurerm_servicebus_topic.alpha_events.id
  max_delivery_count = 10
}

resource "azurerm_servicebus_namespace" "beta" {
  name                = "sb-beta"
  location            = "westeurope"
  resource_group_name = "rg-identity"
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "beta_orders" {
  name         = "orders"
  namespace_id = azurerm_servicebus_namespace.beta.id
}

resource "azurerm_servicebus_topic" "beta_events" {
  name         = "events"
  namespace_id = azurerm_servicebus_namespace.beta.id
}

resource "azurerm_servicebus_subscription" "beta_audit" {
  name               = "audit"
  topic_id           = azurerm_servicebus_topic.beta_events.id
  max_delivery_count = 10
}

resource "azurerm_role_assignment" "unnamed_one" {
  scope                = azurerm_servicebus_namespace.alpha.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = "00000000-0000-0000-0000-00000000c0de"
}

resource "azurerm_role_assignment" "unnamed_two" {
  scope                = azurerm_servicebus_namespace.beta.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = "00000000-0000-0000-0000-00000000c0de"
}
