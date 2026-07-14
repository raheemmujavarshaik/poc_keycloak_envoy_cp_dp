import { useState, useEffect } from "react";

/**
 * This component's JS bundle was fetched by the App Shell from
 * /api/dataplane/<dataPlaneId>/product/assets/... -- i.e. through the
 * Agent Comms Service and the tunnel, never directly from this container.
 * Successfully rendering this proves the whole MFE-through-tunnel loading
 * path works, not just the underlying HTTP relay.
 */
export default function ProductWidget() {
  const [loadedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    console.log("[product-mfe] ProductWidget mounted -- loaded via the tunnel from the data plane");
  }, []);

  return (
    <div style={{ border: "2px solid #057A6E", borderRadius: 8, padding: 16, fontFamily: "sans-serif" }}>
      <h3 style={{ margin: "0 0 8px", color: "#057A6E" }}>Product MFE (Data Plane)</h3>
      <p style={{ margin: 0, fontSize: 14, color: "#132238" }}>
        This component's code was served from the data plane and loaded through the tunnel broker &mdash;
        the browser never connected to the data plane directly.
      </p>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "#5B6B7C" }}>Rendered at: {loadedAt}</p>
    </div>
  );
}
