# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Development with hot reload
npm run dev

# Build TypeScript to dist/
npm run build

# Run built server (HTTP transport, default)
npm start

# Run with stdio transport (for Claude Desktop)
npm run start:stdio

# Run tests (node:test via tsx; builds first — the e2e test boots dist/index.js)
npm test

# Deploy to SAP BTP
npm run build:btp    # Build MTA archive
npm run deploy:btp   # Deploy via CF CLI
```

Tests live in `test/` (unit tests for the UI layer, destination fallback and OIDC auth, plus a stdio end-to-end test against a stub config in `test/fixtures/`).

## Architecture

This is an MCP (Model Context Protocol) server that bridges AI assistants with SAP Cloud Integration (CPI) OData V2 APIs. It runs as either a stdio server (local Claude Desktop) or an HTTP server (SAP BTP Cloud Foundry deployment).

### Transport Modes

- **stdio** (`MCP_TRANSPORT=stdio`): For Claude Desktop integration. Reads/writes over standard I/O.
- **HTTP** (`MCP_TRANSPORT=http`, default): Express-based server on port 4004. Uses Streamable HTTP with SSE (`GET /mcp`) for notifications, `POST /mcp` for requests, `DELETE /mcp` for session teardown. Session state maintained in-memory.

### Request Flow

```
AI Assistant → MCP Protocol → McpServer (tool registry) → ODataClient → Destination Service → SAP CPI OData APIs
```

1. AI sends tool call (e.g. `IntegrationPackages_list`)
2. Tool handler in `src/tools/registry.ts` constructs an OData request
3. `ODataClient` (`src/client/odata-client.ts`) resolves the destination and executes the HTTP request via SAP Cloud SDK
4. `resolveDestination()` (`src/client/destination-service.ts`) returns credentials:
   - **BTP mode**: Uses `@sap-cloud-sdk/connectivity` when a `destination` service is bound in VCAP_SERVICES
   - **Local mode** (no destination binding, e.g. self-hosted with XSUAA-only or OIDC SSO): Uses env vars (`SAP_CPI_BASE_URL`, `SAP_CPI_CLIENT_ID`, `SAP_CPI_CLIENT_SECRET`, `SAP_CPI_TOKEN_URL`) for direct OAuth2

### Tool Registration Pattern

All tools follow a **generic thin-proxy pattern** — tools expose `path`, `body`, and `headers` parameters. The AI constructs the OData path and query string. Tools are registered in `src/tools/registry.ts` for each of the 32 entity sets defined in `src/config/api-config.json`.

API categories (can be filtered via `ENABLED_API_CATEGORIES` env var):
- `integration-content`
- `message-processing-logs`
- `message-stores`
- `log-files`
- `security-content`
- `partner-directory`

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Package root: exports `start(options?)` (with `registerExtras` session hook) and re-exports the building blocks; self-executes only when run directly |
| `src/cli.ts` | CLI entry point (`--config` flag, then calls `start()`) |
| `src/server/mcp-server.ts` | MCP server factory |
| `src/server/http.ts` | Express HTTP server and session management |
| `src/auth/` | Inbound auth providers behind the `AuthProvider` interface: XSUAA (`xsuaa-auth.ts`) and generic OIDC (`oidc-auth.ts`); `createAuthProvider()` picks one from config |
| `src/client/odata-client.ts` | OData HTTP client (GET/POST/PATCH/DELETE, binary downloads) |
| `src/client/destination-service.ts` | Credential resolution (BTP vs local; per-destination `{PREFIX}_AUTH_TYPE`) |
| `src/client/user-propagation.ts` | Per-user backend grants for env-var destinations: signed SAML bearer assertion, JWT bearer, token exchange |
| `src/client/retry.ts` | Exponential backoff retry logic |
| `src/tools/registry.ts` | Tool registration and OData call handlers |
| `src/ui/` | Config-driven MCP-UI views (lazy-loaded; template rendering, data fetching, tool/resource registration) |
| `src/config/api-config.json` | All API definitions (destinations, path prefixes, entity sets) |
| `src/config/index.ts` | Zod-validated config loaded from environment; `ApiDefinition` / `ApiConfig` types |
| `src/types/entities.ts` | TypeScript interfaces for OData entities |
| `src/utils/logger.ts` | Winston logger (dev: pretty, prod: JSON) |

### Configuration

#### Environment variables

Config is Zod-validated at startup; the server exits immediately on invalid config. See `.env.example` for all variables. All variables are optional:

| Variable | Default | Notes |
|----------|---------|-------|
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `PORT` | `4004` | HTTP mode only |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |
| `REQUEST_TIMEOUT` | `60000` | ms |
| `ENABLED_API_CATEGORIES` | all | Comma-separated category filter |
| `API_CONFIG_FILE` | `api-config.json` | Config file name (relative to `src/config/`) or absolute path; also accepts `btp-admin-api-config.json` |
| `AUTH_PROVIDER` | `auto` | Inbound auth for HTTP: `auto` (OIDC if `OIDC_ISSUER` set, else XSUAA), `oidc`, `xsuaa`, `none` |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Required for the OIDC provider; also `OIDC_SCOPES`, `OIDC_AUDIENCE`, `OIDC_TOKEN_AUTH_METHOD` (see `docs/SSO.md`) |

#### Selecting and adding API config files

The active config file is selected via `API_CONFIG_FILE` (default: `api-config.json`). Two config files are included:

| File | Purpose |
|------|---------|
| `src/config/api-config.json` | SAP Cloud Integration OData V2 APIs (default) |
| `src/config/btp-admin-api-config.json` | SAP BTP Core Services REST APIs |

Destination names and path prefixes live under the `apis` array. Each entry supports:

```json
{
  "name": "cpi",
  "destination": "CPI_DESTINATION",
  "pathPrefix": "/api/v1",
  "csrfProtected": true,
  "entitySets": [
    {
      "entitySet": "IntegrationPackages",
      "urlPath": "IntegrationPackages",
      ...
    }
  ]
}
```

- `name`: used for logging
- `destination`: BTP Destination name on BTP, or the env var prefix for local dev (see below)
- `csrfProtected`: set to `false` for REST APIs that do not use SAP OData CSRF tokens (default: `true`)
- `entitySet`: tool name prefix (PascalCase)
- `urlPath`: URL path segment override (defaults to `entitySet` when omitted; useful when REST path casing differs from the tool name)

Add more objects to the array to expose additional backend APIs — each gets its own `ODataClient` instance.

The config may also contain an optional top-level `ui` array of interactive MCP-UI views (read-only tools that fetch declared data sources through the shared clients and return an HTML template with the JSON payload baked into the `"__DATA__"` token). See the README section "Interactive UI Views (mcp-ui)" for the schema. The `src/ui/` module and `@mcp-ui/server` load lazily, only when a config declares UI views.

Programmatic consumers import `start(options?)` from the package root; `options.registerExtras(server, ctx)` runs in the per-session factory with `ctx = { clientsByApi, apiConfig, config }`. Deep `odata-mcp-proxy/dist/...` imports remain supported via the `exports` map.

#### Local development credentials

When no `destination` service is bound in `VCAP_SERVICES`, credentials are read from env vars. The prefix is derived from the `destination` field: uppercase it and replace non-alphanumeric characters with `_`.

Example — destination `"CPI_DESTINATION"` → prefix `CPI_DESTINATION`:

```
CPI_DESTINATION_BASE_URL=https://tenant.it-cpi018.cfapps.eu10.hana.ondemand.com
CPI_DESTINATION_TOKEN_URL=https://subdomain.authentication.eu10.hana.ondemand.com/oauth/token
CPI_DESTINATION_CLIENT_ID=...
CPI_DESTINATION_CLIENT_SECRET=...
```

`{PREFIX}_AUTH_TYPE` defaults to `client-credentials` (technical user). `saml-bearer`, `jwt-bearer` and `token-exchange` call the backend as the SSO-authenticated user (HTTP + OIDC/XSUAA only; fails closed without a user token) — see `docs/SSO.md`.

### BTP Deployment

Uses MTA (Multi-Target Application) descriptor (`mta.yaml`). Requires Cloud Foundry CLI and the MBT Build Tool (`mbt`). Binds three BTP services: Destination, Connectivity, and XSUAA. XSUAA config is in `xs-security.json`.
