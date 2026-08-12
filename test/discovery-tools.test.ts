// End-to-end coverage of the two discovery meta-tools against a real
// McpServer: what gets registered, what search returns at each detail level,
// and every validation branch of execute_operation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { registerAllTools, type EntitySetDefinition } from '../src/tools/registry.js';
import { buildIndex, registerDiscoveryTools } from '../src/tools/discovery.js';
import type { ODataClient } from '../src/client/odata-client.js';

interface Call { method: string; path: string; body?: unknown; jwt?: string }

function fakeClient(calls: Call[], impl?: () => unknown): ODataClient {
  return {
    execute: async (method: string, path: string, body?: unknown, _h?: unknown, jwt?: string) => {
      calls.push({ method, path, body, jwt });
      return impl ? impl() : { ok: true };
    },
  } as unknown as ODataClient;
}

const SUBACCOUNTS: EntitySetDefinition = {
  entitySet: 'Subaccounts',
  description: 'BTP subaccounts under the global account',
  category: 'account-management',
  keys: [{ name: 'subaccountGUID', type: 'string' }],
  operations: { list: true, get: true, create: true, update: true, delete: true },
  filterableProperties: ['displayName', 'region'],
  selectableProperties: ['guid', 'displayName'],
  navigationProperties: [{ name: 'customProperties', description: 'custom labels', isCollection: true }],
} as EntitySetDefinition;

const ROLES: EntitySetDefinition = {
  entitySet: 'Roles',
  description: 'roles derived from role templates',
  category: 'authorization',
  keys: [{ name: 'roleName', type: 'string' }],
  operations: {
    list: true,
    get: true,
    create: { enabled: true, requiredScope: 'admin' },
    update: false,
    delete: false,
  },
} as EntitySetDefinition;

async function connect(opts: { mode: 'search' | 'hybrid'; pinned?: string[]; calls: Call[]; impl?: () => unknown }) {
  const client = fakeClient(opts.calls, opts.impl);
  const apis = [
    { name: 'cis-accounts', client, entitySets: [SUBACCOUNTS] },
    { name: 'xsuaa-authorization', client, entitySets: [ROLES] },
  ];
  const index = buildIndex(apis, ['all']);
  const pinnedSet = new Set(opts.pinned ?? []);

  const server = createMcpServer('test', '1.0.0');
  for (const api of apis) {
    registerAllTools(server, api.client, api.entitySets, ['all'], pinnedSet);
  }
  registerDiscoveryTools(server, {
    discovery: { mode: opts.mode, alwaysRegister: opts.pinned },
    index,
    pinned: [...pinnedSet],
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  return { mcp, server };
}

/** Tool results are JSON in a text block. */
function payload(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text!);
}
function errorText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  assert.equal(result.isError, true, 'expected an isError result');
  return result.content[0].text!;
}

// ─── Registration surface ────────────────────────────────────────────────────

test('search mode registers exactly two meta-tools and no entity tools', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['execute_operation', 'search_operations']);
  await server.close();
});

test('hybrid mode keeps the pinned entity set as individual tools', async () => {
  const { mcp, server } = await connect({ mode: 'hybrid', pinned: ['Subaccounts'], calls: [] });
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();

  assert.ok(names.includes('search_operations') && names.includes('execute_operation'));
  assert.ok(names.includes('Subaccounts_list'), 'pinned entity set keeps its tools');
  assert.ok(names.includes('Subaccounts_customProperties_list'), 'including nav-property tools');
  assert.ok(!names.some((n) => n.startsWith('Roles_')), 'unpinned entity sets stay behind discovery');
  await server.close();
});

test('every entity set is exposed as an odata:// schema resource', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const uris = (await mcp.listResources()).resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ['odata://cis-accounts/Subaccounts', 'odata://xsuaa-authorization/Roles']);

  const read = await mcp.readResource({ uri: 'odata://cis-accounts/Subaccounts' });
  const schema = JSON.parse(read.contents[0].text as string);
  assert.equal(schema.entitySet, 'Subaccounts');
  assert.deepEqual(schema.keys, [{ name: 'subaccountGUID', type: 'string' }]);
  assert.ok(schema.pathExamples.byKey.includes('subaccountGUID'));
  await server.close();
});

// ─── search_operations ───────────────────────────────────────────────────────

test('brief search returns compact entries without schema detail', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const out = payload(await mcp.callTool({ name: 'search_operations', arguments: { query: 'subaccounts' } }) as never);

  assert.equal(out.matched, true);
  assert.equal(out.detail, 'brief');
  assert.equal(out.results[0].entitySet, 'Subaccounts');
  assert.deepEqual(out.results[0].operations, ['list', 'get', 'create', 'update', 'delete']);
  assert.equal(out.results[0].keys, undefined, 'brief must not carry schema detail');
  await server.close();
});

test('full search adds keys, properties and path examples', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const out = payload(await mcp.callTool({
    name: 'search_operations',
    arguments: { query: 'subaccounts', detail: 'full' },
  }) as never);

  const hit = out.results[0];
  assert.deepEqual(hit.keys, [{ name: 'subaccountGUID', type: 'string' }]);
  assert.deepEqual(hit.navProperties, ['customProperties']);
  assert.deepEqual(hit.filterableProperties, ['displayName', 'region']);
  assert.ok(hit.pathExamples.byKey);
  assert.ok(hit.operationDetails.find((o: { operation: string }) => o.operation === 'create').requiresBody);
  await server.close();
});

test('an unmatched query reports matched:false and still lists everything', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const out = payload(await mcp.callTool({ name: 'search_operations', arguments: { query: 'kubernetes' } }) as never);

  assert.equal(out.matched, false);
  assert.match(out.note, /No match for "kubernetes"/);
  assert.equal(out.results.length, 2, 'falls back to the full catalog rather than a dead end');
  await server.close();
});

test('full search is capped harder than brief search', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  // limit is clamped to maxFullResults (default 5) for full detail.
  const out = payload(await mcp.callTool({
    name: 'search_operations',
    arguments: { detail: 'full', limit: 100 },
  }) as never);
  assert.ok(out.returned <= 5);
  await server.close();
});

// ─── execute_operation: happy paths ──────────────────────────────────────────

test('execute_operation routes to the right client, method and path', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect({ mode: 'search', calls });

  await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'list', path: '?$top=5' },
  });
  assert.deepEqual(calls[0], { method: 'GET', path: 'Subaccounts?$top=5', body: undefined, jwt: undefined });

  await mcp.callTool({
    name: 'execute_operation',
    arguments: {
      api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'update',
      path: "('g1')", body: { displayName: 'x' },
    },
  });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].path, "Subaccounts('g1')");
  assert.deepEqual(calls[1].body, { displayName: 'x' });
  await server.close();
});

test('execute_operation appends a navigation property after the key', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect({ mode: 'search', calls });
  await mcp.callTool({
    name: 'execute_operation',
    arguments: {
      api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'list',
      path: "('g1')", navProperty: 'customProperties',
    },
  });
  assert.equal(calls[0].path, "Subaccounts('g1')/customProperties");
  await server.close();
});

// ─── execute_operation: validation ───────────────────────────────────────────

test('unknown entity set suggests the right api', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Roles', operation: 'list' },
  }) as never);
  assert.match(text, /Unknown entity set "Roles" in api "cis-accounts"/);
  assert.match(text, /xsuaa-authorization\/Roles/, 'must point at the API that does have it');
  await server.close();
});

test('unavailable operation lists what is available', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'xsuaa-authorization', entitySet: 'Roles', operation: 'update', path: "('r')" },
  }) as never);
  assert.match(text, /not available/);
  assert.match(text, /Available: list, get, create/);
  await server.close();
});

test('keyed operation without a path explains the key expression', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'get' },
  }) as never);
  assert.match(text, /needs a key expression in "path"/);
  assert.match(text, /subaccountGUID \(string\)/);
  await server.close();
});

test('create without a body is rejected before hitting the backend', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect({ mode: 'search', calls });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'create' },
  }) as never);
  assert.match(text, /needs a "body"/);
  assert.equal(calls.length, 0, 'must not reach the OData client');
  await server.close();
});

test('a keyless entity set accepts a collection-level update with no path', async () => {
  // The BTP "entitle a service plan" shape: PATCH the collection with a body.
  const ASSIGNMENTS: EntitySetDefinition = {
    entitySet: 'Assignments',
    description: 'service plan entitlement assignments',
    category: 'entitlements',
    keys: [],
    operations: { list: true, get: false, create: false, update: true, delete: false },
  } as EntitySetDefinition;

  const calls: Call[] = [];
  const client = fakeClient(calls);
  const apis = [{ name: 'cis-entitlements', client, entitySets: [ASSIGNMENTS] }];
  const server = createMcpServer('t', '1');
  registerDiscoveryTools(server, { discovery: { mode: 'search' }, index: buildIndex(apis, ['all']), pinned: [] });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);

  const body = { subaccountServicePlans: [{ serviceName: 'hana-cloud', servicePlanName: 'hana' }] };
  const result = await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-entitlements', entitySet: 'Assignments', operation: 'update', body },
  }) as { isError?: boolean };

  assert.notEqual(result.isError, true, 'a keyless update must not be rejected');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].path, 'Assignments', 'no key expression appended');
  assert.deepEqual(calls[0].body, body);
  await server.close();
});

test('a keyed entity set still requires its key on update', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'update', body: { displayName: 'x' } },
  }) as never);
  assert.match(text, /needs a key expression in "path"/);
  await server.close();
});

test('unknown navigation property lists the valid ones', async () => {
  const { mcp, server } = await connect({ mode: 'search', calls: [] });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: {
      api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'list',
      path: "('g1')", navProperty: 'bogus',
    },
  }) as never);
  assert.match(text, /Unknown navigation property "bogus"/);
  assert.match(text, /Available: customProperties/);
  await server.close();
});

test('required scope is enforced exactly as on the per-entity tools', async () => {
  const calls: Call[] = [];
  const { mcp, server } = await connect({ mode: 'search', calls });
  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: {
      api: 'xsuaa-authorization', entitySet: 'Roles', operation: 'create', body: { name: 'r' },
    },
  }) as never);
  assert.match(text, /Unauthorized: no token provided/);
  assert.equal(calls.length, 0, 'scope check must precede the backend call');
  await server.close();
});

test('backend errors surface as isError, not a throw', async () => {
  const calls: Call[] = [];
  const client = {
    execute: async () => { throw new Error('403 Forbidden from BTP'); },
  } as unknown as ODataClient;
  const apis = [{ name: 'cis-accounts', client, entitySets: [SUBACCOUNTS] }];
  const server = createMcpServer('t', '1');
  registerDiscoveryTools(server, {
    discovery: { mode: 'search' },
    index: buildIndex(apis, ['all']),
    pinned: [],
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '1' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);

  const text = errorText(await mcp.callTool({
    name: 'execute_operation',
    arguments: { api: 'cis-accounts', entitySet: 'Subaccounts', operation: 'list' },
  }) as never);
  assert.match(text, /403 Forbidden from BTP/);
  assert.equal(calls.length, 0);
  await server.close();
});
