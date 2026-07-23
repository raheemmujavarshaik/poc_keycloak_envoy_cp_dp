const express = require("express");
const { getDb } = require("./db");
const { publishRoleSyncEvent } = require("./roleSync");

const router = express.Router();

router.get("/", async (_req, res) => {
  const roles = await getDb().collection("role_templates").find({}).toArray();
  res.json({ roles });
});

router.get("/:roleName/assignments", async (req, res) => {
  const assignments = await getDb()
    .collection("user_roles")
    .find({ roleName: req.params.roleName })
    .toArray();
  res.json({ roleName: req.params.roleName, users: assignments.map((a) => a.userEmail) });
});

/**
 * Assigns a role to a user, then publishes a sync event -- this is the
 * moment the "role propagation" design actually kicks in: the write here
 * only touches MongoDB (intent), everything downstream in the data plane
 * happens asynchronously via the Role Sync Worker.
 */
router.post("/:roleName/assign", async (req, res) => {
  const { roleName } = req.params;
  const { userEmail } = req.body || {};
  if (!userEmail) return res.status(400).json({ error: "missing_userEmail" });

  const role = await getDb().collection("role_templates").findOne({ roleName });
  if (!role) return res.status(404).json({ error: "role_not_found" });

  await getDb().collection("user_roles").updateOne(
    { userEmail, roleName },
    { $set: { userEmail, roleName, assignedAt: new Date() } },
    { upsert: true }
  );

  const eventId = await publishRoleSyncEvent(roleName);
  res.json({ assigned: true, roleName, userEmail, syncEventId: eventId });
});

router.delete("/:roleName/assign/:userEmail", async (req, res) => {
  const { roleName, userEmail } = req.params;
  await getDb().collection("user_roles").deleteOne({ roleName, userEmail });
  const eventId = await publishRoleSyncEvent(roleName);
  res.json({ unassigned: true, roleName, userEmail, syncEventId: eventId });
});

module.exports = router;
