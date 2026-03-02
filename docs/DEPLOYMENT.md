# Deploying OData MCP Proxy to SAP BTP Cloud Foundry

Step-by-step guide for building and deploying the OData MCP Proxy as a Cloud Foundry application on SAP BTP.

## 1. Prerequisites

Before you begin, make sure the following are in place:

- **SAP BTP Global Account** with at least one subaccount that has Cloud Foundry enabled.
- **Cloud Foundry CLI** (`cf`) installed and available on your PATH.
  Install via <https://github.com/cloudfoundry/cli#downloads>.
- **MBT (MTA Build Tool)** installed globally:
  ```bash
  npm install -g mbt
  ```
- **Node.js >= 18** installed (see `engines` in `package.json`).
- **SAP Integration Suite** subscription in your subaccount with the **Cloud Integration** capability activated.
- **Process Integration Runtime** service instance (plan: **api**) with the required authorization roles (see next section).

## 2. Required Authorization Roles

When you create the Process Integration Runtime service instance (plan `api`), include the following roles in the service key so that the MCP server can access the Cloud Integration OData APIs:

| Role                        | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `WorkspacePackagesRead`     | Read integration packages and artifacts     |
| `WorkspacePackagesEdit`     | Create and modify integration content       |
| `MonitoringDataRead`        | Read message processing logs and monitoring |
| `WorkspaceArtifactsDeploy`  | Deploy integration artifacts at runtime     |
| `AuthGroup_Administrator`   | Manage security content (credentials, etc.) |

Example service-key parameters:

```json
{
  "roles": [
    "WorkspacePackagesRead",
    "WorkspacePackagesEdit",
    "MonitoringDataRead",
    "WorkspaceArtifactsDeploy",
    "AuthGroup_Administrator"
  ]
}
```

## 3. Create the BTP Destination

In the SAP BTP cockpit, navigate to **Connectivity > Destinations** in the subaccount where you will deploy, and create a new destination:

| Property               | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Name**               | The value you will set for `SAP_DESTINATION_NAME` (e.g. `CPI_Tenant`)                  |
| **Type**               | `HTTP`                                                                                  |
| **URL**                | `https://<tenant>.it-cpiXXX.cfapps.<region>.hana.ondemand.com/api/v1`                   |
| **Proxy Type**         | `Internet`                                                                              |
| **Authentication**     | `OAuth2ClientCredentials`                                                               |
| **Token Service URL**  | Copy from the `tokenurl` field in your Process Integration Runtime service key           |
| **Client ID**          | Copy from the `clientid` field in your Process Integration Runtime service key           |
| **Client Secret**      | Copy from the `clientsecret` field in your Process Integration Runtime service key       |

> **Tip:** You can find all of the OAuth fields in the service key you created in the previous step. The Token Service URL typically looks like `https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token`.

## 4. Configure Environment Variables

The application requires the `SAP_DESTINATION_NAME` environment variable to be set. You can configure this in one of two ways:

**Option A -- Set via `cf set-env` after deployment:**

```bash
cf set-env odata-mcp-proxy SAP_DESTINATION_NAME "CPI_Tenant"
cf restage odata-mcp-proxy
```

**Option B -- Add to `mta.yaml` properties (before building):**

In `mta.yaml`, add a `properties` block under the module:

```yaml
modules:
  - name: odata-mcp-proxy
    # ... existing config ...
    properties:
      SAP_DESTINATION_NAME: CPI_Tenant
```

Other optional environment variables (all have sensible defaults):

| Variable                  | Default   | Description                                            |
| ------------------------- | --------- | ------------------------------------------------------ |
| `SAP_DESTINATION_NAME`    | (required)| BTP destination name pointing to your CPI tenant       |
| `MCP_TRANSPORT`           | `http`    | Transport mode (`http` or `stdio`)                     |
| `PORT`                    | `4004`    | HTTP server port (Cloud Foundry assigns this automatically) |
| `LOG_LEVEL`               | `info`    | Logging level (`error`, `warn`, `info`, `debug`)       |
| `REQUEST_TIMEOUT`         | `60000`   | HTTP request timeout in milliseconds                   |
| `ENABLED_API_CATEGORIES`  | `all`     | Comma-separated list of API categories to enable       |

> **Note:** On Cloud Foundry the `PORT` variable is set automatically by the platform. Do not override it.

## 5. Build and Deploy

Log in to Cloud Foundry and deploy:

```bash
# 1. Log in (use --sso for single sign-on, or provide user/password)
cf login -a <api-endpoint> --sso

# 2. Target the correct org and space
cf target -o <org> -s <space>

# 3. Build the MTAR archive
npm run build:btp

# 4. Deploy to Cloud Foundry
npm run deploy:btp
```

Under the hood these scripts run:

- `build:btp` --> `mbt build` (produces an `.mtar` file in `mta_archives/`)
- `deploy:btp` --> `cf deploy mta_archives/*.mtar`

The MTA deployment will automatically create or update the following service instances (defined in `mta.yaml`):

| Resource Name            | Service        | Plan          |
| ------------------------ | -------------- | ------------- |
| `odata-mcp-proxy-destination`   | destination    | lite          |
| `odata-mcp-proxy-connectivity`  | connectivity   | lite          |
| `odata-mcp-proxy-xsuaa`         | xsuaa          | application   |

## 6. Post-Deployment

### Assign roles to users

The XSUAA configuration (`xs-security.json`) defines three role templates:

| Role Template  | Scopes              | Use Case                  |
| -------------- | -------------------- | ------------------------- |
| **MCPViewer**  | `read`               | Read-only access          |
| **MCPEditor**  | `read`, `write`      | Read and modify content   |
| **MCPAdmin**   | `read`, `write`, `admin` | Full administrative access |

To assign roles:

1. In the **SAP BTP cockpit**, go to **Security > Role Collections**.
2. Create a role collection (or use an existing one).
3. Add the appropriate role template(s) from the `odata-mcp-proxy` application.
4. Assign the role collection to the relevant users or user groups.

### Verify the deployment

```bash
# Check application status
cf app odata-mcp-proxy

# View recent logs
cf logs odata-mcp-proxy --recent
```

The output of `cf app` will show the application route (URL), status, and instances. Confirm the health check passes and the state shows `running`.

You can also verify the health endpoint directly:

```bash
curl https://<app-route>/health
```

### View live logs (optional)

```bash
cf logs odata-mcp-proxy
```

## 7. Connecting MCP Clients

Once deployed, the server exposes the Model Context Protocol over HTTP at:

```
https://<app-route>/mcp
```

Where `<app-route>` is the URL shown in the `cf app odata-mcp-proxy` output (under `routes`).

Configure your MCP client to connect to this URL. If XSUAA authentication is enforced, the client must obtain a valid OAuth2 token (using the XSUAA service credentials) and pass it as a `Bearer` token in the `Authorization` header.

## Troubleshooting

| Symptom                            | Likely Cause                                                        | Fix                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| App crashes on startup              | `SAP_DESTINATION_NAME` not set                                     | Set the env variable and restage (`cf restage odata-mcp-proxy`)                    |
| `401 Unauthorized` from CPI APIs   | Missing roles on the Process Integration Runtime service key       | Recreate the service key with the required roles (see Section 2)                        |
| Destination not found               | Destination name mismatch or missing destination service binding   | Verify the destination name matches `SAP_DESTINATION_NAME` and the app is bound to `odata-mcp-proxy-destination` |
| Health check fails                  | App not listening on the assigned `PORT`                           | Ensure you are not overriding `PORT`; the platform assigns it automatically             |
| `mbt build` fails                   | MBT not installed                                                  | Run `npm install -g mbt`                                                                |
| `cf deploy` fails                   | Not logged in or wrong target                                      | Run `cf login` and `cf target -o <org> -s <space>`                                      |
