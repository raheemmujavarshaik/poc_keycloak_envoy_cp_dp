# POC: Control Plane / Data Plane Architecture

Proves three things: the outbound-only tunnel pattern works identically across
AWS, Azure, and GCP; the org-validation-before-redirect login ordering is
enforceable; and a browser can load a data-plane-hosted micro-frontend without
the data plane ever exposing an inbound port. See `POC_Implementation_Plan.md`
(the companion planning doc) for the full objective breakdown.

## What's real here

Every service in this repo is real, runnable code -- not scaffolding. The
core tunnel mechanism (Tunnel Broker \u2194 Tunnel Agent, including relaying a
real built JS bundle byte-for-byte) has been live-tested during development,
not just written. The three cloud Terraform configs under `infra/` are
scaffolding you'll need to fill in with your own account details -- they
haven't been applied against real cloud accounts.

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (only needed if you want to run services outside Docker)
- For the cross-cloud objectives: your own AWS, Azure, and GCP accounts/credentials

## Quickstart: local loopback (Milestone 1)

```bash
# One-time: make Keycloak resolvable identically from your browser and from
# other containers, so the issuer claim in tokens stays consistent. This is
# the standard fix for the classic "Keycloak behind Docker Compose" hostname
# problem -- add this line to /etc/hosts:
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts

docker compose -f docker-compose.local.yml up --build
```

Then:

1. Open http://localhost:3000
2. Try `sarah.choi@acme.test` / `AcmePassword123!` -- routed through the simulated Acme enterprise IdP (a second Keycloak realm acting as the broker target)
3. Try `jordan.lee@beta.test` / `BetaPassword123!` -- native Keycloak login, no broker hop
4. Try `anyone@suspended.test` -- blocked before any redirect to Keycloak happens at all
5. After logging in, click "Open Product" -- this loads the Product MFE's `remoteEntry.js` through the BFF \u2192 Agent Comms Service \u2192 tunnel \u2192 Envoy \u2192 product-mfe chain

### Verifying "no inbound port" for yourself

```bash
docker compose -f docker-compose.local.yml ps
```

Confirm `envoy`, `product-mfe`, and `tunnel-agent` show no host port mappings
(no `0.0.0.0:PORT->PORT` in the output) -- only `mongo`, `redis`, `keycloak`,
the three control-plane services, and `app-shell` should have any.

## Known caveats (read before demoing)

- **mTLS \u2192 bearer token.** The tunnel uses TLS + a per-tenant bearer token
  (`TUNNEL_AGENT_TOKENS`), not the certificate-pinned mTLS described in the
  full production design. Say this out loud in any demo -- it still proves
  outbound-only connectivity and broker-blind relay, just not the full
  production credential lifecycle.
- **Keycloak token exchange (RFC 8693) is best-effort.** It requires the
  `token-exchange` feature flag (already set in `docker-compose.local.yml`)
  plus additional fine-grained permission grants that aren't fully
  pre-configured in the static realm export. If it's not enabled, the code
  in `user-management-service/src/keycloak.js` falls back to using the
  session's own access token directly -- still a real, Envoy-verifiable JWT,
  just not narrowed to a single data plane's audience. The demo works either
  way; only that one scoping property is weaker until token exchange is
  fully wired up.
- **Envoy's JWKS fetch is `remote_jwks`, not the production `local_jwks`
  mirror.** Fine for a local demo where Keycloak is always reachable; the
  full design mirrors keys via GitOps so each data plane has zero runtime
  dependency on the control plane for token validation.
- **Kubernetes was skipped in favor of managed containers** (ECS
  Fargate / Container Apps / Cloud Run) for all three cloud targets, to keep
  the POC's own footprint small. This is a deliberate divergence from the
  production EKS/AKS/GKE plan -- if your team needs the POC to also validate
  the Kubernetes deployment story, that's a different, heavier POC.

## Repo layout

```
control-plane/
  org-validation-service/    # validates org + resolves enterprise IdP alias
  user-management-service/   # OIDC login/callback, session, data-plane proxy
  agent-comms-service/       # Tunnel Broker + HTTP relay surface
  keycloak/                  # realm exports (inaiera + simulated acme broker)
  app-shell/                 # React host, Module Federation consumer
data-plane/
  envoy/                     # envoy.yaml, jwt_authn config
  tunnel-agent/               # outbound-only agent, dials the broker
  product-mfe/                # React remote, Module Federation provider
infra/
  aws-control-plane/          # always used
  aws-data-plane/              # objective 2
  azure-data-plane/            # objective 1
  gcp-data-plane/              # objective 3
docker-compose.local.yml       # full local stack
```

## Running a cross-cloud objective (1 or 3)

1. `docker compose -f docker-compose.local.yml up mongo redis keycloak org-validation-service user-management-service agent-comms-service app-shell` (control plane only, still local for this POC -- swap for `infra/aws-control-plane` once you're ready to deploy it for real)
2. Fill in the relevant `infra/{azure,gcp}-data-plane/main.tf` variables (registry URLs, project/subscription IDs, and critically `broker_ws_url` pointing at wherever `agent-comms-service` is reachable from that cloud)
3. Build and push the three data-plane images (`envoy`, `product-mfe`, `tunnel-agent`) to that cloud's container registry
4. `terraform init && terraform apply` in the relevant `infra/` directory
5. Update `app-shell`'s `VITE_DATA_PLANE_ID` / the org record's `dataPlaneId` in MongoDB if you're targeting a different data plane than `dp_demo`
6. Re-run the login flow and the "no inbound port" check (this time via that cloud's console/CLI network tools instead of `docker compose ps`)

## Troubleshooting

- **Login redirect loops or "state mismatch" errors**: almost always the
  `/etc/hosts` step above -- if Keycloak's issuer doesn't match between the
  browser-facing and container-facing requests, token validation fails
  downstream.
- **"data_plane_unreachable" (502) from agent-comms-service**: the tunnel
  agent hasn't registered yet, or registered with the wrong token. Check
  `docker compose logs tunnel-agent` and `docker compose logs agent-comms-service`.
- **Product MFE fails to load**: check the browser console first -- a CORS
  error there usually means the BFF's proxy isn't attaching headers
  correctly; a 401 usually means the session cookie isn't being sent
  (confirm `credentials: "include"` is intact and `FRONTEND_URL` matches
  where you're actually loading the app shell from).
