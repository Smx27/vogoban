output "plan_id" {
  description = "Full ARM resource id of the App Service plan."
  value       = azurerm_service_plan.this.id
}

output "function_app_id" {
  description = "Full ARM resource id of the Linux function app."
  value       = azurerm_linux_function_app.this.id
}

output "function_app_default_hostname" {
  description = "Default host name of the function app."
  value       = azurerm_linux_function_app.this.default_hostname
}
