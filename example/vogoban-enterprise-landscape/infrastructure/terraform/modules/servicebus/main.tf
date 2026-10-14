resource "azurerm_servicebus_namespace" "this" {
  name                = var.namespace_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku
  minimum_tls_version = "1.2"
  tags                = var.tags
}

resource "azurerm_servicebus_topic" "order_events" {
  name                  = var.topic_name
  namespace_id          = azurerm_servicebus_namespace.this.id
  partitioning_enabled  = false
  max_size_in_megabytes = 1024
}

resource "azurerm_servicebus_subscription" "order_processor" {
  name                                 = var.order_processor_subscription_name
  topic_id                             = azurerm_servicebus_topic.order_events.id
  max_delivery_count                   = var.max_delivery_count
  dead_lettering_on_message_expiration = true
  default_message_ttl                  = "P14D"
}

resource "azurerm_servicebus_subscription" "notifications" {
  name                                 = var.notifications_subscription_name
  topic_id                             = azurerm_servicebus_topic.order_events.id
  max_delivery_count                   = var.max_delivery_count
  dead_lettering_on_message_expiration = true
  default_message_ttl                  = "P14D"
}

resource "azurerm_servicebus_queue" "notification_requests" {
  name                                 = var.notification_requests_queue_name
  namespace_id                         = azurerm_servicebus_namespace.this.id
  max_delivery_count                   = var.max_delivery_count
  dead_lettering_on_message_expiration = true
  default_message_ttl                  = "P7D"
}

resource "azurerm_servicebus_queue" "report_jobs" {
  name                                 = var.report_jobs_queue_name
  namespace_id                         = azurerm_servicebus_namespace.this.id
  max_delivery_count                   = var.max_delivery_count
  dead_lettering_on_message_expiration = true
  default_message_ttl                  = "P7D"
}
