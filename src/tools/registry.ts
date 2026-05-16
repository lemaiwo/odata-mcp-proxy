import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ODataClient } from '../client/odata-client.js';
import { type OperationDefinition, resolveOperation } from '../config/index.js';
import { logger } from '../utils/logger.js';

// ─── Tool Definition Types ───────────────────────────────────────────────────

/**
 * Describes a key property for an OData entity.
 */
export interface KeyProperty {
  name: string;
  type: 'string' | 'number';
}

/**
 * Describes a navigation property that can be queried via $expand or separate URL.
 */
export interface NavigationProperty {
  name: string;
  description: string;
  isCollection: boolean;
}

/**
 * Supported CRUD operations for an entity set.
 */
export interface EntityOperations {
  list: OperationDefinition;
  get: OperationDefinition;
  create: OperationDefinition;
  update: OperationDefinition;
  delete: OperationDefinition;
}

/**
 * Defines an OData entity set to be registered as MCP tools.
 */
export interface EntitySetDefinition {
  /** OData entity set name (e.g. "IntegrationPackages") — also used as tool name prefix */
  entitySet: string;
  /** URL path segment override (defaults to entitySet when omitted) */
  urlPath?: string;
  /** Human-readable description for LLM */
  description: string;
  /** API category for filtering */
  category: string;
  /** Key properties for get/update/delete operations */
  keys: KeyProperty[];
  /** Which CRUD operations are supported */
  operations: EntityOperations;
  /** Filterable properties for the list operation */
  filterableProperties?: string[];
  /** Selectable properties */
  selectableProperties?: string[];
  /** Navigation properties */
  navigationProperties?: NavigationProperty[];
}

// ─── Tool Result Formatting ──────────────────────────────────────────────────

/**
 * Format a successful tool result as MCP CallToolResult.
 */
export function formatToolResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Format an error tool result.
 */
export function formatToolError(message: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}`,
      },
    ],
    isError: true,
  };
}

// ─── Generic Thin-Proxy Schema ───────────────────────────────────────────────

/**
 * Every tool uses the same 3-parameter schema. The AI constructs the OData
 * path suffix itself — LLMs understand OData well enough to build key
 * expressions, query options, and navigation paths.
 */
const genericToolSchema = {
  path: z.string().optional().describe(
    'OData path suffix appended to the entity set (keys, query params, nav properties). ' +
    'Examples: "?$filter=Name eq \'test\'&$top=10", "(\'MyId\')?$select=Id,Name", "(Id=\'x\',Version=\'y\')"',
  ),
  body: z.record(z.unknown()).optional().describe(
    'Request body for POST/PATCH/PUT operations (entity properties as JSON)',
  ),
  headers: z.record(z.string()).optional().describe(
    'Additional HTTP headers to include in the request',
  ),
};

// ─── Tool Registration ───────────────────────────────────────────────────────

/**
 * Build the key hint string for tool descriptions.
 * e.g. "Keys: Id (string), Version (string)"
 */
function formatKeyHint(keys: KeyProperty[]): string {
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k.name} (${k.type})`).join(', ');
  return ` Keys: ${parts}.`;
}

/**
 * Verify that the user JWT contains the required scope.
 * Throws an error if the scope is missing or the token is invalid.
 */
function checkScope(requiredScope: string | undefined, jwt: string | undefined): void {
  if (!requiredScope) return; // no restriction defined, allow all

  if (!jwt) {
    throw new Error('Unauthorized: no token provided');
  }

  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8')
    );
    const scopes: string[] = payload.scope ?? [];

    // Accept both "appname.scopename" (XSUAA format) and bare "scopename"
    const hasScope =
      scopes.some((s) => s === requiredScope) ||
      scopes.some((s) => s.endsWith(`.${requiredScope}`));

    if (!hasScope) {
      throw new Error(`Forbidden: operation requires scope '${requiredScope}'`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Forbidden')) {
      throw error;
    }
    throw new Error('Unauthorized: invalid token');
  }
}

/**
 * Generic handler that forwards the tool call to the OData client.
 */
async function handleToolCall(
  client: ODataClient,
  method: string,
  entitySet: string,
  navProperty: string | undefined,
  args: { path?: string; body?: Record<string, unknown>; headers?: Record<string, string> },
  jwt?: string,
): Promise<CallToolResult> {
  try {
    const fullPath = navProperty
      ? `${entitySet}${args.path ?? ''}/${navProperty}`
      : `${entitySet}${args.path ?? ''}`;

    const result = await client.execute(method, fullPath, args.body, args.headers, jwt);
    return formatToolResult(result ?? { success: true });
  } catch (error) {
    return formatToolError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Register all MCP tools for an entity set definition using the generic
 * thin-proxy schema. Each tool is pre-configured with an HTTP method and
 * entity set prefix; the AI provides the OData path suffix at call time.
 */
export function registerEntityTools(
  server: McpServer,
  client: ODataClient,
  definition: EntitySetDefinition,
): void {
  const { entitySet, description, keys, operations, navigationProperties } = definition;
  const urlPath = definition.urlPath ?? entitySet;
  const keyHint = formatKeyHint(keys);

  // Resolve all operations once — normalises boolean | object to { enabled, requiredScope }
  const opList   = resolveOperation(operations.list);
  const opGet    = resolveOperation(operations.get);
  const opCreate = resolveOperation(operations.create);
  const opUpdate = resolveOperation(operations.update);
  const opDelete = resolveOperation(operations.delete);

  if (opList.enabled) {
    server.tool(
      `${entitySet}_list`,
      `List ${description}. Returns a collection of entities with optional OData query options (GET).${keyHint}`,
      genericToolSchema,
      async (args, extra) => {
        try { checkScope(opList.requiredScope, extra.authInfo?.token); }
        catch (e) { return formatToolError(e instanceof Error ? e.message : String(e)); }
        return handleToolCall(client, 'GET', urlPath, undefined, args, extra.authInfo?.token);
      },
    );
  }

  if (opGet.enabled && keys.length > 0) {
    server.tool(
      `${entitySet}_get`,
      `Get a single ${description} by its key(s) (GET).${keyHint}`,
      genericToolSchema,
      async (args, extra) => {
        try { checkScope(opGet.requiredScope, extra.authInfo?.token); }
        catch (e) { return formatToolError(e instanceof Error ? e.message : String(e)); }
        return handleToolCall(client, 'GET', urlPath, undefined, args, extra.authInfo?.token);
      },
    );
  }

  if (opCreate.enabled) {
    server.tool(
      `${entitySet}_create`,
      `Create a new ${description} (POST). Provide entity properties in the body.`,
      genericToolSchema,
      async (args, extra) => {
        try { checkScope(opCreate.requiredScope, extra.authInfo?.token); }
        catch (e) { return formatToolError(e instanceof Error ? e.message : String(e)); }
        return handleToolCall(client, 'POST', urlPath, undefined, args, extra.authInfo?.token);
      },
    );
  }

  if (opUpdate.enabled && keys.length > 0) {
    server.tool(
      `${entitySet}_update`,
      `Update an existing ${description} (PATCH). Provide key(s) in path and properties in body.${keyHint}`,
      genericToolSchema,
      async (args, extra) => {
        try { checkScope(opUpdate.requiredScope, extra.authInfo?.token); }
        catch (e) { return formatToolError(e instanceof Error ? e.message : String(e)); }
        return handleToolCall(client, 'PATCH', urlPath, undefined, args, extra.authInfo?.token);
      },
    );
  }

  if (opDelete.enabled && keys.length > 0) {
    server.tool(
      `${entitySet}_delete`,
      `Delete a ${description} by its key(s) (DELETE).${keyHint}`,
      genericToolSchema,
      async (args, extra) => {
        try { checkScope(opDelete.requiredScope, extra.authInfo?.token); }
        catch (e) { return formatToolError(e instanceof Error ? e.message : String(e)); }
        return handleToolCall(client, 'DELETE', urlPath, undefined, args, extra.authInfo?.token);
      },
    );
  }

  if (navigationProperties) {
    for (const nav of navigationProperties) {
      server.tool(
        `${entitySet}_${nav.name}_list`,
        `Get ${nav.description} for a specific ${description} (GET). ` +
          `Provide the parent entity key(s) in path, then /${nav.name} is appended automatically.${keyHint}`,
        genericToolSchema,
        async (args, extra) => handleToolCall(client, 'GET', urlPath, nav.name, args, extra.authInfo?.token),
      );
    }
  }

  logger.debug(`Registered tools for ${entitySet}`, {
    operations: (Object.entries(operations) as [string, OperationDefinition][])
      .filter(([, v]) => resolveOperation(v).enabled)
      .map(([k]) => k),
    navProps: navigationProperties?.map((n) => n.name) ?? [],
  });
}

// ─── Bulk Registration ───────────────────────────────────────────────────────

/**
 * Register all entity set definitions as MCP tools, filtered by enabled categories.
 */
export function registerAllTools(
  server: McpServer,
  client: ODataClient,
  definitions: EntitySetDefinition[],
  enabledCategories: string[],
): void {
  const isAll = enabledCategories.length === 1 && enabledCategories[0] === 'all';

  let registered = 0;
  let skipped = 0;

  for (const def of definitions) {
    if (!isAll && !enabledCategories.includes(def.category)) {
      logger.info(`Skipping tools for ${def.entitySet} (category "${def.category}" not enabled)`);
      skipped++;
      continue;
    }

    registerEntityTools(server, client, def);
    registered++;
  }

  logger.info(`Tool registration complete: ${registered} entity sets registered, ${skipped} skipped`);
}