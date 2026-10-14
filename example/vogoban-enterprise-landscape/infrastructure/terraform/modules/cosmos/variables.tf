variable "account_name" {
  type        = string
  description = "Cosmos DB account name, vg-enterprise-cosmos."
}

variable "database_name" {
  type        = string
  description = "SQL database shared by every service, vg-enterprise."
}

variable "orders_container_name" {
  type        = string
  description = "Container holding orders, partitioned by /customerId."
}

variable "customers_container_name" {
  type        = string
  description = "Container holding customers, partitioned by /id."
}

variable "reports_container_name" {
  type        = string
  description = "Container holding reports, partitioned by /reportType."
}

variable "max_autoscale_throughput" {
  type        = number
  description = "Autoscale ceiling in RU/s applied to every container."
  default     = 4000
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the account lives in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
