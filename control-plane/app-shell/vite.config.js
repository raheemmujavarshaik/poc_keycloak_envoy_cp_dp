import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";

// The remote URL points at the BFF (user-management-service), NOT at the
// data plane directly -- the browser never talks to product-mfe or Envoy
// itself. The BFF authenticates the request via the session cookie, mints
// the data-plane ticket server-side, and proxies through the tunnel.
//
// Critical: the remote URL is *relative* (no scheme/host). Module Federation
// loads `remoteEntry.js` via dynamic import(), which does NOT send cookies
// for cross-origin requests. Keeping the URL same-origin routes cookies
// naturally; we then proxy /api → BFF in the preview config below.
const DATA_PLANE_ID = process.env.VITE_DATA_PLANE_ID || "dp_demo";

// Same-origin path baked into the bundle at build time. Do not switch this
// back to an absolute URL — 401s on remoteEntry.js will return.
const PRODUCT_MFE_REMOTE = `/api/dataplane/${DATA_PLANE_ID}/product/assets/remoteEntry.js`;

// Where Vite's preview server should forward /api/* to. In Docker this is
// the service name; outside Docker override with VITE_BFF_UPSTREAM=...
const BFF_UPSTREAM = process.env.VITE_BFF_UPSTREAM || "http://user-management-service:4002";

const proxyConfig = {
  "/api": {
    target: BFF_UPSTREAM,
    changeOrigin: true,
    // WebSocket upgrade support in case anything (e.g. future tunnel path)
    // wants to ride the same origin.
    ws: true,
  },
};

export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "app_shell",
      remotes: {
        product_mfe: PRODUCT_MFE_REMOTE,
      },
      shared: ["react", "react-dom"],
    }),
  ],
  build: {
    target: "esnext",
    minify: false,
    cssCodeSplit: false,
  },
  server: {
    port: 3000,
    host: true,
    proxy: proxyConfig,
  },
  preview: {
    port: 3000,
    host: true,
    proxy: proxyConfig,
  },
});
