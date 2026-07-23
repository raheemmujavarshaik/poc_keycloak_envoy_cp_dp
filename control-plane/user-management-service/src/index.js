require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { connect, findOrCreateUser } = require("./db");
const { buildSessionMiddleware } = require("./session");
const kc = require("./keycloak");
const { dataPlaneRoute } = require("./dataPlaneProxy");
const rolesRouter = require("./roles");
const { startRoleSyncWorker } = require("./roleSync");

const PORT = process.env.PORT || 4002;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PKCE_COOKIE = "pkce_state";

async function main() {
  await connect();
  startRoleSyncWorker();

  const app = express();
  app.use(cors({ origin: FRONTEND_URL, credentials: true }));
  app.use(cookieParser());
  app.use(buildSessionMiddleware());

  // Mounted before express.json() so proxied bodies (product API calls,
  // asset bytes) pass through untouched rather than being consumed by the
  // JSON body parser.
  app.use("/api/dataplane", ...dataPlaneRoute());

  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  app.use("/roles", (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: "not_authenticated" });
    next();
  }, rolesRouter);

  /**
   * Step 3 of the login flow (redirect). Expects the org already validated
   * by org-validation-service; this endpoint never re-validates the org
   * itself, matching the "validate before redirect, not after" design.
   */
  app.get("/auth/login", (req, res) => {
    const { orgId, idpAlias, dataPlaneId } = req.query;
    if (!orgId) {
      return res.status(400).json({ error: "missing_org", message: "orgId is required (call /validate-org first)" });
    }

    const state = crypto.randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = kc.generatePkce();

    // Short-lived, httpOnly cookie carries the PKCE verifier + login context
    // across the redirect round trip. Never readable by frontend JS.
    res.cookie(PKCE_COOKIE, JSON.stringify({ state, codeVerifier, orgId, dataPlaneId }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    });

    const authUrl = kc.buildAuthUrl({ state, codeChallenge, idpAlias: idpAlias || null });
    res.redirect(authUrl);
  });

  /**
   * Step 3-4 of the login flow (callback + code exchange). Keycloak redirects
   * here with a one-time code, never the actual tokens. The code-for-tokens
   * trade happens server-to-server, invisible to the browser.
   */
  app.get("/auth/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      const raw = req.cookies[PKCE_COOKIE];
      if (!raw) return res.status(400).send("Missing PKCE cookie \u2014 login session expired or invalid, please try again");

      const { state: storedState, codeVerifier, orgId, dataPlaneId } = JSON.parse(raw);
      if (state !== storedState) {
        return res.status(400).send("State mismatch \u2014 possible CSRF, aborting login");
      }
      res.clearCookie(PKCE_COOKIE);

      const tokens = await kc.exchangeCode({ code, codeVerifier });
      const claims = await kc.verifyIdToken(tokens.id_token);

      const user = await findOrCreateUser({
        sub: claims.sub,
        email: claims.email,
        name: claims.name || claims.preferred_username,
        orgId,
      });

      req.session.user = {
        sub: claims.sub,
        email: user.email,
        name: user.name,
        orgId,
        dataPlaneId,
      };
      req.session.accessToken = tokens.access_token;
      // Needed at logout time as `id_token_hint` so Keycloak ends the SSO
      // session for THIS user (not just clears the BFF cookie).
      req.session.idToken = tokens.id_token;

      res.redirect(`${FRONTEND_URL}/?login=success`);
    } catch (err) {
      console.error("[auth/callback] error", err.response?.data || err.message);
      res.status(500).send("Login failed during token exchange \u2014 check service logs");
    }
  });

  /** Lightweight check the frontend uses on load to know if a session exists. */
  app.get("/auth/session", (req, res) => {
    if (!req.session.user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: req.session.user });
  });

  app.post("/auth/logout", (req, res) => {
    // Build the Keycloak end-session URL BEFORE destroying the session (we
    // need the id_token). Returning the URL lets the SPA redirect the browser
    // so Keycloak's own SSO cookie also gets cleared — otherwise a subsequent
    // "Sign in" would silently reuse the previous user.
    const idToken  = req.session?.idToken;
    const clientId = process.env.KEYCLOAK_CLIENT_ID || "bff";
    const postLogoutRedirectUri = process.env.FRONTEND_URL || "http://localhost:3000";
    const keycloakLogoutUrl = kc.buildLogoutUrl({
      idTokenHint: idToken,
      postLogoutRedirectUri,
      clientId,
    });

    req.session.destroy(() => {
      res.clearCookie("inaiera_sid");
      res.clearCookie(PKCE_COOKIE);
      res.json({ loggedOut: true, keycloakLogoutUrl });
    });
  });

  /**
   * Step 5-6 of the login flow: mints the short-lived, data-plane-scoped
   * ticket (DPAT) via RFC 8693 token exchange, for the frontend to present
   * when it opens a product through the Agent Comms Service / tunnel.
   */
  app.post("/auth/data-plane-ticket", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "not_authenticated" });
    const dataPlaneId = req.session.user.dataPlaneId;
    const ticket = await kc.exchangeForDataPlaneTicket({
      subjectToken: req.session.accessToken,
      dataPlaneId,
    });
    res.json({ ticket, dataPlaneId });
  });

  app.listen(PORT, () => {
    console.log(`[user-management-service] listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("[user-management-service] fatal startup error", err);
  process.exit(1);
});
