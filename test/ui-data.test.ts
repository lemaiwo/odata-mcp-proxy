import { test } from 'node:test';
import assert from 'node:assert/strict';
import { substitutePlaceholders, fetchUiData } from '../src/ui/data.js';
import type { ODataClient } from '../src/client/odata-client.js';

function fakeClient(execute: (method: string, path: string, body?: unknown, headers?: unknown, jwt?: string) => Promise<unknown>): ODataClient {
  return { execute } as unknown as ODataClient;
}

test('substitutePlaceholders substitutes and URL-encodes values', () => {
  const path = substitutePlaceholders('assignments?subaccountGUID={subaccountGUID}&q={q}', {
    subaccountGUID: 'abc-123',
    q: 'a b&c/d',
  });
  assert.equal(path, 'assignments?subaccountGUID=abc-123&q=a%20b%26c%2Fd');
});

test('substitutePlaceholders leaves paths without placeholders untouched', () => {
  assert.equal(substitutePlaceholders('subaccounts', {}), 'subaccounts');
});

test('substitutePlaceholders throws for a missing value', () => {
  assert.throws(
    () => substitutePlaceholders('subaccounts/{guid}', {}),
    /no value provided for placeholder \{guid\}/,
  );
});

test('fetchUiData fetches all entries concurrently and passes the JWT', async () => {
  const calls: Array<{ path: string; jwt?: string }> = [];
  const client = fakeClient(async (_method, path, _body, _headers, jwt) => {
    calls.push({ path, jwt });
    return { value: [path] };
  });

  const data = await fetchUiData(
    {
      a: { api: 'x', path: 'subaccounts' },
      b: { api: 'x', path: 'assignments?guid={guid}' },
    },
    { x: client },
    { guid: 'g 1' },
    'the-jwt',
  );

  assert.deepEqual(data, {
    a: { value: ['subaccounts'] },
    b: { value: ['assignments?guid=g%201'] },
  });
  assert.ok(calls.every((c) => c.jwt === 'the-jwt'));
});

test('fetchUiData fails soft to null for optional entries', async () => {
  const client = fakeClient(async (_m, path) => {
    if (path === 'broken') throw new Error('backend down');
    return [1, 2, 3];
  });

  const data = await fetchUiData(
    {
      ok: { api: 'x', path: 'fine' },
      soft: { api: 'x', path: 'broken', optional: true },
      missingApi: { api: 'nope', path: 'anything', optional: true },
    },
    { x: client },
    {},
  );

  assert.deepEqual(data, { ok: [1, 2, 3], soft: null, missingApi: null });
});

test('fetchUiData rejects with a descriptive error for required entries', async () => {
  const client = fakeClient(async () => {
    throw new Error('401 Unauthorized');
  });

  await assert.rejects(
    fetchUiData({ subaccounts: { api: 'x', path: 'subaccounts' } }, { x: client }, {}),
    /data entry "subaccounts".*401 Unauthorized/,
  );
});

test('fetchUiData treats a missing placeholder in a required entry as a failure', async () => {
  const client = fakeClient(async () => ({}));
  await assert.rejects(
    fetchUiData({ a: { api: 'x', path: 'items/{id}' } }, { x: client }, {}),
    /placeholder \{id\}/,
  );
});
