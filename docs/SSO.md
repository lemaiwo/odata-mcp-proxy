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

> **Backend calls use a technical user.** SSO decides *who may use the MCP
> server*. Calls to SAP still use the client-credentials configured per
> destination (`{PREFIX}_BASE_URL`, `_TOKEN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`,
> see [LOCAL_RUN.md](LOCAL_RUN.md)). Per-user principal propagation to SAP is
> only available on BTP with XSUAA and the Destination Service.

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
