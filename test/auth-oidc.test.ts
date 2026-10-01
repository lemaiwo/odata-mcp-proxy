// Tests the generic OIDC auth provider against a local stub IdP (discovery
// document + JWKS served over HTTP), plus provider selection and the
// multi-format scope check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose';
import { OidcAuth, createAuthProvider } from '../src/auth/index.js';
import { checkScope } from '../src/tools/registry.js';

let server: Server;
let issuer: string;
let privateKey: KeyLike;
let otherKey: KeyLike;
let lastTokenRequest: { headers: Record<string, string | string[] | undefined>; body: string } | undefined;

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  server = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      }));
    } else if (req.url === '/jwks') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastTokenRequest = { headers: req.headers, body };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer' }));
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function provider(overrides: Partial<ConstructorParameters<typeof OidcAuth>[0]> = {}) {
  return new OidcAuth({
    issuer,
    clientId: 'mcp-client',
    clientSecret: 's3cret',
    scopes: 'openid offline_access api://mcp/access',
    audiences: ['mcp-client'],
    tokenAuthMethod: 'client_secret_post',
    ...overrides,
  });
}

async function sign(claims: Record<string, unknown>, opts: { key?: KeyLike; iss?: string; aud?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? 'mcp-client')
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opts.key ?? privateKey);
}

/** Run the middleware against a fake request; resolve with status (200 = next() called). */
async function runMiddleware(auth: OidcAuth, authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Record<string, unknown>;
  let status = 200;
  let nextCalled = false;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  };
  await auth.requireAuth()(req as never, res as never, () => { nextCalled = true; });
  return { status: nextCalled ? 200 : status, req };
}

test('valid token passes and exposes scopes from scp and roles', async () => {
  const token = await sign({ scp: 'read write', roles: ['admin'] });
  const { status, req } = await runMiddleware(provider(), `Bearer ${token}`);
  assert.equal(status, 200);
  assert.equal(req.jwtToken, token);
  assert.deepEqual((req.auth as { scopes: string[] }).scopes, ['read', 'write', 'admin']);
});

test('missing, wrongly signed, wrong-audience and wrong-issuer tokens are rejected', async () => {
  const auth = provider();
  assert.equal((await runMiddleware(auth)).status, 401);
  assert.equal((await runMiddleware(auth, `Bearer ${await sign({}, { key: otherKey })}`)).status, 401);
  assert.equal((await runMiddleware(auth, `Bearer ${await sign({}, { aud: 'someone-else' })}`)).status, 401);
  assert.equal((await runMiddleware(auth, `Bearer ${await sign({}, { iss: 'https://evil.example.com' })}`)).status, 401);
});

test('any configured audience is accepted', async () => {
  const auth = provider({ audiences: ['mcp-client', 'api://mcp'] });
  const { status } = await runMiddleware(auth, `Bearer ${await sign({}, { aud: 'api://mcp' })}`);
  assert.equal(status, 200);
});

test('authorization URL targets the discovered endpoint with our callback', async () => {
  const url = new URL(await provider().getAuthorizationUrl('st-1', 'https://mcp.example.com'));
  assert.equal(`${url.origin}${url.pathname}`, `${issuer}/authorize`);
  assert.equal(url.searchParams.get('client_id'), 'mcp-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mcp.example.com/oauth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid offline_access api://mcp/access');
  assert.equal(url.searchParams.get('state'), 'st-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('code exchange sends client credentials in the body (client_secret_post)', async () => {
  const tokens = await provider().exchangeCodeForToken('c1', 'https://mcp.example.com/oauth/callback');
  assert.equal(tokens.access_token, 'at');
  const body = new URLSearchParams(lastTokenRequest!.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'c1');
  assert.equal(body.get('client_secret'), 's3cret');
  assert.equal(lastTokenRequest!.headers.authorization, undefined);
});

test('refresh with client_secret_basic sends credentials in the header', async () => {
  await provider({ tokenAuthMethod: 'client_secret_basic' }).refreshAccessToken('rt-1');
  const body = new URLSearchParams(lastTokenRequest!.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'rt-1');
  assert.equal(body.get('client_secret'), null);
  assert.equal(
    lastTokenRequest!.headers.authorization,
    `Basic ${Buffer.from('mcp-client:s3cret').toString('base64')}`,
  );
});

test('createAuthProvider selects OIDC when an issuer is set, XSUAA otherwise', () => {
  const base = {
    authProvider: 'auto' as const,
    oidcScopes: 'openid',
    oidcTokenAuthMethod: 'client_secret_post' as const,
    oidcIssuer: undefined, oidcClientId: undefined, oidcClientSecret: undefined, oidcAudience: undefined,
  };
  const oidc = createAuthProvider({ ...base, oidcIssuer: issuer, oidcClientId: 'c', oidcClientSecret: 's' });
  assert.equal(oidc.kind, 'oidc');
  assert.equal(oidc.forwardsUserToken, false);
  assert.equal(createAuthProvider(base).kind, 'xsuaa');
  const none = createAuthProvider({ ...base, authProvider: 'none' });
  assert.equal(none.kind, 'none');
  assert.equal(none.isConfigured(), false);
});

test('checkScope accepts XSUAA arrays, OIDC strings and Entra roles', async () => {
  const unsigned = (claims: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  assert.doesNotThrow(() => checkScope('read', unsigned({ scope: ['odata-mcp-proxy!t1.read'] })));
  assert.doesNotThrow(() => checkScope('write', unsigned({ scope: 'openid write' })));
  assert.doesNotThrow(() => checkScope('read', unsigned({ scp: 'mcp.read profile' })));
  assert.doesNotThrow(() => checkScope('admin', unsigned({ roles: ['admin'] })));
  assert.throws(() => checkScope('admin', unsigned({ scp: 'read write' })), /Forbidden/);
  assert.throws(() => checkScope('read', undefined), /Unauthorized/);
});
