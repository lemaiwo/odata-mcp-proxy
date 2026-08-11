# OData MCP Proxy

A config-driven [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes OData and REST APIs as MCP tools. This enables AI assistants such as Claude to query, manage, and monitor SAP backends through natural language.

The server runs on SAP BTP Cloud Foundry and uses BTP Destinations for secure, token-managed connectivity to OData APIs.

---

## Features

- **32 OData entity sets** across 6 API categories, automatically registered as MCP tools
- **Full CRUD support** -- list, get, create, update, and delete operations where the API permits
- **OData V2 query capabilities** -- `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`, and `$inlinecount`
- **Navigation property traversal** -- dedicated tools for related entities (e.g., iFlow configurations, message attachments, error details)
- **Category-based filtering** -- enable only the API categories you need via configuration
- **Dual transport modes** -- Streamable HTTP for BTP deployment, stdio for local Claude Desktop use
- **Automatic OAuth token management** -- tokens are refreshed transparently via the BTP Destination Service

---

## Architecture

```
Claude / AI Assistant
        |
        | MCP Protocol (stdio or HTTP)
        v
 OData MCP Proxy
        |
        | OData V2 + JSON
        v
   OData Client
        |
        | OAuth2 (via BTP Destination Service)
        v
  BTP Destination
        |
        v
 SAP Cloud Integration
   OData Admin APIs
```

The server resolves a BTP Destination at startup to obtain the Cloud Integration tenant URL and OAuth2 credentials. On each API call, the destination is re-resolved to ensure tokens remain valid. The OData client translates MCP tool invocations into OData V2 HTTP requests and returns structured JSON results to the AI assistant.

---

## Prerequisites

- **Node.js** 20+ (18+ minimum, 20+ recommended)
- **SAP BTP account** with a Cloud Foundry environment
- **SAP Integration Suite** tenant (Cloud Integration capability)
- **BTP Destination** configured to point to your Cloud Integration tenant's OData API with OAuth2 authentication
- **Cloud Foundry CLI** (`cf`) and **MBT Build Tool** (`mbt`) for BTP deployment

---

## Quick Start (Local Development)

### 1. Clone and install

```bash
git clone <repository-url>
cd odata-mcp-proxy
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
SAP_DESTINATION_NAME=your_ci_destination_name
MCP_TRANSPORT=stdio
```

> **Note:** For local development with stdio transport, you must have BTP Destination Service credentials available in your environment (e.g., via `VCAP_SERVICES` or a `default-env.json` file).

### 3. Build and run

```bash
npm run build
npm run start:stdio
```

Or use the development watcher:

```bash
npm run dev
```

### 4. Connect from Claude Desktop

Add the server to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odata-mcp-proxy": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/odata-mcp-proxy",
      "env": {
        "SAP_DESTINATION_NAME": "your_ci_destination_name",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## Using as an npm Package

You can consume `odata-mcp-proxy` as a dependency in your own project -- similar to how the [SAP Application Router](https://www.npmjs.com/package/@sap/approuter) works. No TypeScript compilation or build step required.

### 1. Create your project

```bash
mkdir my-mcp-server
cd my-mcp-server
npm init -y
npm install odata-mcp-proxy
```

### 2. Add a start script

In your `package.json`:

```json
{
  "scripts": {
    "start": "odata-mcp-proxy"
  },
  "dependencies": {
    "odata-mcp-proxy": "^1.0.0"
  }
}
```

### 3. Add your API config

Create an `api-config.json` in your project root. The CLI automatically picks it up from the working directory. See the [bundled config files](src/config/) for the full format.

```json
{
  "server": {
    "name": "my-mcp-server",
    "version": "1.0.0",
    "description": "My custom MCP server"
  },
  "apis": [
    {
      "name": "my-api",
      "destination": "MY_DESTINATION",
      "pathPrefix": "/api/v1",
      "csrfProtected": true,
      "entitySets": [
        {
          "entitySet": "Products",
          "description": "product entities",
          "category": "master-data",
          "keys": [{ "name": "Id", "type": "string" }],
          "operations": { "list": true, "get": true, "create": false, "update": false, "delete": false }
        }
      ]
    }
  ]
}
```

You can also use a custom filename with the `--config` flag:

```bash
odata-mcp-proxy --config my-custom-config.json
```

Or set it via environment variable:

```bash
API_CONFIG_FILE=my-custom-config.json npm start
```

If no config file is found in the working directory, the bundled defaults (SAP Cloud Integration APIs) are used.

### 4. Configure credentials

For local development, create a `.env` file or `default-env.json` with your destination credentials. The env var prefix is derived from the `destination` field in your config -- uppercase it and replace non-alphanumeric characters with `_`.

For example, destination `"MY_DESTINATION"` maps to:

```dotenv
MY_DESTINATION_BASE_URL=https://my-api.example.com
MY_DESTINATION_TOKEN_URL=https://auth.example.com/oauth/token
MY_DESTINATION_CLIENT_ID=...
MY_DESTINATION_CLIENT_SECRET=...
```

On BTP, use the Destination Service instead (credentials are resolved automatically via `VCAP_SERVICES`).

### 5. Project structure

A complete consumer project looks like this:

```
my-mcp-server/
├── package.json          # start script + dependency
├── api-config.json       # your API configuration
├── default-env.json      # local BTP credentials (gitignored)
├── .env                  # local env overrides (gitignored)
├── mta.yaml              # BTP deployment descriptor
└── xs-security.json      # XSUAA config (if using OAuth)
```

### Deploying to BTP as a consumer project

Since there is no build step, the `mta.yaml` is straightforward -- just like the SAP Application Router:

```yaml
_schema-version: "3.1"
ID: my-mcp-server
version: 1.0.0

parameters:
  enable-parallel-deployments: true

modules:
  - name: my-mcp-server
    type: nodejs
    path: .
    parameters:
      memory: 512M
      disk-quota: 1G
      buildpack: nodejs_buildpack
      health-check-type: http
      health-check-http-endpoint: /health
      command: npm start
    build-parameters:
      builder: npm
      ignore:
        - .git/
        - .env
        - default-env.json
    requires:
      - name: my-destination
      - name: my-connectivity
      - name: my-xsuaa

resources:
  - name: my-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite

  - name: my-connectivity
    type: org.cloudfoundry.managed-service
    parameters:
      service: connectivity
      service-plan: lite

  - name: my-xsuaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: xs-security.json
```

The key difference from a standalone deployment: `builder: npm` is all you need. MBT runs `npm install --production`, which installs the pre-built `odata-mcp-proxy` package from the registry. No TypeScript, no custom build commands.

Deploy with:

```bash
mbt build && cf deploy mta_archives/my-mcp-server_1.0.0.mtar
```

---

## Interactive UI Views (mcp-ui)

Beyond plain data tools, the config file can declare **interactive UI views**: read-only MCP tools that fetch data through the shared OData clients and return a self-contained HTML page as an [mcp-ui](https://mcpui.dev) embedded resource (with the MCP Apps adapter enabled, so the same widget works on MCP Apps hosts like Claude and on classic mcp-ui hosts).

Add a top-level `ui` array to your API config:

```json
{
  "server": { "name": "my-mcp-server", "version": "1.0.0", "description": "..." },
  "apis": [ ... ],
  "ui": [
    {
      "tool": "UI_SubaccountsOverview",
      "description": "Interactive overview of all subaccounts",
      "uri": "ui://my-server/subaccounts-overview",
      "template": "ui/subaccounts-overview.html",
      "inputs": {
        "subaccountGUID": { "type": "string", "required": true, "description": "GUID of the subaccount" }
      },
      "data": {
        "subaccounts": { "api": "cis-accounts", "path": "subaccounts" },
        "assignments": { "api": "cis-entitlements", "path": "assignments?subaccountGUID={subaccountGUID}", "optional": true }
      },
      "partials": {
        "/*__SHARED_CSS__*/": "ui/_shared.css",
        "/*__SHARED_JS__*/": "ui/_shared.js"
      },
      "frameSize": ["100%", "760px"]
    }
  ]
}
```

Per entry:

| Field | Required | Description |
|-------|----------|-------------|
| `tool` | yes | MCP tool name. Registered read-only (`annotations.readOnlyHint: true`) with `_meta["ui/resourceUri"]` pointing at `uri`. |
| `description` | yes | Tool description for the LLM. |
| `uri` | yes | `ui://` resource URI. The template is also registered as an MCP resource at this URI (with `null` data), so MCP Apps hosts that pre-fetch templates can use render-data delivery. |
| `template` | yes | HTML template file, path relative to the config file. File reads are cached. |
| `inputs` | no | Tool parameters: `{ "name": { "type": "string"\|"number"\|"boolean", "required": bool, "default": val, "min": n, "max": n, "description": "..." } }`. Compiled into the tool's input schema. A `default` is applied during parsing, so placeholders referencing that parameter always resolve; `min`/`max` bound number inputs. |
| `data` | no | Named data sources, fetched **concurrently** on invocation through the shared OData client of the referenced `api` (the caller's JWT is forwarded, exactly like the generated entity tools). Placeholders in `path` are substituted with URL-encoded values (see below). `"optional": true` entries fail soft to `null`; a failure in any other entry returns an `isError` tool result. Each source also accepts `paginate` and `select`. |
| `partials` | no | Literal token → file map. Each file (path relative to the config file) is inlined into the template *before* data injection — useful for shared CSS/JS. |
| `frameSize` | no | Overrides the mcp-ui `preferred-frame-size` (default `["100%", "760px"]`). |

### Path placeholders

`{param}` expands to a validated tool argument. `{$...}` expands to a **fixed, closed vocabulary** of derived values — enough for reporting windows and paging without a templating language (there is no eval and no user-defined function):

| Placeholder | Expands to |
|---|---|
| `{$now:FMT}` | The current UTC time. |
| `{$monthsAgo(N):FMT}` | The **first of the month**, `N` months back — so a `yyyymm` window is stable no matter which day the tool runs. |
| `{$daysAgo(N):FMT}` | `N` days back. |
| `{$offset}` / `{$pageSize}` | Page position. Only valid on a source with a `paginate` block. |

`FMT` is `yyyymm` (`202608`), `date` (`2026-08-11`), or `iso` (default). `N` is an integer, the name of a tool input, or that name with one integer offset (`months-1`) — the offset form exists so an *inclusive* window ("the last 6 months, including this one") is expressible, and it is the only arithmetic supported.

```json
"usage": { "api": "uas", "path": "monthlyUsage?fromDate={$monthsAgo(months-1):yyyymm}&toDate={$now:yyyymm}" }
```

Because dates resolve at call time, a view using them is not a pure function of its arguments — expected for reporting windows, worth knowing when caching.

### Pagination

`paginate` repeats the request until the collection is exhausted, a short page arrives, or `maxItems` is hit:

```json
"users": {
  "api": "xsuaa-scim",
  "path": "Users?startIndex={$offset}&count={$pageSize}",
  "paginate": { "strategy": "offset", "pageSize": 100, "maxItems": 500,
                "itemsPath": "resources", "totalPath": "totalResults" }
}
```

| Field | Description |
|---|---|
| `strategy` | `offset` (1-based, SCIM `startIndex`) or `skiptop` (0-based, OData `$skip`). |
| `pageSize` | Items per request, exposed as `{$pageSize}` (default `100`). |
| `maxItems` | Hard cap on accumulated items (default `1000`). |
| `itemsPath` | Dotted path to the item array. Auto-detected (`value`, `resources`, `results`, `content`, `d.results`) when omitted. |
| `totalPath` | Dotted path to the backend's total count, when it reports one. |

A paginated source returns a normalized `{ items, total, truncated, pages }` object rather than the raw response — so templates read `.items`, and **`truncated` tells them the view is showing a capped subset** instead of silently under-reporting.

### Trimming the payload

The payload is baked into the template *and* returned as `structuredContent`, so raw responses reach the model. `select` keeps only the listed dotted paths of each item, preserving the surrounding envelope:

```json
"subaccounts": { "api": "cis-accounts", "path": "subaccounts",
                 "select": ["guid", "displayName", "region", "state"] }
```

**Templates** are full, self-contained HTML/JS pages. The server replaces the token `"__DATA__"` with the JSON payload:

```html
<script>
  const DATA = "__DATA__"; // becomes { view, params, data: { subaccounts: [...], ... } } — or null in the ui:// template resource
</script>
```

`<` is escaped as `\u003c` in the JSON, so user-controlled strings can never close the script tag. Aggregation and reshaping are the template's job — the server side stays declarative (there is deliberately no templating language or server-side aggregation DSL).

The tool result contains a short text summary (tool name + item counts per data entry), the rendered page as an embedded `ui://` resource, and the payload as `structuredContent` for hosts using render-data delivery.

The UI machinery (and its `@mcp-ui/server` dependency) is loaded lazily — configs without a `ui` section skip it entirely.

---

## Programmatic API

The package root exports a `start()` function, so you can embed the server in your own entry point instead of using the CLI:

```js
// server.mjs
import { start } from 'odata-mcp-proxy';

await start(); // identical to running `odata-mcp-proxy`
```

To register extra tools or resources on every MCP session, pass `registerExtras`. It runs inside the per-session factory, after the generated entity tools, API doc resources, and config-driven UI views:

```js
import { start } from 'odata-mcp-proxy';

await start({
  registerExtras(server, ctx) {
    // server: the session's McpServer
    // ctx.clientsByApi: shared ODataClient instances keyed by API name
    // ctx.apiConfig:    the loaded API config file
    // ctx.config:       the environment-derived app config
    server.registerTool('My_CustomTool', { description: '...', inputSchema: {} }, async (args, extra) => {
      const result = await ctx.clientsByApi['my-api'].execute('GET', 'Products', undefined, undefined, extra.authInfo?.token);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  },
});
```

`ODataClient`, `resolveDestination`, `createMcpServer`, `registerAllTools`, `registerApiDocResources`, and the config types are re-exported from the package root as well.

**Migration note:** if you previously forked the bootstrap (copying the transport/session wiring and deep-importing from `odata-mcp-proxy/dist/...` to add your own tools), you can delete that entry point: call `start({ registerExtras })` for custom tools, and move interactive views into the config's `ui` section. Deep `dist/` imports keep working via the package's `exports` map, but the root export is the supported surface.

---

## BTP Deployment (Standalone)

When working with the source repository directly (not as an npm dependency), the project includes its own `mta.yaml` for deployment to SAP BTP Cloud Foundry. The MTA provisions the required service instances (Destination, Connectivity, XSUAA) and deploys the server as a Node.js application using HTTP transport.

```bash
npm run build:btp    # Build the MTA archive
npm run deploy:btp   # Deploy to Cloud Foundry
```

For detailed deployment instructions, destination configuration, and XSUAA setup, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Configuration

All configuration is managed through environment variables. The server validates configuration at startup using Zod and fails fast on invalid values.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SAP_DESTINATION_NAME` | Yes | -- | BTP Destination name pointing to your Cloud Integration tenant |
| `MCP_TRANSPORT` | No | `http` | Transport mode: `http` (BTP deployment) or `stdio` (Claude Desktop) |
| `PORT` | No | `4004` | HTTP server port (only used when `MCP_TRANSPORT=http`) |
| `LOG_LEVEL` | No | `info` | Logging level: `error`, `warn`, `info`, `debug` |
| `REQUEST_TIMEOUT` | No | `60000` | HTTP request timeout in milliseconds |
| `ENABLED_API_CATEGORIES` | No | `all` | Comma-separated list of API categories to enable (see below) |

### API Categories

Use `ENABLED_API_CATEGORIES` to restrict which tool groups are registered:

| Category | Description |
|---|---|
| `integration-content` | Integration packages, iFlows, value/message mappings, script collections, custom tags, deploy status |
| `message-processing-logs` | Message processing logs, ID mappings, idempotent repository |
| `message-stores` | Data stores, variables, number ranges, message stores, JMS brokers and queues |
| `log-files` | System log files and log file archives |
| `security-content` | Keystores, certificates, SSH keys, credentials, OAuth2 clients, secure parameters, access policies |
| `partner-directory` | Partners, string/binary parameters, alternative partners, authorized users |

Set to `all` (the default) to enable every category.

---

## Available Tools

Tools are dynamically generated from entity set definitions. Each entity set produces up to five tools (`_list`, `_get`, `_create`, `_update`, `_delete`) plus navigation property tools, depending on what the OData API supports.

### Integration Content

| Tool | Operations |
|---|---|
| `IntegrationPackages` | list, get, create, update, delete |
| `IntegrationDesigntimeArtifacts` | list, get, create, update, delete + Resources, Configurations |
| `IntegrationRuntimeArtifacts` | list, get |
| `ValueMappingDesigntimeArtifacts` | list, get, create, update, delete + ValMapSchema |
| `MessageMappingDesigntimeArtifacts` | list, get, create, update, delete |
| `ScriptCollectionDesigntimeArtifacts` | list, get, create, update, delete |
| `CustomTagConfigurations` | list, get, create, update, delete |
| `BuildAndDeployStatus` | list, get |

### Message Processing Logs

| Tool | Operations |
|---|---|
| `MessageProcessingLogs` | list, get + Attachments, ErrorInformations, AdapterAttributes, CustomHeaderProperties, MessageStoreEntries |
| `IdMapFromId2s` | list |
| `IdempotentRepositoryEntries` | list |

### Message Stores

| Tool | Operations |
|---|---|
| `DataStoreEntries` | list, get, delete |
| `Variables` | list, get |
| `NumberRanges` | list, get |
| `MessageStoreEntries` | list, get |
| `JmsBrokers` | list, get |
| `JmsResources` | list |

### Log Files

| Tool | Operations |
|---|---|
| `LogFiles` | list, get |
| `LogFileArchives` | list, get |

### Security Content

| Tool | Operations |
|---|---|
| `KeystoreEntries` | list, get, delete |
| `CertificateResources` | list, get |
| `SSHKeyResources` | list, get |
| `UserCredentials` | list, get, create, update, delete |
| `OAuth2ClientCredentials` | list, get, create, update, delete |
| `SecureParameters` | list, get, create, update, delete |
| `CertificateUserMappings` | list, get, create, update, delete |
| `AccessPolicies` | list, get, create, update, delete + ArtifactReferences |

### Partner Directory

| Tool | Operations |
|---|---|
| `Partners` | list, get, create, update, delete |
| `StringParameters` | list, get, create, update, delete |
| `BinaryParameters` | list, get, create, update, delete |
| `AlternativePartners` | list, get, create, update, delete |
| `AuthorizedUsers` | list, get, create, update, delete |

### Tool Naming Convention

Tools follow the pattern `{EntitySet}_{operation}`:

```
IntegrationPackages_list
IntegrationPackages_get
IntegrationPackages_create
IntegrationDesigntimeArtifacts_Configurations_list
MessageProcessingLogs_ErrorInformations_list
```

### OData Query Parameters

All `_list` tools accept standard OData V2 query options:

- `$filter` -- e.g., `"Status eq 'FAILED'"`
- `$select` -- e.g., `"Id,Name,Status"`
- `$expand` -- e.g., `"Configurations"`
- `$orderby` -- e.g., `"Name asc"`
- `$top` -- e.g., `10`
- `$skip` -- e.g., `20`

---

## Transport Modes

### HTTP (Streamable HTTP)

Used for BTP Cloud Foundry deployment. The server exposes an `/mcp` endpoint supporting the MCP Streamable HTTP transport with session management, plus a `/health` endpoint for CF health checks.

```bash
MCP_TRANSPORT=http PORT=4004 npm start
```

### stdio

Used for local development and direct integration with Claude Desktop. Communication happens over standard input/output streams.

```bash
MCP_TRANSPORT=stdio npm start
```

---

## Tech Stack

- **Runtime:** Node.js 20+ with ES Modules
- **Language:** TypeScript 5.7+
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.17+
- **SAP Cloud SDK:** `@sap-cloud-sdk/connectivity` and `@sap-cloud-sdk/http-client` 4.x for destination resolution and HTTP calls
- **Validation:** Zod for configuration and input validation
- **HTTP Framework:** Express 4.x (HTTP transport only)
- **Logging:** Winston

---

## License

MIT
