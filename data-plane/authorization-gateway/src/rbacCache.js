const Redis = require("ioredis");
const { actionsForPrivileges } = require("./privilegeMap");

const REDIS_URL = process.env.REDIS_URL || "redis://dp-redis:6379";
const redis = new Redis(REDIS_URL);

const roleKey = (role) => `role:${role}:grants`;
const userKey = (user) => `user:${user}:roles`;

/**
 * Write-through: called whenever the control plane pushes a role sync.
 * Overwrites the role's full grant set and the user-to-role mapping --
 * every sync carries full desired state, never a delta, so replays are
 * always safe (matches the Role Sync Worker design).
 */
async function applyRoleSync({ roleName, grants, users }) {
  await redis.set(roleKey(roleName), JSON.stringify(grants));
  for (const user of users || []) {
    const existingRaw = await redis.get(userKey(user));
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    if (!existing.includes(roleName)) existing.push(roleName);
    await redis.set(userKey(user), JSON.stringify(existing));
  }
}

async function getUserRoles(user) {
  const raw = await redis.get(userKey(user));
  return raw ? JSON.parse(raw) : [];
}

async function getRoleGrants(role) {
  const raw = await redis.get(roleKey(role));
  return raw ? JSON.parse(raw) : [];
}

/**
 * Core decision function. resource is a dotted path like
 * "platform_apps.mlops.training_jobs" or "catalog.schema.object".
 * Returns { allowed, viaRole } -- never throws for a "no" answer, only for
 * genuine infrastructure failure (Redis unreachable).
 */
async function authorize(user, resource, action) {
  const roles = await getUserRoles(user);
  for (const role of roles) {
    const grants = await getRoleGrants(role);
    for (const grant of grants) {
      if (resourceMatches(grant.resource, resource)) {
        const actions = actionsForPrivileges(grant.privileges);
        if (actions.includes(action)) {
          return { allowed: true, viaRole: role };
        }
      }
    }
  }
  return { allowed: false, viaRole: null };
}

/** Grant resource "platform_apps.mlops.*" matches request resource "platform_apps.mlops.training_jobs". */
function resourceMatches(grantResource, requestResource) {
  if (grantResource === requestResource) return true;
  if (grantResource.endsWith(".*")) {
    const prefix = grantResource.slice(0, -2);
    return requestResource.startsWith(prefix);
  }
  return false;
}

async function listAllRoles() {
  const keys = await redis.keys("role:*:grants");
  return keys.map((k) => k.split(":")[1]);
}

module.exports = { applyRoleSync, getUserRoles, getRoleGrants, authorize, listAllRoles };
