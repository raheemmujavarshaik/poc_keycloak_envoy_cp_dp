# AWS data-plane target (POC objective 2: control plane AWS, data plane AWS).
#
# Deliberately contains NO load balancer, NO public ingress resource, and NO
# inbound security-group rule from 0.0.0.0/0 -- that absence is the point.
# tunnel-agent, envoy, and product-mfe talk to each other over the private
# VPC network only; tunnel-agent's only external connection is outbound to
# the control plane's Agent Comms Service.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  default = "us-east-1"
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets -- no public IP assignment for this stack"
  type        = list(string)
}

variable "ecr_repo_prefix" {
  type = string
}

variable "broker_ws_url" {
  description = "wss:// URL of the control plane's Agent Comms Service tunnel endpoint"
  type        = string
}

variable "data_plane_id" {
  default = "dp_demo"
}

variable "tunnel_token" {
  type      = string
  sensitive = true
}

resource "aws_ecs_cluster" "data_plane" {
  name = "poc-data-plane-aws"
}

# No inbound rules at all -- egress-only. This is what "no inbound listener"
# looks like at the infrastructure level, not just the application level.
resource "aws_security_group" "data_plane" {
  name   = "poc-data-plane-sg"
  vpc_id = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  services = {
    envoy        = { image = "${var.ecr_repo_prefix}/envoy:latest" }
    product-mfe  = { image = "${var.ecr_repo_prefix}/product-mfe:latest" }
    tunnel-agent = { image = "${var.ecr_repo_prefix}/tunnel-agent:latest" }
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "poc-dp-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode              = "awsvpc"
  cpu                       = "256"
  memory                    = "512"
  container_definitions = jsonencode([
    {
      name      = each.key
      image     = each.value.image
      essential = true
      environment = each.key == "tunnel-agent" ? [
        { name = "BROKER_WS_URL", value = var.broker_ws_url },
        { name = "DATA_PLANE_ID", value = var.data_plane_id },
        { name = "TUNNEL_TOKEN", value = var.tunnel_token },
        { name = "ENVOY_URL", value = "http://localhost:10000" },   # matches envoy.yaml listener
      ] : []
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each        = local.services
  name            = "poc-dp-${each.key}"
  cluster         = aws_ecs_cluster.data_plane.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.data_plane.id]
    assign_public_ip = false # private subnet, no public IP -- reachable by nothing inbound
  }
}
