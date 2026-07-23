const Redis = require("ioredis");
const gravitino = require("./gravitinoClient");

const REDIS_URL = process.env.REDIS_URL || "redis://dp-redis:6379";
const redis = new Redis(REDIS_URL);
const MOCK_KEY = "catalog:mock:objects";

// Demo objects matching the InAiEra Catalog UI mock -- registered into real
// Gravitino if reachable, or into a Redis-backed mock list if not. Either
// way /v1/catalog/search reads through the same interface below, so the UI
// never needs to know which mode is active.
const DEMO_OBJECTS = [
  { name: "fct_customer_orders", kind: "TABLE", comment: "Iceberg table \u00b7 12 cols \u00b7 updated 2h ago", schema: "curated" },
  { name: "stg_customers", kind: "VIEW", comment: "Iceberg view \u00b7 8 cols \u00b7 updated daily", schema: "staging" },
  { name: "customer_embeddings", kind: "VECTOR", comment: "Vector index \u00b7 768 dim \u00b7 updated hourly", schema: "ml" },
  { name: "customers_2025.csv", kind: "FILE", comment: "Dataset file \u00b7 1.2 GB \u00b7 updated weekly", schema: "raw" },
];

// Gravitino entity names reject dots and other punctuation (e.g.
// "customers_2025.csv" -> IllegalArgumentException). Sanitize to a legal
// name for Gravitino while keeping the original as a displayName property
// so the Catalog UI still shows the real, human-readable name.
const safeName = (n) => n.replace(/[^a-zA-Z0-9_]/g, "_");

let mode = "unknown"; // "gravitino" | "mock"

async function init() {
  const reachable = await gravitino.isReachable().catch(() => false);
  if (reachable) {
    mode = "gravitino";
    console.log("[catalogStore] Gravitino reachable -- seeding real catalog");
    try {
      await gravitino.ensureMetalake();
      await gravitino.ensureCatalog("demo_catalog");
      for (const schema of [...new Set(DEMO_OBJECTS.map((o) => o.schema))]) {
        await gravitino.ensureSchema("demo_catalog", schema);
      }
      for (const obj of DEMO_OBJECTS) {
        await gravitino.registerCatalogObject("demo_catalog", obj.schema, {
          name: safeName(obj.name),
          comment: obj.comment,
          properties: { kind: obj.kind, displayName: obj.name },
        });
      }
    } catch (err) {
      console.warn("[catalogStore] Gravitino seeding failed, falling back to mock mode:", err.message);
      mode = "mock";
      await seedMock();
    }
  } else {
    mode = "mock";
    console.warn("[catalogStore] Gravitino not reachable -- running in MOCK catalog mode. " +
      "The search API and UI still work end-to-end; results are served from an in-memory demo list, not a real Gravitino catalog. " +
      "See gravitinoClient.js for what to check once a real Gravitino instance is available.");
    await seedMock();
  }
  console.log(`[catalogStore] mode = ${mode}`);
}

async function seedMock() {
  const existing = await redis.get(MOCK_KEY);
  if (existing) return;
  await redis.set(MOCK_KEY, JSON.stringify(DEMO_OBJECTS));
}

async function search(query) {
  const q = (query || "").toLowerCase();

  if (mode === "gravitino") {
    try {
      const results = [];
      for (const schema of [...new Set(DEMO_OBJECTS.map((o) => o.schema))]) {
        const identifiers = await gravitino.listCatalogObjects("demo_catalog", schema);
        for (const id of identifiers) {
          if (!q || id.name.toLowerCase().includes(q)) {
            const obj = await gravitino.getCatalogObject("demo_catalog", schema, id.name);
            results.push({
              name: obj.properties?.displayName || obj.name,
              kind: obj.properties?.kind || "FILE",
              comment: obj.comment,
              schema,
            });
          }
        }
      }
      return results;
    } catch (err) {
      console.warn("[catalogStore] live Gravitino query failed, falling back to mock results for this request:", err.message);
      // fall through to mock below
    }
  }

  const raw = await redis.get(MOCK_KEY);
  const objects = raw ? JSON.parse(raw) : DEMO_OBJECTS;
  if (!q) return objects;
  return objects.filter((o) => o.name.toLowerCase().includes(q));
}

function getMode() {
  return mode;
}

module.exports = { init, search, getMode };
