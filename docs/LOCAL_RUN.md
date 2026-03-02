# Running the OData MCP Proxy Locally

This guide covers how to set up and run the OData MCP Proxy on your local
machine for development and testing.

## Prerequisites

- **Node.js** 20 or later (the project declares `>=18.0.0` but 20+ is
  recommended for full ESM and `fetch` support)
- **npm** (ships with Node.js)
- A **SAP Cloud Integration** tenant with an OAuth2 service key (client
  credentials grant)

## 1. Clone and Install

```bash
git clone <repository-url>
cd odata-mcp-proxy
npm install
```

## 2. Build

The project is written in TypeScript. Compile it before running:

```bash
npm run build
```

This outputs JavaScript to the `dist/` directory. The entry point is
`dist/index.js`.

## 3. Environment Setup

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description |
|---|---|
| `SAP_DESTINATION_NAME` | A logical name for the destination (e.g. `CPIDestination`). Always required by the config schema. |

### Local Authentication Variables

When running locally there is no BTP Destination Service available
(`VCAP_SERVICES` is not set). The server automatically falls back to a direct
OAuth2 client-credentials flow using these four environment variables:

| Variable | Description | Example |
|---|---|---|
| `SAP_CPI_BASE_URL` | Base URL of your Cloud Integration tenant | `https://your-tenant.it-cpi018.cfapps.eu10.hana.ondemand.com` |
| `SAP_CPI_TOKEN_URL` | OAuth2 token endpoint URL | `https://your-tenant.authentication.eu10.hana.ondemand.com/oauth/token` |
| `SAP_CPI_CLIENT_ID` | OAuth2 client ID from your service key | |
| `SAP_CPI_CLIENT_SECRET` | OAuth2 client secret from your service key | |

You obtain these values by creating a **service key** for the
*Process Integration Runtime* service instance in the BTP cockpit (plan
`api` with the role `AuthGroup_Administrator` or equivalent).

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `http` | Transport mode: `http` or `stdio` |
| `PORT` | `4004` | HTTP port (only relevant when `MCP_TRANSPORT=http`) |
| `LOG_LEVEL` | `info` | Logging verbosity: `error`, `warn`, `info`, `debug` |
| `REQUEST_TIMEOUT` | `60000` | HTTP request timeout in milliseconds |
| `ENABLED_API_CATEGORIES` | `all` | Comma-separated list of API categories (see below) |

### Example `.env` for Local Development

```dotenv
SAP_DESTINATION_NAME=CPIDestination
MCP_TRANSPORT=stdio

SAP_CPI_BASE_URL=https://your-tenant.it-cpi018.cfapps.eu10.hana.ondemand.com
SAP_CPI_TOKEN_URL=https://your-tenant.authentication.eu10.hana.ondemand.com/oauth/token
SAP_CPI_CLIENT_ID=sb-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx!b12345|it!b12345
SAP_CPI_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

LOG_LEVEL=debug
```

## 4. Running the Server

The server supports two transport modes.

### a) stdio Mode (for Claude Desktop)

Set `MCP_TRANSPORT=stdio` in your `.env` file (or pass it as an environment
variable). In stdio mode the server communicates over standard input/output
using the MCP JSON-RPC protocol -- this is how Claude Desktop launches MCP
servers.

```bash
# Using the npm script:
npm run start:stdio

# Or manually:
MCP_TRANSPORT=stdio node dist/index.js
```

You do not interact with the server directly in stdio mode. Instead, configure
Claude Desktop to launch it (see the `claude-desktop-config.example.json` file
in the repository root for a ready-made configuration snippet).

During development you can also use `tsx` for live-reloading:

```bash
MCP_TRANSPORT=stdio npx tsx src/index.ts
```

### b) HTTP Mode (for Testing and Debugging)

Set `MCP_TRANSPORT=http` (the default). The server starts an Express HTTP
server with:

- `GET /health` -- health check endpoint
- `POST /mcp` -- MCP JSON-RPC requests
- `GET /mcp` -- SSE stream for server-to-client notifications
- `DELETE /mcp` -- session termination

```bash
# Using the npm script:
npm run start:http

# Or manually:
node dist/index.js
```

Verify the server is running:

```bash
curl http://localhost:4004/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "version": "1.0.0"
}
```

For live-reloading during development:

```bash
npm run dev
```

This uses `tsx watch` to restart the server on source file changes.

## 5. Filtering API Categories

The `ENABLED_API_CATEGORIES` variable controls which groups of MCP tools are
registered. Set it to `all` (the default) to enable everything, or provide a
comma-separated list of specific categories:

| Category | Description |
|---|---|
| `integration-content` | Integration flows, value mappings, packages, configurations |
| `message-processing-logs` | Message processing logs and run steps |
| `message-stores` | Message stores, entries, and data stores |
| `log-files` | System and HTTP log files |
| `security-content` | Keystores, certificates, user credentials, OAuth credentials |
| `partner-directory` | Partner directory entries and parameters |

Example -- enable only monitoring and integration content:

```dotenv
ENABLED_API_CATEGORIES=integration-content,message-processing-logs,log-files
```

## 6. Troubleshooting

### "Configuration validation failed: sapDestinationName"

`SAP_DESTINATION_NAME` is missing or empty. Set it in your `.env` file. The
value is a logical name used to identify the destination; when running locally
the actual connection details come from the `SAP_CPI_*` variables.

### "Local fallback: SAP_CPI_BASE_URL environment variable is not set"

You are running outside BTP (no `VCAP_SERVICES`) and one or more of the four
local OAuth2 variables is missing. Make sure `SAP_CPI_BASE_URL`,
`SAP_CPI_TOKEN_URL`, `SAP_CPI_CLIENT_ID`, and `SAP_CPI_CLIENT_SECRET` are all
set.

### "OAuth2 token request failed with status 401"

Your client credentials are incorrect or expired. Create a new service key in
the BTP cockpit and update the values.

### "OAuth2 token request failed with status 400"

Double-check that `SAP_CPI_TOKEN_URL` points to the correct OAuth2 token
endpoint (it should end with `/oauth/token`).

### Port already in use (EADDRINUSE)

Another process is using port 4004. Either stop it or set a different port:

```dotenv
PORT=4005
```

### "Failed to resolve destination" with VCAP_SERVICES present

If you have a `default-env.json` or `VCAP_SERVICES` environment variable set
from a previous BTP deployment test, the server will try to use the BTP
Destination Service instead of the local fallback. Remove or rename the
`default-env.json` file to force the local OAuth2 flow.

### Timeout errors on OData requests

Increase the request timeout:

```dotenv
REQUEST_TIMEOUT=120000
```

### Debugging

Set `LOG_LEVEL=debug` for verbose output including token cache hits, OData
request/response details, and MCP session lifecycle events.
