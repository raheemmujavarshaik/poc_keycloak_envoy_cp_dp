const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const REQUEST_TIMEOUT_MS = 15000;

/**
 * POC Tunnel Broker.
 *
 * Data-plane Tunnel Agents open an outbound WebSocket connection here and
 * register with a data_plane_id + bearer token. The broker never initiates
 * a connection into a customer network -- it only ever accepts inbound
 * WebSocket connections that the agent itself opened.
 *
 * Once registered, the broker can relay an HTTP-shaped request down that
 * agent's socket and match the eventual response back to the original
 * caller by requestId. This is the mechanism that lets the control plane
 * reach a data plane that has no listening port open anywhere.
 */
class TunnelBroker {
  constructor({ tokensByDataPlaneId }) {
    this.tokensByDataPlaneId = tokensByDataPlaneId; // { [dataPlaneId]: token }
    this.connections = new Map(); // dataPlaneId -> WebSocket
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
  }

  attach(server) {
    const wss = new WebSocketServer({ server, path: "/tunnel" });

    wss.on("connection", (ws) => {
      let registeredDataPlaneId = null;

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return ws.close(1002, "invalid_json");
        }

        if (msg.type === "register") {
          const expected = this.tokensByDataPlaneId[msg.dataPlaneId];
          if (!expected || expected !== msg.token) {
            console.warn(`[broker] rejected registration for ${msg.dataPlaneId}: bad token`);
            ws.close(4001, "unauthorized");
            return;
          }
          registeredDataPlaneId = msg.dataPlaneId;
          this.connections.set(registeredDataPlaneId, ws);
          console.log(`[broker] tunnel agent registered: ${registeredDataPlaneId}`);
          ws.send(JSON.stringify({ type: "registered", dataPlaneId: registeredDataPlaneId }));
          return;
        }

        if (msg.type === "response") {
          const waiter = this.pending.get(msg.requestId);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.pending.delete(msg.requestId);
            waiter.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
          }
          return;
        }
      });

      ws.on("close", () => {
        if (registeredDataPlaneId && this.connections.get(registeredDataPlaneId) === ws) {
          this.connections.delete(registeredDataPlaneId);
          console.log(`[broker] tunnel agent disconnected: ${registeredDataPlaneId}`);
        }
      });
    });

    console.log("[broker] WebSocket tunnel listening at /tunnel");
  }

  isConnected(dataPlaneId) {
    return this.connections.has(dataPlaneId);
  }

  /**
   * Relays one HTTP-shaped request to the named data plane's already-open
   * tunnel and resolves with its response, or rejects on timeout / no
   * connected agent for that data plane.
   */
  relay(dataPlaneId, { method, path, headers, body }) {
    const ws = this.connections.get(dataPlaneId);
    if (!ws) {
      return Promise.reject(new Error(`no tunnel connected for data plane '${dataPlaneId}'`));
    }

    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("tunnel relay timed out"));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "request", requestId, method, path, headers, body }));
    });
  }
}

module.exports = { TunnelBroker };
