const { createProxyMiddleware } = require("http-proxy-middleware");
const kc = require("./keycloak");

const AGENT_COMMS_URL = process.env.AGENT_COMMS_URL || "http://agent-comms-service:4003";

/**
 * Server-side proxy from the browser's perspective, to the Agent Comms
 * Service / tunnel from the BFF's perspective.
 *
 * This exists because the browser cannot attach a custom auth header to a
 * <script> tag or a dynamic import() -- which is exactly how Module
 * Federation loads a remote entry. So the data-plane ticket is minted and
 * attached here, server-side, using the browser's own session cookie as the
 * only credential it ever presents. This is the concrete implementation of
 * the "no direct browser-to-data-plane path" rule: every asset and API call
 * the App Shell makes for a product goes through this same authenticated
 * hop, whether it's remoteEntry.js or a product API response.
 */
function buildDataPlaneProxy() {
  return createProxyMiddleware({
    target: AGENT_COMMS_URL,
    changeOrigin: true,
    // Express strips the "/api/dataplane" mount prefix from req.url before
    // this middleware ever sees it -- restore it so the path arriving at
    // the Agent Comms Service still matches its expected route shape.
    pathRewrite: (path) => `/api/dataplane${path}`,
    on: {
      proxyReq: async (proxyReq, req) => {
        // Note: http-proxy-middleware's synchronous proxyReq hook can't await;
        // the ticket is minted ahead of time in the route handler below and
        // passed via req.dataPlaneTicket before this middleware runs.
        if (req.dataPlaneTicket) {
          proxyReq.setHeader("X-Data-Plane-Ticket", req.dataPlaneTicket);
        }
      },
    },
  });
}

/** Express middleware chain: require a session, mint/attach the ticket, then proxy. */
function dataPlaneRoute() {
  const proxy = buildDataPlaneProxy();
  return [
    async (req, res, next) => {
      if (!req.session.user) {
        return res.status(401).json({ error: "not_authenticated" });
      }
      try {
        req.dataPlaneTicket = await kc.exchangeForDataPlaneTicket({
          subjectToken: req.session.accessToken,
          dataPlaneId: req.session.user.dataPlaneId,
        });
        next();
      } catch (err) {
        console.error("[data-plane proxy] failed to mint ticket:", err.message);
        res.status(502).json({ error: "ticket_mint_failed" });
      }
    },
    proxy,
  ];
}

module.exports = { dataPlaneRoute };
