import { useState, useEffect } from "react";

/**
 * This component's JS bundle was fetched by the App Shell from
 * /api/dataplane/<dataPlaneId>/product/assets/... -- i.e. through the
 * Agent Comms Service and the tunnel, never directly from this container.
 * Successfully rendering this proves the whole MFE-through-tunnel loading
 * path works, not just the underlying HTTP relay.
 *
 * The "Load countries" button below then makes a SECOND request through the
 * same tunnel, this time to a sibling data-plane microservice
 * (`countries-service`). That request rides the identical path:
 *   browser → App Shell (Vite proxy) → BFF → agent-comms broker
 *   → WebSocket → tunnel-agent → Envoy → countries-service:8000
 * — proving the pattern generalises to any data-plane HTTP resource, not
 * just MFE bundles.
 */

// Same-origin path — the Vite preview server proxies /api → BFF, which
// mints the DPAT server-side and forwards through the tunnel. Using a
// relative URL here is what makes the browser attach the session cookie
// (dynamic `import()` for cross-origin URLs would not).
const DATA_PLANE_ID = "dp_demo";
const COUNTRIES_URL = `/api/dataplane/${DATA_PLANE_ID}/api/countries`;

export default function ProductWidget() {
  const [loadedAt] = useState(() => new Date().toISOString());
  const [countries, setCountries] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    console.log("[product-mfe] ProductWidget mounted -- loaded via the tunnel from the data plane");
  }, []);

  async function handleLoadCountries() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(COUNTRIES_URL, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`upstream returned ${res.status}`);
      const payload = await res.json();
      setCountries(payload);
    } catch (err) {
      setError(err.message || "unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: "2px solid #057A6E", borderRadius: 8, padding: 16, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 8px", color: "#057A6E" }}>Product MFE (Data Plane)</h3>
      <p style={{ margin: 0, fontSize: 14, color: "#132238" }}>
        This component's code was served from the data plane and loaded through the tunnel broker &mdash;
        the browser never connected to the data plane directly.
      </p>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "#5B6B7C" }}>Rendered at: {loadedAt}</p>

      <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #D6DBE1" }} />

      <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "#132238" }}>
        Second data-plane call: sibling <code>countries-service</code>
      </h4>
      <p style={{ margin: 0, fontSize: 12, color: "#5B6B7C" }}>
        Fetches <code>{COUNTRIES_URL}</code> through the same tunnel. Envoy routes
        it to <code>countries-service:8000</code> based on the URL prefix.
      </p>

      <button
        onClick={handleLoadCountries}
        disabled={loading}
        style={{
          marginTop: 12,
          padding: "8px 14px",
          background: loading ? "#9DA9B4" : "#057A6E",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: loading ? "not-allowed" : "pointer",
          fontSize: 14,
        }}
      >
        {loading ? "Loading…" : "Load countries"}
      </button>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: "#FDECEC",
            color: "#8B1F1F",
            border: "1px solid #F2B8B8",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Failed to load: {error}
        </div>
      )}

      {countries && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "#5B6B7C", marginBottom: 6 }}>
            {countries.count} countries returned by <code>{countries.servedBy}</code>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#E6F1F0" }}>
                <th style={cellStyle}>Code</th>
                <th style={cellStyle}>Name</th>
                <th style={cellStyle}>Capital</th>
                <th style={cellStyle}>Region</th>
                <th style={{ ...cellStyle, textAlign: "right" }}>Population</th>
              </tr>
            </thead>
            <tbody>
              {countries.data.map((c) => (
                <tr key={c.code} style={{ borderTop: "1px solid #E1E5EA" }}>
                  <td style={cellStyle}><code>{c.code}</code></td>
                  <td style={cellStyle}>{c.name}</td>
                  <td style={cellStyle}>{c.capital}</td>
                  <td style={cellStyle}>{c.region}</td>
                  <td style={{ ...cellStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {c.population.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cellStyle = { textAlign: "left", padding: "6px 8px", color: "#132238" };
