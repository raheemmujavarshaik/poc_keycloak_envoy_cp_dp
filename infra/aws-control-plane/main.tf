# AWS control plane -- used identically across all three POC objectives.
# Runs the four control-plane services as ECS Fargate tasks behind an ALB.
#
# This is scaffolding, not a tested/applied config: fill in your own
# account-specific values (VPC, subnets, ECR image URIs) before running
# `terraform apply`. Kept intentionally minimal for POC purposes -- no
# autoscaling, no multi-AZ redundancy, no secrets-manager wiring.

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
  description = "Existing VPC ID to deploy into"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the Fargate tasks (public, for POC simplicity)"
  type        = list(string)
}

variable "ecr_repo_prefix" {
  description = "e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/poc"
  type        = string
}

resource "aws_ecs_cluster" "control_plane" {
  name = "poc-control-plane"
}

resource "aws_security_group" "control_plane" {
  name   = "poc-control-plane-sg"
  vpc_id = var.vpc_id

  ingress {
    description = "HTTP from anywhere (POC only -- restrict in any real deployment)"
    from_port   = 3000
    to_port     = 4003
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  services = {
    org-validation-service   = { port = 4001, image = "${var.ecr_repo_prefix}/org-validation-service:latest" }
    user-management-service  = { port = 4002, image = "${var.ecr_repo_prefix}/user-management-service:latest" }
    agent-comms-service      = { port = 4003, image = "${var.ecr_repo_prefix}/agent-comms-service:latest" }
    app-shell                = { port = 3000, image = "${var.ecr_repo_prefix}/app-shell:latest" }
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "poc-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  container_definitions = jsonencode([
    {
      name         = each.key
      image        = each.value.image
      portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
      essential    = true
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each        = local.services
  name            = "poc-${each.key}"
  cluster         = aws_ecs_cluster.control_plane.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = true
  }
}

output "cluster_name" {
  value = aws_ecs_cluster.control_plane.name
}
