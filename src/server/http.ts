import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../utils/logger.js';

/**
 * Creates an Express application pre-configured with:
 * - JSON body parser
 * - CORS (permissive in development, configurable via environment in production)
 * - Request logging middleware (method, url, status, duration)
 * - Health check endpoint at GET /health
 *
 * MCP protocol routes (POST /mcp, GET /mcp, DELETE /mcp) are registered
 * by the entry point after transport initialization.
 *
 * @param port - The port number (used only for logging context during setup)
 * @returns A fully configured Express application (not yet listening)
 */
export function createHttpServer(port: number): Express {
  const app = express();

  // ---------------------------------------------------------------------------
  // Body parsing
  // ---------------------------------------------------------------------------
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = process.env.CORS_ORIGIN; // e.g. "https://my-app.example.com"

  app.use(
    cors({
      // In production, honour an explicit allow-list when provided;
      // otherwise fall back to same-origin only (false).
      // In development, allow all origins for convenience.
      origin: isProduction ? (corsOrigin ?? false) : true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
      credentials: true,
    }),
  );

  // ---------------------------------------------------------------------------
  // JWT extraction — populate req.auth so StreamableHTTPServerTransport
  // propagates the token to tool callbacks via extra.authInfo
  // ---------------------------------------------------------------------------
  app.use('/mcp', (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      (req as any).auth = {
        token: authHeader.slice(7),
        clientId: 'forwarded',
        scopes: [],
      };
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // Request logging middleware
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
    });
  });

  // ---------------------------------------------------------------------------
  // MCP protocol endpoints are wired up by the entry point (src/index.ts)
  // after the transport and MCP server are initialized.
  // ---------------------------------------------------------------------------

  logger.debug('Express application created', { port });

  return app;
}

/**
 * Starts the Express server on the given port.
 *
 * The returned promise resolves once the server is successfully listening.
 * If the port is already in use (or another listen error occurs) the promise
 * is rejected.
 *
 * @param app  - The Express application returned by {@link createHttpServer}
 * @param port - The TCP port to listen on
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
