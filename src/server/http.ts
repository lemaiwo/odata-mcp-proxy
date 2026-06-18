// =============================================================================
// HTTP Server
//
// Express application with JSON body parsing, CORS, request logging, and a
// health check — plus inbound authentication via `@arc-mcp/xsuaa-auth`:
// the MCP-native XSUAA OAuth proxy (RFC 8414 discovery + RFC 7591 stateless
// dynamic client registration + an HMAC-signed `/oauth/callback` proxy) and a
// chained bearer verifier (XSUAA → OIDC → API key). The `/mcp` protocol routes
// (POST/GET/DELETE) are registered by the entry point (src/index.ts) after
// transport initialisation; they sit behind the bearer guard mounted here.
//
// Auth-only model: the verifier extracts no MCP-level scopes
// (`scopesSupported: []`, no `requiredScopes`) — a valid XSUAA token is
// sufficient, and SAP enforces authorization downstream on the OData calls.
// When no XSUAA service is bound (local / stdio dev) `/mcp` is left open and a
// warning is logged.
// =============================================================================

import {
  type AuthOptions,
  type Logger as AuthLogger,
  type XsuaaCredentials,
  loadXsuaaCredentials,
  resolveAppUrl,
  setupHttpAuth,
} from '@arc-mcp/xsuaa-auth';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';

// Adapt the winston logger to the `@arc-mcp/xsuaa-auth` structural Logger.
// Both use `(message, data)` argument order, so this just forwards.
const authLogger: AuthLogger = {
  debug: (message, data) => logger.debug(message, data),
  info: (message, data) => logger.info(message, data),
  warn: (message, data) => logger.warn(message, data),
  error: (message, data) => logger.error(message, data),
};

/**
 * Load the bound XSUAA credentials, or `undefined` when none is bound (local /
 * stdio dev — `/mcp` is then left open). `loadXsuaaCredentials` throws when there
 * is no (complete) xsuaa binding, so it is guarded.
 */
function loadXsuaa(): XsuaaCredentials | undefined {
  if (!process.env.VCAP_SERVICES) return undefined;
  try {
    return loadXsuaaCredentials();
  } catch (err) {
    logger.warn('XSUAA service not bound or incomplete — OAuth disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Creates an Express application pre-configured with body parsing, CORS, request
 * logging, a health check, and — when an XSUAA service is bound — the MCP-native
 * OAuth proxy plus a bearer guard on `/mcp` (via `@arc-mcp/xsuaa-auth`).
 *
 * @param port - TCP port; used for the OAuth-metadata URL fallback and logging.
 */
export function createHttpServer(port: number): Express {
  const app = express();

  // ── Body parsing ────────────────────────────────────────────────────────────
  app.use(express.json());
  // OAuth token / registration endpoints receive application/x-www-form-urlencoded bodies.
  app.use(express.urlencoded({ extended: false }));

  // ── CORS ──────────────────────────────────────────────────────────────────────
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

  // ── Request logging ───────────────────────────────────────────────────────────
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

  // ── Health check (always unauthenticated) ──────────────────────────────────────
  const credentials = loadXsuaa();
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      oauth: credentials !== undefined,
    });
  });

  // ── Inbound auth: XSUAA OAuth proxy + bearer guard on /mcp ──────────────────────
  // setupHttpAuth mounts the OAuth router (discovery + DCR + authorize/token/revoke)
  // and the `/oauth/callback` proxy, and returns the bearer middleware for `/mcp`
  // (or undefined when no method is configured → endpoint left open).
  const options: AuthOptions = credentials
    ? {
        xsuaa: {
          credentials,
          appUrl: resolveAppUrl(process.env, { port }),
          scopesSupported: [],
          resourceName: 'OData MCP Proxy',
        },
      }
    : {};
  const bearer = setupHttpAuth(app, options, authLogger);
  if (bearer) {
    app.use('/mcp', bearer);
    logger.info('XSUAA OAuth proxy enabled — /mcp requires a valid bearer token');
  } else {
    logger.warn(
      'XSUAA not configured — /mcp is UNAUTHENTICATED (local / stdio dev). Do not expose publicly.',
    );
  }

  // The MCP protocol endpoints (POST/GET/DELETE /mcp) are registered by the entry
  // point after transport initialisation; they run behind the guard mounted above.

  logger.debug('Express application created', { port, oauth: credentials !== undefined });
  return app;
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
