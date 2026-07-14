import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";

// This remote is built once and served as static files from the data
// plane. The App Shell (running in the control plane) loads remoteEntry.js
// from here -- through the tunnel, never directly -- which is the
// micro-frontend loading pattern from the architecture design.
export default defineConfig({
  plugins: [
    react(),
    federation({
      name: "product_mfe",
      filename: "remoteEntry.js",
      exposes: {
        "./ProductWidget": "./src/ProductWidget.jsx",
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
    port: 5000,
    cors: true,
  },
  preview: {
    port: 5000,
    cors: true,
  },
});
