// Tests per-user propagation for env-var destinations: the signed SAML bearer
// assertion, the per-user grant requests, per-user token caching, and failing
// closed when no user token is present.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { resolveDestination, clearLocalTokenCache } from '../src/client/destination-service.js';
import { buildSamlAssertion } from '../src/client/user-propagation.js';
import type { HttpDestination } from '@sap-cloud-sdk/connectivity';

const PREFIX = 'USER_DEST';
// Self-signed, test-only key pair (test/fixtures/saml).
const FIXTURES = new URL('./fixtures/saml/', import.meta.url);
const KEY_PEM = readFileSync(new URL('test-signing-key.pem', FIXTURES), 'utf-8');
const CERT_PEM = readFileSync(new URL('test-signing-cert.pem', FIXTURES), 'utf-8');
const originalFetch = globalThis.fetch;
const originalVcap = process.env.VCAP_SERVICES;

/** A validated-looking user token (the middleware verifies signatures, not this layer). */
function userToken(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify({ iss: 'https://idp.example.com', ...claims })).toString('base64url')}.sig`;
}

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) process.env[`${PREFIX}_${k}`] = v;
}

beforeEach(() => {
  clearLocalTokenCache();
  delete process.env.VCAP_SERVICES;
  setEnv({
    BASE_URL: 'https://s4.example.com',
    TOKEN_URL: 'https://s4.example.com/sap/bc/sec/oauth2/token',
    CLIENT_ID: 'MCP_CLIENT',
    CLIENT_SECRET: 'secret',
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalVcap !== undefined) process.env.VCAP_SERVICES = originalVcap;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${PREFIX}_`)) delete process.env[key];
  }
});

function mockTokenEndpoint() {
  let n = 0;
  const fetchMock = mock.fn(async () =>
    new Response(JSON.stringify({ access_token: `sap-tok-${++n}`, expires_in: 3600 }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof mockTokenEndpoint>, call = 0): URLSearchParams {
  const [, init] = fetchMock.mock.calls[call].arguments as unknown as [string, RequestInit];
  return new URLSearchParams(String(init.body));
}

function verify(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const signature = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  const sig = new SignedXml({ publicCert: CERT_PEM });
  sig.loadSignature(signature);
  return sig.checkSignature(xml);
}

test('SAML assertion is signed, places the Signature after Issuer, and carries the user', () => {
  const xml = buildSamlAssertion({
    issuer: 'MCP_PROXY',
    audience: 'S4H_100',
    recipient: 'https://s4.example.com/sap/bc/sec/oauth2/token',
    nameId: 'jane@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    signingKey: KEY_PEM,
    signingCert: CERT_PEM,
  });

  assert.ok(verify(xml), 'signature must verify');
  assert.match(xml, /<saml2:Issuer>MCP_PROXY<\/saml2:Issuer><Signature /);
  assert.match(xml, /<saml2:NameID Format="urn:oasis:names:tc:SAML:1\.1:nameid-format:emailAddress">jane@example\.com<\/saml2:NameID>/);
  assert.match(xml, /<saml2:Audience>S4H_100<\/saml2:Audience>/);
  assert.match(xml, /<KeyInfo><X509Data><X509Certificate>/, 'certificate must be embedded for SAP');
  assert.match(xml, /Recipient="https:\/\/s4\.example\.com\/sap\/bc\/sec\/oauth2\/token"/);

  const tampered = xml.replace('jane@example.com', 'admin@example.com');
  assert.equal(verify(tampered), false, 'a changed NameID must break the signature');
});

test('SAML assertion escapes XML special characters in the NameID', () => {
  const xml = buildSamlAssertion({
    issuer: 'I', audience: 'A', recipient: 'R', nameId: 'a<b>&"c',
    nameIdFormat: 'f', signingKey: KEY_PEM, signingCert: CERT_PEM,
  });
  assert.match(xml, />a&lt;b&gt;&amp;"c<\/saml2:NameID>|>a&lt;b&gt;&amp;&quot;c<\/saml2:NameID>/);
  assert.ok(verify(xml));
});

test('saml-bearer exchanges a signed assertion for the user and attaches the SAP token', async () => {
  setEnv({
    AUTH_TYPE: 'saml-bearer',
    SAML_ISSUER: 'MCP_PROXY',
    SAML_AUDIENCE: 'S4H_100',
    SAML_SIGNING_KEY: KEY_PEM.replace(/\n/g, '\\n'), // inline, env-var style
    SAML_SIGNING_CERT: new URL('test-signing-cert.pem', FIXTURES).pathname, // file path
    SCOPE: 'ZAPI_SRV_0001',
  });
  const fetchMock = mockTokenEndpoint();

  const dest = (await resolveDestination('user-dest', userToken({ sub: 'u1', email: 'jane@example.com' }))) as HttpDestination;

  assert.deepEqual(dest.headers, { Authorization: 'Bearer sap-tok-1' });
  const body = requestBody(fetchMock);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:saml2-bearer');
  assert.equal(body.get('client_id'), 'MCP_CLIENT');
  assert.equal(body.get('scope'), 'ZAPI_SRV_0001');
  const assertion = Buffer.from(body.get('assertion')!, 'base64url').toString('utf-8');
  assert.match(assertion, />jane@example\.com<\/saml2:NameID>/);
  assert.ok(verify(assertion));
});

test('saml-bearer uses the configured NameID claim and rejects tokens without it', async () => {
  setEnv({
    AUTH_TYPE: 'saml-bearer', SAML_ISSUER: 'I', SAML_AUDIENCE: 'A',
    SAML_SIGNING_KEY: KEY_PEM, SAML_SIGNING_CERT: CERT_PEM, SAML_NAMEID_CLAIM: 'preferred_username',
  });
  const fetchMock = mockTokenEndpoint();

  await resolveDestination('user-dest', userToken({ sub: 'u1', preferred_username: 'JDOE' }));
  const assertion = Buffer.from(requestBody(fetchMock).get('assertion')!, 'base64url').toString('utf-8');
  assert.match(assertion, />JDOE<\/saml2:NameID>/);

  await assert.rejects(
    resolveDestination('user-dest', userToken({ sub: 'u2' })),
    /no "preferred_username" claim/,
  );
});

test('backend tokens are cached per user, never shared between users', async () => {
  setEnv({ AUTH_TYPE: 'jwt-bearer' });
  const fetchMock = mockTokenEndpoint();

  const a1 = (await resolveDestination('user-dest', userToken({ sub: 'alice' }))) as HttpDestination;
  const b1 = (await resolveDestination('user-dest', userToken({ sub: 'bob' }))) as HttpDestination;
  const a2 = (await resolveDestination('user-dest', userToken({ sub: 'alice' }))) as HttpDestination;

  assert.equal(fetchMock.mock.callCount(), 2);
  assert.notDeepEqual(a1.headers, b1.headers);
  assert.deepEqual(a1.headers, a2.headers);
});

test('jwt-bearer presents the user token as the assertion', async () => {
  setEnv({ AUTH_TYPE: 'jwt-bearer' });
  const fetchMock = mockTokenEndpoint();
  const token = userToken({ sub: 'u1' });

  await resolveDestination('user-dest', token);

  const body = requestBody(fetchMock);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(body.get('assertion'), token);
});

test('token-exchange sends an RFC 8693 request with optional audience', async () => {
  setEnv({ AUTH_TYPE: 'token-exchange', TOKEN_EXCHANGE_AUDIENCE: 'sap-backend' });
  const fetchMock = mockTokenEndpoint();
  const token = userToken({ sub: 'u1' });

  await resolveDestination('user-dest', token);

  const body = requestBody(fetchMock);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(body.get('subject_token'), token);
  assert.equal(body.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(body.get('audience'), 'sap-backend');
});

test('per-user auth types fail closed without a user token', async () => {
  setEnv({ AUTH_TYPE: 'jwt-bearer' });
  const fetchMock = mockTokenEndpoint();

  await assert.rejects(resolveDestination('user-dest'), /no authenticated user token/);
  assert.equal(fetchMock.mock.callCount(), 0, 'must not fall back to a technical-user token');
});

test('unknown AUTH_TYPE is rejected', async () => {
  setEnv({ AUTH_TYPE: 'basic' });
  await assert.rejects(resolveDestination('user-dest', userToken({ sub: 'u1' })), /AUTH_TYPE "basic" is not supported/);
});

test('non-XSUAA tokens are withheld from the BTP Destination Service', async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ destination: [{ label: 'destination' }] });

  const options = await resolveDestination('user-dest', 'oidc-jwt', { forwardToDestinationService: false });

  assert.deepEqual(options, { destinationName: 'user-dest', jwt: undefined, useCache: false });
});
