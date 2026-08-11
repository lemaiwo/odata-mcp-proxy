// =============================================================================
// Progressive tool discovery.
//
// Replaces per-operation entity tools with two stable meta-tools:
//
//   search_operations(query, detail)  — catalog AND inspect, in one call
//   execute_operation(...)            — routes to the same OData client
//
// Two levels rather than three: the MCP client-best-practices guidance is to
// "offer multiple detail levels" on the catalog tool rather than split
// catalog and inspect, and it saves a round trip when the model already knows
// what it wants.
//
// The tool list never changes at runtime. The 2026-07-28 spec removed
// per-connection variation of tools/list, and a mutating tool array
// invalidates the model's prompt cache — so dynamic registration is not an
// option here even though it would give richer per-tool schemas.
// =============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ODataClient } from '../client/odata-client.js';
import { resolveOperation, type DiscoveryDefinition } from '../config/index.js';
import {
  formatToolResult,
  formatToolError,
  checkScope,
  type EntitySetDefinition,
  type KeyProperty,
} from './registry.js';
import { logger } from '../utils/logger.js';

/** Map-key separator; cannot occur in an api or entity-set name. */
const KEY_SEP = '\u0000';

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_MAX_FULL_RESULTS = 5;

/** The five CRUD operations, in the order they are reported. */
const OPERATIONS = ['list', 'get', 'create', 'update', 'delete'] as const;
type OperationName = (typeof OPERATIONS)[number];

/**
 * Per operation: the HTTP method, whether the entity set must define keys for
 * the operation to exist at all, and whether a key expression is required in
 * `path` when it does.
 *
 * These differ for `update`: a keyless collection-level PATCH is valid (BTP
 * entitlement assignments work this way), so it is always available, but a
 * keyed entity set still expects the key in the path.
 */
const OPERATION_METHOD: Record<
  OperationName,
  { method: string; requiresKeyedEntitySet: boolean; keyedWhenAvailable: boolean }
> = {
  list: { method: 'GET', requiresKeyedEntitySet: false, keyedWhenAvailable: false },
  get: { method: 'GET', requiresKeyedEntitySet: true, keyedWhenAvailable: true },
  create: { method: 'POST', requiresKeyedEntitySet: false, keyedWhenAvailable: false },
  update: { method: 'PATCH', requiresKeyedEntitySet: false, keyedWhenAvailable: true },
  delete: { method: 'DELETE', requiresKeyedEntitySet: true, keyedWhenAvailable: true },
};

/** Whether this operation needs a key expression in `path` for this entity set. */
function needsKeyInPath(operation: OperationName, keyCount: number): boolean {
  return OPERATION_METHOD[operation].keyedWhenAvailable && keyCount > 0;
}

/** One searchable entity set, bound to the client of its API. */
export interface IndexEntry {
  api: string;
  client: ODataClient;
  definition: EntitySetDefinition;
  /** Operations actually available (enabled, and keyed when the op needs keys). */
  available: OperationName[];
  /** Navigation property names, exposed as `navProperty` on execute. */
  navProperties: string[];
  /** Lower-cased haystack fields for scoring. */
  haystack: { name: string; description: string; category: string; api: string };
}

// ─── Index construction ──────────────────────────────────────────────────────

/**
 * Build the searchable index. Category filtering is applied here so a disabled
 * category is invisible to discovery, exactly as it is invisible to
 * per-entity registration.
 */
export function buildIndex(
  apis: Array<{ name: string; client: ODataClient; entitySets: EntitySetDefinition[] }>,
  enabledCategories: string[],
): IndexEntry[] {
  const isAll = enabledCategories.length === 1 && enabledCategories[0] === 'all';
  const index: IndexEntry[] = [];

  for (const api of apis) {
    for (const definition of api.entitySets) {
      if (!isAll && !enabledCategories.includes(definition.category)) continue;

      const available = OPERATIONS.filter((op) => {
        const resolved = resolveOperation(definition.operations[op]);
        if (!resolved.enabled) return false;
        // get/delete address a single entity, so they need a keyed entity set.
        // update does not: a collection-level PATCH with a body is valid.
        return !OPERATION_METHOD[op].requiresKeyedEntitySet || definition.keys.length > 0;
      });
      if (available.length === 0) continue;

      index.push({
        api: api.name,
        client: api.client,
        definition,
        available,
        navProperties: (definition.navigationProperties ?? []).map((n) => n.name),
        haystack: {
          name: definition.entitySet.toLowerCase(),
          description: (definition.description ?? '').toLowerCase(),
          category: (definition.category ?? '').toLowerCase(),
          api: api.name.toLowerCase(),
        },
      });
    }
  }

  // Deterministic order: the spec asks for a stable tools/list, and stable
  // search output keeps results reproducible for the same query.
  index.sort((a, b) => a.api.localeCompare(b.api) || a.definition.entitySet.localeCompare(b.definition.entitySet));
  return index;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Split a query into lower-cased terms. Also splits camelCase so "Subaccounts"
 * matches a query of "sub accounts" and vice versa.
 */
function terms(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Field-weighted keyword score for one entry against one query.
 *
 * Keyword scoring rather than embeddings: the configs already carry
 * descriptive text, and embeddings would pull a model dependency into a
 * package that has none. Name matches dominate, because an exact entity-set
 * name is a much stronger signal than an incidental description word.
 */
export function scoreEntry(entry: IndexEntry, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const { name, description, category, api } = entry.haystack;
  let score = 0;

  for (const term of queryTerms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 40;
    else if (name.includes(term)) score += 25;

    if (category === term) score += 20;
    else if (category.includes(term)) score += 8;

    if (description.includes(term)) score += 10;
    if (api.includes(term)) score += 5;
  }

  // Prefer entries matching more distinct terms over one term matching hard.
  const matched = queryTerms.filter(
    (t) => name.includes(t) || description.includes(t) || category.includes(t) || api.includes(t),
  ).length;
  return score * (1 + matched / queryTerms.length);
}

/**
 * Rank the index against a query. An empty query, or one that matches
 * nothing, returns the whole index — a dead end is far worse for the model
 * than a long list it can narrow.
 */
export function search(
  index: IndexEntry[],
  query: string | undefined,
  filters: { api?: string; category?: string },
): { entries: IndexEntry[]; matched: boolean } {
  let pool = index;
  if (filters.api) pool = pool.filter((e) => e.api === filters.api);
  if (filters.category) pool = pool.filter((e) => e.definition.category === filters.category);

  const queryTerms = query ? terms(query) : [];
  if (queryTerms.length === 0) return { entries: pool, matched: false };

  const scored = pool
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTerms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { entries: pool, matched: false };
  return { entries: scored.map((s) => s.entry), matched: true };
}

// ─── Result shaping ──────────────────────────────────────────────────────────

function formatKeys(keys: KeyProperty[]): string {
  return keys.map((k) => `${k.name} (${k.type})`).join(', ');
}

/** Compact form: enough for the model to pick, not enough to bloat context. */
function briefEntry(entry: IndexEntry) {
  return {
    api: entry.api,
    entitySet: entry.definition.entitySet,
    category: entry.definition.category,
    operations: entry.available,
    description: entry.definition.description,
  };
}

/** Everything needed to build a correct execute_operation call. */
function fullEntry(entry: IndexEntry) {
  const { definition } = entry;
  return {
    ...briefEntry(entry),
    keys: definition.keys,
    keyHint: definition.keys.length > 0 ? formatKeys(definition.keys) : null,
    navProperties: entry.navProperties.length > 0 ? entry.navProperties : undefined,
    filterableProperties: definition.filterableProperties,
    selectableProperties: definition.selectableProperties,
    operationDetails: entry.available.map((op) => ({
      operation: op,
      method: OPERATION_METHOD[op].method,
      requiresKeysInPath: needsKeyInPath(op, definition.keys.length),
      requiresBody: op === 'create' || op === 'update',
    })),
    pathExamples: buildPathExamples(definition),
  };
}

/** Concrete `path` values, since that argument is free-form OData. */
function buildPathExamples(definition: EntitySetDefinition): Record<string, string> {
  const examples: Record<string, string> = {
    list: "?$top=10&$select=" + (definition.selectableProperties?.slice(0, 2).join(',') || 'Id,Name'),
  };
  if (definition.keys.length === 1) {
    const k = definition.keys[0];
    examples.byKey = k.type === 'string' ? `('<${k.name}>')` : `(<${k.name}>)`;
  } else if (definition.keys.length > 1) {
    examples.byKey =
      '(' + definition.keys.map((k) => `${k.name}=${k.type === 'string' ? `'<${k.name}>'` : `<${k.name}>`}`).join(',') + ')';
  }
  if (definition.filterableProperties?.length) {
    examples.filtered = `?$filter=${definition.filterableProperties[0]} eq '<value>'`;
  }
  return examples;
}

// ─── Registration ────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  discovery: DiscoveryDefinition;
  index: IndexEntry[];
  /** Entity sets kept as individual tools in hybrid mode, for the tool description. */
  pinned: string[];
}

/**
 * Register the two discovery tools plus one `odata://` schema resource per
 * entity set.
 */
export function registerDiscoveryTools(server: McpServer, options: DiscoveryOptions): void {
  const { discovery, index, pinned } = options;
  const maxResults = discovery.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFullResults = discovery.maxFullResults ?? DEFAULT_MAX_FULL_RESULTS;

  const apiNames = [...new Set(index.map((e) => e.api))];
  const categories = [...new Set(index.map((e) => e.definition.category))].filter(Boolean);

  const pinnedNote = pinned.length > 0
    ? ` Note: ${pinned.join(', ')} are also registered as dedicated tools — prefer those when they fit.`
    : '';

  // ── Tool 1: catalog + inspect ──────────────────────────────────────────────
  server.registerTool(
    'search_operations',
    {
      description:
        `Find which OData entity set and operation to use, across ${index.length} entity sets in ` +
        `${apiNames.length} API(s). START HERE for any data request, then call execute_operation. ` +
        `Use detail="brief" (default) to scan candidates, then detail="full" on a narrowed query to get ` +
        `keys, filterable properties and path examples needed to build the call. ` +
        `An empty or unmatched query returns everything, so you can always browse.${pinnedNote}`,
      inputSchema: {
        query: z.string().optional().describe(
          'Natural-language or keyword search over entity set names, descriptions and categories. ' +
          'Examples: "subaccounts", "service entitlements", "role collections". Omit to list everything.',
        ),
        api: z.enum(apiNames as [string, ...string[]]).optional().describe('Restrict to one API.'),
        category: categories.length > 0
          ? z.enum(categories as [string, ...string[]]).optional().describe('Restrict to one category.')
          : z.string().optional().describe('Restrict to one category.'),
        detail: z.enum(['brief', 'full']).optional().describe(
          'brief = name, category, operations and description (default). ' +
          'full = adds keys, navigation/filterable/selectable properties and path examples.',
        ),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum matches to return.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const detail = args.detail ?? 'brief';
      const cap = Math.min(
        args.limit ?? (detail === 'full' ? maxFullResults : maxResults),
        detail === 'full' ? maxFullResults : maxResults,
      );

      const { entries, matched } = search(index, args.query, { api: args.api, category: args.category });
      const shown = entries.slice(0, cap);

      return formatToolResult({
        query: args.query ?? null,
        matched,
        // Say so rather than letting the model read a fallback list as a hit.
        note: matched
          ? undefined
          : args.query
            ? `No match for "${args.query}". Showing all available entity sets instead — narrow with a different term, api or category.`
            : 'No query given. Showing all available entity sets.',
        totalMatches: entries.length,
        returned: shown.length,
        truncated: entries.length > shown.length,
        detail,
        results: shown.map((e) => (detail === 'full' ? fullEntry(e) : briefEntry(e))),
        nextStep: detail === 'brief'
          ? 'Call search_operations again with detail="full" for the chosen entity set, or execute_operation if you already know the path.'
          : 'Call execute_operation with api, entitySet, operation and a path built from pathExamples.',
      });
    },
  );

  // ── Tool 2: execute ────────────────────────────────────────────────────────
  const byKey = new Map<string, IndexEntry>();
  for (const entry of index) byKey.set(`${entry.api}${KEY_SEP}${entry.definition.entitySet}`, entry);

  server.registerTool(
    'execute_operation',
    {
      description:
        'Execute an OData operation found via search_operations. ' +
        'Provide api, entitySet and operation; build `path` from the entity set\'s pathExamples ' +
        '(keys, $filter, $select, $top…) and `body` for create/update.',
      inputSchema: {
        api: z.enum(apiNames as [string, ...string[]]).describe('API name from search_operations.'),
        entitySet: z.string().describe('Entity set name exactly as returned by search_operations.'),
        operation: z.enum(OPERATIONS).describe('Operation to perform.'),
        path: z.string().optional().describe(
          'OData path suffix appended to the entity set: key expression and/or query options. ' +
          'Examples: "?$filter=Name eq \'test\'&$top=10", "(\'MyId\')?$select=Id,Name".',
        ),
        navProperty: z.string().optional().describe(
          'Navigation property to append after the key expression, e.g. "Configurations". ' +
          'Only valid for entity sets that list it under navProperties.',
        ),
        body: z.record(z.unknown()).optional().describe('Request body for create/update (entity properties as JSON).'),
        headers: z.record(z.string()).optional().describe('Additional HTTP headers.'),
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      const entry = byKey.get(`${args.api}${KEY_SEP}${args.entitySet}`);

      // Validate routing before touching the backend, and make every failure
      // say what the valid options are — a generic executor has no per-tool
      // schema to reject bad input for it.
      if (!entry) {
        const candidates = index
          .filter((e) => e.definition.entitySet.toLowerCase() === args.entitySet.toLowerCase())
          .map((e) => `${e.api}/${e.definition.entitySet}`);
        return formatToolError(
          `Unknown entity set "${args.entitySet}" in api "${args.api}".` +
          (candidates.length > 0
            ? ` Did you mean: ${candidates.join(', ')}?`
            : ' Call search_operations to find the correct api and entitySet.'),
        );
      }

      const operation = args.operation as OperationName;
      if (!entry.available.includes(operation)) {
        const resolved = resolveOperation(entry.definition.operations[operation]);
        const reason = resolved.enabled && OPERATION_METHOD[operation].requiresKeyedEntitySet && entry.definition.keys.length === 0
          ? `it defines no keys, which "${operation}" requires`
          : `the API does not permit it`;
        return formatToolError(
          `Operation "${operation}" is not available on ${entry.api}/${entry.definition.entitySet} because ${reason}. ` +
          `Available: ${entry.available.join(', ')}.`,
        );
      }

      if (args.navProperty && !entry.navProperties.includes(args.navProperty)) {
        return formatToolError(
          `Unknown navigation property "${args.navProperty}" on ${entry.definition.entitySet}. ` +
          (entry.navProperties.length > 0
            ? `Available: ${entry.navProperties.join(', ')}.`
            : 'This entity set has no navigation properties.'),
        );
      }

      const spec = OPERATION_METHOD[operation];
      if (needsKeyInPath(operation, entry.definition.keys.length) && !args.path) {
        return formatToolError(
          `Operation "${operation}" on ${entry.definition.entitySet} needs a key expression in "path". ` +
          `Keys: ${formatKeys(entry.definition.keys)}. ` +
          `Example path: ${buildPathExamples(entry.definition).byKey ?? "('<key>')"}.`,
        );
      }
      if ((operation === 'create' || operation === 'update') && !args.body) {
        return formatToolError(
          `Operation "${operation}" on ${entry.definition.entitySet} needs a "body" with the entity properties.`,
        );
      }

      // Same scope enforcement as the generated per-entity tools.
      const resolved = resolveOperation(entry.definition.operations[operation]);
      try {
        checkScope(resolved.requiredScope, extra.authInfo?.token);
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error));
      }

      const urlPath = entry.definition.urlPath ?? entry.definition.entitySet;
      const fullPath = args.navProperty
        ? `${urlPath}${args.path ?? ''}/${args.navProperty}`
        : `${urlPath}${args.path ?? ''}`;

      try {
        const result = await entry.client.execute(
          spec.method,
          fullPath,
          args.body,
          args.headers,
          extra.authInfo?.token,
        );
        return formatToolResult(result ?? { success: true });
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // ── Schema resources ───────────────────────────────────────────────────────
  //
  // Hosts that pre-fetch and cache resources can read an entity set's schema
  // without spending a tool round-trip or any context until it is read.
  for (const entry of index) {
    server.registerResource(
      `${entry.api}_${entry.definition.entitySet}`,
      `odata://${entry.api}/${entry.definition.entitySet}`,
      {
        description: `Schema and available operations for ${entry.definition.entitySet} (${entry.definition.description})`,
        mimeType: 'application/json',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(fullEntry(entry), null, 2) }],
      }),
    );
  }

  logger.info(
    `Discovery registration complete: 2 meta-tools + ${index.length} schema resource(s) for ${index.length} entity set(s)`,
    { mode: discovery.mode, apis: apiNames, pinned },
  );
}
