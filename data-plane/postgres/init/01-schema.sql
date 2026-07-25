-- Demo data for the RBAC-over-Postgres POC.
-- Two schemas mirror the app domains: mlops (data_scientist territory) and
-- dataplatform (data_engineer territory). Table/schema privileges on these are
-- granted to the group roles by the Authorization Gateway, driven by the
-- control plane's Gravitino role grants -- never per-user.

CREATE SCHEMA IF NOT EXISTS mlops;
CREATE SCHEMA IF NOT EXISTS dataplatform;

CREATE TABLE IF NOT EXISTS mlops.training_runs (
  id          SERIAL PRIMARY KEY,
  model_name  TEXT NOT NULL,
  status      TEXT NOT NULL,
  accuracy    NUMERIC(5,4),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mlops.models (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'staging'
);

CREATE TABLE IF NOT EXISTS dataplatform.pipelines (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  schedule    TEXT NOT NULL,
  last_run    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dataplatform.workspaces (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_email TEXT NOT NULL
);

INSERT INTO mlops.training_runs (model_name, status, accuracy) VALUES
  ('churn-predictor', 'succeeded', 0.9123),
  ('fraud-detector',  'running',   NULL),
  ('demand-forecast', 'succeeded', 0.8471)
ON CONFLICT DO NOTHING;

INSERT INTO mlops.models (name, version, stage) VALUES
  ('churn-predictor', 'v3', 'production'),
  ('fraud-detector',  'v1', 'staging')
ON CONFLICT DO NOTHING;

INSERT INTO dataplatform.pipelines (name, schedule, last_run) VALUES
  ('daily-ingest',    '0 2 * * *', now() - interval '6 hours'),
  ('hourly-rollup',   '0 * * * *', now() - interval '30 minutes')
ON CONFLICT DO NOTHING;

INSERT INTO dataplatform.workspaces (name, owner_email) VALUES
  ('team_alpha', 'alice.engineer@acme.test'),
  ('team_beta',  'carol.lead@acme.test')
ON CONFLICT DO NOTHING;
