import { useState, useEffect, useCallback } from "react";

const DATA_PLANE_ID = import.meta.env.VITE_DATA_PLANE_ID || "dp_demo";

// Everything here goes to the DATA PLANE through the same same-origin proxy
// CatalogView uses: the BFF mints the data-plane ticket server-side, and the
// broker forwards our X-Act-As-User header through the tunnel to the service.
const base = `/api/dataplane/${DATA_PLANE_ID}/apps`;

// Pre-seeded by user-management-service (db.js seedUserRoles). Dave is
// intentionally unseeded -> a "no roles" user, denied everywhere.
const TEST_USERS = [
  { email: "alice.engineer@acme.test", label: "Alice", note: "data_engineer" },
  { email: "bob.scientist@acme.test", label: "Bob", note: "data_scientist" },
  { email: "carol.lead@acme.test", label: "Carol", note: "both roles" },
  { email: "dave.newbie@acme.test", label: "Dave", note: "no roles" },
];

const METHOD = { view: "GET", create: "POST", edit: "PUT", delete: "DELETE" };
const ACTION_COLORS = {
  view: "#0B2545",
  create: "#057A6E",
  edit: "#5B4B9A",
  delete: "#D85A30",
};

export default function WorkbenchView() {
  const [manifest, setManifest] = useState(null);
  const [matrix, setMatrix] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // interactive tester
  const [actor, setActor] = useState(TEST_USERS[1].email); // Bob
  const [domain, setDomain] = useState("mlops");
  const [resource, setResource] = useState("training_jobs");
  const [outcome, setOutcome] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadMatrix = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await Promise.all(
        TEST_USERS.map(async (u) => {
          const res = await fetch(`${base}/capabilities`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user: u.email }),
          });
          const body = res.ok ? await res.json() : { capabilities: [] };
          return { user: u, caps: body.capabilities || [] };
        })
      );
      setMatrix(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${base}/manifest`, { credentials: "include" });
        if (res.ok) setManifest(await res.json());
      } catch {
        /* manifest is best-effort; matrix + tester still work */
      }
      loadMatrix();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = manifest?.domains || [
    { id: "mlops", label: "MLOps Studio", resources: [{ id: "training_jobs", label: "Training Jobs" }] },
    { id: "dataplatform", label: "Data Platform Studio", resources: [{ id: "team_alpha", label: "Workspace: team_alpha" }] },
  ];
  const currentDomain = domains.find((d) => d.id === domain) || domains[0];
  const resources = currentDomain?.resources || [];

  async function runAction(action) {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch(`${base}/${domain}/${resource}`, {
        method: METHOD[action],
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Act-As-User": actor },
      });
      const body = await res.json().catch(() => ({}));
      setOutcome({ status: res.status, action, body });
    } catch (err) {
      setOutcome({ status: 0, action, body: { message: err.message } });
    } finally {
      setBusy(false);
    }
  }

  function onDomainChange(id) {
    setDomain(id);
    const d = domains.find((x) => x.id === id);
    if (d?.resources?.length) setResource(d.resources[0].id);
  }

  return (
    <div style={{ width: 680, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 4px", color: "#0B2545" }}>App Workbench</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#5B6B7C" }}>
        Two demo product apps live in the data plane. Every action below calls the real{" "}
        <code>platform-apps-service</code>, which asks the Authorization Gateway
        <code> /v1/authorize</code> before doing anything &mdash; so a 200 vs 403 here is the
        actual role/privilege enforcement, not a UI guess. <code>data_scientist</code> can act in
        MLOps; <code>data_engineer</code> in Data Platform; nobody can <code>delete</code>
        (WRITE_FILESET maps only to view/create/edit).
      </p>

      {error && <div style={box("#FDECEC", "#8B1F1F", "#F2B8B8")}>Error: {error}</div>}

      {/* ---- Capability matrix ---- */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h4 style={{ margin: "8px 0", fontSize: 14, color: "#0B2545" }}>Who can do what</h4>
        <button onClick={loadMatrix} style={ghostBtn} disabled={loading}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 16 }}>
        <thead>
          <tr style={{ background: "#E6F1F0" }}>
            <th style={th}>User</th>
            <th style={th}>MLOps Studio</th>
            <th style={th}>Data Platform Studio</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map(({ user, caps }) => (
            <tr key={user.email} style={{ borderTop: "1px solid #E1E5EA" }}>
              <td style={td}>
                <div style={{ fontWeight: "bold", color: "#132238" }}>{user.label}</div>
                <div style={{ fontSize: 11, color: "#5B6B7C" }}>{user.note}</div>
              </td>
              {["mlops", "dataplatform"].map((dom) => {
                const c = caps.find((x) => x.domain === dom);
                return <td key={dom} style={td}>{renderAllowed(c)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---- Interactive tester ---- */}
      <h4 style={{ margin: "8px 0", fontSize: 14, color: "#0B2545" }}>Try an action</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <label style={lbl}>Act as</label>
        <select value={actor} onChange={(e) => setActor(e.target.value)} style={sel}>
          {TEST_USERS.map((u) => (
            <option key={u.email} value={u.email}>{u.label} ({u.note})</option>
          ))}
        </select>
        <label style={lbl}>App</label>
        <select value={domain} onChange={(e) => onDomainChange(e.target.value)} style={sel}>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </select>
        <label style={lbl}>Resource</label>
        <select value={resource} onChange={(e) => setResource(e.target.value)} style={sel}>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {["view", "create", "edit", "delete"].map((a) => (
          <button
            key={a}
            onClick={() => runAction(a)}
            disabled={busy}
            style={{ ...actionBtn, background: ACTION_COLORS[a] }}
          >
            {a}
          </button>
        ))}
      </div>

      {outcome && (
        <div
          style={box(
            outcome.status === 200 ? "#E9F6EF" : "#FDECEC",
            outcome.status === 200 ? "#1B6E43" : "#8B1F1F",
            outcome.status === 200 ? "#B7E2C8" : "#F2B8B8"
          )}
        >
          <div style={{ fontWeight: "bold", marginBottom: 4 }}>
            {outcome.status === 200 ? "✓ 200 Allowed" : `✗ ${outcome.status || "ERR"} Denied`} &mdash; {outcome.action}
          </div>
          {outcome.body.viaRole && (
            <div style={{ fontSize: 12 }}>via role: <code>{outcome.body.viaRole}</code></div>
          )}
          <div style={{ fontSize: 12, marginTop: 4 }}>{outcome.body.message}</div>
          {outcome.body.hint && (
            <div style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>{outcome.body.hint}</div>
          )}
          {outcome.body.result && (
            <pre style={{ fontSize: 11, marginTop: 6, background: "rgba(0,0,0,0.04)", padding: 8, borderRadius: 4, overflowX: "auto" }}>
              {JSON.stringify(outcome.body.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function renderAllowed(cap) {
  if (!cap || !cap.allowed?.length) {
    return <span style={{ color: "#9DA9B4", fontSize: 12 }}>— denied —</span>;
  }
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {cap.allowed.map((a) => (
        <span key={a} style={{ background: "#E9F6EF", color: "#1B6E43", fontSize: 11, fontWeight: "bold", padding: "2px 6px", borderRadius: 4 }}>
          {a}
        </span>
      ))}
      {cap.viaRole && <span style={{ fontSize: 10, color: "#5B6B7C", alignSelf: "center" }}>via {cap.viaRole}</span>}
    </div>
  );
}

const box = (bg, fg, border) => ({
  padding: 10, margin: "10px 0", background: bg, color: fg,
  border: `1px solid ${border}`, borderRadius: 6, fontSize: 13,
});
const th = { textAlign: "left", padding: "8px", color: "#0B2545", fontSize: 12 };
const td = { padding: "8px", verticalAlign: "top" };
const lbl = { fontSize: 12, color: "#5B6B7C" };
const sel = { padding: 6, fontSize: 13, border: "1px solid #C7CFD6", borderRadius: 4 };
const actionBtn = { padding: "8px 18px", color: "white", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 14, textTransform: "capitalize" };
const ghostBtn = { padding: "4px 10px", background: "none", border: "1px solid #C7CFD6", borderRadius: 4, cursor: "pointer", fontSize: 12, color: "#5B6B7C" };
