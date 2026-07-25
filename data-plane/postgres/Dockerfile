# PostgreSQL 18 + Percona pg_oidc_validator, so Postgres can authenticate
# connections with Keycloak OIDC tokens (pg_hba.conf `oauth` method).
#
# amd64 only: Percona ships the validator prebuilt for x86_64 (no arm64 build),
# so on Apple Silicon this runs under emulation (compose sets platform).
FROM postgres:18

COPY pg_oidc_validator.deb /tmp/pg_oidc_validator.deb
# apt resolves the validator's runtime deps (libcurl etc.); ca-certificates lets
# us trust the POC's self-signed Keycloak cert so the validator can fetch JWKS.
# libpq-oauth provides the CLIENT-side OIDC device-code flow, so psql in this
# image can also act as an OAuth test client (not just the server).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libcurl4 libpq-oauth /tmp/pg_oidc_validator.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/pg_oidc_validator.deb

# Trust Keycloak's self-signed cert (validator talks to https://keycloak:8443).
COPY keycloak.pem /usr/local/share/ca-certificates/keycloak.crt
RUN update-ca-certificates
