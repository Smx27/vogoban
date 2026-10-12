resource "azurerm_resource_group" "platform" {
  name     = "rg-contoso-platform-${var.environment}"
  location = var.location
}

resource "azurerm_servicebus_namespace" "platform" {
  name                = "sb-contoso-platform"
  location            = azurerm_resource_group.platform.location
  resource_group_name = azurerm_resource_group.platform.name
  sku                 = "Standard"
  local_auth_enabled  = false
}

resource "azurerm_servicebus_topic" "shipments" {
  name         = "shipments"
  namespace_id = azurerm_servicebus_namespace.platform.id
}

resource "azurerm_servicebus_subscription" "notifications" {
  name               = "notifications"
  topic_id           = azurerm_servicebus_topic.shipments.id
  max_delivery_count = 10
}

data "azurerm_servicebus_namespace" "orders" {
  name                = "sb-contoso-orders"
  resource_group_name = "rg-contoso-orders-${var.environment}"
}

data "azurerm_servicebus_topic" "orders" {
  name         = "orders"
  namespace_id = data.azurerm_servicebus_namespace.orders.id
}

resource "azurerm_servicebus_subscription" "fulfillment" {
  name               = "fulfillment"
  topic_id           = data.azurerm_servicebus_topic.orders.id
  max_delivery_count = 5
}

module "fulfillment_data" {
  source         = "./modules/cosmos"
  account_name   = "cosmos-contoso-fulfillment"
  location       = var.location
  resource_group = azurerm_resource_group.platform.name
}

resource "azurerm_user_assigned_identity" "fulfillment" {
  name                = "id-contoso-fulfillment"
  location            = var.location
  resource_group_name = azurerm_resource_group.platform.name
}

resource "azurerm_role_assignment" "fulfillment_receiver" {
  scope                = data.azurerm_servicebus_namespace.orders.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.fulfillment.principal_id
}

resource "azurerm_role_assignment" "platform_owner" {
  scope                = azurerm_resource_group.platform.id
  role_definition_name = "Owner"
  principal_id         = azurerm_user_assigned_identity.fulfillment.principal_id
}
