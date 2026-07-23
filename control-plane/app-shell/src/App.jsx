import { useState, useEffect, lazy, Suspense } from "react";
import CatalogView from "./CatalogView.jsx";
import RolesView from "./RolesView.jsx";
import WorkbenchView from "./WorkbenchView.jsx";

const ORG_VALIDATION_URL = import.meta.env.VITE_ORG_VALIDATION_URL || "http://localhost:4001";
const BFF_URL = import.meta.env.VITE_BFF_URL || "http://localhost:4002";

// Dynamically imports the federated remote -- this network request goes to
// the BFF (see vite.config.js), which proxies it through the tunnel to the
// data plane. Lazy so the import only happens once the user actually asks
// to open a product, matching the "opens a product" step of the login flow.
const ProductWidget = lazy(() => import("product_mfe/ProductWidget"));

export default function App() {
  const [session, setSession] = useState({ loading: true, authenticated: false });
  const [email, setEmail] = useState("");
  const [orgError, setOrgError] = useState(null);
  const [showProduct, setShowProduct] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showWorkbench, setShowWorkbench] = useState(false);

  useEffect(() => {
    fetch(`${BFF_URL}/auth/session`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setSession({ loading: false, ...data }))
      .catch(() => setSession({ loading: false, authenticated: false }));
  }, []);

  async function handleContinue(e) {
    e.preventDefault();
    setOrgError(null);

    // Step 1-2 of the login flow: validate the org BEFORE any redirect to
    // Keycloak happens at all.
    const res = await fetch(`${ORG_VALIDATION_URL}/validate-org`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      setOrgError(data.message || "Could not validate organization");
      return; // deliberately no redirect on failure
    }

    // Step 3: redirect to the BFF's /auth/login, which builds the Keycloak
    // authorize URL (with kc_idp_hint if this org has its own enterprise IdP).
    const params = new URLSearchParams({
      orgId: data.orgId,
      dataPlaneId: data.dataPlaneId,
    });
    if (data.idpAlias) params.set("idpAlias", data.idpAlias);
    window.location.href = `${BFF_URL}/auth/login?${params.toString()}`;
  }

  async function handleLogout() {
    // 1. Destroy the server-side session + clear BFF cookies.
    let keycloakLogoutUrl = null;
    try {
      const r = await fetch(`${BFF_URL}/auth/logout`, { method: "POST", credentials: "include" });
      const data = await r.json().catch(() => ({}));
      keycloakLogoutUrl = data?.keycloakLogoutUrl || null;
    } catch { /* proceed with client-side wipe anyway */ }

    // 2. Wipe anything the SPA stashed — makes user switching safe.
    try { sessionStorage.clear(); } catch {}
    try { localStorage.clear(); } catch {}

    // 3. End the Keycloak SSO session so a different user actually re-authenticates.
    if (keycloakLogoutUrl) {
      window.location.replace(keycloakLogoutUrl);
    } else {
      window.location.href = "/";
    }
  }

  if (session.loading) return <Centered>Loading\u2026</Centered>;

  if (!session.authenticated) {
    return (
      <Centered>
        <h1 style={{ fontFamily: "sans-serif", color: "#0B2545" }}>InAiEra Platform (POC)</h1>
        <form onSubmit={handleContinue} style={{ display: "flex", gap: 8, fontFamily: "sans-serif" }}>
          <input
            type="email"
            required
            placeholder="you@acme.test or you@beta.test"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ padding: 8, fontSize: 14, width: 260 }}
          />
          <button type="submit" style={{ padding: "8px 16px", background: "#0B2545", color: "white", border: "none", borderRadius: 4 }}>
            Continue
          </button>
        </form>
        {orgError && <p style={{ color: "#D85A30", fontFamily: "sans-serif" }}>{orgError}</p>}
        <p style={{ fontFamily: "sans-serif", fontSize: 12, color: "#5B6B7C", maxWidth: 420 }}>
          Try <code>sarah.choi@acme.test</code> (password <code>AcmePassword123!</code>, routed through the
          simulated enterprise IdP) or <code>jordan.lee@beta.test</code> (password <code>BetaPassword123!</code>,
          native Keycloak login) or <code>anyone@suspended.test</code> (blocked before any redirect).
        </p>
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 style={{ fontFamily: "sans-serif", color: "#0B2545" }}>Welcome, {session.user.name || session.user.email}</h1>
      <p style={{ fontFamily: "sans-serif", color: "#5B6B7C" }}>
        Org: {session.user.orgId} &middot; Data plane: {session.user.dataPlaneId}
      </p>
      <div style={{ display: "flex", gap: 12 }}>
        <button
          onClick={() => setShowProduct(true)}
          style={{ padding: "8px 16px", background: "#057A6E", color: "white", border: "none", borderRadius: 4, fontFamily: "sans-serif" }}
        >
          Open Product (loads through the tunnel)
        </button>
        <button
          onClick={() => setShowCatalog((v) => !v)}
          style={{ padding: "8px 16px", background: "#5B4B9A", color: "white", border: "none", borderRadius: 4, fontFamily: "sans-serif" }}
        >
          {showCatalog ? "Hide" : "Browse"} Catalog
        </button>
        <button
          onClick={() => setShowRoles((v) => !v)}
          style={{ padding: "8px 16px", background: "#0B2545", color: "white", border: "none", borderRadius: 4, fontFamily: "sans-serif" }}
        >
          {showRoles ? "Hide" : "Manage"} Roles
        </button>
        <button
          onClick={() => setShowWorkbench((v) => !v)}
          style={{ padding: "8px 16px", background: "#13315C", color: "white", border: "none", borderRadius: 4, fontFamily: "sans-serif" }}
        >
          {showWorkbench ? "Hide" : "App"} Workbench
        </button>
      </div>
      {showProduct && (
        <div style={{ marginTop: 16, width: 420 }}>
          <Suspense fallback={<p style={{ fontFamily: "sans-serif" }}>Loading product from data plane\u2026</p>}>
            <ProductWidget />
          </Suspense>
        </div>
      )}
      {showCatalog && (
        <div style={{ marginTop: 16 }}>
          <CatalogView />
        </div>
      )}
      {showRoles && (
        <div style={{ marginTop: 16 }}>
          <RolesView />
        </div>
      )}
      {showWorkbench && (
        <div style={{ marginTop: 16 }}>
          <WorkbenchView />
        </div>
      )}
      <button onClick={handleLogout} style={{ marginTop: 24, background: "none", border: "none", color: "#5B6B7C", textDecoration: "underline", cursor: "pointer" }}>
        Log out
      </button>
    </Centered>
  );
}

function Centered({ children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 12 }}>
      {children}
    </div>
  );
}
