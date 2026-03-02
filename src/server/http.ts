// =============================================================================
// HTTP Server
//
// Creates and configures an Express application with:
//   - JSON body parser + CORS
//   - Optional XSUAA JWT validation middleware
//   - Request logging
//   - Health check
//   - OAuth2 endpoints (when XSUAA is configured):
//       GET  /.well-known/oauth-authorization-server  RFC 8414 discovery
//       GET  /oauth/authorize                          Start OAuth flow
//       GET  /oauth/callback                           XSUAA → client redirect
//       GET  /oauth/token                              Token endpoint (GET form)
//       POST /oauth/token                              Token endpoint (POST)
//       POST /oauth/refresh                            Refresh token endpoint
//       GET  /oauth/client-registration                Static client info
//       POST /oauth/client-registration                Static client registration
//
// MCP protocol routes (POST /mcp, GET /mcp, DELETE /mcp) are registered
// by the entry point (src/index.ts) after transport initialisation.
// =============================================================================

import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../utils/logger.js';
import { type XsuaaAuth } from '../auth/xsuaa-auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// In-memory store for MCP-Inspector OAuth proxy state (short-lived, <10 min).
// Maps `state` → { mcpRedirectUri, code_challenge, … }
const mcpProxyStates = new Map<
  string,
  {
    mcpRedirectUri: string;
    state: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    timestamp: number;
  }
>();

function purgeStaleMcpStates(): void {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes
  for (const [key, value] of mcpProxyStates) {
    if (value.timestamp < cutoff) mcpProxyStates.delete(key);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an Express application pre-configured with middleware and OAuth endpoints.
 *
 * @param port - TCP port (used only for log context during setup)
 * @param auth - XsuaaAuth instance; OAuth endpoints are registered only when
 *               `auth.isConfigured()` returns true.
 */
export function createHttpServer(port: number, auth: XsuaaAuth): Express {
  const app = express();

  // ---------------------------------------------------------------------------
  // Body parsing
  // ---------------------------------------------------------------------------
  app.use(express.json());
  // OAuth token endpoints receive application/x-www-form-urlencoded bodies.
  app.use(express.urlencoded({ extended: false }));

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = process.env.CORS_ORIGIN;

  app.use(
    cors({
      origin: isProduction ? (corsOrigin ?? false) : true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'mcp-session-id',
        'mcp-protocol-version',
        'last-event-id',
      ],
      exposedHeaders: ['mcp-session-id'],
      credentials: true,
    }),
  );

  // ---------------------------------------------------------------------------
  // JWT extraction / optional XSUAA validation
  //
  // Attaches req.auth (for the MCP SDK) and req.jwtToken when a valid Bearer
  // token is present. When XSUAA is configured the token is validated; invalid
  // tokens are silently dropped so local / stdio development still works.
  // ---------------------------------------------------------------------------
  app.use('/mcp', auth.requireAuth() as unknown as (req: Request, res: Response, next: NextFunction) => void);

  // ---------------------------------------------------------------------------
  // Request logging
  // ---------------------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`, {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        duration,
      });
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      oauth: auth.isConfigured(),
    });
  });

  // ---------------------------------------------------------------------------
  // OAuth endpoints — only wired when XSUAA service is bound
  // ---------------------------------------------------------------------------
  if (auth.isConfigured()) {
    logger.info('XSUAA configured — OAuth endpoints enabled');

    // ── RFC 8414 Authorization Server Metadata ───────────────────────────────
    app.get(
      ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'],
      (req: Request, res: Response) => {
        const metadata = auth.getDiscoveryMetadata(getBaseUrl(req));
        if (!metadata) {
          res.status(503).json({ error: 'OAuth not configured' });
          return;
        }
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json(metadata);
      },
    );

    // ── Start OAuth flow ─────────────────────────────────────────────────────
    // MCP Inspector calls this with redirect_uri pointing back to itself.
    // We store the mapping (state → mcpRedirectUri) and forward the request
    // to XSUAA using OUR /oauth/callback as the redirect URI.
    app.get('/oauth/authorize', (req: Request, res: Response) => {
      try {
        const state = (req.query['state'] as string | undefined) ?? randomUUID();
        const mcpRedirectUri = req.query['redirect_uri'] as string | undefined;
        const codeChallenge = req.query['code_challenge'] as string | undefined;
        const codeChallengeMethod = req.query['code_challenge_method'] as string | undefined;
        const baseUrl = getBaseUrl(req);

        if (!mcpRedirectUri) {
          res.status(400).json({ error: 'Missing required parameter: redirect_uri' });
          return;
        }

        purgeStaleMcpStates();
        mcpProxyStates.set(state, {
          mcpRedirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          timestamp: Date.now(),
        });

        const authUrl = auth.getAuthorizationUrl(state, baseUrl);
        logger.debug('OAuth authorize — redirecting to XSUAA', { state, mcpRedirectUri });
        res.redirect(authUrl);
      } catch (err) {
        logger.error('OAuth authorize failed', { error: String(err) });
        res.status(500).json({ error: 'Failed to initiate OAuth flow' });
      }
    });

    // ── XSUAA callback ───────────────────────────────────────────────────────
    // XSUAA redirects here after the user authenticates.
    // We look up the original MCP Inspector redirect URI by state and forward.
    app.get('/oauth/callback', (req: Request, res: Response) => {
      try {
        const code = req.query['code'] as string | undefined;
        const state = req.query['state'] as string | undefined;
        const error = req.query['error'] as string | undefined;

        if (error) {
          const description = (req.query['error_description'] as string | undefined) ?? error;
          logger.warn('OAuth callback received error from XSUAA', { error, description });
          res.status(400).send(errorPage('Authentication Failed', description));
          return;
        }

        if (!code || !state) {
          res.status(400).send(errorPage('Bad Request', 'Missing code or state parameter'));
          return;
        }

        const proxyInfo = mcpProxyStates.get(state);
        if (!proxyInfo) {
          logger.warn('OAuth callback — state not found', { state });
          res.status(400).send(errorPage('Session Expired', 'OAuth state not found. Please restart the authentication flow.'));
          return;
        }

        mcpProxyStates.delete(state);

        const redirectTarget = new URL(proxyInfo.mcpRedirectUri);
        redirectTarget.searchParams.set('code', code);
        redirectTarget.searchParams.set('state', state);

        logger.debug('OAuth callback — redirecting to MCP client', {
          target: redirectTarget.toString(),
        });
        res.redirect(redirectTarget.toString());
      } catch (err) {
        logger.error('OAuth callback failed', { error: String(err) });
        res.status(500).send(errorPage('Server Error', 'An unexpected error occurred'));
      }
    });

    // ── Token endpoint (GET + POST) ───────────────────────────────────────────
    const tokenHandler = async (req: Request, res: Response): Promise<void> => {
      try {
        const body = (req.method === 'GET' ? req.query : req.body) as Record<string, string>;
        const grantType = body['grant_type'];

        if (grantType === 'authorization_code' || body['code']) {
          const code = body['code'];
          if (!code) {
            res.status(400).json({ error: 'invalid_request', error_description: 'Missing parameter: code' });
            return;
          }
          const baseUrl = getBaseUrl(req);
          const tokenData = await auth.exchangeCodeForToken(code, `${baseUrl}/oauth/callback`);
          res.json(tokenData);
        } else if (grantType === 'refresh_token' || body['refresh_token']) {
          const refreshToken = body['refresh_token'];
          if (!refreshToken) {
            res.status(400).json({ error: 'invalid_request', error_description: 'Missing parameter: refresh_token' });
            return;
          }
          const tokenData = await auth.refreshAccessToken(refreshToken);
          res.json(tokenData);
        } else {
          res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: 'Supported grant types: authorization_code, refresh_token',
          });
        }
      } catch (err) {
        logger.error('Token exchange failed', { error: String(err) });
        res.status(400).json({
          error: 'invalid_grant',
          error_description: err instanceof Error ? err.message : 'Token exchange failed',
        });
      }
    };

    app.get('/oauth/token', tokenHandler);
    app.post('/oauth/token', tokenHandler);

    // ── Refresh token endpoint ────────────────────────────────────────────────
    app.post('/oauth/refresh', async (req: Request, res: Response) => {
      try {
        const refreshToken = (req.body as Record<string, string>)['refresh_token']
          ?? (req.body as Record<string, string>)['refreshToken'];
        if (!refreshToken) {
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing parameter: refresh_token',
          });
          return;
        }
        const tokenData = await auth.refreshAccessToken(refreshToken);
        res.json(tokenData);
      } catch (err) {
        logger.error('Token refresh failed', { error: String(err) });
        res.status(400).json({
          error: 'invalid_grant',
          error_description: err instanceof Error ? err.message : 'Token refresh failed',
        });
      }
    });

    // ── Static client registration (RFC 7591) ────────────────────────────────
    // Returns pre-configured XSUAA client credentials so MCP clients (e.g.
    // MCP Inspector) can auto-register without a dynamic registration flow.
    app.post('/oauth/client-registration', (req: Request, res: Response) => {
      const creds = auth.getClientCredentials();
      if (!creds) {
        res.status(503).json({ error: 'OAuth not configured' });
        return;
      }
      const baseUrl = getBaseUrl(req);
      res.json({
        client_id: creds.clientid,
        client_secret: creds.clientsecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: [`${baseUrl}/oauth/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        client_name: 'OData MCP Proxy',
        registration_client_uri: `${baseUrl}/oauth/client-registration`,
        'x-xsuaa-metadata': {
          url: creds.url,
          identityzone: creds.identityzone,
          uaadomain: creds.uaadomain ?? creds.url.replace(/^https?:\/\//, ''),
        },
      });
    });

    app.get('/oauth/client-registration', (req: Request, res: Response) => {
      const baseUrl = getBaseUrl(req);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({
        registration_endpoint: `${baseUrl}/oauth/client-registration`,
        client_registration_types_supported: ['static'],
        static_client_available: true,
      });
    });
  } else {
    logger.info('XSUAA not configured — OAuth endpoints disabled');
  }

  // ---------------------------------------------------------------------------
  // MCP protocol endpoints are wired up by the entry point (src/index.ts)
  // after transport initialisation.
  // ---------------------------------------------------------------------------

  logger.debug('Express application created', { port, oauth: auth.isConfigured() });

  return app;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;text-align:center;padding:2rem}h1{color:#d32f2f}a{display:inline-block;margin-top:1rem;padding:.5rem 1.5rem;background:#1976d2;color:#fff;border-radius:4px;text-decoration:none}</style>
</head>
<body><h1>❌ ${title}</h1><p>${message}</p>
<a href="/oauth/authorize">Try again</a></body></html>`;
}

/**
 * Starts the Express server on the given port.
 *
 * @param app  - Application returned by {@link createHttpServer}
 * @param port - TCP port to listen on
 */
export function startHttpServer(app: Express, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`HTTP server listening on port ${port}`);
      resolve();
    });
    server.on('error', (err: Error) => {
      logger.error(`Failed to start HTTP server on port ${port}`, { error: err.message });
      reject(err);
    });
  });
}
