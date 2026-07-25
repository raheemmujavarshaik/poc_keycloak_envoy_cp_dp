#!/bin/bash
# Lock down the demo schemas so access is strictly what the Authorization
# Gateway grants. Roles are NOT created here anymore: the gateway creates the
# group roles (data_scientist, data_engineer — NOLOGIN) and the per-user login
# roles, driven by the RBAC it reads from Gravitino. No per-person account and
# no group-role passwords live in this script.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  REVOKE ALL ON SCHEMA mlops, dataplatform FROM PUBLIC;
EOSQL

echo "[postgres-init] schemas locked down; gateway will create roles/users from Gravitino RBAC"
