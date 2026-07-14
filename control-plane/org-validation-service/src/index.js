require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { connect, getDb } = require("./db");

const PORT = process.env.PORT || 4001;

async function main() {
  await connect();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  /**
   * POC step 1-2 of the login flow: given a work email, resolve which org it
   * belongs to and confirm that org is active BEFORE any redirect happens.
   * This is deliberately called before Keycloak is ever touched.
   */
  app.post("/validate-org", async (req, res) => {
    const { email } = req.body || {};
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "invalid_email", message: "A valid work email is required" });
    }
    const domain = email.split("@")[1].toLowerCase();

    const org = await getDb().collection("orgs").findOne({ emailDomains: domain });
    if (!org) {
      return res.status(404).json({ error: "org_not_found", message: `No organization is registered for domain ${domain}` });
    }
    if (org.status !== "active") {
      return res.status(403).json({ error: "org_inactive", message: `Organization ${org.name} is ${org.status}`, orgId: org.orgId });
    }

    return res.json({
      valid: true,
      orgId: org.orgId,
      orgName: org.name,
      idpAlias: org.idpAlias, // null => Keycloak-native login; non-null => kc_idp_hint value
      dataPlaneId: org.dataPlaneId,
    });
  });

  app.listen(PORT, () => {
    console.log(`[org-validation-service] listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("[org-validation-service] fatal startup error", err);
  process.exit(1);
});
