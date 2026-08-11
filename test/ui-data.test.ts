import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  substitutePlaceholders,
  resolveNumericArg,
  applySelect,
  fetchUiData,
} from '../src/ui/data.js';
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

// ─── Built-in date placeholders ──────────────────────────────────────────────

// Fixed reference point so the expectations below are deterministic.
const NOW = new Date('2026-08-11T14:44:22.116Z');

test('substitutePlaceholders expands $now with each date format', () => {
  const opts = { now: NOW };
  assert.equal(substitutePlaceholders('u?d={$now:yyyymm}', {}, opts), 'u?d=202608');
  assert.equal(substitutePlaceholders('u?d={$now:date}', {}, opts), 'u?d=2026-08-11');
  assert.equal(
    substitutePlaceholders('u?d={$now:iso}', {}, opts),
    'u?d=2026-08-11T14%3A44%3A22.116Z',
  );
});

test('substitutePlaceholders expands $monthsAgo from a literal and a parameter', () => {
  assert.equal(substitutePlaceholders('u?f={$monthsAgo(6):yyyymm}', {}, { now: NOW }), 'u?f=202602');
  assert.equal(
    substitutePlaceholders('u?f={$monthsAgo(months):yyyymm}', { months: 6 }, { now: NOW }),
    'u?f=202602',
  );
});

test('substitutePlaceholders supports the name±n offset form for inclusive windows', () => {
  // A 6-month window *including* the current month starts 5 months back.
  assert.equal(
    substitutePlaceholders('u?f={$monthsAgo(months-1):yyyymm}', { months: 6 }, { now: NOW }),
    'u?f=202603',
  );
  assert.equal(
    substitutePlaceholders('u?f={$monthsAgo(months+1):yyyymm}', { months: 1 }, { now: NOW }),
    'u?f=202606',
  );
});

test('substitutePlaceholders rolls $monthsAgo across a year boundary', () => {
  assert.equal(substitutePlaceholders('{$monthsAgo(9):yyyymm}', {}, { now: NOW }), '202511');
});

test('substitutePlaceholders expands $daysAgo', () => {
  assert.equal(substitutePlaceholders('{$daysAgo(30):date}', {}, { now: NOW }), '2026-07-12');
});

test('substitutePlaceholders rejects unknown built-ins and formats', () => {
  assert.throws(() => substitutePlaceholders('{$bogus:yyyymm}', {}, { now: NOW }), /unknown built-in "\$bogus"/);
  assert.throws(() => substitutePlaceholders('{$now:bogus}', {}, { now: NOW }), /unknown date format ":bogus"/);
});

test('substitutePlaceholders rejects a built-in argument with no value', () => {
  assert.throws(
    () => substitutePlaceholders('{$monthsAgo(months):yyyymm}', {}, { now: NOW }),
    /no value provided for built-in argument "months"/,
  );
});

test('substitutePlaceholders rejects paging built-ins outside a paginated source', () => {
  assert.throws(
    () => substitutePlaceholders('Users?startIndex={$offset}', {}, {}),
    /only available on a data source with a "paginate" block/,
  );
});

test('substitutePlaceholders mixes built-ins with plain parameters', () => {
  assert.equal(
    substitutePlaceholders('cost?sub={guid}&f={$now:yyyymm}', { guid: 'a b' }, { now: NOW }),
    'cost?sub=a%20b&f=202608',
  );
});

test('resolveNumericArg rejects malformed expressions', () => {
  assert.throws(() => resolveNumericArg('months*2', {}), /invalid built-in argument/);
  assert.throws(() => resolveNumericArg('months', { months: 'abc' }), /is not numeric/);
});

// ─── Pagination ──────────────────────────────────────────────────────────────

/** SCIM-style backend: 1-based startIndex, `resources` array, `totalResults`. */
function scimBackend(total: number, pageSize = 100) {
  const paths: string[] = [];
  const client = fakeClient(async (_m, path) => {
    paths.push(path);
    const start = Number(/startIndex=(\d+)/.exec(path)?.[1] ?? 1);
    const slice = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - (start - 1))) },
      (_v, i) => ({ id: `u${start + i}`, extra: 'noise' }),
    );
    return { totalResults: total, resources: slice };
  });
  return { client, paths };
}

test('fetchPaginated walks every page and reports the total', async () => {
  const { client, paths } = scimBackend(250);
  const data = await fetchUiData(
    {
      users: {
        api: 'x',
        path: 'Users?startIndex={$offset}&count={$pageSize}',
        paginate: { strategy: 'offset', pageSize: 100, maxItems: 500, itemsPath: 'resources', totalPath: 'totalResults' },
      },
    },
    { x: client },
    {},
  );

  const users = data.users as { items: unknown[]; total: number; truncated: boolean; pages: number };
  assert.equal(users.items.length, 250);
  assert.equal(users.total, 250);
  assert.equal(users.truncated, false);
  assert.equal(users.pages, 3);
  assert.deepEqual(paths, [
    'Users?startIndex=1&count=100',
    'Users?startIndex=101&count=100',
    'Users?startIndex=201&count=100',
  ]);
});

test('fetchPaginated caps at maxItems and flags truncation', async () => {
  const { client } = scimBackend(1000);
  const data = await fetchUiData(
    {
      users: {
        api: 'x',
        path: 'Users?startIndex={$offset}&count={$pageSize}',
        paginate: { strategy: 'offset', pageSize: 100, maxItems: 500, itemsPath: 'resources', totalPath: 'totalResults' },
      },
    },
    { x: client },
    {},
  );

  const users = data.users as { items: unknown[]; total: number; truncated: boolean };
  assert.equal(users.items.length, 500);
  assert.equal(users.total, 1000);
  assert.equal(users.truncated, true);
});

test('fetchPaginated uses a 0-based offset for the skiptop strategy', async () => {
  const paths: string[] = [];
  const client = fakeClient(async (_m, path) => {
    paths.push(path);
    const skip = Number(/skip=(\d+)/.exec(path)?.[1] ?? 0);
    return { value: skip === 0 ? [1, 2] : [3] };
  });

  await fetchUiData(
    {
      rows: { api: 'x', path: 'Things?$skip={$offset}&$top={$pageSize}', paginate: { strategy: 'skiptop', pageSize: 2 } },
    },
    { x: client },
    {},
  );

  assert.deepEqual(paths, ['Things?$skip=0&$top=2', 'Things?$skip=2&$top=2']);
});

test('fetchPaginated auto-detects the item array when itemsPath is omitted', async () => {
  const client = fakeClient(async () => ({ value: [{ a: 1 }] }));
  const data = await fetchUiData(
    { rows: { api: 'x', path: 'Things?$skip={$offset}&$top={$pageSize}', paginate: { strategy: 'skiptop', pageSize: 10 } } },
    { x: client },
    {},
  );
  assert.deepEqual((data.rows as { items: unknown[] }).items, [{ a: 1 }]);
});

// ─── select projection ───────────────────────────────────────────────────────

test('applySelect trims items inside a response envelope', () => {
  const trimmed = applySelect(
    { totalResults: 2, resources: [{ id: 'a', junk: 1, meta: { created: 'x', junk: 2 } }] },
    ['id', 'meta.created'],
  );
  assert.deepEqual(trimmed, {
    totalResults: 2,
    resources: [{ id: 'a', meta: { created: 'x' } }],
  });
});

test('applySelect trims a bare array and a single entity', () => {
  assert.deepEqual(applySelect([{ a: 1, b: 2 }], ['a']), [{ a: 1 }]);
  assert.deepEqual(applySelect({ a: 1, b: 2 }, ['a']), { a: 1 });
});

test('applySelect omits absent fields and passes null through', () => {
  assert.deepEqual(applySelect([{ a: 1 }], ['a', 'nope']), [{ a: 1 }]);
  assert.equal(applySelect(null, ['a']), null);
});

test('fetchUiData applies select to paginated and plain sources', async () => {
  const { client } = scimBackend(2);
  const data = await fetchUiData(
    {
      users: {
        api: 'x',
        path: 'Users?startIndex={$offset}&count={$pageSize}',
        paginate: { strategy: 'offset', itemsPath: 'resources', totalPath: 'totalResults' },
        select: ['id'],
      },
      plain: { api: 'y', path: 'things', select: ['keep'] },
    },
    { x: client, y: fakeClient(async () => [{ keep: 1, drop: 2 }]) },
    {},
  );

  assert.deepEqual((data.users as { items: unknown[] }).items, [{ id: 'u1' }, { id: 'u2' }]);
  assert.deepEqual(data.plain, [{ keep: 1 }]);
});
