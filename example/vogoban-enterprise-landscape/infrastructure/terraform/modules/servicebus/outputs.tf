output "namespace_id" {
  description = "Full ARM resource id of the Service Bus namespace."
  value       = azurerm_servicebus_namespace.this.id
}

output "namespace_name" {
  description = "Logical namespace name, vg-enterprise-servicebus."
  value       = azurerm_servicebus_namespace.this.name
}

output "fully_qualified_namespace" {
  description = "Fully qualified namespace host name, vg-enterprise-servicebus.servicebus.windows.net."
  value       = "${azurerm_servicebus_namespace.this.name}.servicebus.windows.net"
}

output "order_events_topic_id" {
  description = "Full ARM resource id of the vg-order-events topic."
  value       = azurerm_servicebus_topic.order_events.id
}

output "order_processor_subscription_id" {
  description = "Full ARM resource id of the vg-order-processor subscription."
  value       = azurerm_servicebus_subscription.order_processor.id
}

output "notifications_subscription_id" {
  description = "Full ARM resource id of the vg-notifications subscription."
  value       = azurerm_servicebus_subscription.notifications.id
}

output "notification_requests_queue_id" {
  description = "Full ARM resource id of the vg-notification-requests queue."
  value       = azurerm_servicebus_queue.notification_requests.id
}

output "report_jobs_queue_id" {
  description = "Full ARM resource id of the vg-report-jobs queue."
  value       = azurerm_servicebus_queue.report_jobs.id
}
