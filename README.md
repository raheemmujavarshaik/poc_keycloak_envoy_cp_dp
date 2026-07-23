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

docker compose -f docker-compose.yml up --build
```

Then:

1. Open http://localhost:3000
2. Try `sarah.choi@acme.test` / `AcmePassword123!` -- routed through the simulated Acme enterprise IdP (a second Keycloak realm acting as the broker target)
3. Try `jordan.lee@beta.test` / `BetaPassword123!` -- native Keycloak login, no broker hop
4. Try `anyone@suspended.test` -- blocked before any redirect to Keycloak happens at all
5. After logging in, click "Open Product" -- this loads the Product MFE's `remoteEntry.js` through the BFF \u2192 Agent Comms Service \u2192 tunnel \u2192 Envoy \u2192 product-mfe chain

### Verifying "no inbound port" for yourself

```bash
docker compose -f docker-compose.yml ps
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
  `token-exchange` feature flag (already set in `docker-compose.yml`)
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

## Extension: Gravitino RBAC, roles/groups, and the unified catalog

Layered on top of the baseline above. Adds three new services and extends
four existing ones:

- **`data-plane/gravitino`** -- real Apache Gravitino server
  (`apache/gravitino:1.0.1`), the data plane's RBAC authority and unified
  data catalog (`metalake → catalog → schema → fileset`).
- **`data-plane/authorization-gateway`** (new) -- the only client that talks
  to Gravitino. Extends Gravitino RBAC to app-level resources, exposes the
  unified catalog search behind the Catalog UI, and receives role syncs from
  the control plane. Has its own Redis (`dp-redis`), separate from the control
  plane's, matching the "each data plane owns its own cache" principle. No
  host port -- reached only via Envoy's `/authz` route and via the tunnel.
- **`control-plane/user-management-service`** (extended) -- `roles.js` (role
  CRUD + assignment API under `/roles`) and `roleSync.js` (a Redis Streams
  producer + consumer-group worker: MongoDB is the only source of truth for
  *who has which role*; every sync pushes full desired state, never a delta,
  so retries are always safe). `db.js` seeds two role templates
  (`data_engineer`, `data_scientist`).
- **`control-plane/agent-comms-service`** (extended) -- the broker now
  forwards all non-hop-by-hop headers, not just two hardcoded ones. Without
  this the internal role-sync token was silently dropped and role propagation
  never reached the data plane.
- **`data-plane/envoy`** (extended) -- new `/authz/*` routes to the
  Authorization Gateway (written as the two-route prefix-strip pattern Envoy's
  docs recommend). `/authz/internal` is exempted from the user-token
  `jwt_authn` requirement, since it's a system-to-system call gated instead by
  the gateway's own `x-internal-sync-token`.
- **`data-plane/platform-apps-service`** (new) -- a sample product
  microservice with two app domains: **MLOps Studio** (resources under
  `platform_apps.mlops.*`) and **Data Platform Studio** (under
  `platform_apps.dataplatform.workspaces.*`). Every action (view/create/edit/
  delete) is enforced by calling the Authorization Gateway's `/v1/authorize`
  before doing anything -- the concrete "product microservice asks the gateway
  yes/no" pattern. No host port; reached via Envoy's `/apps` route.
- **`control-plane/app-shell`** (extended) -- three panels on top of the
  product remote, all through the same same-origin BFF-proxied path:
  - **Browse Catalog** -- unified catalog search (Gravitino-backed).
  - **Manage Roles** -- assign/unassign roles and see a user's resolved,
    data-plane-enforced capabilities via `authorize/batch`.
  - **App Workbench** -- pick an acting user and fire real view/create/edit/
    delete calls at `platform-apps-service`; a 200 vs 403 is the actual
    RBAC decision. Includes a who-can-do-what matrix across the seeded users.

`user-management-service`'s `db.js` also seeds a few test users with different
role combinations (alice=`data_engineer`, bob=`data_scientist`, carol=both,
dave=none) and `roleSync.js` runs an initial full sync on startup, so the
Workbench has something to exercise the moment the stack is up.

### How the pieces connect

```
Role assignment (MongoDB, control plane)
  → roleSync.js → Redis Stream "role-sync-events"
  → worker re-reads FULL desired state from MongoDB
  → POST through agent-comms broker → tunnel → Envoy /authz/internal
  → gateway /internal/role-sync (auth'd by x-internal-sync-token)
      → writes through to dp-redis      ← what authorize() actually reads
      → best-effort mirror into Gravitino
```

The dp-redis cache is authoritative for authorize() decisions; the Gravitino
write is best-effort and non-fatal. `privilegeMap.js` maps Gravitino's coarse
privileges (`READ/WRITE/CREATE_FILESET`) to fine app actions (`view/create/edit`).

### What's tested

The Gravitino catalog integration is **live-verified against
`apache/gravitino:1.0.1`**: the gateway connects, seeds the demo catalog, and
`/v1/catalog/search` returns real Gravitino-backed results (`catalog mode:
gravitino` in its startup log). Four fixes were needed to get there and are
already applied here:

1. Gravitino's config bind-mount is copied into place at startup (its
   `rewrite_gravitino_server_config.py` does `os.remove()` on the file, which
   fails on a bind-mounted single file with "Device or resource busy").
2. Its healthcheck uses `curl` (the old `/dev/tcp` check was a bash builtin
   that `/bin/sh` doesn't have, so it could never pass).
3. The gateway probes `/metalakes` (not `/metalakes/<name>`, which 404s on a
   fresh server and forced permanent mock mode).
4. Catalog object names are sanitized for Gravitino (dots are illegal in
   entity names, e.g. `customers_2025.csv`); the human name is kept as a
   `displayName` property.

If Gravitino ever isn't reachable, the gateway **falls back to a mock catalog
automatically** -- check its startup log for `catalog mode: gravitino` vs
`catalog mode: mock`.

### Trying it out

1. Log in as `sarah.choi@acme.test` (see the main Quickstart above).
2. Click **Browse Catalog** -- searches the unified catalog and returns 4
   results for a "customer" search.
3. Assign a role and watch it propagate (needs a logged-in session cookie):
   ```bash
   curl -X POST http://localhost:4002/roles/data_scientist/assign \
     -H "Content-Type: application/json" -H "Cookie: <your session cookie>" \
     -d '{"userEmail":"sarah.choi@acme.test"}'
   ```
   Check `docker compose -f docker-compose.yml logs authorization-gateway`
   for `[role-sync] applied role...` -- that confirms the full MongoDB → Redis
   Streams → tunnel → Authorization Gateway path just ran.
4. Confirm the decision landed (the gateway has no host port, so exec in):
   ```bash
   docker compose -f docker-compose.yml exec authorization-gateway \
     node -e "require('http').request({host:'localhost',port:4010,path:'/v1/authorize',method:'POST',headers:{'content-type':'application/json'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).end(JSON.stringify({user:'sarah.choi@acme.test',resource:'platform_apps.mlops.training_jobs',action:'create'}))"
   ```
   Expect `{"allowed":true,"viaRole":"data_scientist"}`; re-run with
   `action:"delete"` to see it correctly denied (coarse-to-fine mapping).
5. Click **App Workbench** to test the two roles across multiple users
   without any curl. The seeded users (alice=`data_engineer`,
   bob=`data_scientist`, carol=both, dave=none) start already assigned. Pick
   an "act as" user and fire view/create/edit/delete at either app -- each
   button calls the real `platform-apps-service`, which authorizes via the
   gateway, so the 200/403 you see is genuine enforcement. Expected shape:
   - Bob can view/create/edit in **MLOps** but not delete, and is denied in
     **Data Platform**.
   - Alice is the mirror image (Data Platform yes, MLOps no).
   - Carol can act in both; Dave is denied everywhere.

## Repo layout

```
control-plane/
  org-validation-service/    # validates org + resolves enterprise IdP alias
  user-management-service/   # OIDC login/callback, session, data-plane proxy,
                              #   role CRUD (roles.js), role sync worker (roleSync.js)
  agent-comms-service/       # Tunnel Broker + HTTP relay surface
  keycloak/                  # realm exports (inaiera + simulated acme broker)
  app-shell/                 # React host + Catalog UI, Manage Roles, App Workbench
data-plane/
  envoy/                     # envoy.yaml, jwt_authn config, /authz + /apps + /api/countries routing
  tunnel-agent/               # outbound-only agent, dials the broker
  product-mfe/                # React remote, Module Federation provider
  countries-service/          # sample second data-plane microservice (tunnel demo)
  authorization-gateway/      # Gravitino RBAC extension + unified catalog search
  platform-apps-service/      # MLOps + Data Platform demo apps, gateway-enforced RBAC
  gravitino/                  # gravitino.conf (real Apache Gravitino server)
infra/
  aws-control-plane/          # always used
  aws-data-plane/              # objective 2
  azure-data-plane/            # objective 1
  gcp-data-plane/              # objective 3
docker-compose.yml       # full local stack
```

## Running a cross-cloud objective (1 or 3)

1. `docker compose -f docker-compose.yml up mongo redis keycloak org-validation-service user-management-service agent-comms-service app-shell` (control plane only, still local for this POC -- swap for `infra/aws-control-plane` once you're ready to deploy it for real)
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
