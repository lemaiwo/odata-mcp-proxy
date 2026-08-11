// =============================================================================
// Declarative data acquisition for UI views.
//
// Each view lists named data sources ({ api, path, optional, paginate, select }).
// On tool invocation the sources are fetched concurrently through the shared
// ODataClient instances — same destinations and auth as the generated entity
// tools, including the caller's JWT.
//
// Paths support two placeholder families:
//   {param}    — a validated tool argument, URL-encoded
//   {$builtin} — a fixed, closed vocabulary of derived values (dates, paging)
//
// The built-ins exist so common shapes (a reporting window, a paged
// collection) stay expressible in config. They are deliberately not a
// general expression language: no eval, no user-defined functions.
// =============================================================================

import type { ODataClient } from '../client/odata-client.js';
import type { UiDataSourceDefinition, UiPaginationDefinition } from '../config/index.js';

// ─── Built-in placeholder vocabulary ─────────────────────────────────────────

/** Formats a Date into the representation an API expects. */
const DATE_FORMATTERS = {
  /** `202608` — the integer form SAP usage/reporting APIs take. */
  yyyymm: (d: Date) => String(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1),
  /** `2026-08-11` */
  date: (d: Date) => d.toISOString().slice(0, 10),
  /** `2026-08-11T14:44:22.116Z` */
  iso: (d: Date) => d.toISOString(),
} as const;

type DateFormat = keyof typeof DATE_FORMATTERS;

/**
 * Derives a Date from "now". Month offsets snap to the first of the month so
 * a `yyyymm` window is stable regardless of the day the tool is called.
 */
const DATE_GENERATORS = {
  now: (now: Date) => now,
  monthsAgo: (now: Date, n: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)),
  daysAgo: (now: Date, n: number) => new Date(now.getTime() - n * 86_400_000),
} as const;

type DateGenerator = keyof typeof DATE_GENERATORS;

const ARGLESS_GENERATORS: DateGenerator[] = ['now'];

/** `{$name(arg):format}` — arg and format are optional. */
const BUILTIN_PATTERN = /\{\$([A-Za-z_]\w*)(?:\(([^)]*)\))?(?::(\w+))?\}/g;

/** `{param}` — a plain tool argument. */
const PARAM_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Page position injected by the pagination loop. */
export interface PaginationContext {
  /** Value for `{$offset}` — already adjusted for the strategy's base. */
  offset: number;
  /** Value for `{$pageSize}`. */
  pageSize: number;
}

export interface SubstituteOptions {
  /** Reference point for date built-ins. Injectable so tests are deterministic. */
  now?: Date;
  /** Present only while fetching a paginated source. */
  pagination?: PaginationContext;
}

/**
 * Resolve the numeric argument of a date built-in.
 *
 * Accepts an integer literal, the name of a tool argument, or that name with a
 * single integer offset (`months-1`). The offset form exists because inclusive
 * reporting windows ("the last 6 months, including this one") otherwise can't
 * be expressed without arithmetic in the config — it is intentionally the only
 * arithmetic supported.
 *
 * @throws {Error} when the expression is malformed or resolves to a non-number.
 */
export function resolveNumericArg(expr: string, params: Record<string, unknown>): number {
  const match = /^\s*([A-Za-z_]\w*|\d+)\s*(?:([+-])\s*(\d+))?\s*$/.exec(expr);
  if (!match) {
    throw new Error(`invalid built-in argument "${expr}" (expected a number, a parameter name, or name±number)`);
  }
  const [, base, op, delta] = match;

  let value: number;
  if (/^\d+$/.test(base)) {
    value = Number(base);
  } else {
    const raw = params[base];
    if (raw === undefined || raw === null) {
      throw new Error(`no value provided for built-in argument "${base}"`);
    }
    value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`built-in argument "${base}" is not numeric (got "${String(raw)}")`);
    }
  }

  if (op) value = op === '+' ? value + Number(delta) : value - Number(delta);
  return value;
}

/**
 * Expand one `{$...}` built-in token.
 *
 * @throws {Error} for an unknown name/format, or for a paging token used on a
 *         source that has no `paginate` block.
 */
function expandBuiltin(
  name: string,
  arg: string | undefined,
  format: string | undefined,
  params: Record<string, unknown>,
  options: SubstituteOptions,
): string {
  if (name === 'offset' || name === 'pageSize') {
    if (!options.pagination) {
      throw new Error(`{$${name}} is only available on a data source with a "paginate" block`);
    }
    return String(options.pagination[name]);
  }

  if (!(name in DATE_GENERATORS)) {
    const known = [...Object.keys(DATE_GENERATORS), 'offset', 'pageSize'].map((n) => `$${n}`).join(', ');
    throw new Error(`unknown built-in "$${name}" (known: ${known})`);
  }
  const generator = name as DateGenerator;

  const needsArg = !ARGLESS_GENERATORS.includes(generator);
  if (needsArg && arg === undefined) {
    throw new Error(`built-in "$${generator}" requires an argument, e.g. {$${generator}(6):yyyymm}`);
  }

  const fmt = (format ?? 'iso') as DateFormat;
  if (!(fmt in DATE_FORMATTERS)) {
    throw new Error(`unknown date format ":${format}" (known: ${Object.keys(DATE_FORMATTERS).join(', ')})`);
  }

  const now = options.now ?? new Date();
  const date = needsArg
    ? (DATE_GENERATORS[generator] as (n: Date, v: number) => Date)(now, resolveNumericArg(arg!, params))
    : (DATE_GENERATORS[generator] as (n: Date) => Date)(now);

  return DATE_FORMATTERS[fmt](date);
}

/**
 * Substitute `{param}` and `{$builtin}` placeholders in a data source path.
 * All substituted values are URL-encoded.
 *
 * @throws {Error} when a placeholder has no corresponding argument value.
 */
export function substitutePlaceholders(
  path: string,
  params: Record<string, unknown>,
  options: SubstituteOptions = {},
): string {
  // Built-ins first: they are the more specific syntax, and their arguments
  // reference parameter names that must not be substituted textually.
  const withBuiltins = path.replace(
    BUILTIN_PATTERN,
    (_match, name: string, arg: string | undefined, format: string | undefined) =>
      encodeURIComponent(expandBuiltin(name, arg, format, params, options)),
  );

  return withBuiltins.replace(PARAM_PATTERN, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`no value provided for placeholder {${name}}`);
    }
    return encodeURIComponent(String(value));
  });
}

// ─── Response shape helpers ──────────────────────────────────────────────────

/** Keys commonly wrapping a collection across OData V2/V4, SCIM, and REST. */
const ITEM_KEYS = ['value', 'resources', 'results', 'content'] as const;

/** Read a dotted path. An empty path returns the value itself. */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** Write a dotted path into a plain object, creating intermediate objects. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * Find where the item array lives in a response. Returns a dotted path, `''`
 * when the response is itself an array, or `undefined` when nothing matches.
 */
export function detectItemsPath(response: unknown): string | undefined {
  if (Array.isArray(response)) return '';
  if (!response || typeof response !== 'object') return undefined;

  const obj = response as Record<string, unknown>;
  for (const key of ITEM_KEYS) {
    if (Array.isArray(obj[key])) return key;
  }
  // OData V2 wraps collections in `d.results`.
  const d = obj.d as Record<string, unknown> | undefined;
  if (d && typeof d === 'object' && Array.isArray(d.results)) return 'd.results';
  return undefined;
}

/** Keep only the selected dotted paths of one item. */
function pick(item: unknown, paths: string[]): unknown {
  if (!item || typeof item !== 'object') return item;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const value = getPath(item, path);
    if (value !== undefined) setPath(out, path, value);
  }
  return out;
}

/**
 * Apply a `select` projection to whatever collection the response holds,
 * preserving the surrounding envelope. Falls back to projecting the object
 * itself for single-entity responses.
 */
export function applySelect(value: unknown, paths?: string[]): unknown {
  if (!paths?.length || value === null || value === undefined) return value;

  const itemsPath = detectItemsPath(value);
  if (itemsPath === '') return (value as unknown[]).map((item) => pick(item, paths));

  if (itemsPath !== undefined) {
    const items = getPath(value, itemsPath) as unknown[];
    const clone = structuredClone(value) as Record<string, unknown>;
    setPath(clone, itemsPath, items.map((item) => pick(item, paths)));
    return clone;
  }

  return pick(value, paths);
}

// ─── Fetching ────────────────────────────────────────────────────────────────

/** Normalized result of a paginated source. */
export interface PaginatedResult {
  items: unknown[];
  /** Backend-reported total when available, else the number collected. */
  total: number;
  /** True when `maxItems` cut the collection short. */
  truncated: boolean;
  /** Number of requests issued. */
  pages: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_ITEMS = 1000;

/**
 * Fetch every page of a source until the backend runs out, a short page
 * arrives, or `maxItems` is reached.
 *
 * Unlike unpaginated sources (which return the raw response), this returns a
 * normalized {@link PaginatedResult} — templates read `.items`, and
 * `.truncated` tells them the view is showing a capped subset.
 */
export async function fetchPaginated(
  source: UiDataSourceDefinition,
  paginate: UiPaginationDefinition,
  client: ODataClient,
  params: Record<string, unknown>,
  jwt?: string,
  now?: Date,
): Promise<PaginatedResult> {
  const pageSize = paginate.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = paginate.maxItems ?? DEFAULT_MAX_ITEMS;
  const base = paginate.strategy === 'offset' ? 1 : 0;

  const items: unknown[] = [];
  let total: number | undefined;
  let truncated = false;
  let pages = 0;

  for (;;) {
    const path = substitutePlaceholders(source.path, params, {
      now,
      pagination: { offset: base + items.length, pageSize },
    });
    const response = await client.execute('GET', path, undefined, undefined, jwt);
    pages++;

    const itemsPath = paginate.itemsPath ?? detectItemsPath(response);
    const pageItems = itemsPath === undefined ? undefined : getPath(response, itemsPath);
    if (!Array.isArray(pageItems)) break;

    items.push(...pageItems);

    if (paginate.totalPath) {
      const reported = Number(getPath(response, paginate.totalPath));
      if (Number.isFinite(reported)) total = reported;
    }

    if (items.length >= maxItems) {
      // More remain if the backend said so, or if the last page came back full.
      truncated = total !== undefined ? total > maxItems : pageItems.length >= pageSize;
      items.length = maxItems;
      break;
    }
    // A short page means the collection is exhausted.
    if (pageItems.length < pageSize) break;
    if (total !== undefined && items.length >= total) break;
  }

  return { items, total: total ?? items.length, truncated, pages };
}

/**
 * Fetch all data sources of a view concurrently.
 *
 * Sources marked `optional: true` fail soft to `null`; a failure in any other
 * source rejects with a descriptive error (which the tool handler turns into
 * an `isError` result).
 */
export async function fetchUiData(
  sources: Record<string, UiDataSourceDefinition>,
  clientsByApi: Record<string, ODataClient>,
  params: Record<string, unknown>,
  jwt?: string,
  now?: Date,
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(sources).map(async ([name, source]): Promise<[string, unknown]> => {
      try {
        const client = clientsByApi[source.api];
        if (!client) {
          throw new Error(`unknown api "${source.api}"`);
        }

        let result: unknown;
        if (source.paginate) {
          const page = await fetchPaginated(source, source.paginate, client, params, jwt, now);
          result = { ...page, items: applySelect(page.items, source.select) };
        } else {
          const path = substitutePlaceholders(source.path, params, { now });
          const raw = await client.execute('GET', path, undefined, undefined, jwt);
          result = applySelect(raw ?? null, source.select);
        }

        return [name, result ?? null];
      } catch (error) {
        if (source.optional) {
          return [name, null];
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch data entry "${name}" (api "${source.api}", path "${source.path}"): ${message}`);
      }
    }),
  );

  return Object.fromEntries(entries);
}
