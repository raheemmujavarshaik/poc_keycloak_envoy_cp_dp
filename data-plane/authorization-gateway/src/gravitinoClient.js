const axios = require("axios");

const GRAVITINO_URL = process.env.GRAVITINO_URL || "http://gravitino:8090";
const METALAKE = process.env.GRAVITINO_METALAKE || "org_demo";

const client = axios.create({ baseURL: `${GRAVITINO_URL}/api`, timeout: 5000 });

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
    await client.get(`/metalakes/${METALAKE}/users/${username}`);
  } catch {
    await client.post(`/metalakes/${METALAKE}/users`, { name: username });
  }
}

async function grantRoleToUser(username, roleName) {
  await ensureUser(username);
  await client.put(`/metalakes/${METALAKE}/permissions/users/${username}/grant`, {
    roleNames: [roleName],
  });
}

module.exports = {
  METALAKE,
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
};
