variable "identity_name" {
  type        = string
  description = "User-assigned managed identity name, vg-enterprise-identity."
}

variable "subscription_id" {
  type        = string
  description = "Subscription the role definitions are addressed in. Placeholder in this repository."
}

variable "service_bus_namespace_id" {
  type        = string
  description = "Scope the Service Bus Data Sender and Data Receiver assignments are granted on."
}

variable "cosmos_account_id" {
  type        = string
  description = "Scope the Cosmos DB Data Contributor assignment is granted on."
}

variable "storage_account_id" {
  type        = string
  description = "Scope the Storage Blob Data Contributor assignment is granted on."
}

variable "key_vault_id" {
  type        = string
  description = "Scope the Key Vault Secrets User assignment is granted on."
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the identity lives in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
