# Azure data-plane target (POC objective 1: control plane AWS, data plane
# Azure). Uses Azure Container Apps -- the simplest managed-container
# runtime on Azure, chosen for POC speed over AKS.
#
# No ingress is configured for any of these three container apps. Container
# Apps' "ingress" block is entirely omitted here, which is what makes them
# unreachable from outside the environment -- tunnel-agent reaches out to
# the control plane on its own, nothing reaches in.

terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.0" }
  }
}

provider "azurerm" {
  features {}
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  default = "eastus"
}

variable "acr_login_server" {
  description = "e.g. pocregistry.azurecr.io"
  type        = string
}

variable "broker_ws_url" {
  type = string
}

variable "data_plane_id" {
  default = "dp_demo"
}

variable "tunnel_token" {
  type      = string
  sensitive = true
}

resource "azurerm_container_app_environment" "data_plane" {
  name                = "poc-data-plane-azure"
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_container_app" "envoy" {
  name                         = "poc-dp-envoy"
  container_app_environment_id = azurerm_container_app_environment.data_plane.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  # No `ingress` block -- intentionally not externally reachable.

  template {
    container {
      name   = "envoy"
      image  = "${var.acr_login_server}/envoy:latest"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }
}

resource "azurerm_container_app" "product_mfe" {
  name                         = "poc-dp-product-mfe"
  container_app_environment_id = azurerm_container_app_environment.data_plane.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"

  template {
    container {
      name   = "product-mfe"
      image  = "${var.acr_login_server}/product-mfe:latest"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }
}

resource "azurerm_container_app" "tunnel_agent" {
  name                         = "poc-dp-tunnel-agent"
  container_app_environment_id = azurerm_container_app_environment.data_plane.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  # No `ingress` block here either -- this one dials out, nothing dials in.

  template {
    container {
      name   = "tunnel-agent"
      image  = "${var.acr_login_server}/tunnel-agent:latest"
      cpu    = 0.25
      memory = "0.5Gi"
      env {
        name  = "BROKER_WS_URL"
        value = var.broker_ws_url
      }
      env {
        name  = "DATA_PLANE_ID"
        value = var.data_plane_id
      }
      env {
        name        = "TUNNEL_TOKEN"
        secret_name = "tunnel-token"
      }
      env {
        name  = "ENVOY_URL"
        # Container Apps internal DNS + Envoy listener port. Also requires the
        # envoy Container App to declare `ingress { target_port = 10000,
        # external_enabled = false }` for inter-app discovery to route here —
        # add that block if you enable this data-plane target.
        value = "http://poc-dp-envoy:10000"
      }
    }
  }

  secret {
    name  = "tunnel-token"
    value = var.tunnel_token
  }
}
