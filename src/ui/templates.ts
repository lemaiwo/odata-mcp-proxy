// =============================================================================
// UI template loading and data injection.
//
// Templates are self-contained HTML/JS pages. The server stays declarative:
// it inlines optional partials (literal token -> file) and replaces the
// `"__DATA__"` token with the view's JSON payload. All aggregation/reshaping
// is the template's job.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Token replaced with the JSON payload. Quoted so raw templates stay valid JS. */
export const DATA_TOKEN = '"__DATA__"';

const fileCache = new Map<string, string>();

/** Clear the template/partial file cache (used by tests). */
export function clearTemplateCache(): void {
  fileCache.clear();
}

function loadFile(absolutePath: string): string {
  let content = fileCache.get(absolutePath);
  if (content === undefined) {
    content = readFileSync(absolutePath, 'utf-8');
    fileCache.set(absolutePath, content);
  }
  return content;
}

/**
 * Load a template and inline its partials. Paths resolve against `baseDir`
 * (the directory of the API config file). Every occurrence of a partial's
 * token is replaced with the partial file's content.
 */
export function assembleTemplate(
  baseDir: string,
  templatePath: string,
  partials?: Record<string, string>,
): string {
  let html = loadFile(resolve(baseDir, templatePath));
  for (const [token, file] of Object.entries(partials ?? {})) {
    html = html.split(token).join(loadFile(resolve(baseDir, file)));
  }
  return html;
}

/**
 * Bake the payload into an assembled template by replacing `"__DATA__"` with
 * `JSON.stringify(payload)`. `<` is escaped as `\u003c` so user-controlled
 * strings can never close the surrounding script tag. Pass `null` to produce
 * the data-less variant served as the ui:// template resource.
 */
export function injectData(html: string, payload: unknown): string {
  const json = JSON.stringify(payload ?? null).replace(/</g, '\\u003c');
  return html.replace(DATA_TOKEN, () => json);
}
