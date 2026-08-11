import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RESOURCE_URI_META_KEY } from '@mcp-ui/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerUiTools,
  createUiToolHandler,
  buildInputSchema,
  summarizeUiResult,
} from '../src/ui/register.js';
import { clearTemplateCache } from '../src/ui/templates.js';
import type { ODataClient } from '../src/client/odata-client.js';
import type { UiViewDefinition } from '../src/config/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const helloView: UiViewDefinition = {
  tool: 'UI_Hello',
  description: 'Interactive hello view',
  uri: 'ui://test/hello',
  template: 'ui/hello.html',
  inputs: { who: { type: 'string', required: true, description: 'Who to greet' } },
  data: { items: { api: 'x', path: 'items?who={who}' } },
  partials: { '/*__STYLE__*/': 'ui/style.css' },
};

function fakeClient(execute: (...args: unknown[]) => Promise<unknown>): ODataClient {
  return { execute } as unknown as ODataClient;
}

beforeEach(() => clearTemplateCache());

test('buildInputSchema compiles types, required and descriptions', () => {
  const shape = buildInputSchema({
    ...helloView,
    inputs: {
      who: { type: 'string', required: true, description: 'Who to greet' },
      count: { type: 'number' },
      flag: { type: 'boolean', required: false },
    },
  });

  const schema = z.object(shape);
  assert.ok(schema.safeParse({ who: 'x' }).success);
  assert.ok(!schema.safeParse({}).success, 'required input must be enforced');
  assert.ok(!schema.safeParse({ who: 'x', count: 'NaN' }).success);
  assert.ok(schema.safeParse({ who: 'x', count: 2, flag: true }).success);
  assert.equal(shape.who.description, 'Who to greet');
});

test('buildInputSchema rejects unsupported input types', () => {
  assert.throws(
    () => buildInputSchema({ ...helloView, inputs: { bad: { type: 'object' as 'string' } } }),
    /unsupported type "object"/,
  );
});

test('buildInputSchema applies defaults so placeholders always see a value', () => {
  const shape = buildInputSchema({
    ...helloView,
    inputs: {
      months: { type: 'number', default: 6, description: 'Reporting window' },
      scope: { type: 'string', default: 'all' },
    },
  });

  const parsed = z.object(shape).parse({});
  assert.deepEqual(parsed, { months: 6, scope: 'all' });
  // An explicit value still wins over the default.
  assert.deepEqual(z.object(shape).parse({ months: 12 }), { months: 12, scope: 'all' });
});

test('buildInputSchema enforces min/max bounds on number inputs', () => {
  const shape = buildInputSchema({
    ...helloView,
    inputs: { months: { type: 'number', default: 6, min: 1, max: 24 } },
  });
  const schema = z.object(shape);

  assert.equal(schema.parse({}).months, 6);
  assert.ok(schema.safeParse({ months: 24 }).success);
  assert.ok(!schema.safeParse({ months: 0 }).success);
  assert.ok(!schema.safeParse({ months: 25 }).success);
});

test('buildInputSchema rejects min/max on non-number inputs', () => {
  assert.throws(
    () => buildInputSchema({ ...helloView, inputs: { who: { type: 'string', min: 1 } } }),
    /only applies to number inputs/,
  );
});

test('buildInputSchema rejects a default whose type contradicts the declaration', () => {
  assert.throws(
    () => buildInputSchema({ ...helloView, inputs: { months: { type: 'number', default: 'six' } } }),
    /has a string default but is declared as number/,
  );
});

test('summarizeUiResult counts items per data entry', () => {
  const text = summarizeUiResult('UI_X', {
    plain: [1, 2],
    odataV4: { value: [1] },
    odataV2: { d: { results: [1, 2, 3] } },
    single: { guid: 'x' },
    missing: null,
  });
  assert.match(text, /UI_X/);
  assert.match(text, /plain: 2 items/);
  assert.match(text, /odataV4: 1 items/);
  assert.match(text, /odataV2: 3 items/);
  assert.match(text, /single: 1 result/);
  assert.match(text, /missing: unavailable/);
});

test('summarizeUiResult counts paginated entries and flags truncation', () => {
  const text = summarizeUiResult('UI_X', {
    full: { items: [1, 2, 3], total: 3, truncated: false, pages: 1 },
    capped: { items: [1, 2], total: 900, truncated: true, pages: 1 },
  });
  assert.match(text, /full: 3 items/);
  assert.doesNotMatch(text, /full: 3 items \(capped/);
  assert.match(text, /capped: 2 items \(capped, more available\)/);
});

test('handler returns text summary + ui resource + structuredContent payload', async () => {
  const client = fakeClient(async () => ({ value: [{ id: 1 }, { id: 2 }] }));
  const handler = createUiToolHandler(helloView, { x: client }, fixturesDir);

  const result = await handler({ who: 'Wo<rld' }, { authInfo: { token: 'jwt' } });

  assert.ok(!result.isError);
  assert.equal(result.content.length, 2);

  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text as string, /items: 2 items/);

  const embedded = result.content[1] as { type: string; resource: { uri: string; mimeType: string; text: string } };
  assert.equal(embedded.type, 'resource');
  assert.equal(embedded.resource.uri, 'ui://test/hello');
  // With the MCP Apps adapter enabled, mcp-ui tags the mime type with a profile.
  assert.match(embedded.resource.mimeType, /^text\/html/);

  const html = embedded.resource.text;
  assert.match(html, /shared-style-marker/, 'partial must be inlined');
  assert.ok(html.includes('"who":"Wo\\u003crld"'), 'arg value must be baked in with < escaped');
  assert.ok(!html.includes('"__DATA__"'), 'data token must be replaced');

  assert.deepEqual(result.structuredContent, {
    view: 'UI_Hello',
    params: { who: 'Wo<rld' },
    data: { items: { value: [{ id: 1 }, { id: 2 }] } },
  });
});

test('handler returns isError when a required data entry fails', async () => {
  const client = fakeClient(async () => {
    throw new Error('boom');
  });
  const handler = createUiToolHandler(helloView, { x: client }, fixturesDir);

  const result = await handler({ who: 'x' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text as string, /Error: .*"items".*boom/);
});

test('handler renders optional-failure entries as null', async () => {
  const view: UiViewDefinition = {
    ...helloView,
    data: {
      items: { api: 'x', path: 'items' },
      extra: { api: 'x', path: 'extra', optional: true },
    },
  };
  const client = fakeClient(async (_m, path) => {
    if (path === 'extra') throw new Error('nope');
    return [1];
  });
  const handler = createUiToolHandler(view, { x: client }, fixturesDir);

  const result = await handler({ who: 'x' });
  assert.ok(!result.isError);
  assert.deepEqual(
    (result.structuredContent as { data: Record<string, unknown> }).data,
    { items: [1], extra: null },
  );
});

test('registerUiTools registers tool with _meta/readOnlyHint and the template resource', async () => {
  type ToolReg = { name: string; cfg: Record<string, unknown>; handler: unknown };
  type ResourceReg = { name: string; uri: string; meta: Record<string, unknown>; cb: () => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }> };
  const tools: ToolReg[] = [];
  const resources: ResourceReg[] = [];
  const server = {
    registerTool: (name: string, cfg: Record<string, unknown>, handler: unknown) => tools.push({ name, cfg, handler }),
    registerResource: (name: string, uri: string, meta: Record<string, unknown>, cb: ResourceReg['cb']) => resources.push({ name, uri, meta, cb }),
  } as unknown as McpServer;

  const client = fakeClient(async () => []);
  registerUiTools(server, { views: [helloView], clientsByApi: { x: client }, baseDir: fixturesDir });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'UI_Hello');
  assert.deepEqual(tools[0].cfg.annotations, { readOnlyHint: true });
  assert.deepEqual(tools[0].cfg._meta, { [RESOURCE_URI_META_KEY]: 'ui://test/hello' });
  assert.equal(RESOURCE_URI_META_KEY, 'ui/resourceUri');

  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, 'ui://test/hello');
  const { contents } = await resources[0].cb();
  assert.equal(contents[0].uri, 'ui://test/hello');
  assert.match(contents[0].mimeType ?? '', /^text\/html/);
  assert.match(contents[0].text ?? '', /const DATA = null;/, 'template resource must have null data');
  assert.match(contents[0].text ?? '', /shared-style-marker/, 'template resource must inline partials');
});

test('registerUiTools fails fast when a view references an unknown api', () => {
  const server = { registerTool: () => {}, registerResource: () => {} } as unknown as McpServer;
  assert.throws(
    () => registerUiTools(server, { views: [helloView], clientsByApi: {}, baseDir: fixturesDir }),
    /references unknown api "x"/,
  );
});
