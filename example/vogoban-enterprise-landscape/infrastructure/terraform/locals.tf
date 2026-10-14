locals {
  tags = {
    "vg:system"      = "vg-enterprise"
    "vg:repository"  = "infrastructure"
    "vg:environment" = var.environment
  }

  resource_group_id = "/subscriptions/${var.subscription_id}/resourceGroups/${var.resource_group_name}"

  container_apps = {
    (var.platform_gateway_app_name) = {
      external     = true
      min_replicas = var.container_app_min_replicas
      max_replicas = var.container_app_max_replicas
      queue_name   = ""
    }
    (var.orders_api_app_name) = {
      external     = false
      min_replicas = var.container_app_min_replicas
      max_replicas = var.container_app_max_replicas
      queue_name   = ""
    }
    (var.customers_api_app_name) = {
      external     = false
      min_replicas = var.container_app_min_replicas
      max_replicas = var.container_app_max_replicas
      queue_name   = ""
    }
    (var.notification_service_app_name) = {
      external     = false
      min_replicas = var.container_app_min_replicas
      max_replicas = var.notification_service_max_replicas
      queue_name   = var.notification_requests_queue_name
    }
  }
}
