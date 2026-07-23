const express = require("express");
const axios = require("axios");

/**
 * Sample data-plane PRODUCT microservice with two app domains:
 *   • MLOps Studio        -> resources under platform_apps.mlops.*
 *   • Data Platform Studio -> resources under platform_apps.dataplatform.workspaces.*
 *
 * The point of this service in the POC: make RBAC enforcement concrete. Every
 * resource action (view/create/edit/delete) is authorized by calling the
 * Authorization Gateway's /v1/authorize BEFORE doing anything -- this is the
 * "product microservice asks the gateway for a yes/no" pattern the RBAC design
 * describes. The service itself has no idea about roles, grants, or Gravitino;
 * it only knows "for THIS user, on THIS resource, is THIS action allowed?".
 *
 * Same "no inbound port" property as every other data-plane service: reached
 * only through Envoy, no host port published.
 *
 * Acting user: taken from the X-Act-As-User header. In production this would be
 * derived from the validated data-plane ticket (the JWT Envoy already checks).
 * For this POC we let the Workbench UI set it explicitly so you can test many
 * users' privileges while logged in as just one -- flagged here so it isn't
 * mistaken for the production identity source.
 */

const PORT = process.env.PORT || 4020;
const AUTH_GATEWAY_URL = process.env.AUTH_GATEWAY_URL || "http://authorization-gateway:4010";

const ACTIONS = ["view", "create", "edit", "delete"];

// The app catalog. resourcePath() builds the dotted resource string the
// Authorization Gateway matches grants against. Note the two domains sit under
// different prefixes on purpose: data_scientist's grant is platform_apps.mlops.*
// and data_engineer's is platform_apps.dataplatform.workspaces.* -- so each
// role can act in exactly one domain, which is what makes the demo legible.
const APPS = {
  mlops: {
    label: "MLOps Studio",
    grantedBy: "data_scientist",
    resourcePath: (r) => `platform_apps.mlops.${r}`,
    resources: [
      { id: "training_jobs", label: "Training Jobs" },
      { id: "model_registry", label: "Model Registry" },
      { id: "inference_endpoints", label: "Inference Endpoints" },
    ],
  },
  dataplatform: {
    label: "Data Platform Studio",
    grantedBy: "data_engineer",
    resourcePath: (r) => `platform_apps.dataplatform.workspaces.${r}`,
    resources: [
      { id: "team_alpha", label: "Workspace: team_alpha" },
      { id: "team_beta", label: "Workspace: team_beta" },
      { id: "shared", label: "Workspace: shared" },
    ],
  },
};

async function authorize(user, resource, action) {
  const { data } = await axios.post(
    `${AUTH_GATEWAY_URL}/v1/authorize`,
    { user, resource, action },
    { timeout: 5000 }
  );
  return data; // { allowed, viaRole }
}

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Act-As-User, X-Data-Plane-Ticket");
  next();
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

/** Describes the app catalog so the Workbench UI can render itself dynamically. */
app.get("/apps/manifest", (_req, res) => {
  res.json({
    actions: ACTIONS,
    domains: Object.entries(APPS).map(([id, d]) => ({
      id,
      label: d.label,
      grantedBy: d.grantedBy,
      resources: d.resources,
    })),
  });
});

/**
 * Capability matrix for one user. For each domain, asks the gateway what the
 * user is allowed to do (resources within a domain share the same grant, so we
 * probe one representative resource per domain -- 4 authorize calls per domain).
 */
app.post("/apps/capabilities", async (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: "missing_user" });
  try {
    const capabilities = [];
    for (const [domainId, d] of Object.entries(APPS)) {
      const probe = d.resourcePath(d.resources[0].id);
      const allowed = [];
      let viaRole = null;
      for (const action of ACTIONS) {
        const decision = await authorize(user, probe, action);
        if (decision.allowed) {
          allowed.push(action);
          viaRole = viaRole || decision.viaRole;
        }
      }
      capabilities.push({ domain: domainId, label: d.label, grantedBy: d.grantedBy, allowed, viaRole });
    }
    res.json({ user, capabilities });
  } catch (err) {
    res.status(502).json({ error: "authorize_unreachable", message: err.message });
  }
});

/** Shared enforcement for every concrete resource action. */
async function handleAction(req, res, action) {
  const user = req.header("x-act-as-user");
  const { domain, resource } = req.params;
  if (!user) {
    return res.status(400).json({ error: "missing_act_as_user", message: "set the X-Act-As-User header" });
  }
  const appDomain = APPS[domain];
  if (!appDomain) return res.status(404).json({ error: "unknown_domain", domain });

  const fullResource = appDomain.resourcePath(resource);
  let decision;
  try {
    decision = await authorize(user, fullResource, action);
  } catch (err) {
    return res.status(502).json({ error: "authorize_unreachable", message: err.message });
  }

  if (!decision.allowed) {
    return res.status(403).json({
      allowed: false,
      user,
      action,
      resource: fullResource,
      message: `${user} is not allowed to ${action} ${fullResource}`,
      hint: `needs a role whose grant covers this resource and maps to '${action}' (WRITE_FILESET => view/create/edit; nothing grants delete)`,
    });
  }

  // Authorized -> "perform" the action. Canned result; the point is the call
  // path + the enforcement decision, not a real datastore.
  res.json({
    allowed: true,
    user,
    action,
    resource: fullResource,
    viaRole: decision.viaRole,
    result: simulatedResult(domain, resource, action),
  });
}

function simulatedResult(domain, resource, action) {
  const now = "just now";
  switch (action) {
    case "view":
      return { message: `Opened ${domain}/${resource}`, items: [`${resource}-001`, `${resource}-002`], lastUpdated: now };
    case "create":
      return { message: `Created a new item in ${domain}/${resource}`, id: `${resource}-new`, createdAt: now };
    case "edit":
      return { message: `Updated ${domain}/${resource}`, updatedAt: now };
    case "delete":
      return { message: `Deleted from ${domain}/${resource}` };
    default:
      return {};
  }
}

app.get("/apps/:domain/:resource", (req, res) => handleAction(req, res, "view"));
app.post("/apps/:domain/:resource", (req, res) => handleAction(req, res, "create"));
app.put("/apps/:domain/:resource/:id?", (req, res) => handleAction(req, res, "edit"));
app.delete("/apps/:domain/:resource/:id?", (req, res) => handleAction(req, res, "delete"));

app.listen(PORT, () => {
  console.log(`[platform-apps-service] listening on :${PORT} (gateway: ${AUTH_GATEWAY_URL})`);
});
