variable "vault_name" {
  type        = string
  description = "Key Vault name, vg-enterprise-kv."
}

variable "tenant_id" {
  type        = string
  description = "Azure AD tenant that owns the vault."
}

variable "secrets" {
  type        = map(string)
  description = "Secrets to create, keyed by their logical names, with clearly fake placeholder values."
  default     = {}
}

variable "location" {
  type        = string
  description = "Azure region."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the vault lives in."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource in this module."
  default     = {}
}
