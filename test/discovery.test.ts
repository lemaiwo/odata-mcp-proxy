import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, scoreEntry, search } from '../src/tools/discovery.js';
import type { EntitySetDefinition } from '../src/tools/registry.js';
import type { ODataClient } from '../src/client/odata-client.js';

const client = { execute: async () => ({ value: [] }) } as unknown as ODataClient;

function def(partial: Partial<EntitySetDefinition> & { entitySet: string }): EntitySetDefinition {
  return {
    description: '',
    category: 'general',
    keys: [],
    operations: { list: true, get: false, create: false, update: false, delete: false },
    ...partial,
  } as EntitySetDefinition;
}

const SUBACCOUNTS = def({
  entitySet: 'Subaccounts',
  description: 'BTP subaccounts under the global account',
  category: 'account-management',
  keys: [{ name: 'subaccountGUID', type: 'string' }],
  operations: { list: true, get: true, create: true, update: true, delete: true },
});
const ASSIGNMENTS = def({
  entitySet: 'Assignments',
  description: 'service plan entitlement assignments for a subaccount',
  category: 'entitlements',
  operations: { list: true, get: false, create: false, update: true, delete: false },
});
const ROLES = def({
  entitySet: 'Roles',
  description: 'roles derived from role templates',
  category: 'authorization',
  keys: [{ name: 'roleName', type: 'string' }],
  operations: { list: true, get: true, create: true, update: false, delete: true },
});
// get/update/delete are enabled but the entity set has no keys, so those
// operations were never registerable.
const KEYLESS = def({
  entitySet: 'GlobalAccount',
  description: 'BTP global account details',
  category: 'account-management',
  keys: [],
  operations: { list: true, get: true, create: false, update: true, delete: true },
});

const apis = [
  { name: 'cis-accounts', client, entitySets: [SUBACCOUNTS, KEYLESS] },
  { name: 'cis-entitlements', client, entitySets: [ASSIGNMENTS] },
  { name: 'xsuaa-authorization', client, entitySets: [ROLES] },
];

// ─── Index construction ──────────────────────────────────────────────────────

test('buildIndex lists only operations that were actually registerable', () => {
  const index = buildIndex(apis, ['all']);

  const subs = index.find((e) => e.definition.entitySet === 'Subaccounts')!;
  assert.deepEqual(subs.available, ['list', 'get', 'create', 'update', 'delete']);

  // Single-entity operations drop out when the entity set defines no keys.
  const ga = index.find((e) => e.definition.entitySet === 'GlobalAccount')!;
  assert.deepEqual(ga.available, ['list', 'update']);
});

test('a keyless entity set can still be updated at collection level', () => {
  // BTP entitlement assignments are entitled/revoked with a keyless PATCH
  // carrying a payload — there is no key to address. get/delete stay gated
  // because a keyless get duplicates list and a keyless delete would target
  // the whole collection.
  const index = buildIndex(apis, ['all']);
  const assignments = index.find((e) => e.definition.entitySet === 'Assignments')!;
  assert.deepEqual(assignments.available, ['list', 'update']);

  const ga = index.find((e) => e.definition.entitySet === 'GlobalAccount')!;
  assert.ok(!ga.available.includes('get'), 'keyless get stays gated');
  assert.ok(!ga.available.includes('delete'), 'keyless delete stays gated');
  assert.ok(ga.available.includes('update'), 'keyless update is allowed');
});

test('buildIndex honours enabledApiCategories', () => {
  const index = buildIndex(apis, ['entitlements']);
  assert.deepEqual(index.map((e) => e.definition.entitySet), ['Assignments']);
});

test('buildIndex returns a deterministic order', () => {
  const a = buildIndex(apis, ['all']).map((e) => `${e.api}/${e.definition.entitySet}`);
  const b = buildIndex([...apis].reverse(), ['all']).map((e) => `${e.api}/${e.definition.entitySet}`);
  assert.deepEqual(a, b);
  assert.deepEqual(a, [
    'cis-accounts/GlobalAccount',
    'cis-accounts/Subaccounts',
    'cis-entitlements/Assignments',
    'xsuaa-authorization/Roles',
  ]);
});

test('buildIndex drops entity sets with no available operations', () => {
  const none = def({ entitySet: 'Nothing', operations: { list: false, get: false, create: false, update: false, delete: false } });
  const index = buildIndex([{ name: 'x', client, entitySets: [none] }], ['all']);
  assert.equal(index.length, 0);
});

// ─── Scoring ─────────────────────────────────────────────────────────────────

test('scoreEntry ranks an exact name match above a description match', () => {
  const index = buildIndex(apis, ['all']);
  const subs = index.find((e) => e.definition.entitySet === 'Subaccounts')!;
  const assignments = index.find((e) => e.definition.entitySet === 'Assignments')!;

  // "subaccounts" is the name of one and a description word of the other.
  assert.ok(scoreEntry(subs, ['subaccounts']) > scoreEntry(assignments, ['subaccounts']));
});

test('scoreEntry gives no score to an unrelated term', () => {
  const index = buildIndex(apis, ['all']);
  const roles = index.find((e) => e.definition.entitySet === 'Roles')!;
  assert.equal(scoreEntry(roles, ['kubernetes']), 0);
});

// ─── Search ──────────────────────────────────────────────────────────────────

test('search ranks the best match first', () => {
  const index = buildIndex(apis, ['all']);
  const { entries, matched } = search(index, 'role templates', {});
  assert.equal(matched, true);
  assert.equal(entries[0].definition.entitySet, 'Roles');
});

test('search matches across camelCase and multi-word queries', () => {
  const index = buildIndex(apis, ['all']);
  // "sub accounts" must reach "Subaccounts" via camel/word splitting.
  assert.equal(search(index, 'sub accounts', {}).entries[0].definition.entitySet, 'Subaccounts');
  assert.equal(search(index, 'entitlement', {}).entries[0].definition.entitySet, 'Assignments');
});

test('search falls back to the full list when nothing matches', () => {
  const index = buildIndex(apis, ['all']);
  const { entries, matched } = search(index, 'nonexistent-thing', {});
  assert.equal(matched, false, 'must report the fallback rather than pretend it matched');
  assert.equal(entries.length, index.length);
});

test('search with no query returns everything and reports no match', () => {
  const index = buildIndex(apis, ['all']);
  const { entries, matched } = search(index, undefined, {});
  assert.equal(matched, false);
  assert.equal(entries.length, index.length);
});

test('search applies api and category filters', () => {
  const index = buildIndex(apis, ['all']);
  assert.deepEqual(
    search(index, undefined, { api: 'cis-accounts' }).entries.map((e) => e.definition.entitySet),
    ['GlobalAccount', 'Subaccounts'],
  );
  assert.deepEqual(
    search(index, undefined, { category: 'authorization' }).entries.map((e) => e.definition.entitySet),
    ['Roles'],
  );
});

test('search filters still apply when the query matches nothing', () => {
  const index = buildIndex(apis, ['all']);
  const { entries, matched } = search(index, 'zzz', { api: 'cis-accounts' });
  assert.equal(matched, false);
  // The fallback must respect the filter, not dump the whole index.
  assert.deepEqual(entries.map((e) => e.definition.entitySet), ['GlobalAccount', 'Subaccounts']);
});
