require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rbac = require("./rbacCache");
const catalogStore = require("./catalogStore");
const gravitino = require("./gravitinoClient");

const PORT = process.env.PORT || 4010;
// Shared secret for the control-plane -> data-plane role sync call only.
// This is a POC simplification -- production would use mTLS or a proper
// client-credentials token for this system-to-system hop, per the caveats
// already flagged elsewhere in this POC for the tunnel's own auth model.
const INTERNAL_SYNC_TOKEN = process.env.INTERNAL_SYNC_TOKEN || "poc-internal-sync-secret";

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

  // Best-effort mirror into Gravitino itself -- failure here doesn't fail
  // the sync overall, since the Redis-backed cache is what the gateway's
  // own authorize() calls actually read from.
  try {
    if (await gravitino.isReachable()) {
      const securableObjects = grants.map((g) => ({
        fullName: g.resource,
        type: "FILESET",
        privileges: g.privileges,
      }));
      await gravitino.ensureRole(roleName, securableObjects);
      for (const user of users || []) {
        await gravitino.grantRoleToUser(user, roleName);
      }
    }
  } catch (err) {
    console.warn(`[role-sync] Gravitino mirror failed for role '${roleName}' (cache was still updated):`, err.message);
  }

  console.log(`[role-sync] applied role '${roleName}' for users: ${(users || []).join(", ")}`);
  res.json({ applied: true, roleName });
});

app.get("/internal/roles", async (_req, res) => {
  const roles = await rbac.listAllRoles();
  res.json({ roles });
});

catalogStore.init().then(() => {
  app.listen(PORT, () => {
    console.log(`[authorization-gateway] listening on :${PORT} (catalog mode: ${catalogStore.getMode()})`);
  });
});
