/**
 * Bridges Gravitino's coarse, fixed privilege vocabulary (READ/WRITE/CREATE
 * per object type) to the finer app-level actions product UIs actually ask
 * about. This mapping is deliberately NOT stored in Gravitino -- it's
 * platform-owned config, per the RBAC design doc.
 */
const PRIVILEGE_TO_ACTIONS = {
  READ_FILESET: ["view"],
  WRITE_FILESET: ["view", "create", "edit"],
  CREATE_FILESET: ["view", "create"],
};

function actionsForPrivileges(privileges = []) {
  const actions = new Set();
  for (const p of privileges) {
    for (const a of PRIVILEGE_TO_ACTIONS[p] || []) actions.add(a);
  }
  return [...actions];
}

/**
 * Same idea, one level down: maps the coarse table privileges used in
 * `postgres.*` grants to concrete SQL privileges the gateway GRANTs on the
 * matching Postgres group role. Also platform-owned config, not in Gravitino.
 */
const PRIVILEGE_TO_SQL = {
  READ_TABLE: ["SELECT"],
  WRITE_TABLE: ["SELECT", "INSERT", "UPDATE", "DELETE"],
};

function sqlPrivilegesFor(privileges = []) {
  const set = new Set();
  for (const p of privileges) {
    for (const s of PRIVILEGE_TO_SQL[p] || []) set.add(s);
  }
  return [...set];
}

/**
 * Gravitino's own table-privilege vocabulary (as returned by its REST API,
 * lower-cased) → SQL privileges. This is what makes Gravitino the source of
 * truth: the connector reads a role's Gravitino privileges and translates
 * them here into the GRANTs it applies in Postgres.
 */
const GRAVITINO_PRIV_TO_SQL = {
  select_table: ["SELECT"],
  modify_table: ["INSERT", "UPDATE", "DELETE"],
  create_table: [], // DDL create is out of scope for the POC's data access
};

function sqlForGravitinoPrivileges(privileges = []) {
  const set = new Set();
  for (const p of privileges) {
    if (String(p.condition).toLowerCase() !== "allow") continue;
    for (const s of GRAVITINO_PRIV_TO_SQL[String(p.name).toLowerCase()] || []) set.add(s);
  }
  return [...set];
}

module.exports = {
  PRIVILEGE_TO_ACTIONS,
  actionsForPrivileges,
  PRIVILEGE_TO_SQL,
  sqlPrivilegesFor,
  GRAVITINO_PRIV_TO_SQL,
  sqlForGravitinoPrivileges,
};
