require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const { TunnelBroker } = require("./broker");

const PORT = process.env.PORT || 4003;

// { "dp_demo": "supersecrettoken123" } -- one shared token per data plane for
// the POC. Production replaces this with per-tenant, short-lived,
// certificate-pinned mTLS as described in the full architecture design.
const tokensByDataPlaneId = JSON.parse(process.env.TUNNEL_AGENT_TOKENS || '{"dp_demo":"supersecrettoken123"}');

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*", limit: "10mb" }));

const broker = new TunnelBroker({ tokensByDataPlaneId });

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.get("/tunnel-status", (_req, res) => {
  const connected = Object.keys(tokensByDataPlaneId).map((id) => ({ dataPlaneId: id, connected: broker.isConnected(id) }));
  res.json({ dataPlanes: connected });
});

/**
 * The proxy surface the frontend (and, in the full design, other product
 * microservices) calls. Everything under this path is forwarded through the
 * tunnel to the named data plane's Envoy gateway -- this is the "no direct
 * browser-to-Envoy path" rule from the architecture design: the browser only
 * ever talks to this service, never to a data plane directly.
 */
app.all("/api/dataplane/:dataPlaneId/*", async (req, res) => {
  const { dataPlaneId } = req.params;
  const path = "/" + req.params[0];
  const ticket = req.header("x-data-plane-ticket");

  if (!ticket) {
    return res.status(401).json({ error: "missing_ticket", message: "X-Data-Plane-Ticket header is required" });
  }

  try {
    const result = await broker.relay(dataPlaneId, {
      method: req.method,
      path: path + (req.url.includes("?") ? "?" + req.url.split("?")[1] : ""),
      headers: {
        "x-data-plane-ticket": ticket,
        "content-type": req.header("content-type") || "application/octet-stream",
      },
      body: req.body && req.body.length ? req.body.toString("base64") : null,
    });

    res.status(result.status);
    for (const [key, value] of Object.entries(result.headers || {})) {
      res.setHeader(key, value);
    }
    res.send(result.body ? Buffer.from(result.body, "base64") : undefined);
  } catch (err) {
    console.error(`[agent-comms-service] relay failed for ${dataPlaneId}${path}:`, err.message);
    res.status(502).json({ error: "data_plane_unreachable", message: err.message });
  }
});

const server = http.createServer(app);
broker.attach(server);

server.listen(PORT, () => {
  console.log(`[agent-comms-service] listening on :${PORT} (HTTP + WebSocket tunnel at /tunnel)`);
});
