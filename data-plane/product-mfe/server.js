// Serves the built product-mfe bundle (including remoteEntry.js) as static
// files. In the real architecture this sits behind Envoy and is never
// reachable except through the tunnel -- this server itself has no
// awareness of that; it just serves files on the internal cluster network.
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.use(express.static(path.join(__dirname, "dist")));

app.listen(PORT, () => {
  console.log(`[product-mfe] serving built bundle on :${PORT}`);
});
