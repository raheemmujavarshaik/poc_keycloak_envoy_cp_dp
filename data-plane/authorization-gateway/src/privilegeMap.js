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

module.exports = { PRIVILEGE_TO_ACTIONS, actionsForPrivileges };
