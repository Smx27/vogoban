variable "namespace_name" {
  type        = string
  description = "Service Bus namespace name, vg-enterprise-servicebus."
}

variable "topic_name" {
  type        = string
  description = "Topic carrying order lifecycle events, vg-order-events."
}

variable "order_processor_subscription_name" {
  type        = string
  description = "Subscription on the topic consumed by the order-processing function."
}

variable "notifications_subscription_name" {
  type        = string
  description = "Subscription on the topic consumed by the notification service."
}

variable "notification_requests_queue_name" {
  type        = string
  description = "Queue the notification service consumes and KEDA scales on."
}

variable "report_jobs_queue_name" {
  type        = string
  description = "Queue the reporting platform consumes."
}

variable "sku" {
  type        = string
  description = "Messaging tier of the namespace."
  default     = "Standard"
}

variable "max_delivery_count" {
  type        = number
  description = "Delivery attempts before a message is dead-lettered."
  default     = 10
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the namespace lives in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
