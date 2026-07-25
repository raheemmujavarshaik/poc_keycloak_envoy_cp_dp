require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rbac = require("./rbacCache");
const catalogStore = require("./catalogStore");
const gravitino = require("./gravitinoClient");
const pg = require("./pgClient");

const PORT = process.env.PORT || 4010;
// Shared secret for the control-plane -> data-plane role sync call only.
// This is a POC simplification -- production would use mTLS or a proper
// client-credentials token for this system-to-system hop, per the caveats
// already flagged elsewhere in this POC for the tunnel's own auth model.
const INTERNAL_SYNC_TOKEN = process.env.INTERNAL_SYNC_TOKEN || "poc-internal-sync-secret";

// RBAC definition seeded INTO Gravitino at startup (Gravitino = source of
// truth). Maps our role name -> the pg_catalog schema privileges it grants. An
// operator can change these directly in Gravitino afterward; the connector
// always reads them back from Gravitino before provisioning Postgres.
const PG_ROLE_SEED = {
  data_scientist: [{ schema: "mlops", privileges: ["SELECT_TABLE"] }],
  data_engineer: [{ schema: "dataplatform", privileges: ["SELECT_TABLE", "MODIFY_TABLE"] }],
};

/**
 * Provision a Postgres group role by READING its privileges from Gravitino
 * (not from dp-redis / the sync payload). Optionally reconcile its members.
 * Returns true if the Gravitino role actually carries Postgres privileges.
 */
async function provisionPgRoleFromGravitino(roleName, users) {
  const role = await gravitino.getRole(roleName);
  const specs = pg.pgGrantsFromGravitinoRole(role);
  if (!specs.length) return false;
  await pg.syncGroupRole(roleName, specs);
  if (Array.isArray(users)) await pg.reconcileMembers(roleName, users);
  return true;
}

/** Startup: model Postgres in Gravitino and seed the PG roles' privileges there. */
async function setupPgRbacInGravitino() {
  if (!(await gravitino.isReachable())) {
    console.warn("[pg-rbac] Gravitino not reachable -- skipping PG catalog/role seed");
    return;
  }
  try {
    await gravitino.ensureMetalake();
    await gravitino.ensurePgCatalog();
    for (const [roleName, schemaGrants] of Object.entries(PG_ROLE_SEED)) {
      await gravitino.ensurePgRole(roleName, schemaGrants);
    }
    console.log(`[pg-rbac] Gravitino PG catalog + roles ready: ${Object.keys(PG_ROLE_SEED).join(", ")}`);
  } catch (err) {
    console.warn("[pg-rbac] setup failed:", err.response?.data?.message || err.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/healthz", async (_req, res) => {
  res.json({ status: "ok", catalogMode: catalogStore.getMode() });
});

/**
 * Single authorize check. Called by product microservices (or, in this POC,
 * directly by the Catalog UI through the BFF proxy) for a yes/no decision.
 */
app.post("/v1/authorize", async (req, res) => {
  const { user, resource, action } = req.body || {};
  if (!user || !resource || !action) {
    return res.status(400).json({ error: "missing_fields", message: "user, resource, and action are required" });
  }
  const result = await rbac.authorize(user, resource, action);
  res.json(result);
});

/** Batch check -- e.g. "what can this user do under platform_apps.mlops.*". */
app.post("/v1/authorize/batch", async (req, res) => {
  const { user, resourcePrefix, actions } = req.body || {};
  if (!user || !resourcePrefix) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const candidateActions = actions || ["view", "create", "edit"];
  const allowed = [];
  for (const action of candidateActions) {
    const result = await rbac.authorize(user, resourcePrefix, action);
    if (result.allowed) allowed.push(action);
  }
  res.json({ resourcePrefix, allowed });
});

/**
 * The unified catalog search surface behind the Catalog UI -- registers as
 * TABLE / VIEW / VECTOR / FILE, matching the InAiEra Catalog design.
 * Read-only and unauthenticated at this layer in the POC (the BFF proxy in
 * front of this already requires a session); a full implementation would
 * also filter results per-user through rbac.authorize() before returning
 * them, which is left as a clearly-flagged simplification here.
 */
app.get("/v1/catalog/search", async (req, res) => {
  const results = await catalogStore.search(req.query.q);
  res.json({ query: req.query.q || "", count: results.length, results });
});

/**
 * Receives a role sync from the control plane's Role Sync Worker, via the
 * same tunnel every other data-plane request uses. Writes through to the
 * local RBAC cache and (best-effort) into Gravitino itself.
 */
app.post("/internal/role-sync", async (req, res) => {
  if (req.header("x-internal-sync-token") !== INTERNAL_SYNC_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { roleName, grants, users } = req.body || {};
  if (!roleName || !Array.isArray(grants)) {
    return res.status(400).json({ error: "missing_fields" });
  }

  await rbac.applyRoleSync({ roleName, grants, users });

  // Assign users to the role IN GRAVITINO. Gravitino is the RBAC source of
  // truth; the role's privileges were seeded into Gravitino at startup, and
  // this records who holds the role (read back at credential-vend time).
  try {
    if (await gravitino.isReachable()) {
      for (const user of users || []) await gravitino.grantRoleToUser(user, roleName);
    }
  } catch (err) {
    console.warn(`[role-sync] Gravitino user-grant failed for '${roleName}':`, err.message);
  }

  // Provision Postgres by READING the role's privileges back from Gravitino
  // (group-role GRANTs) and mapping the listed users onto it (per-user PG
  // roles + membership). Best-effort: a Postgres/Gravitino outage must not
  // fail the sync (dp-redis already holds the app-level RBAC above).
  try {
    if (await gravitino.isReachable()) {
      const isPg = await provisionPgRoleFromGravitino(roleName, users || []);
      if (isPg) console.log(`[role-sync] provisioned Postgres for role '${roleName}'`);
    }
  } catch (err) {
    console.warn(`[role-sync] Postgres provisioning failed for '${roleName}':`, err.message);
  }

  console.log(`[role-sync] applied role '${roleName}' for users: ${(users || []).join(", ")}`);
  res.json({ applied: true, roleName });
});

app.get("/internal/roles", async (_req, res) => {
  const roles = await rbac.listAllRoles();
  res.json({ roles });
});

/**
 * Vend Postgres credentials for a user, per the architect's model:
 *   1. Read the user's roles FROM GRAVITINO (source of truth).
 *   2. Keep only roles that actually carry Postgres privileges in Gravitino,
 *      provisioning each group role's GRANTs on the way (idempotent).
 *   3. Ensure the user's own PG login role is a member of those group roles.
 *   4. Rotate + return the user's password. The user connects AS themselves
 *      and inherits the group role's privileges. No shared group password.
 * User identity is taken from the request (POC: body.user or X-Act-As-User);
 * a full impl would derive it from the validated data-plane ticket.
 */
app.post("/v1/pg/credentials", async (req, res) => {
  const user = (req.body && req.body.user) || req.header("x-act-as-user");
  if (!user) return res.status(400).json({ error: "missing_user" });

  try {
    const roles = await gravitino.getUserRoles(user);

    const pgRoles = [];
    for (const r of roles) {
      if (await provisionPgRoleFromGravitino(r)) pgRoles.push(r);
    }
    if (!pgRoles.length) {
      return res.status(403).json({
        allowed: false,
        user,
        roles,
        message: `${user} has no Gravitino role that grants Postgres access`,
      });
    }

    await pg.addUserToGroups(user, pgRoles);
    const connection = await pg.vendUserCredentials(user);
    const access = await pg.effectiveAccess(user); // live from Postgres
    res.json({ user, roles: pgRoles, connection, access });
  } catch (err) {
    console.error(`[pg/credentials] failed for '${user}':`, err.message);
    res.status(500).json({ error: "vend_failed", message: err.message });
  }
});

catalogStore.init()
  .then(setupPgRbacInGravitino)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[authorization-gateway] listening on :${PORT} (catalog mode: ${catalogStore.getMode()})`);
    });
  })
  .catch((err) => {
    console.error("[authorization-gateway] startup error:", err);
    process.exit(1);
  });
