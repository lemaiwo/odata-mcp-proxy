// End-to-end test: boots the built server (dist/index.js) over stdio against a
// local HTTP stub standing in for the OAuth token endpoint and SAP CPI, and
// asserts that response bodies reach the MCP client intact: binary `$value`
// content (an iflow zip) as a lossless base64 envelope, text `$value` content
// (a Groovy script) as text, JSON as parsed JSON, and OData errors as readable
// messages. Also covers the upload half of an artifact copy (`_create` with
// the downloaded base64 as `ArtifactContent`) and the progressive-discovery
// executor, which shares the same client path. Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(rootDir, 'test', 'fixtures', 'e2e-binary-config.json');
const serverEntry = join(rootDir, 'dist', 'index.js');

// A zip-like body: local file header magic followed by every byte value, so
// any lossy text decoding (e.g. UTF-8 with U+FFFD replacement) is detectable.
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x08, 0x08, 0x00, 0x89, 0x6c]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
]);
// Valid UTF-8 with non-ASCII characters, served with CPI's vendor content type.
const GROOVY = 'import com.sap.gateway.ip.core.customdev.util.Message\n// Grüße – ✓\ndef Message processData(Message message) { return message }\n';

const ARTIFACT = "IntegrationDesigntimeArtifacts(Id='Flow_A',Version='active')";
const SCRIPT = "IntegrationDesigntimeArtifacts(Id='Flow_A',Version='active')/Resources(Name='script1.groovy',ResourceType='groovy')";

let stub: Server;
let baseUrl: string;
const uploads: Buffer[] = [];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

before(async () => {
  stub = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = decodeURIComponent(req.url ?? '');

    if (url === '/oauth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }));
      return;
    }
    if (String(req.headers['x-csrf-token']).toLowerCase() === 'fetch') {
      res.writeHead(200, { 'x-csrf-token': 'stub-csrf' });
      res.end();
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${ARTIFACT}/$value`) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(ZIP_BYTES);
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${SCRIPT}/$value`) {
      res.writeHead(200, { 'content-type': 'application/vnd.sap.integration.groovyscript' });
      res.end(Buffer.from(GROOVY, 'utf8'));
      return;
    }
    if (req.method === 'GET' && url === `/api/v1/${ARTIFACT}`) {
      res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ d: { Id: 'Flow_A', Name: 'Flüx A', Version: 'active' } }));
      return;
    }
    if (req.method === 'POST' && url === '/api/v1/IntegrationDesigntimeArtifacts') {
      const payload = JSON.parse(body.toString('utf8')) as { ArtifactContent: string };
      uploads.push(Buffer.from(payload.ArtifactContent, 'base64'));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ d: { Id: 'Flow_A_copy' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'Not Found', message: { lang: 'en', value: 'Integration artifact not found – ünknown' } } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(() => {
  stub.close();
});

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  assert.ok(existsSync(serverEntry), 'dist/index.js missing — run `npm run build` first');
  const env = { ...(process.env as Record<string, string>) };
  delete env.VCAP_SERVICES;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: rootDir,
    env: {
      ...env,
      MCP_TRANSPORT: 'stdio',
      API_CONFIG_FILE: configPath,
      LOG_LEVEL: 'error',
      E2E_BINARY_DEST_BASE_URL: baseUrl,
      E2E_BINARY_DEST_TOKEN_URL: `${baseUrl}/oauth/token`,
      E2E_BINARY_DEST_CLIENT_ID: 'id',
      E2E_BINARY_DEST_CLIENT_SECRET: 'secret',
    },
  });
  const client = new Client({ name: 'e2e-binary-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text ?? '';
}

interface BinaryEnvelope {
  contentType: string;
  encoding: string;
  size: number;
  data: string;
}

test('binary $value round-trips byte-identically through download and create', async () => {
  await withClient(async (client) => {
    const download = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')/$value",
    });
    assert.ok(!download.isError, textOf(download));
    const envelope = JSON.parse(textOf(download)) as BinaryEnvelope;
    assert.equal(envelope.contentType, 'application/zip');
    assert.equal(envelope.encoding, 'base64');
    assert.equal(envelope.size, ZIP_BYTES.length);
    assert.ok(Buffer.from(envelope.data, 'base64').equals(ZIP_BYTES), 'downloaded bytes must match');

    uploads.length = 0;
    const create = await call(client, 'IntegrationDesigntimeArtifacts_create', {
      body: { Id: 'Flow_A_copy', Name: 'Flow A copy', PackageId: 'Pkg', ArtifactContent: envelope.data },
    });
    assert.ok(!create.isError, textOf(create));
    assert.deepEqual(JSON.parse(textOf(create)), { d: { Id: 'Flow_A_copy' } });
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].equals(ZIP_BYTES), 'uploaded ArtifactContent must match the original bytes');
  });
});

test('text $value with a non-text content type is returned as text', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')/Resources(Name='script1.groovy',ResourceType='groovy')/$value",
    });
    assert.ok(!result.isError, textOf(result));
    assert.equal(JSON.parse(textOf(result)), GROOVY);
  });
});

test('JSON GET is still parsed', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Flow_A',Version='active')",
    });
    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(JSON.parse(textOf(result)), { d: { Id: 'Flow_A', Name: 'Flüx A', Version: 'active' } });
  });
});

test('OData error body is surfaced as a readable error message', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'IntegrationDesigntimeArtifacts_get', {
      path: "(Id='Missing',Version='active')",
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: Integration artifact not found – ünknown');
  });
});

test('progressive-discovery executor returns binary $value losslessly', async () => {
  await withClient(async (client) => {
    const result = await call(client, 'execute_operation', {
      api: 'cpi',
      entitySet: 'IntegrationDesigntimeArtifacts',
      operation: 'get',
      path: "(Id='Flow_A',Version='active')/$value",
    });
    assert.ok(!result.isError, textOf(result));
    const envelope = JSON.parse(textOf(result)) as BinaryEnvelope;
    assert.equal(envelope.encoding, 'base64');
    assert.ok(Buffer.from(envelope.data, 'base64').equals(ZIP_BYTES), 'downloaded bytes must match');
  });
});
