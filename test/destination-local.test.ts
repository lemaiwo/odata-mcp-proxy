// Tests the local (non-VCAP) destination fallback: it must fetch the OAuth2
// client-credentials token itself and attach it as an Authorization header,
// since the SAP Cloud SDK does not fetch tokens for programmatically-built
// destinations.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination, clearLocalTokenCache } from '../src/client/destination-service.js';
import type { HttpDestination } from '@sap-cloud-sdk/connectivity';

const PREFIX = 'LOCAL_TEST_DEST';
const originalFetch = globalThis.fetch;
const originalVcap = process.env.VCAP_SERVICES;

beforeEach(() => {
  clearLocalTokenCache();
  delete process.env.VCAP_SERVICES;
  process.env[`${PREFIX}_BASE_URL`] = 'https://backend.example.com/';
  process.env[`${PREFIX}_TOKEN_URL`] = 'https://auth.example.com/oauth/token';
  process.env[`${PREFIX}_CLIENT_ID`] = 'client-id';
  process.env[`${PREFIX}_CLIENT_SECRET`] = 'client-secret';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalVcap !== undefined) process.env.VCAP_SERVICES = originalVcap;
  for (const suffix of ['BASE_URL', 'TOKEN_URL', 'CLIENT_ID', 'CLIENT_SECRET']) {
    delete process.env[`${PREFIX}_${suffix}`];
  }
});

function mockTokenEndpoint(payload: unknown, status = 200) {
  const fetchMock = mock.fn(async () => new Response(JSON.stringify(payload), { status }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

test('local fallback fetches a client-credentials token and attaches it as a header', async () => {
  const fetchMock = mockTokenEndpoint({ access_token: 'tok-1', expires_in: 3600 });

  const destination = (await resolveDestination('local-test-dest')) as HttpDestination;

  assert.equal(destination.url, 'https://backend.example.com');
  assert.equal(destination.authentication, 'NoAuthentication');
  assert.deepEqual(destination.headers, { Authorization: 'Bearer tok-1' });

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(url, 'https://auth.example.com/oauth/token');
  assert.equal(init.method, 'POST');
  assert.equal(String(init.body), 'grant_type=client_credentials');
  const expectedBasic = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;
  assert.equal((init.headers as Record<string, string>).Authorization, expectedBasic);
});

test('local fallback caches the token across resolutions', async () => {
  const fetchMock = mockTokenEndpoint({ access_token: 'tok-cached', expires_in: 3600 });

  await resolveDestination('local-test-dest');
  const second = (await resolveDestination('local-test-dest')) as HttpDestination;

  assert.equal(fetchMock.mock.callCount(), 1, 'second resolution must reuse the cached token');
  assert.deepEqual(second.headers, { Authorization: 'Bearer tok-cached' });
});

test('local fallback re-fetches when the cached token is about to expire', async () => {
  // expires_in below the 60s safety margin -> cache entry is immediately stale.
  const fetchMock = mockTokenEndpoint({ access_token: 'tok-short', expires_in: 30 });

  await resolveDestination('local-test-dest');
  await resolveDestination('local-test-dest');

  assert.equal(fetchMock.mock.callCount(), 2);
});

test('local fallback surfaces token endpoint failures descriptively', async () => {
  mockTokenEndpoint({ error: 'unauthorized' }, 401);

  await assert.rejects(
    resolveDestination('local-test-dest'),
    /Failed to resolve destination "local-test-dest".*status 401/s,
  );
});

test('local fallback rejects when the token response has no access_token', async () => {
  mockTokenEndpoint({ token_type: 'bearer' });

  await assert.rejects(
    resolveDestination('local-test-dest'),
    /no access_token/,
  );
});
