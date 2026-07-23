import { useState, useEffect, useCallback } from "react";

const BFF_URL = import.meta.env.VITE_BFF_URL || "http://localhost:4002";
const DATA_PLANE_ID = import.meta.env.VITE_DATA_PLANE_ID || "dp_demo";

// Role CRUD lives on the control-plane BFF (cross-origin, cookie-auth'd via
// CORS credentials). The capability check goes to the DATA PLANE instead --
// through the same same-origin /api/dataplane proxy CatalogView uses, so the
// BFF mints the data-plane ticket server-side. That difference is the point:
// /roles is intent (MongoDB), authorize/batch is the enforced answer read
// from the data plane's own dp-redis cache -- proving the role sync landed.
const ROLES_URL = `${BFF_URL}/roles`;
const BATCH_URL = `/api/dataplane/${DATA_PLANE_ID}/authz/v1/authorize/batch`;

const PRIV_COLORS = {
  WRITE_FILESET: { bg: "#E6F1F0", fg: "#057A6E" },
  CREATE_FILESET: { bg: "#EFE8FA", fg: "#5B4B9A" },
  READ_FILESET: { bg: "#E4E9F5", fg: "#0B2545" },
};

const ALL_ACTIONS = ["view", "create", "edit", "delete"];

export default function RolesView() {
  const [roles, setRoles] = useState([]);
  const [assignments, setAssignments] = useState({}); // roleName -> [emails]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // assign form
  const [email, setEmail] = useState("sarah.choi@acme.test");
  const [roleName, setRoleName] = useState("");

  // capability check
  const [checkUser, setCheckUser] = useState("sarah.choi@acme.test");
  const [checkResource, setCheckResource] = useState("");
  const [capability, setCapability] = useState(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(ROLES_URL, { credentials: "include" });
      if (!res.ok) throw new Error(`failed to load roles (${res.status})`);
      const { roles: list } = await res.json();
      setRoles(list || []);
      if (list?.length && !roleName) setRoleName(list[0].roleName);
      if (list?.length && !checkResource) {
        setCheckResource(list[0].grants?.[0]?.resource || "");
      }

      // Pull each role's current assignees so the table shows who has what.
      const pairs = await Promise.all(
        (list || []).map(async (r) => {
          const a = await fetch(`${ROLES_URL}/${r.roleName}/assignments`, { credentials: "include" });
          const body = a.ok ? await a.json() : { users: [] };
          return [r.roleName, body.users || []];
        })
      );
      setAssignments(Object.fromEntries(pairs));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [roleName, checkResource]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg) => {
    setNotice(msg);
    setError(null);
  };

  async function assign(e) {
    e.preventDefault();
    if (!email || !roleName) return;
    try {
      const res = await fetch(`${ROLES_URL}/${roleName}/assign`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userEmail: email }),
      });
      if (!res.ok) throw new Error(`assign failed (${res.status})`);
      const body = await res.json();
      flash(`Assigned ${email} → ${roleName} (sync event ${body.syncEventId || "queued"})`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function unassign(role, userEmail) {
    try {
      const res = await fetch(`${ROLES_URL}/${role}/assign/${encodeURIComponent(userEmail)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`unassign failed (${res.status})`);
      flash(`Removed ${userEmail} from ${role}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function checkCapability(e) {
    e.preventDefault();
    if (!checkUser || !checkResource) return;
    setChecking(true);
    setCapability(null);
    setError(null);
    try {
      const res = await fetch(BATCH_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: checkUser, resourcePrefix: checkResource, actions: ALL_ACTIONS }),
      });
      if (!res.ok) throw new Error(`capability check failed (${res.status})`);
      const body = await res.json();
      setCapability(body); // { resourcePrefix, allowed: [...] }
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  // Distinct resources across all role grants -- used to populate the checker.
  const resourceOptions = [
    ...new Set(roles.flatMap((r) => (r.grants || []).map((g) => g.resource))),
  ];

  return (
    <div style={{ width: 620, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 4px", color: "#0B2545" }}>Roles &amp; Capabilities</h3>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#5B6B7C" }}>
        Assign roles to users (writes intent to MongoDB, then propagates through the tunnel to this
        data plane&rsquo;s Authorization Gateway). The capability check below reads the <em>enforced</em>
        answer back from the data plane, proving the sync landed.
      </p>

      {error && <div style={box("#FDECEC", "#8B1F1F", "#F2B8B8")}>Error: {error}</div>}
      {notice && <div style={box("#E9F6EF", "#1B6E43", "#B7E2C8")}>{notice}</div>}

      {/* --- Assign --- */}
      <form onSubmit={assign} style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user email"
          style={{ flex: 1, minWidth: 200, padding: 8, fontSize: 14, border: "1px solid #C7CFD6", borderRadius: 4 }}
        />
        <select
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
          style={{ padding: 8, fontSize: 14, border: "1px solid #C7CFD6", borderRadius: 4 }}
        >
          {roles.map((r) => (
            <option key={r.roleName} value={r.roleName}>{r.roleName}</option>
          ))}
        </select>
        <button type="submit" style={btn("#057A6E")}>Assign role</button>
      </form>

      {/* --- Roles table --- */}
      {loading && <p style={{ fontSize: 13, color: "#5B6B7C" }}>Loading roles&hellip;</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {roles.map((r) => (
          <div key={r.roleName} style={{ border: "1px solid #E1E6EB", borderRadius: 6, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontFamily: "monospace", fontSize: 14, color: "#132238", fontWeight: "bold" }}>{r.roleName}</div>
              <div style={{ fontSize: 11, color: "#5B6B7C" }}>{(assignments[r.roleName] || []).length} assigned</div>
            </div>
            <div style={{ fontSize: 12, color: "#5B6B7C", margin: "2px 0 8px" }}>{r.description}</div>

            {/* grants = the permissions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              {(r.grants || []).map((g, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ fontFamily: "monospace", color: "#132238" }}>{g.resource}</span>
                  {(g.privileges || []).map((p) => {
                    const c = PRIV_COLORS[p] || PRIV_COLORS.READ_FILESET;
                    return (
                      <span key={p} style={{ background: c.bg, color: c.fg, fontSize: 10, fontWeight: "bold", padding: "2px 6px", borderRadius: 4 }}>
                        {p}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* assignees */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(assignments[r.roleName] || []).length === 0 && (
                <span style={{ fontSize: 12, color: "#9DA9B4" }}>no users assigned</span>
              )}
              {(assignments[r.roleName] || []).map((u) => (
                <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#F1F4F7", borderRadius: 12, padding: "3px 6px 3px 10px", fontSize: 12 }}>
                  {u}
                  <button
                    onClick={() => unassign(r.roleName, u)}
                    title="unassign"
                    style={{ border: "none", background: "#D85A30", color: "white", borderRadius: "50%", width: 16, height: 16, lineHeight: "16px", fontSize: 11, cursor: "pointer", padding: 0 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* --- Capability check (enforced, from the data plane) --- */}
      <div style={{ marginTop: 16, borderTop: "1px solid #E1E6EB", paddingTop: 12 }}>
        <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "#0B2545" }}>Check resolved capabilities</h4>
        <form onSubmit={checkCapability} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={checkUser}
            onChange={(e) => setCheckUser(e.target.value)}
            placeholder="user email"
            style={{ flex: 1, minWidth: 180, padding: 8, fontSize: 14, border: "1px solid #C7CFD6", borderRadius: 4 }}
          />
          <select
            value={checkResource}
            onChange={(e) => setCheckResource(e.target.value)}
            style={{ padding: 8, fontSize: 14, border: "1px solid #C7CFD6", borderRadius: 4, maxWidth: 280 }}
          >
            {resourceOptions.map((res) => (
              <option key={res} value={res}>{res}</option>
            ))}
          </select>
          <button type="submit" style={btn("#5B4B9A")} disabled={checking}>
            {checking ? "Checking…" : "Check"}
          </button>
        </form>

        {capability && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <span style={{ color: "#5B6B7C" }}>Allowed on </span>
            <span style={{ fontFamily: "monospace", color: "#132238" }}>{capability.resourcePrefix}</span>
            <span style={{ color: "#5B6B7C" }}>: </span>
            {(capability.allowed || []).length === 0 ? (
              <span style={{ color: "#D85A30", fontWeight: "bold" }}>none (no matching grant)</span>
            ) : (
              ALL_ACTIONS.map((a) => {
                const ok = capability.allowed.includes(a);
                return (
                  <span
                    key={a}
                    style={{
                      display: "inline-block",
                      margin: "0 4px",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: "bold",
                      background: ok ? "#E9F6EF" : "#F1F4F7",
                      color: ok ? "#1B6E43" : "#9DA9B4",
                      textDecoration: ok ? "none" : "line-through",
                    }}
                  >
                    {a}
                  </span>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const box = (bg, fg, border) => ({
  padding: 10,
  margin: "8px 0",
  background: bg,
  color: fg,
  border: `1px solid ${border}`,
  borderRadius: 6,
  fontSize: 13,
});

const btn = (bg) => ({
  padding: "8px 16px",
  background: bg,
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
});
