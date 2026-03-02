// =============================================================================
// XSUAA Auth Service
//
// Handles SAP XSUAA OAuth2 flows:
//   - Authorization URL construction
//   - Authorization code → token exchange
//   - Token refresh
//   - JWT validation (optional — only active when XSUAA is bound)
//   - Express middleware for optional token extraction + validation
//   - RFC 8414 discovery metadata
//   - Static client registration payload
// =============================================================================

import xsenv from '@sap/xsenv';
import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface XsuaaCredentials {
  clientid: string;
  clientsecret: string;
  url: string;
  xsappname?: string;
  identityzone?: string;
  tenantid?: string;
  tenantmode?: string;
  verificationkey?: string;
  uaadomain?: string;
}

/** Minimal security-context shape we use from @sap/xssec. */
export interface SecurityContext {
  getUserName(): string;
  getEmail(): string | undefined;
  getGrantedScopes(): string[];
  checkScope(scope: string): boolean;
}

/**
 * Extended Express Request that carries the validated JWT token string.
 * Set by `optionalAuth()` when a valid Bearer token is provided.
 */
export interface AuthRequest extends Request {
  /** Raw JWT string extracted (and optionally validated) from the Bearer header. */
  jwtToken?: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class XsuaaAuth {
  private credentials: XsuaaCredentials | null = null;

  constructor() {
    this._init();
  }

  private _init(): void {
    try {
      const services = xsenv.getServices({ xsuaa: { label: 'xsuaa' } });
      this.credentials = services['xsuaa'] as unknown as XsuaaCredentials;
      logger.info('XSUAA service initialized');
    } catch {
      logger.warn('XSUAA service not found in VCAP_SERVICES — OAuth flow disabled');
      this.credentials = null;
    }
  }

  /** Whether XSUAA credentials were found in the environment. */
  isConfigured(): boolean {
    return this.credentials !== null;
  }

  /**
   * Build the XSUAA authorization redirect URL.
   * @param state  - Opaque value used to correlate the callback.
   * @param baseUrl - This server's base URL (used to build the redirect_uri).
   */
  getAuthorizationUrl(state: string, baseUrl: string): string {
    if (!this.credentials) throw new Error('XSUAA not configured');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.credentials.clientid,
      redirect_uri: `${baseUrl}/oauth/callback`,
      state,
    });
    return `${this.credentials.url}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for an access + refresh token pair.
   * @param code        - The code received at the callback.
   * @param redirectUri - Must match the redirect_uri used when starting the flow.
   */
  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('XSUAA not configured');
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.credentials.clientid,
      client_secret: this.credentials.clientsecret,
      redirect_uri: redirectUri,
    });
    const response = await fetch(`${this.credentials.url}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} — ${text}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Use a refresh token to obtain a new access token.
   * @param refreshToken - The refresh token from a previous token response.
   */
  async refreshAccessToken(refreshToken: string): Promise<Record<string, unknown>> {
    if (!this.credentials) throw new Error('XSUAA not configured');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.credentials.clientid,
      client_secret: this.credentials.clientsecret,
    });
    const response = await fetch(`${this.credentials.url}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} — ${text}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Validate a JWT with @sap/xssec and return its SecurityContext.
   * Throws if the token is invalid or the credentials are unavailable.
   */
  async validateToken(token: string): Promise<SecurityContext> {
    if (!this.credentials) throw new Error('XSUAA not configured');
    const { default: xssec } = await import('@sap/xssec');
    const creds = this.credentials as unknown as Record<string, unknown>;
    return new Promise<SecurityContext>((resolve, reject) => {
      xssec.createSecurityContext(token, creds, (err, ctx) => {
        if (err) reject(err);
        else if (ctx) resolve(ctx as unknown as SecurityContext);
        else reject(new Error('Security context creation failed'));
      });
    });
  }

  /**
   * Express middleware that **requires** a valid Bearer token when XSUAA is configured.
   *
   * - If XSUAA is **not** configured the middleware is a no-op (local / stdio dev).
   * - Missing or invalid tokens → 401 Unauthorized.
   * - Valid tokens → `req.jwtToken` and `req.auth` are populated and the request continues.
   */
  requireAuth() {
    return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
      if (!this.credentials) {
        // XSUAA not configured — allow all requests (local dev / stdio).
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized', error_description: 'Missing Bearer token' });
        return;
      }

      const token = authHeader.slice(7);

      try {
        await this.validateToken(token);
        (req as Request & { auth?: unknown }).auth = { token, clientId: 'forwarded', scopes: [] };
        (req as AuthRequest).jwtToken = token;
        logger.debug('XSUAA token validated successfully');
        next();
      } catch (err) {
        logger.debug('XSUAA token validation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(401).json({ error: 'unauthorized', error_description: 'Invalid or expired token' });
      }
    };
  }

  /**
   * RFC 8414 Authorization Server Metadata document.
   * Returns `null` when XSUAA is not configured.
   */
  getDiscoveryMetadata(baseUrl: string): Record<string, unknown> | null {
    if (!this.credentials) return null;
    const creds = this.credentials;
    return {
      issuer: creds.url,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${baseUrl}/oauth/client-registration`,
      'x-xsuaa-metadata': {
        client_id: creds.clientid,
        identityZone: creds.identityzone,
        tenantMode: creds.tenantmode,
      },
    };
  }

  /** Raw XSUAA client credentials — used for the static client-registration endpoint. */
  getClientCredentials(): XsuaaCredentials | null {
    return this.credentials;
  }
}
