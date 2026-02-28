import { type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Express Request augmentation
// ---------------------------------------------------------------------------
// Adds `userToken` to Express Request so downstream handlers can access the
// extracted Bearer token without casting.
// ---------------------------------------------------------------------------
declare global {
  namespace Express {
    interface Request {
      userToken?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Exempt paths
// ---------------------------------------------------------------------------
// Requests matching these patterns skip authentication entirely.
//   - /health           exact match
//   - /oauth/*          any path starting with /oauth/
// ---------------------------------------------------------------------------
const EXEMPT_PATHS: readonly string[] = ['/health'];
const EXEMPT_PREFIXES: readonly string[] = ['/oauth/'];

function isExempt(path: string): boolean {
  if (EXEMPT_PATHS.includes(path)) {
    return true;
  }
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------
function isBTP(): boolean {
  return process.env.VCAP_SERVICES !== undefined;
}

// ---------------------------------------------------------------------------
// Bearer token extraction
// ---------------------------------------------------------------------------
const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates Express middleware that handles JWT / Bearer-token validation.
 *
 * **BTP (VCAP_SERVICES present):**
 * Extracts the Bearer token from the `Authorization` header and stores it on
 * `req.userToken`.  If no token is provided the request is rejected with
 * `401 Unauthorized`.  Actual cryptographic validation is expected to be
 * performed upstream by the BTP Approuter / XSUAA; this middleware acts as a
 * lightweight gatekeeper and token-pass-through.
 *
 * **Local development (no VCAP_SERVICES):**
 * Authentication is skipped entirely.  A warning is logged once so that the
 * developer is aware auth is disabled.
 *
 * **Exempt paths:**
 * `/health` and `/oauth/*` are always allowed through without a token.
 *
 * @returns An Express {@link RequestHandler} that can be registered via
 *          `app.use(createAuthMiddleware())`.
 */
export function createAuthMiddleware(): RequestHandler {
  const runningOnBTP = isBTP();

  // Log once at creation time so the message does not repeat per-request.
  if (!runningOnBTP) {
    logger.warn(
      'VCAP_SERVICES not found — running in local development mode. ' +
        'Authentication is disabled. Do NOT use this configuration in production.',
    );
  } else {
    logger.info('BTP environment detected — Bearer-token authentication is enabled.');
  }

  // Return the actual middleware function.
  return (req: Request, res: Response, next: NextFunction): void => {
    // ------------------------------------------------------------------
    // 1. Exempt paths bypass auth unconditionally.
    // ------------------------------------------------------------------
    if (isExempt(req.path)) {
      next();
      return;
    }

    // ------------------------------------------------------------------
    // 2. Local development — skip auth.
    // ------------------------------------------------------------------
    if (!runningOnBTP) {
      next();
      return;
    }

    // ------------------------------------------------------------------
    // 3. BTP — require and extract Bearer token.
    // ------------------------------------------------------------------
    const token = extractBearerToken(req);

    if (!token) {
      logger.warn('Rejected request — missing or malformed Authorization header', {
        method: req.method,
        url: req.originalUrl,
      });

      res.status(401).json({
        error: 'Unauthorized',
        message: 'A valid Bearer token is required in the Authorization header.',
      });
      return;
    }

    // Store the token for downstream consumption (e.g. token-exchange flows).
    req.userToken = token;

    next();
  };
}
