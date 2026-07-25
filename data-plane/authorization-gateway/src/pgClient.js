const { Pool } = require("pg");
const { sqlForGravitinoPrivileges } = require("./privilegeMap");

/**
 * Provisions Postgres from Gravitino's RBAC (Gravitino is the source of truth):
 *
 *   • group roles  — one NOLOGIN Postgres role per control-plane role
 *     (data_scientist, data_engineer). Its table GRANTs are derived from the
 *     matching Gravitino role's privileges on the pg_catalog schemas.
 *
 *   • per-user roles — one LOGIN Postgres role per person, made a MEMBER of the
 *     group role(s) their Gravitino roles map to. So each person connects AS
 *     themselves and inherits the group role's privileges. (Architect's model:
 *     "create postgres roles on our role name; create users as pg users and map
 *     the pg role to the user.")
 *
 *   • credentials — vended per user with a freshly rotated password
 *     (ALTER ROLE ... PASSWORD on each request), so nothing stores standing
 *     per-user secrets.
 */

const ADMIN = {
  host: process.env.PG_HOST || "postgres",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "dataplane",
  user: process.env.PG_ADMIN_USER || "postgres",
  password: process.env.PG_ADMIN_PASSWORD || "postgres",
};
// Address handed to clients (host-mapped), not the internal service name.
const PUBLIC_HOST = process.env.PG_PUBLIC_HOST || "localhost";
const PUBLIC_PORT = Number(process.env.PG_PUBLIC_PORT || 5432);
const PG_CATALOG_PREFIX = (process.env.GRAVITINO_PG_CATALOG || "pg_catalog") + ".";
const MANAGED_SCHEMAS = (process.env.PG_MANAGED_SCHEMAS || "mlops,dataplatform")
  .split(",").map((s) => s.trim()).filter(Boolean);

const pool = new Pool({ ...ADMIN, max: 4, connectionTimeoutMillis: 5000 });

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name) => {
  // Group roles / schemas are simple identifiers. Per-user role names (emails)
  // contain '.' '@' etc., so quote-escape by doubling any embedded quotes.
  if (IDENT.test(name)) return `"${name}"`;
  return `"${String(name).replace(/"/g, '""')}"`;
};

async function ping() {
  const c = await pool.connect();
  try { await c.query("SELECT 1"); return true; } finally { c.release(); }
}

/**
 * Translate a Gravitino role (as returned by its REST API) into Postgres grant
 * specs. Only securables under the pg_catalog are considered; each maps to a
 * schema (and optionally a table) plus the SQL privileges the Gravitino
 * privileges imply. This is the "read RBAC from Gravitino" step.
 */
function pgGrantsFromGravitinoRole(role) {
  const out = [];
  for (const so of role?.securableObjects || []) {
    if (!so.fullName || !so.fullName.startsWith(PG_CATALOG_PREFIX)) continue;
    const rest = so.fullName.slice(PG_CATALOG_PREFIX.length); // "mlops" or "mlops.training_runs"
    const [schema, table] = rest.split(".");
    if (!MANAGED_SCHEMAS.includes(schema)) continue;
    const privs = sqlForGravitinoPrivileges(so.privileges);
    if (privs.length) out.push({ schema, table: table || null, privileges: privs });
  }
  return out;
}

/** Create a NOLOGIN group role if absent (idempotent). */
async function ensureGroupRole(client, roleName) {
  const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
  if (!rowCount) await client.query(`CREATE ROLE ${ident(roleName)} NOLOGIN`);
}

/**
 * Reconcile a group role's GRANTs to exactly the specs derived from Gravitino
 * (full desired state: revoke on managed schemas, then re-grant).
 */
async function syncGroupRole(roleName, grantSpecs) {
  const role = ident(roleName);
  const client = await pool.connect();
  try {
    await ensureGroupRole(client, roleName);

    for (const schema of MANAGED_SCHEMAS) {
      const s = ident(schema);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${role}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${role}`);
      await client.query(`REVOKE ALL ON SCHEMA ${s} FROM ${role}`);
    }

    for (const spec of grantSpecs) {
      const s = ident(spec.schema);
      const privList = spec.privileges.join(", "); // fixed whitelist, safe
      await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${role}`);
      if (spec.table) {
        await client.query(`GRANT ${privList} ON TABLE ${s}.${ident(spec.table)} TO ${role}`);
      } else {
        await client.query(`GRANT ${privList} ON ALL TABLES IN SCHEMA ${s} TO ${role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${privList} ON TABLES TO ${role}`);
      }
      if (spec.privileges.includes("INSERT") || spec.privileges.includes("UPDATE")) {
        await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE ON SEQUENCES TO ${role}`);
      }
    }
    console.log(`[pgClient] group role '${roleName}' reconciled (${grantSpecs.length} schema grant(s) from Gravitino)`);
  } finally {
    client.release();
  }
}

/** Ensure a per-user LOGIN role exists (no usable password until vended). */
async function ensureUserRole(client, user) {
  const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [user]);
  if (!rowCount) await client.query(`CREATE ROLE ${ident(user)} LOGIN`);
}

/**
 * Reconcile which users are members of a group role to exactly `desiredUsers`:
 * create each user's PG role, GRANT membership, and REVOKE from anyone dropped.
 */
async function reconcileMembers(roleName, desiredUsers = []) {
  const role = ident(roleName);
  const client = await pool.connect();
  try {
    for (const user of desiredUsers) {
      await ensureUserRole(client, user);
      await client.query(`GRANT ${role} TO ${ident(user)}`);
    }
    // Drop members no longer assigned (full desired state).
    const { rows } = await client.query(
      `SELECT m.rolname AS member
         FROM pg_auth_members am
         JOIN pg_roles g ON g.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE g.rolname = $1`,
      [roleName]
    );
    const desired = new Set(desiredUsers);
    for (const { member } of rows) {
      if (!desired.has(member)) {
        await client.query(`REVOKE ${role} FROM ${ident(member)}`);
      }
    }
    console.log(`[pgClient] group role '${roleName}' members: ${desiredUsers.join(", ") || "(none)"}`);
  } finally {
    client.release();
  }
}

/** Ensure a user's PG role exists and is a member of the given group roles (grant-only). */
async function addUserToGroups(user, roleNames = []) {
  const client = await pool.connect();
  try {
    await ensureUserRole(client, user);
    for (const r of roleNames) await client.query(`GRANT ${ident(r)} TO ${ident(user)}`);
  } finally {
    client.release();
  }
}

const KEYCLOAK_ISSUER = process.env.KEYCLOAK_ISSUER || "https://keycloak:8443/realms/inaiera";
const OAUTH_CLIENT_ID = process.env.PG_OAUTH_CLIENT_ID || "pgclient";

/**
 * Return the OAuth connection details for a user. Authentication is delegated
 * to Keycloak (pg_hba `oauth` method), so there is NO password: the user runs
 * the OIDC device-code flow, logs into Keycloak, and the validator maps their
 * email claim to their same-named PG role. We only ensure the LOGIN role exists;
 * the caller has already confirmed (against Gravitino) that the user holds a
 * PG-relevant role, and group-role membership provides the actual privileges.
 */
async function vendUserCredentials(user) {
  const client = await pool.connect();
  try {
    await ensureUserRole(client, user);
  } finally {
    client.release();
  }
  // Host form: for a PostgreSQL 18 client on the host (host-mapped port).
  const hostConn = `host=${PUBLIC_HOST} port=${PUBLIC_PORT} dbname=${ADMIN.database} user=${user} oauth_issuer=${KEYCLOAK_ISSUER} oauth_client_id=${OAUTH_CLIENT_ID}`;
  // Container form: run via the bundled PG18 client (127.0.0.1 + internal port).
  // Reliable regardless of the host's psql version.
  const inContainerConn = `host=127.0.0.1 port=${ADMIN.port} dbname=${ADMIN.database} user=${user} oauth_issuer=${KEYCLOAK_ISSUER} oauth_client_id=${OAUTH_CLIENT_ID}`;
  return {
    user,
    auth: "oauth-keycloak",
    host: PUBLIC_HOST,
    port: PUBLIC_PORT,
    database: ADMIN.database,
    issuer: KEYCLOAK_ISSUER,
    clientId: OAUTH_CLIENT_ID,
    dsn: hostConn,
    // Primary, copy-paste runnable command (uses the container's PG18 client):
    psqlDocker: `docker compose exec postgres psql "${inContainerConn}"`,
    // Alternative if you have a PostgreSQL 18 client on the host:
    psql: `psql "${hostConn}"`,
    note: "No password: a browser device-code login to Keycloak completes the connection.",
  };
}

/**
 * The user's LIVE effective permissions, straight from Postgres: for every
 * table in the managed schemas, which of SELECT/INSERT/UPDATE/DELETE the user's
 * role actually has (via group-role membership). This is a real permission
 * test surfaced to the UI -- Postgres itself answers, not our model.
 */
async function effectiveAccess(user) {
  const client = await pool.connect();
  try {
    const out = [];
    for (const schema of MANAGED_SCHEMAS) {
      const { rows: tables } = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]
      );
      for (const { tablename } of tables) {
        const fq = `${schema}.${tablename}`;
        const allowed = [];
        for (const act of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const { rows } = await client.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [user, fq, act]);
          if (rows[0].ok) allowed.push(act.toLowerCase());
        }
        out.push({ schema, table: tablename, privileges: allowed });
      }
    }
    return out;
  } finally {
    client.release();
  }
}

module.exports = {
  ping,
  pgGrantsFromGravitinoRole,
  syncGroupRole,
  reconcileMembers,
  addUserToGroups,
  vendUserCredentials,
  effectiveAccess,
};
