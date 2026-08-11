// =============================================================================
// Config-driven MCP-UI registration.
//
// For each `ui` entry in the API config this registers:
//   1. A read-only MCP tool that fetches the entry's data sources through the
//      shared ODataClient instances, bakes the payload into the HTML template,
//      and returns it as an mcp-ui embedded resource (MCP Apps adapter on).
//   2. The template as an MCP resource at its ui:// URI (data token replaced
//      with null) so MCP Apps hosts that pre-fetch templates can use
//      render-data delivery.
//
// This module is imported lazily — only when the config has a `ui` section —
// so @mcp-ui/server stays out of the startup path for API-only configs.
// =============================================================================

import { z, type ZodTypeAny } from 'zod';
import { createUIResource, RESOURCE_URI_META_KEY } from '@mcp-ui/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ODataClient } from '../client/odata-client.js';
import type { UiViewDefinition } from '../config/index.js';
import { fetchUiData } from './data.js';
import { assembleTemplate, injectData } from './templates.js';
import { logger } from '../utils/logger.js';

const DEFAULT_FRAME_SIZE: [string, string] = ['100%', '760px'];

export interface UiRegistrationOptions {
  /** UI view definitions (the config's `ui` array). */
  views: UiViewDefinition[];
  /** Shared ODataClient instances keyed by API name. */
  clientsByApi: Record<string, ODataClient>;
  /** Directory template/partial paths resolve against (the config file's directory). */
  baseDir: string;
}

// ─── Schema & payload helpers ────────────────────────────────────────────────

const inputTypes = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
} as const;

/** Compile a view's `inputs` map into a Zod raw shape. */
export function buildInputSchema(view: UiViewDefinition): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, input] of Object.entries(view.inputs ?? {})) {
    const factory = inputTypes[input.type];
    if (!factory) {
      throw new Error(
        `UI view "${view.tool}": input "${name}" has unsupported type "${input.type}" (expected string, number, or boolean)`,
      );
    }
    let schema: ZodTypeAny = factory();

    if (input.min !== undefined || input.max !== undefined) {
      if (input.type !== 'number') {
        throw new Error(`UI view "${view.tool}": input "${name}" uses min/max, which only applies to number inputs`);
      }
      let numeric = schema as z.ZodNumber;
      if (input.min !== undefined) numeric = numeric.min(input.min);
      if (input.max !== undefined) numeric = numeric.max(input.max);
      schema = numeric;
    }

    if (input.description) schema = schema.describe(input.description);
    if (input.default !== undefined) {
      if (typeof input.default !== input.type) {
        throw new Error(
          `UI view "${view.tool}": input "${name}" has a ${typeof input.default} default but is declared as ${input.type}`,
        );
      }
      // Applied during parsing, so placeholder substitution always sees a value.
      schema = schema.default(input.default);
    } else if (!input.required) {
      schema = schema.optional();
    }
    shape[name] = schema;
  }
  return shape;
}

/** Count items in common collection shapes (plain array, OData V2/V4, REST wrappers). */
function itemCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Paginated sources carry the normalized { items, total, truncated } shape.
    if (Array.isArray(obj.items)) return obj.items.length;
    for (const key of ['value', 'results', 'content', 'resources']) {
      if (Array.isArray(obj[key])) return (obj[key] as unknown[]).length;
    }
    const d = obj.d as Record<string, unknown> | undefined;
    if (d && typeof d === 'object' && Array.isArray(d.results)) return d.results.length;
  }
  return undefined;
}

/** True when a paginated entry stopped short of the backend's full collection. */
function isTruncated(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).truncated === true;
}

/**
 * Short, generic text summary (tool name + item counts per data entry) so the
 * model doesn't re-describe what the interactive view already shows.
 */
export function summarizeUiResult(tool: string, data: Record<string, unknown>): string {
  const parts = Object.entries(data).map(([name, value]) => {
    if (value === null || value === undefined) return `${name}: unavailable`;
    const count = itemCount(value);
    if (count === undefined) return `${name}: 1 result`;
    // Flag a capped collection so the model doesn't report it as the total.
    return `${name}: ${count} items${isTruncated(value) ? ' (capped, more available)' : ''}`;
  });
  return parts.length > 0
    ? `Rendered ${tool} (${parts.join(', ')}). The interactive view shows the details.`
    : `Rendered ${tool}. The interactive view shows the details.`;
}

function buildUiResource(view: UiViewDefinition, html: string) {
  return createUIResource({
    uri: view.uri as `ui://${string}`,
    content: { type: 'rawHtml', htmlString: html },
    encoding: 'text',
    uiMetadata: { 'preferred-frame-size': view.frameSize ?? DEFAULT_FRAME_SIZE },
    // The adapter script lets the same widget run on MCP Apps hosts
    // (Claude & co.) and classic mcp-ui hosts alike.
    adapters: { mcpApps: { enabled: true } },
  });
}

// ─── Tool handler ────────────────────────────────────────────────────────────

/**
 * Build the tool handler for one UI view. Exported for unit testing.
 */
export function createUiToolHandler(
  view: UiViewDefinition,
  clientsByApi: Record<string, ODataClient>,
  baseDir: string,
): (args: Record<string, unknown> | undefined, extra?: { authInfo?: { token?: string } }) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      const params = args ?? {};
      const data = await fetchUiData(view.data ?? {}, clientsByApi, params, extra?.authInfo?.token);
      const payload = { view: view.tool, params, data };
      const html = injectData(assembleTemplate(baseDir, view.template, view.partials), payload);

      return {
        content: [
          { type: 'text', text: summarizeUiResult(view.tool, data) },
          buildUiResource(view, html),
        ],
        // MCP Apps hosts that render the ui:// template (instead of the
        // embedded resource) receive the payload as render-data toolOutput.
        structuredContent: payload,
      };
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register all UI views of a config as MCP tools and ui:// template resources.
 *
 * @throws {Error} at registration time when a view references an unknown API,
 *         so misconfiguration fails fast at startup instead of at call time.
 */
export function registerUiTools(server: McpServer, options: UiRegistrationOptions): void {
  const { views, clientsByApi, baseDir } = options;

  for (const view of views) {
    for (const [name, source] of Object.entries(view.data ?? {})) {
      if (!clientsByApi[source.api]) {
        throw new Error(
          `UI view "${view.tool}": data entry "${name}" references unknown api "${source.api}". ` +
          `Available APIs: ${Object.keys(clientsByApi).join(', ') || '(none)'}`,
        );
      }
    }

    server.registerTool(
      view.tool,
      {
        description: view.description,
        inputSchema: buildInputSchema(view),
        annotations: { readOnlyHint: true },
        _meta: { [RESOURCE_URI_META_KEY]: view.uri },
      },
      createUiToolHandler(view, clientsByApi, baseDir),
    );

    // Template resource (no baked data): MCP Apps hosts fetch this once and
    // feed it render data per tool call; it also serves as a browsable copy.
    server.registerResource(
      view.tool,
      view.uri,
      { description: `HTML template for the ${view.tool} view`, mimeType: 'text/html' },
      async () => {
        const html = injectData(assembleTemplate(baseDir, view.template, view.partials), null);
        const { resource } = buildUiResource(view, html);
        return { contents: [resource] };
      },
    );

    logger.debug(`Registered UI view ${view.tool}`, {
      uri: view.uri,
      template: view.template,
      dataEntries: Object.keys(view.data ?? {}),
    });
  }

  logger.info(`UI registration complete: ${views.length} view(s) registered`);
}
