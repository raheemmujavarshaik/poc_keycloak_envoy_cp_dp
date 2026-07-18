const express = require("express");

/**
 * Sample data-plane API. Serves a canned list of countries.
 *
 * The POC uses this to demonstrate that ANY microservice in the data plane
 * can be reached from the control plane via the same tunnel + Envoy pattern
 * as the MFE. This service has:
 *   • no listener published to the host (compose omits `ports:`)
 *   • no direct browser-to-service path (all traffic arrives via Envoy)
 *   • no idea a tunnel exists — it's plain HTTP behind Envoy
 *
 * The whole "no inbound port" property of the POC applies to this service
 * identically to how it applies to product-mfe.
 */

const PORT = process.env.PORT || 8000;

// Canned sample data. Static on purpose — the point is to demonstrate the
// call path, not a real dataset. Add/remove entries freely.
const COUNTRIES = [
  { code: "IN", name: "India",         capital: "New Delhi",    population: 1417000000, region: "Asia"          },
  { code: "US", name: "United States", capital: "Washington DC",population:  334000000, region: "Americas"      },
  { code: "GB", name: "United Kingdom",capital: "London",       population:   67000000, region: "Europe"        },
  { code: "DE", name: "Germany",       capital: "Berlin",       population:   83000000, region: "Europe"        },
  { code: "FR", name: "France",        capital: "Paris",        population:   68000000, region: "Europe"        },
  { code: "JP", name: "Japan",         capital: "Tokyo",        population:  125000000, region: "Asia"          },
  { code: "AU", name: "Australia",     capital: "Canberra",     population:   26000000, region: "Oceania"       },
  { code: "BR", name: "Brazil",        capital: "Brasília",     population:  216000000, region: "Americas"      },
  { code: "ZA", name: "South Africa",  capital: "Pretoria",     population:   60000000, region: "Africa"        },
  { code: "SG", name: "Singapore",     capital: "Singapore",    population:    5700000, region: "Asia"          },
];

const app = express();

// Trivial CORS pass-through — normally not needed because everything reaches
// this service through Envoy on the same network, but adds defense-in-depth
// if the compose is reshuffled.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "countries-service" });
});

/**
 * GET /countries
 *   Returns the full canned list, wrapped so the UI can distinguish payload
 *   from metadata later (pagination, filtering, etc.) without an API break.
 */
app.get("/countries", (_req, res) => {
  res.json({
    count:   COUNTRIES.length,
    servedBy:"countries-service",
    data:    COUNTRIES,
  });
});

/**
 * GET /countries/:code
 *   Returns one country by ISO-2 code, or 404. Same wrapper shape.
 */
app.get("/countries/:code", (req, res) => {
  const wanted = String(req.params.code || "").toUpperCase();
  const match = COUNTRIES.find((c) => c.code === wanted);
  if (!match) return res.status(404).json({ error: "country_not_found", code: wanted });
  res.json({ servedBy: "countries-service", data: match });
});

app.listen(PORT, () => {
  console.log(`[countries-service] listening on :${PORT}`);
});
