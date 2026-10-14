resource "azurerm_resource_group" "enterprise" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = var.log_analytics_workspace_name
  location            = azurerm_resource_group.enterprise.location
  resource_group_name = azurerm_resource_group.enterprise.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_analytics_retention_in_days
  tags                = local.tags
}

resource "azurerm_application_insights" "this" {
  name                = var.app_insights_name
  location            = azurerm_resource_group.enterprise.location
  resource_group_name = azurerm_resource_group.enterprise.name
  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.this.id
  tags                = local.tags
}

module "servicebus" {
  source = "./modules/servicebus"

  namespace_name                    = var.service_bus_namespace_name
  topic_name                        = var.order_events_topic_name
  order_processor_subscription_name = var.order_processor_subscription_name
  notifications_subscription_name   = var.notifications_subscription_name
  notification_requests_queue_name  = var.notification_requests_queue_name
  report_jobs_queue_name            = var.report_jobs_queue_name
  sku                               = var.service_bus_sku
  location                          = azurerm_resource_group.enterprise.location
  resource_group_name               = azurerm_resource_group.enterprise.name
  tags                              = local.tags
}

module "cosmos" {
  source = "./modules/cosmos"

  account_name             = var.cosmos_account_name
  database_name            = var.cosmos_database_name
  orders_container_name    = var.cosmos_orders_container_name
  customers_container_name = var.cosmos_customers_container_name
  reports_container_name   = var.cosmos_reports_container_name
  max_autoscale_throughput = var.cosmos_max_autoscale_throughput
  location                 = azurerm_resource_group.enterprise.location
  resource_group_name      = azurerm_resource_group.enterprise.name
  tags                     = local.tags
}

module "storage" {
  source = "./modules/storage"

  account_name                         = var.storage_account_name
  replication_type                     = var.storage_replication_type
  notification_payloads_container_name = var.notification_payloads_container_name
  report_artifacts_container_name      = var.report_artifacts_container_name
  location                             = azurerm_resource_group.enterprise.location
  resource_group_name                  = azurerm_resource_group.enterprise.name
  tags                                 = local.tags
}

module "keyvault" {
  source = "./modules/keyvault"

  vault_name          = var.key_vault_name
  tenant_id           = var.tenant_id
  location            = azurerm_resource_group.enterprise.location
  resource_group_name = azurerm_resource_group.enterprise.name
  tags                = local.tags

  secrets = {
    (var.service_bus_connection_secret_name) = "Endpoint=sb://${var.service_bus_namespace_name}.servicebus.windows.net/;SharedAccessKeyName=placeholder-policy;SharedAccessKey=0000000000000000000000000000000000000000000000="
    (var.cosmos_connection_secret_name)      = "AccountEndpoint=https://${var.cosmos_account_name}.documents.azure.com:443/;AccountKey=0000000000000000000000000000000000000000000000000000000000000000=="
    (var.storage_connection_secret_name)     = "DefaultEndpointsProtocol=https;AccountName=${var.storage_account_name};AccountKey=0000000000000000000000000000000000000000000000000000000000000000==;EndpointSuffix=core.windows.net"
  }
}

module "identity" {
  source = "./modules/identity"

  identity_name            = var.identity_name
  subscription_id          = var.subscription_id
  service_bus_namespace_id = module.servicebus.namespace_id
  cosmos_account_id        = module.cosmos.account_id
  storage_account_id       = module.storage.account_id
  key_vault_id             = module.keyvault.vault_id
  location                 = azurerm_resource_group.enterprise.location
  resource_group_name      = azurerm_resource_group.enterprise.name
  tags                     = local.tags
}

module "functionapp" {
  source = "./modules/functionapp"

  plan_name                             = var.app_service_plan_name
  plan_sku_name                         = var.function_app_plan_sku_name
  function_app_name                     = var.function_app_name
  storage_account_name                  = module.storage.account_name
  storage_account_access_key            = module.storage.primary_access_key
  identity_id                           = module.identity.identity_id
  identity_client_id                    = module.identity.client_id
  key_vault_uri                         = module.keyvault.vault_uri
  service_bus_connection_secret_name    = var.service_bus_connection_secret_name
  cosmos_connection_secret_name         = var.cosmos_connection_secret_name
  storage_connection_secret_name        = var.storage_connection_secret_name
  service_bus_fully_qualified_namespace = module.servicebus.fully_qualified_namespace
  cosmos_account_endpoint               = module.cosmos.account_endpoint
  storage_blob_service_uri              = module.storage.blob_service_uri
  app_insights_connection_string        = azurerm_application_insights.this.connection_string
  location                              = azurerm_resource_group.enterprise.location
  resource_group_name                   = azurerm_resource_group.enterprise.name
  tags                                  = local.tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = var.container_apps_environment_name
  location                   = azurerm_resource_group.enterprise.location
  resource_group_name        = azurerm_resource_group.enterprise.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

resource "azurerm_container_app" "this" {
  for_each = local.container_apps

  name                         = each.key
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.enterprise.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [module.identity.identity_id]
  }

  secret {
    name                = "servicebus-connection"
    identity            = module.identity.identity_id
    key_vault_secret_id = "${module.keyvault.vault_uri}secrets/${var.service_bus_connection_secret_name}"
  }

  secret {
    name                = "cosmos-connection"
    identity            = module.identity.identity_id
    key_vault_secret_id = "${module.keyvault.vault_uri}secrets/${var.cosmos_connection_secret_name}"
  }

  secret {
    name                = "storage-connection"
    identity            = module.identity.identity_id
    key_vault_secret_id = "${module.keyvault.vault_uri}secrets/${var.storage_connection_secret_name}"
  }

  ingress {
    external_enabled = each.value.external
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = each.value.min_replicas
    max_replicas = each.value.max_replicas

    dynamic "custom_scale_rule" {
      for_each = each.value.queue_name == "" ? [] : [each.value.queue_name]

      content {
        name             = "servicebus-queue"
        custom_rule_type = "azure-servicebus"

        metadata = {
          queueName    = custom_scale_rule.value
          messageCount = tostring(var.queue_message_count_threshold)
        }

        authentication {
          secret_name       = "servicebus-connection"
          trigger_parameter = "connection"
        }
      }
    }

    container {
      name   = each.key
      image  = "${var.container_image_registry}/${each.key}:${var.container_image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "AZURE_CLIENT_ID"
        value = module.identity.client_id
      }

      env {
        name  = "ASPNETCORE_HTTP_PORTS"
        value = "8080"
      }

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.this.connection_string
      }

      env {
        name  = "Azure__ServiceBus__FullyQualifiedNamespace"
        value = module.servicebus.fully_qualified_namespace
      }

      env {
        name  = "Azure__Cosmos__AccountEndpoint"
        value = module.cosmos.account_endpoint
      }

      env {
        name  = "Azure__Storage__BlobServiceUri"
        value = module.storage.blob_service_uri
      }

      env {
        name  = "Azure__KeyVault__VaultUri"
        value = module.keyvault.vault_uri
      }

      env {
        name  = "Azure__Identity__ManagedIdentityClientId"
        value = module.identity.client_id
      }

      env {
        name        = "ConnectionStrings__ServiceBus"
        secret_name = "servicebus-connection"
      }

      env {
        name        = "ConnectionStrings__Cosmos"
        secret_name = "cosmos-connection"
      }

      env {
        name        = "ConnectionStrings__Storage"
        secret_name = "storage-connection"
      }
    }
  }
}
