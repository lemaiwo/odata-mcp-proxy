// =============================================================================
// Declarative data acquisition for UI views.
//
// Each view lists named data sources ({ api, path, optional }). On tool
// invocation the sources are fetched concurrently through the shared
// ODataClient instances — same destinations and auth as the generated entity
// tools, including the caller's JWT.
// =============================================================================

import type { ODataClient } from '../client/odata-client.js';
import type { UiDataSourceDefinition } from '../config/index.js';

/**
 * Substitute `{param}` placeholders in a data source path with URL-encoded
 * values from the validated tool arguments.
 *
 * @throws {Error} when a placeholder has no corresponding argument value.
 */
export function substitutePlaceholders(
  path: string,
  params: Record<string, unknown>,
): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`no value provided for placeholder {${name}}`);
    }
    return encodeURIComponent(String(value));
  });
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
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(sources).map(async ([name, source]): Promise<[string, unknown]> => {
      try {
        const client = clientsByApi[source.api];
        if (!client) {
          throw new Error(`unknown api "${source.api}"`);
        }
        const path = substitutePlaceholders(source.path, params);
        const result = await client.execute('GET', path, undefined, undefined, jwt);
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
