# GCP data-plane target (POC objective 3: control plane AWS, data plane
# GCP). Uses Cloud Run -- simplest managed-container runtime on GCP for POC
# speed over GKE.
#
# envoy and product-mfe are deployed with ingress = "internal" (only
# reachable from within the VPC via a Serverless VPC connector), not
# "all" -- there is no public ingress. tunnel-agent needs no ingress
# setting at all since it never receives inbound traffic in the first
# place; it only dials out.

terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type = string
}

variable "region" {
  default = "us-central1"
}

variable "artifact_registry_prefix" {
  description = "e.g. us-central1-docker.pkg.dev/PROJECT/poc"
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

resource "google_cloud_run_v2_service" "envoy" {
  name     = "poc-dp-envoy"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY" # not internet-facing

  template {
    containers {
      image = "${var.artifact_registry_prefix}/envoy:latest"
      # Cloud Run defaults its inbound port to 8080; Envoy now listens on
      # 10000, so declare it explicitly. Cloud Run will still surface the
      # service on 443/HTTPS externally; container_port is what it forwards to.
      ports {
        container_port = 10000
      }
    }
  }
}

resource "google_cloud_run_v2_service" "product_mfe" {
  name     = "poc-dp-product-mfe"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.artifact_registry_prefix}/product-mfe:latest"
    }
  }
}

resource "google_cloud_run_v2_service" "tunnel_agent" {
  name     = "poc-dp-tunnel-agent"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = "${var.artifact_registry_prefix}/tunnel-agent:latest"
      env {
        name  = "BROKER_WS_URL"
        value = var.broker_ws_url
      }
      env {
        name  = "DATA_PLANE_ID"
        value = var.data_plane_id
      }
      env {
        name  = "TUNNEL_TOKEN"
        value = var.tunnel_token
      }
      env {
        name  = "ENVOY_URL"
        value = google_cloud_run_v2_service.envoy.uri
      }
    }
  }
}
