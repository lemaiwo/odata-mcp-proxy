// End-to-end test: boots the built server (dist/index.js) over stdio with a
// stub config + tiny template and asserts the UI tool result renders with
// baked data. Run `npm run build` first (the `npm test` script does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

test('stdio server renders a config-driven UI tool with baked data', async () => {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: {
      ...(process.env as Record<string, string>),
      MCP_TRANSPORT: 'stdio',
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'error',
    },
  });
  const client = new Client({ name: 'e2e-test', version: '0.0.0' });
  await client.connect(transport);

  try {
    // Tool is advertised with the ui/resourceUri _meta pointing at the template.
    const { tools } = await client.listTools();
    const hello = tools.find((t) => t.name === 'UI_Hello');
    assert.ok(hello, 'UI_Hello tool must be registered');
    assert.equal(hello._meta?.['ui/resourceUri'], 'ui://ui-e2e/hello');
    assert.equal(hello.annotations?.readOnlyHint, true);
    assert.equal(hello.inputSchema.required?.includes('who'), true);

    // Calling the tool returns summary text + the rendered embedded resource.
    const result = await client.callTool({ name: 'UI_Hello', arguments: { who: 'Wo<rld' } });
    assert.ok(!result.isError, `tool call failed: ${JSON.stringify(result.content)}`);

    const content = result.content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text as string, /UI_Hello/);

    assert.equal(content[1].type, 'resource');
    const resource = content[1].resource as { uri: string; mimeType: string; text: string };
    assert.equal(resource.uri, 'ui://ui-e2e/hello');
    assert.match(resource.mimeType, /^text\/html/);
    assert.match(resource.text, /shared-style-marker/, 'partial must be inlined');
    assert.ok(resource.text.includes('"who":"Wo\\u003crld"'), 'data must be baked in with < escaped');
    assert.ok(!resource.text.includes('"__DATA__"'), 'data token must be replaced');

    assert.deepEqual(result.structuredContent, {
      view: 'UI_Hello',
      params: { who: 'Wo<rld' },
      data: {},
    });

    // The template is also served as a ui:// resource with null data.
    const read = await client.readResource({ uri: 'ui://ui-e2e/hello' });
    const templateResource = read.contents[0] as { uri: string; mimeType?: string; text?: string };
    assert.equal(templateResource.uri, 'ui://ui-e2e/hello');
    assert.match(templateResource.mimeType ?? '', /^text\/html/);
    assert.match(templateResource.text ?? '', /const DATA = null;/);
  } finally {
    await client.close();
  }
});
