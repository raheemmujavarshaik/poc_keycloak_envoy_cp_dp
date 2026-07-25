const axios = require("axios");

const GRAVITINO_URL = process.env.GRAVITINO_URL || "http://gravitino:8090";
const METALAKE = process.env.GRAVITINO_METALAKE || "org_demo";
// The JDBC catalog that models the data-plane Postgres. Its tables/schemas
// become Gravitino securable objects, so roles can carry real table privileges.
const PG_CATALOG = process.env.GRAVITINO_PG_CATALOG || "pg_catalog";

const client = axios.create({ baseURL: `${GRAVITINO_URL}/api`, timeout: 8000 });
const enc = encodeURIComponent;

/**
 * IMPORTANT: these REST paths follow Gravitino's documented API
 * conventions but were not verified against a live server in the
 * environment this POC was built in (no Docker daemon available there).
 * If any of these calls 404 or return an unexpected shape against your
 * actual running Gravitino, check that version's REST reference
 * (typically browsable at GRAVITINO_URL/swagger or in its docs) and adjust
 * the paths/payloads here accordingly -- the rest of the gateway (caching,
 * privilege mapping, catalog search, the tunnel-based role sync) does not
 * need to change either way, since it's all built against this module's
 * exported functions, not against Gravitino's wire format directly.
 */

async function isReachable() {
  try {
    // Probe the list endpoint, NOT /metalakes/${METALAKE} -- the specific
    // metalake doesn't exist on a fresh server and would 404, making a
    // perfectly healthy Gravitino look unreachable (and dropping us into
    // mock mode). /metalakes returns 200 even when the list is empty.
    await client.get(`/metalakes`);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureMetalake() {
  try {
    await client.get(`/metalakes/${METALAKE}`);
  } catch {
    await client.post(`/metalakes`, { name: METALAKE, comment: "POC demo metalake" });
  }
}

async function ensureCatalog(catalogName, type = "fileset", provider = "hadoop") {
  try {
    await client.get(`/metalakes/${METALAKE}/catalogs/${catalogName}`);
  } catch {
    await client.post(`/metalakes/${METALAKE}/catalogs`, {
      name: catalogName,
      type,
      provider,
      comment: `POC ${catalogName} catalog`,
      properties: {},
    });
  }
}

async function ensureSchema(catalogName, schemaName) {
  try {
    await client.get(`/metalakes/${METALAKE}/catalogs/${catalogName}/schemas/${schemaName}`);
  } catch {
    await client.post(`/metalakes/${METALAKE}/catalogs/${catalogName}/schemas`, {
      name: schemaName,
      comment: `POC ${schemaName} schema`,
      properties: {},
    });
  }
}

/** Registers a demo catalog object (table/view/vector/file) as a Fileset entry, tagged with `kind`. */
async function registerCatalogObject(catalogName, schemaName, { name, kind, comment, properties }) {
  try {
    await client.post(`/metalakes/${METALAKE}/catalogs/${catalogName}/schemas/${schemaName}/filesets`, {
      name,
      comment,
      type: "MANAGED",
      storageLocation: `/poc-demo/${catalogName}/${schemaName}/${name}`,
      properties: { kind, ...properties },
    });
  } catch (err) {
    if (err.response?.status !== 409) throw err; // 409 = already exists, fine
  }
}

async function listCatalogObjects(catalogName, schemaName) {
  const { data } = await client.get(`/metalakes/${METALAKE}/catalogs/${catalogName}/schemas/${schemaName}/filesets`);
  return data.identifiers || [];
}

async function getCatalogObject(catalogName, schemaName, objectName) {
  const { data } = await client.get(`/metalakes/${METALAKE}/catalogs/${catalogName}/schemas/${schemaName}/filesets/${objectName}`);
  return data.fileset;
}

async function ensureRole(roleName, securableObjects) {
  try {
    await client.get(`/metalakes/${METALAKE}/roles/${roleName}`);
    // Role exists -- in a full implementation this would diff and update
    // privileges here. POC keeps this a create-if-absent for simplicity.
  } catch {
    await client.post(`/metalakes/${METALAKE}/roles`, {
      name: roleName,
      securableObjects,
    });
  }
}

async function ensureUser(username) {
  try {
    await client.get(`/metalakes/${METALAKE}/users/${enc(username)}`);
  } catch {
    await client.post(`/metalakes/${METALAKE}/users`, { name: username });
  }
}

async function grantRoleToUser(username, roleName) {
  await ensureUser(username);
  await client.put(`/metalakes/${METALAKE}/permissions/users/${enc(username)}/grant`, {
    roleNames: [roleName],
  });
}

// ── Postgres-as-Gravitino-catalog + RBAC reads (source of truth for PG) ──────

/** Create the jdbc-postgresql catalog that models the data-plane Postgres. */
async function ensurePgCatalog() {
  try {
    await client.get(`/metalakes/${METALAKE}/catalogs/${PG_CATALOG}`);
  } catch {
    await client.post(`/metalakes/${METALAKE}/catalogs`, {
      name: PG_CATALOG,
      type: "RELATIONAL",
      provider: "jdbc-postgresql",
      comment: "Data-plane Postgres, governed by control-plane RBAC",
      properties: {
        "jdbc-url": process.env.PG_JDBC_URL ||
          `jdbc:postgresql://${process.env.PG_HOST || "postgres"}:${process.env.PG_PORT || 5432}/${process.env.PG_DATABASE || "dataplane"}`,
        "jdbc-database": process.env.PG_DATABASE || "dataplane",
        "jdbc-user": process.env.PG_ADMIN_USER || "postgres",
        "jdbc-password": process.env.PG_ADMIN_PASSWORD || "postgres",
        "jdbc-driver": "org.postgresql.Driver",
      },
    });
  }
}

/**
 * Create-if-absent a role whose privileges live on the PG catalog. This seeds
 * the RBAC definition INTO Gravitino; the connector then reads it back to
 * provision Postgres. `schemaGrants` = [{ schema, privileges:["SELECT_TABLE",…] }].
 */
async function ensurePgRole(roleName, schemaGrants) {
  try {
    await client.get(`/metalakes/${METALAKE}/roles/${enc(roleName)}`);
  } catch {
    const securableObjects = schemaGrants.map((g) => ({
      fullName: `${PG_CATALOG}.${g.schema}`,
      type: "SCHEMA",
      privileges: g.privileges.map((p) => ({ name: p, condition: "ALLOW" })),
    }));
    await client.post(`/metalakes/${METALAKE}/roles`, { name: roleName, properties: {}, securableObjects });
  }
}

/** Read a role's full detail (securableObjects + privileges) — the RBAC source. */
async function getRole(roleName) {
  const { data } = await client.get(`/metalakes/${METALAKE}/roles/${enc(roleName)}`);
  return data.role;
}

/** Read a user's role assignments from Gravitino. */
async function getUserRoles(username) {
  try {
    const { data } = await client.get(`/metalakes/${METALAKE}/users/${enc(username)}`);
    return data.user?.roles || [];
  } catch {
    return [];
  }
}

module.exports = {
  METALAKE,
  PG_CATALOG,
  isReachable,
  ensureMetalake,
  ensureCatalog,
  ensureSchema,
  registerCatalogObject,
  listCatalogObjects,
  getCatalogObject,
  ensureRole,
  ensureUser,
  grantRoleToUser,
  ensurePgCatalog,
  ensurePgRole,
  getRole,
  getUserRoles,
};
