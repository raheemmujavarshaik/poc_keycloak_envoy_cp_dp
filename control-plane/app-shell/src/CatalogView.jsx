import { useState, useEffect, useCallback } from "react";

const DATA_PLANE_ID = import.meta.env.VITE_DATA_PLANE_ID || "dp_demo";

// Relative, same-origin path -- deliberately NOT an absolute BFF_URL.
// Module Federation's remote loading already needed this same fix (cross-
// origin dynamic import() doesn't send cookies); this request is a plain
// fetch so it's less strict about that, but keeping it same-origin avoids
// needing a separate CORS+credentials configuration for this one call, and
// keeps every browser-to-BFF request going through the one proxy path
// Vite's dev/preview server already forwards to the BFF.
const SEARCH_URL = (q) => `/api/dataplane/${DATA_PLANE_ID}/authz/v1/catalog/search?q=${encodeURIComponent(q)}`;

const KIND_COLORS = {
  TABLE: { bg: "#E4E9F5", fg: "#0B2545" },
  VIEW: { bg: "#E4E9F5", fg: "#0B2545" },
  VECTOR: { bg: "#EFE8FA", fg: "#5B4B9A" },
  FILE: { bg: "#FBF0DA", fg: "#8A5A00" },
};

export default function CatalogView() {
  const [query, setQuery] = useState("customer");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const search = useCallback(async (q) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(SEARCH_URL(q), { credentials: "include" });
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const data = await res.json();
      setResults(data.results || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    search(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width: 480, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 4px", color: "#0B2545" }}>InAiEra Catalog</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#5B6B7C" }}>
        Dataset discovery, backed by the Authorization Gateway's unified catalog search &mdash; itself backed by
        Gravitino (or a mock demo catalog if Gravitino isn't reachable; see the badge below).
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search datasets\u2026"
          style={{ flex: 1, padding: 8, fontSize: 14, border: "1px solid #C7CFD6", borderRadius: 4 }}
        />
        <button type="submit" style={{ padding: "8px 16px", background: "#057A6E", color: "white", border: "none", borderRadius: 4 }}>
          Search
        </button>
      </form>

      {loading && <p style={{ fontSize: 13, color: "#5B6B7C" }}>Searching\u2026</p>}
      {error && <p style={{ fontSize: 13, color: "#D85A30" }}>Error: {error}</p>}

      {!loading && !error && (
        <>
          <p style={{ fontSize: 12, color: "#5B6B7C", margin: "0 0 8px" }}>{results.length} results</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {results.map((r) => {
              const colors = KIND_COLORS[r.kind] || KIND_COLORS.FILE;
              return (
                <div
                  key={r.name}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, border: "1px solid #E1E6EB", borderRadius: 6 }}
                >
                  <span
                    style={{
                      background: colors.bg,
                      color: colors.fg,
                      fontSize: 10,
                      fontWeight: "bold",
                      padding: "3px 8px",
                      borderRadius: 4,
                      minWidth: 52,
                      textAlign: "center",
                    }}
                  >
                    {r.kind}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "monospace", fontSize: 13, color: "#132238" }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: "#5B6B7C" }}>{r.comment}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
