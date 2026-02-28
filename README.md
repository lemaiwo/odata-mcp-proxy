# CPI Admin MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes SAP Cloud Integration (CPI) OData V2 administration APIs as MCP tools. This enables AI assistants such as Claude to query, manage, and monitor your SAP Integration Suite tenant through natural language.

The server runs on SAP BTP Cloud Foundry and uses BTP Destinations for secure, token-managed connectivity to the Cloud Integration OData APIs.

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
 CPI Admin MCP Server
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
cd cpi-mcp-server
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
    "cpi-admin": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/cpi-mcp-server",
      "env": {
        "SAP_DESTINATION_NAME": "your_ci_destination_name",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## BTP Deployment

The project includes an `mta.yaml` descriptor for deployment to SAP BTP Cloud Foundry. The MTA provisions the required service instances (Destination, Connectivity, XSUAA) and deploys the server as a Node.js application using HTTP transport.

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
