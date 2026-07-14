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
  return db;
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
