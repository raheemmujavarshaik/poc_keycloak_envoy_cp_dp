require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");

const BROKER_WS_URL = process.env.BROKER_WS_URL || "ws://agent-comms-service:4003/tunnel";
const DATA_PLANE_ID = process.env.DATA_PLANE_ID || "dp_demo";
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || "supersecrettoken123";
const ENVOY_URL = process.env.ENVOY_URL || "http://envoy:10000";
const RECONNECT_DELAY_MS = 3000;

/**
 * POC Tunnel Agent. This process NEVER opens a listening socket -- it only
 * ever dials out to the broker. That's the property this whole exercise is
 * meant to demonstrate: the data plane has no inbound attack surface at all,
 * yet the control plane can still reach it through this already-open,
 * agent-initiated connection.
 */
function connect() {
  const ws = new WebSocket(BROKER_WS_URL);

  ws.on("open", () => {
    console.log(`[tunnel-agent] connected to broker, registering as '${DATA_PLANE_ID}'`);
    ws.send(JSON.stringify({ type: "register", dataPlaneId: DATA_PLANE_ID, token: TUNNEL_TOKEN }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "registered") {
      console.log(`[tunnel-agent] registered successfully as '${msg.dataPlaneId}'`);
      return;
    }

    if (msg.type === "request") {
      await handleRelayedRequest(ws, msg);
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`[tunnel-agent] disconnected (${code} ${reason}), reconnecting in ${RECONNECT_DELAY_MS}ms`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    console.error("[tunnel-agent] socket error:", err.message);
  });
}

/** Delivers a relayed request to the local Envoy gateway and streams the response back over the same socket. */
function handleRelayedRequest(ws, { requestId, method, path, headers, body }) {
  return new Promise((resolve) => {
    const target = new URL(ENVOY_URL + path);
    const bodyBuffer = body ? Buffer.from(body, "base64") : undefined;

    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: { ...headers, host: target.host },
      },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          ws.send(
            JSON.stringify({
              type: "response",
              requestId,
              status: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: responseBody.length ? responseBody.toString("base64") : null,
            })
          );
          resolve();
        });
      }
    );

    proxyReq.on("error", (err) => {
      console.error(`[tunnel-agent] local delivery to Envoy failed:`, err.message);
      ws.send(
        JSON.stringify({
          type: "response",
          requestId,
          status: 502,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "envoy_unreachable", message: err.message })).toString("base64"),
        })
      );
      resolve();
    });

    if (bodyBuffer) proxyReq.write(bodyBuffer);
    proxyReq.end();
  });
}

connect();
