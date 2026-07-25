const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017";
const DB_NAME = process.env.MONGO_DB || "control_plane";

let client;
let db;

async function connect() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection("users").createIndex({ keycloakSub: 1 }, { unique: true });
  await db.collection("user_roles").createIndex({ userEmail: 1, roleName: 1 }, { unique: true });
  await seedRoleTemplates();
  await seedUserRoles();
  return db;
}

/**
 * Seeds a few test users with different role combinations so the App
 * Workbench has something to exercise out of the box:
 *   alice -> data_engineer (Data Platform only)
 *   bob   -> data_scientist (MLOps only)
 *   carol -> both (full access to both domains)
 *   (dave -> intentionally unseeded: a "no roles" user, denied everywhere)
 * These are plain email strings -- the authorize path only needs the
 * user_roles -> role -> grants chain, not a real Keycloak login.
 */
async function seedUserRoles() {
  const userRoles = db.collection("user_roles");
  if ((await userRoles.countDocuments()) > 0) return;
  const now = new Date();
  await userRoles.insertMany([
    { userEmail: "alice.engineer@acme.test", roleName: "data_engineer", assignedAt: now },
    { userEmail: "bob.scientist@acme.test", roleName: "data_scientist", assignedAt: now },
    { userEmail: "carol.lead@acme.test", roleName: "data_engineer", assignedAt: now },
    { userEmail: "carol.lead@acme.test", roleName: "data_scientist", assignedAt: now },
  ]);
  console.log("[db] seeded user_roles (alice=engineer, bob=scientist, carol=both)");
}

/**
 * Seeds the two roles designed earlier: data_engineer and data_scientist.
 * Each role's grants span both the app catalog and (in the full design)
 * the data catalogs -- this POC only exercises the app-catalog half, since
 * there's no real Trino/Kafka/pgEdge behind it, but the shape of the grant
 * list is what a real deployment would extend.
 */
async function seedRoleTemplates() {
  const roleTemplates = db.collection("role_templates");
  const count = await roleTemplates.countDocuments();
  if (count > 0) return;

  await roleTemplates.insertMany([
    {
      roleName: "data_engineer",
      description: "Builds Kafka Connect ingestions, dbt transformations, and Flink SQL streams",
      grants: [
        { resource: "platform_apps.dataplatform.workspaces.*", privileges: ["WRITE_FILESET"] },
        // Postgres: full DML on the dataplatform schema (mapped to SELECT/INSERT/UPDATE/DELETE).
        { resource: "postgres.dataplatform.*", privileges: ["WRITE_TABLE"] },
      ],
    },
    {
      roleName: "data_scientist",
      description: "Performs MLOps/LLMOps work: model training, deployment, inference",
      grants: [
        { resource: "platform_apps.mlops.*", privileges: ["WRITE_FILESET"] },
        // Postgres: read-only on the mlops schema (mapped to SELECT).
        { resource: "postgres.mlops.*", privileges: ["READ_TABLE"] },
      ],
    },
  ]);
  console.log("[db] seeded 2 role templates (data_engineer, data_scientist)");
}

function getDb() {
  if (!db) throw new Error("DB not connected yet");
  return db;
}

/** Finds a user by Keycloak subject, creating them on first login (JIT provisioning). */
async function findOrCreateUser({ sub, email, name, orgId }) {
  const users = getDb().collection("users");
  const existing = await users.findOne({ keycloakSub: sub });
  if (existing) {
    await users.updateOne({ keycloakSub: sub }, { $set: { lastLoginAt: new Date() } });
    return existing;
  }
  const doc = {
    keycloakSub: sub,
    email,
    name,
    orgId,
    createdAt: new Date(),
    lastLoginAt: new Date(),
  };
  await users.insertOne(doc);
  return doc;
}

module.exports = { connect, getDb, findOrCreateUser };
