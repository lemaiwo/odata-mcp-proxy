# Self-Hosted Deployment with SSO

The server does not need SAP BTP to run. Any Node.js host (VM, on-prem server,
container, Azure/AWS/GCP) can run it in HTTP mode, with single sign-on in front
of the `/mcp` endpoint.

Two inbound auth providers are available, selected with `AUTH_PROVIDER`:

| `AUTH_PROVIDER` | Behaviour |
|---|---|
| `auto` (default) | `oidc` when `OIDC_ISSUER` is set, otherwise `xsuaa` |
| `oidc` | Generic OpenID Connect: Entra ID, Okta, Keycloak, SAP IAS, Auth0, … |
| `xsuaa` | SAP XSUAA from `VCAP_SERVICES` (open when no XSUAA is bound, as before) |
| `none` | No authentication (local development only) |

In both cases the server proxies the OAuth authorization-code flow for MCP
clients (Claude, MCP Inspector, …) exactly as on BTP: it publishes
`/.well-known/oauth-authorization-server`, hands out a static client at
`/oauth/client-registration`, and forwards `/oauth/authorize`, `/oauth/callback`
and `/oauth/token` to the identity provider. Every `/mcp` request needs a valid
Bearer token.

> **By default, backend calls use a technical user.** SSO decides *who may use
> the MCP server*; calls to SAP use the client-credentials configured per
> destination (`{PREFIX}_BASE_URL`, `_TOKEN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`,
> see [LOCAL_RUN.md](LOCAL_RUN.md)). To call SAP *as the signed-in user*, set a
> per-user `{PREFIX}_AUTH_TYPE` — see
> [Propagating the user to SAP](#propagating-the-user-to-sap).

---

## Option 1 — Generic OIDC

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OIDC_ISSUER` | Yes | — | Issuer URL; `${OIDC_ISSUER}/.well-known/openid-configuration` must resolve |
| `OIDC_CLIENT_ID` | Yes | — | Client ID of the app registered at the IdP |
| `OIDC_CLIENT_SECRET` | Yes | — | Client secret of that app |
| `OIDC_SCOPES` | No | `openid profile email offline_access` | Scopes requested at login. Must yield an access token **for this server** (see IdP notes) |
| `OIDC_AUDIENCE` | No | `OIDC_CLIENT_ID` | Accepted `aud` values of access tokens, comma-separated |
| `OIDC_TOKEN_AUTH_METHOD` | No | `client_secret_post` | `client_secret_post` or `client_secret_basic` for the IdP token endpoint |

Register `https://<your-host>/oauth/callback` as the redirect URI of the app
at the IdP.

Access tokens are verified against the IdP's JWKS (signature, `iss`, `aud`,
`exp`). Tokens issued for another resource (e.g. Microsoft Graph) are rejected,
which is why `OIDC_SCOPES` usually has to include a scope of your own API.

### Scopes and roles

Operations with a `requiredScope` in the API config are checked against the
token. The check reads, in order, `scope` (array or space-separated string),
`scp` and `roles`. A granted value matches when it equals the required scope or
ends with `.<requiredScope>` — so `read`, `MCP.read` and
`odata-mcp-proxy!t1.read` all satisfy `requiredScope: "read"`.

### Microsoft Entra ID

1. **App registrations → New registration.** Platform *Web*, redirect URI
   `https://<your-host>/oauth/callback`. Create a client secret.
2. **Expose an API.** Set the Application ID URI (`api://<client-id>`) and add
   a scope, e.g. `access_as_user`.
3. **Manifest.** Set `"requestedAccessTokenVersion": 2` (under `api`), so access
   tokens carry the v2 issuer and `aud = <client-id>`.
4. **App roles** (optional, for `requiredScope`). Create roles with values
   `read`, `write`, `admin` and assign users or groups under *Enterprise
   applications → Users and groups*.

```bash
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<secret>
OIDC_SCOPES="openid profile offline_access api://<client-id>/access_as_user"
```

Only single-tenant issuers are supported (not `/common` or `/organizations`).

### Okta

Use a **custom authorization server** (e.g. `default`); tokens from the Org
authorization server cannot be validated by third parties. Add custom scopes
`read`, `write`, `admin` to the authorization server if you use `requiredScope`.

```bash
OIDC_ISSUER=https://<org>.okta.com/oauth2/default
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<secret>
OIDC_AUDIENCE=api://default
OIDC_SCOPES="openid profile offline_access read write"
OIDC_TOKEN_AUTH_METHOD=client_secret_basic
```

### Keycloak

Create a confidential OpenID Connect client. Access tokens only contain the
client ID in `aud` after adding an **Audience** mapper for it. For
`requiredScope`, either create client scopes named `read` / `write` / `admin`,
or add a *User Realm Role* mapper with token claim name `roles`.

```bash
OIDC_ISSUER=https://<keycloak-host>/realms/<realm>
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<secret>
```

### SAP Cloud Identity Services (IAS)

Create an OpenID Connect application with a client secret and the redirect URI
above. IAS can in turn federate a corporate IdP.

```bash
OIDC_ISSUER=https://<tenant>.accounts.ondemand.com
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<secret>
```

IAS puts authorizations in `groups`, which the scope check does not read; leave
`requiredScope` unset or use Option 2 for role-based access.

---

## Option 2 — XSUAA outside BTP

If you already have a BTP subaccount, the server can keep using XSUAA (and IAS
or a corporate IdP behind it) while running anywhere. Provide **only** the
`xsuaa` binding in `VCAP_SERVICES`, e.g. via `default-env.json`:

```json
{
  "VCAP_SERVICES": {
    "xsuaa": [{
      "label": "xsuaa",
      "name": "odata-mcp-proxy-xsuaa",
      "credentials": {
        "clientid": "...", "clientsecret": "...",
        "url": "https://<subdomain>.authentication.<region>.hana.ondemand.com",
        "xsappname": "...", "uaadomain": "authentication.<region>.hana.ondemand.com",
        "verificationkey": "..."
      }
    }]
  }
}
```

Add `https://<your-host>/**` to `redirect-uris` in `xs-security.json` and
update the XSUAA instance. Because no `destination` binding is present, backend
credentials are still read from the `{PREFIX}_*` environment variables.

---

## Propagating the user to SAP

With SSO enabled, each `/mcp` request carries the user's validated access
token. An env-var destination can turn it into a backend token **for that
user**, independently of which OIDC provider issued it, by setting
`{PREFIX}_AUTH_TYPE`:

| `{PREFIX}_AUTH_TYPE` | Flow | Typical backend |
|---|---|---|
| `client-credentials` (default) | Technical user | anything |
| `saml-bearer` | The proxy signs a SAML 2.0 assertion for the user and trades it at the backend's OAuth server (RFC 7522) — the same flow as BTP's `OAuth2SAMLBearerAssertion` | SAP ABAP / S/4HANA on-prem, S/4HANA Cloud |
| `jwt-bearer` | The user's token is presented as an assertion (RFC 7523) | Authorization servers that trust your IdP, e.g. XSUAA when the IdP is SAP IAS |
| `token-exchange` | OAuth 2.0 Token Exchange (RFC 8693) | Keycloak, Okta, Auth0, … issuing tokens your backend accepts |

All per-user types use `{PREFIX}_TOKEN_URL`, `_CLIENT_ID` and `_CLIENT_SECRET`
(sent with HTTP Basic) plus an optional `{PREFIX}_SCOPE`. Backend tokens are
cached per user (`iss` + `sub`) and destination, never shared. If a request has
no user token (stdio, or auth disabled) the call **fails** — it never falls
back to the technical user.

### `saml-bearer` (SAP ABAP / S/4HANA)

The proxy acts as a trusted SAML identity provider towards SAP. It maps a
claim of the validated user token to the SAML `NameID`, so any OIDC IdP works.

| Variable | Required | Default | Description |
|---|---|---|---|
| `{PREFIX}_SAML_ISSUER` | Yes | — | Issuer of the assertion; the trusted provider name in SAP |
| `{PREFIX}_SAML_AUDIENCE` | Yes | — | The SAP system's local SAML provider name (transaction `SAML2`) |
| `{PREFIX}_SAML_SIGNING_KEY` | Yes | — | PEM private key (inline with `\n`, or a file path) |
| `{PREFIX}_SAML_SIGNING_CERT` | Yes | — | PEM X.509 certificate for that key (inline or file path) |
| `{PREFIX}_SAML_NAMEID_CLAIM` | No | `email` | Token claim used as NameID (`email`, `preferred_username`, `upn`, …) |
| `{PREFIX}_SAML_NAMEID_FORMAT` | No | `urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified` | NameID format, e.g. `…:emailAddress` |
| `{PREFIX}_SAML_ASSERTION_ENCODING` | No | `base64url` | Assertion encoding in the token request (`base64url` per RFC 7522, or `base64`) |
| `{PREFIX}_SCOPE` | Usually | — | OAuth scopes of the SAP services, e.g. `ZAPI_BUSINESS_PARTNER_0001` |

Generate a signing key pair:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 730 \
  -keyout saml-signing-key.pem -out saml-signing-cert.pem -subj "/CN=odata-mcp-proxy"
```

SAP ABAP / S/4HANA on-premise:

1. **`SAML2`** — enable SAML 2.0 for the client; note the *local provider
   name* (→ `SAML_AUDIENCE`).
2. **Trusted Providers → OAuth 2.0 Identity Providers** — add a provider named
   `SAML_ISSUER` with `saml-signing-cert.pem` as signing certificate. Choose
   the NameID format and how it maps to SAP users (e.g. e-mail address from
   `SU01`, or user ID / alias).
3. **`SOAUTH2`** — create an OAuth 2.0 client (its system user and password are
   `CLIENT_ID` / `CLIENT_SECRET`), enable the *SAML 2.0 Bearer Assertion* grant
   for that trusted provider and add the OData services' scopes.
4. `TOKEN_URL` is `https://<host>:<port>/sap/bc/sec/oauth2/token?sap-client=<client>`.

S/4HANA Cloud: create a communication system with the proxy as SAML bearer
assertion provider (upload the certificate, set the issuer), an inbound OAuth
2.0 user, and a communication arrangement for the APIs; the token URL is
`https://<tenant>-api.s4hana.cloud.sap/sap/bc/sec/oauth2/token`.

```bash
S4_BASE_URL=https://s4.example.com:44300
S4_TOKEN_URL=https://s4.example.com:44300/sap/bc/sec/oauth2/token?sap-client=100
S4_CLIENT_ID=MCP_OAUTH_CLIENT
S4_CLIENT_SECRET=...
S4_AUTH_TYPE=saml-bearer
S4_SAML_ISSUER=odata-mcp-proxy
S4_SAML_AUDIENCE=S4H_100
S4_SAML_SIGNING_KEY=/etc/odata-mcp-proxy/saml-signing-key.pem
S4_SAML_SIGNING_CERT=/etc/odata-mcp-proxy/saml-signing-cert.pem
S4_SAML_NAMEID_CLAIM=email
S4_SCOPE=ZAPI_BUSINESS_PARTNER_0001
```

> **Protect the signing key.** SAP trusts any assertion signed with it, so
> whoever holds it can act as *any* mapped SAP user. Store it like a root
> credential (file readable only by the service account, or a secret store),
> restrict the trusted provider to the users and scopes you need, and rotate
> it periodically. The proxy only signs assertions for users whose tokens it
> has validated, and the NameID comes from that validated token.

### `jwt-bearer` and `token-exchange`

```bash
CPI_DESTINATION_AUTH_TYPE=jwt-bearer          # or token-exchange
CPI_DESTINATION_SCOPE=...                     # optional
CPI_DESTINATION_TOKEN_EXCHANGE_AUDIENCE=...   # token-exchange only, optional
CPI_DESTINATION_TOKEN_EXCHANGE_RESOURCE=...   # token-exchange only, optional
```

These only work when the authorization server at `TOKEN_URL` trusts tokens
from your IdP (`jwt-bearer`) or implements RFC 8693 for them
(`token-exchange`). For SAP BTP services (XSUAA), that typically means using
SAP IAS as the OIDC provider, federating your corporate IdP behind it.

---

## Running in production

- **HTTPS is required** for the OAuth redirect (except on `localhost`). Put the
  server behind a reverse proxy (nginx, Caddy, IIS, Azure App Gateway, …) and
  forward the `Host` and `X-Forwarded-Proto` headers — the public base URL in
  the OAuth metadata is derived from them.
- **Run a single instance**, or enable sticky sessions: MCP sessions are kept
  in memory.
- Set `NODE_ENV=production` and `CORS_ORIGIN` if browser-based clients connect.
- Run it as a service, e.g. systemd:

```ini
[Unit]
Description=OData MCP Proxy
After=network-online.target

[Service]
WorkingDirectory=/opt/odata-mcp-proxy
EnvironmentFile=/opt/odata-mcp-proxy/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
User=odata-mcp

[Install]
WantedBy=multi-user.target
```

- `GET /health` reports `"authProvider"` so you can confirm which provider is
  active.
