const Redis = require("ioredis");
const axios = require("axios");
const { getDb } = require("./db");

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const AGENT_COMMS_URL = process.env.AGENT_COMMS_URL || "http://agent-comms-service:4003";
const DATA_PLANE_ID = process.env.DATA_PLANE_ID || "dp_demo";
const INTERNAL_SYNC_TOKEN = process.env.INTERNAL_SYNC_TOKEN || "poc-internal-sync-secret";

const STREAM = "role-sync-events";
const GROUP = "role-sync-workers";
const CONSUMER = `worker-${process.pid}`;
const CLAIM_IDLE_MS = 15000; // reclaim entries stuck for >15s (crashed worker, etc.)

const redis = new Redis(REDIS_URL);

/**
 * Producer side. Called whenever a role assignment changes. Deliberately
 * publishes only the role name, not the full payload -- the worker always
 * re-reads current state from MongoDB before syncing, so a stale event
 * body can never cause a stale sync. This is what makes replays safe.
 */
async function publishRoleSyncEvent(roleName) {
  const id = await redis.xadd(STREAM, "*", "roleName", roleName);
  console.log(`[role-sync] queued event ${id} for role '${roleName}'`);
  return id;
}

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!String(err.message).includes("BUSYGROUP")) throw err; // group already exists, fine
  }
}

/** Builds full desired state for a role (grants + currently assigned users) and pushes it through the tunnel. */
async function syncRole(roleName) {
  const role = await getDb().collection("role_templates").findOne({ roleName });
  if (!role) {
    console.warn(`[role-sync] role '${roleName}' no longer exists, skipping`);
    return;
  }
  const assignments = await getDb().collection("user_roles").find({ roleName }).toArray();
  const users = assignments.map((a) => a.userEmail);

  await axios.post(
    `${AGENT_COMMS_URL}/api/dataplane/${DATA_PLANE_ID}/authz/internal/role-sync`,
    { roleName, grants: role.grants, users },
    {
      headers: {
        // Presence-only check at the broker layer; the real authorization
        // for this internal system call is the sync token below, checked
        // by the Authorization Gateway itself. See envoy.yaml for why this
        // path is exempted from the normal user-token jwt_authn requirement.
        "X-Data-Plane-Ticket": "internal-system-call",
        "x-internal-sync-token": INTERNAL_SYNC_TOKEN,
      },
      timeout: 10000,
    }
  );
  console.log(`[role-sync] synced role '${roleName}' for ${users.length} user(s)`);
}

async function processEntries(entries) {
  for (const [id, fields] of entries) {
    const roleName = fields[fields.indexOf("roleName") + 1];
    try {
      await syncRole(roleName);
      await redis.xack(STREAM, GROUP, id);
    } catch (err) {
      console.error(`[role-sync] sync failed for entry ${id} (role '${roleName}'), will retry:`, err.message);
      // deliberately not acked -- picked up again by the reclaim sweep below
    }
  }
}

async function consumeLoop() {
  while (true) {
    try {
      const res = await redis.xreadgroup("GROUP", GROUP, CONSUMER, "COUNT", 10, "BLOCK", 5000, "STREAMS", STREAM, ">");
      if (res) {
        const [[, entries]] = res;
        await processEntries(entries);
      }
    } catch (err) {
      console.error("[role-sync] consume loop error:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Periodically reclaims entries left pending by a crashed/slow worker and retries them. */
async function reclaimLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, CLAIM_IDLE_MS));
    try {
      const [, entries] = await redis.xautoclaim(STREAM, GROUP, CONSUMER, CLAIM_IDLE_MS, "0");
      if (entries?.length) {
        console.log(`[role-sync] reclaimed ${entries.length} stalled entrie(s)`);
        await processEntries(entries);
      }
    } catch (err) {
      console.error("[role-sync] reclaim loop error:", err.message);
    }
  }
}

/**
 * Publishes a sync event for every existing role template on startup, so the
 * data plane's cache converges to the seeded assignments without anyone having
 * to click "assign" first. Safe to run every boot: each sync pushes full
 * desired state, and if the data plane isn't up yet the entries simply aren't
 * acked and the reclaim loop retries them.
 */
async function publishInitialSync() {
  try {
    const roles = await getDb().collection("role_templates").find({}).toArray();
    for (const r of roles) await publishRoleSyncEvent(r.roleName);
    console.log(`[role-sync] queued initial sync for ${roles.length} role(s)`);
  } catch (err) {
    console.error("[role-sync] initial sync enqueue failed:", err.message);
  }
}

async function startRoleSyncWorker() {
  await ensureGroup();
  console.log(`[role-sync] worker started (consumer: ${CONSUMER})`);
  consumeLoop();
  reclaimLoop();
  publishInitialSync();
}

module.exports = { publishRoleSyncEvent, startRoleSyncWorker };
