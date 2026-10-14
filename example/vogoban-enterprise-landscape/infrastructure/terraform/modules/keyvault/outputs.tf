output "vault_id" {
  description = "Full ARM resource id of the vault."
  value       = azurerm_key_vault.this.id
}

output "vault_name" {
  description = "Logical vault name, vg-enterprise-kv."
  value       = azurerm_key_vault.this.name
}

output "vault_uri" {
  description = "Vault URI, https://vg-enterprise-kv.vault.azure.net/."
  value       = azurerm_key_vault.this.vault_uri
}

output "secret_ids" {
  description = "Full ARM resource ids of the vault secrets, keyed by secret name."
  value       = { for name, secret in azurerm_key_vault_secret.this : name => secret.id }
}
