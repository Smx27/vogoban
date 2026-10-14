variable "account_name" {
  type        = string
  description = "Storage account name, vgentstorage."
}

variable "replication_type" {
  type        = string
  description = "Replication of the storage account, for example LRS or GRS."
  default     = "LRS"
}

variable "notification_payloads_container_name" {
  type        = string
  description = "Blob container holding notification payloads."
}

variable "report_artifacts_container_name" {
  type        = string
  description = "Blob container holding report artifacts."
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the storage account lives in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
