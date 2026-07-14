const crypto = require("crypto");
const axios = require("axios");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL || "http://localhost:8080";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "inaiera";
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "bff";
const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || "bff-secret";
const REDIRECT_URI = process.env.KEYCLOAK_REDIRECT_URI || "http://localhost:4002/auth/callback";

const ISSUER = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}`;
const AUTH_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;

let jwks; // lazily created remote JWK set

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generates a PKCE code_verifier + code_challenge pair (S256). */
function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Builds the Keycloak /authorize redirect URL.
 * When idpAlias is provided, kc_idp_hint is set so Keycloak skips its own
 * login form and forwards straight to that broker IdP (the enterprise-IdP
 * branch of the login flow). When idpAlias is null, Keycloak shows its own
 * native login page instead.
 */
function buildAuthUrl({ state, codeChallenge, idpAlias }) {
  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (idpAlias) {
    params.set("kc_idp_hint", idpAlias);
  }
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchanges an authorization code for tokens, server-to-server, using PKCE. */
async function exchangeCode({ code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: KEYCLOAK_CLIENT_ID,
    client_secret: KEYCLOAK_CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const { data } = await axios.post(TOKEN_ENDPOINT, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return data; // { access_token, id_token, refresh_token, expires_in, ... }
}

/**
 * RFC 8693 token exchange: trades the session's access token for a new
 * token scoped to a single data_plane_id with a short TTL (the "DPAT").
 * POC simplification: Keycloak's token-exchange feature must be explicitly
 * enabled on the realm/client (see keycloak/realm-inaiera.json) and is
 * version- and edition-sensitive. If it isn't available, this falls back to
 * using the session's own access_token directly as the data-plane ticket --
 * that's still a real, Envoy-verifiable JWT signed by Keycloak, just not
 * narrowed to a single data plane's audience the way the full design
 * requires. The POC still demonstrates the whole path end-to-end either way;
 * only the audience-scoping property is weaker until token exchange is on.
 */
async function exchangeForDataPlaneTicket({ subjectToken, dataPlaneId }) {
  try {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: KEYCLOAK_CLIENT_ID,
      client_secret: KEYCLOAK_CLIENT_SECRET,
      subject_token: subjectToken,
      audience: dataPlaneId,
    });
    const { data } = await axios.post(TOKEN_ENDPOINT, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return data.access_token;
  } catch (err) {
    console.warn("[keycloak] token exchange not available, falling back to the session's own access token:", err.response?.data || err.message);
    return subjectToken;
  }
}

/** Verifies an id_token's signature against Keycloak's JWKS and returns its claims. */
async function verifyIdToken(idToken) {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URI));
  }
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER });
  return payload;
}

/**
 * Ends the user's SSO session in Keycloak. Without this the BFF cookie can be
 * cleared and Keycloak will still auto-authenticate the same user on the next
 * login, so a different user pressing "Sign in" sees the prior identity.
 * `id_token_hint` proves we hold a token from the session we want to end.
 * `post_logout_redirect_uri` must be listed in the client's Valid Post Logout
 * Redirect URIs, else Keycloak lands on its own signed-out page.
 */
function buildLogoutUrl({ idTokenHint, postLogoutRedirectUri, clientId }) {
  const url = new URL(`${ISSUER}/protocol/openid-connect/logout`);
  if (idTokenHint)            url.searchParams.set("id_token_hint", idTokenHint);
  if (postLogoutRedirectUri)  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  if (clientId)               url.searchParams.set("client_id", clientId);
  return url.toString();
}

module.exports = { generatePkce, buildAuthUrl, exchangeCode, exchangeForDataPlaneTicket, verifyIdToken, buildLogoutUrl };
