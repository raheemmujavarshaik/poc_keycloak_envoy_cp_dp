const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017";
const DB_NAME = process.env.MONGO_DB || "control_plane";

let client;
let db;

/**
 * Connect to MongoDB and seed two test orgs:
 *  - "acme"  -> has its own enterprise IdP (brokered via the "acme" Keycloak realm)
 *  - "beta"  -> no enterprise IdP configured, uses Keycloak-native login
 * This mirrors the two branches in the login flow diagram.
 */
async function connect() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);

  const orgs = db.collection("orgs");
  const count = await orgs.countDocuments();
  if (count === 0) {
    await orgs.insertMany([
      {
        orgId: "org_acme_001",
        name: "Acme Corp",
        status: "active",
        emailDomains: ["acme.test"],
        idpAlias: "acme", // has its own enterprise IdP -> brokered login
        dataPlaneId: "dp_demo",
      },
      {
        orgId: "org_beta_002",
        name: "Beta Inc",
        status: "active",
        emailDomains: ["beta.test"],
        idpAlias: null, // no enterprise IdP -> Keycloak-native login
        dataPlaneId: "dp_demo",
      },
      {
        orgId: "org_suspended_003",
        name: "Suspended LLC",
        status: "suspended",
        emailDomains: ["suspended.test"],
        idpAlias: null,
        dataPlaneId: "dp_demo",
      },
    ]);
    console.log("[org-validation-service] seeded 3 test orgs (acme, beta, suspended)");
  }

  return db;
}

function getDb() {
  if (!db) throw new Error("DB not connected yet");
  return db;
}

module.exports = { connect, getDb };
