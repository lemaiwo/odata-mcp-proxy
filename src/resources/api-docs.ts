import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntitySetDefinition } from '../tools/registry.js';
import { logger } from '../utils/logger.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the human-friendly label for a category slug.
 *
 * "integration-content"  ->  "Integration Content"
 * "message-processing-logs"  ->  "Message Processing Logs"
 */
function formatCategoryLabel(category: string): string {
  return category
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Return a comma-separated list of the operations that are enabled for an
 * entity set (e.g. "list, get, create").
 */
function formatOperations(ops: EntitySetDefinition['operations']): string {
  const labels: string[] = [];
  if (ops.list) labels.push('list');
  if (ops.get) labels.push('get');
  if (ops.create) labels.push('create');
  if (ops.update) labels.push('update');
  if (ops.delete) labels.push('delete');
  return labels.join(', ');
}

// ─── Markdown Generation ─────────────────────────────────────────────────────

/**
 * Build the full Markdown document that summarises every registered entity set.
 *
 * Entity sets are grouped by their `category` field and listed in the order
 * they appear in the definitions array.
 */
function buildApiOverviewMarkdown(definitions: EntitySetDefinition[], serverName: string): string {
  // Group definitions by category while preserving insertion order.
  const grouped = new Map<string, EntitySetDefinition[]>();
  for (const def of definitions) {
    let group = grouped.get(def.category);
    if (!group) {
      group = [];
      grouped.set(def.category, group);
    }
    group.push(def);
  }

  const lines: string[] = [];

  lines.push(`# ${serverName} — API Overview`);
  lines.push('');
  lines.push(
    `This document lists every OData entity set exposed by ${serverName}, ` +
    'grouped by API category. Each entity set maps to one or more MCP tools ' +
    '(named `{EntitySet}_{operation}`).',
  );
  lines.push('');

  for (const [category, defs] of grouped) {
    lines.push(`## ${formatCategoryLabel(category)}`);
    lines.push('');

    for (const def of defs) {
      lines.push(`### ${def.entitySet}`);
      lines.push('');
      lines.push(`**Description:** ${def.description}`);
      lines.push('');
      lines.push(`**Operations:** ${formatOperations(def.operations)}`);
      lines.push('');

      // Key properties
      const keyList = def.keys.map((k) => `\`${k.name}\` (${k.type})`).join(', ');
      lines.push(`**Key properties:** ${keyList}`);
      lines.push('');

      // Navigation properties (only if present)
      if (def.navigationProperties && def.navigationProperties.length > 0) {
        lines.push('**Navigation properties:**');
        lines.push('');
        for (const nav of def.navigationProperties) {
          const collectionTag = nav.isCollection ? 'collection' : 'single';
          lines.push(`- \`${nav.name}\` (${collectionTag}) — ${nav.description}`);
        }
        lines.push('');
      }

      // Filterable properties (only if present)
      if (def.filterableProperties && def.filterableProperties.length > 0) {
        const filterList = def.filterableProperties.map((p) => `\`${p}\``).join(', ');
        lines.push(`**Filterable properties:** ${filterList}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Resource Registration ───────────────────────────────────────────────────

/**
 * Register MCP resources that expose API documentation to LLM clients.
 *
 * Currently registers a single static resource:
 *
 * - **cpi-api-overview** (`cpi://api/overview`) — a Markdown summary of all
 *   available entity sets, their operations, keys, and navigation properties.
 *
 * @param server      The MCP server instance to register resources on.
 * @param definitions The full list of entity set definitions to document.
 */
export function registerApiDocResources(
  server: McpServer,
  definitions: EntitySetDefinition[],
  serverName: string,
): void {
  const markdown = buildApiOverviewMarkdown(definitions, serverName);

  server.resource(
    `${serverName}-api-overview`,
    `${serverName}://api/overview`,
    {
      description:
        `Markdown overview of all ${serverName} OData entity sets — their descriptions, ` +
        'supported operations, key properties, navigation properties, and filterable fields.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: markdown,
        },
      ],
    }),
  );

  logger.info('API documentation resources registered', {
    resourceCount: 1,
    entitySetCount: definitions.length,
  });
}
