// =============================================================================
// Generic OIDC Auth Service
//
// SSO against any OpenID Connect provider (Entra ID, Okta, Keycloak, SAP IAS,
// Auth0, …) without SAP BTP. Mirrors XsuaaAuth so the HTTP layer can proxy
// the same OAuth flow:
//   - Endpoints discovered from `${issuer}/.well-known/openid-configuration`
//   - Authorization URL construction
//   - Authorization code → token exchange, token refresh
//   - JWT validation against the IdP's JWKS (issuer + audience checked)
// =============================================================================

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { extractScopes } from './scopes.js';
import type { AuthProvider, AuthRequest, StaticClientCredentials } from './types.js';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scopes requested at the authorization endpoint. */
  scopes: string;
  /** Accepted `aud` values for access tokens (defaults to the client ID). */
  audiences: string[];
  tokenAuthMethod: 'client_secret_post' | 'client_secret_basic';
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class OidcAuth implements AuthProvider {
  readonly kind = 'oidc' as const;
  // OIDC tokens mean nothing to the BTP Destination Service — never forward them.
  readonly forwardsUserToken = false;

  private discovery: Promise<OidcDiscovery> | null = null;
  private jwks: JWTVerifyGetKey | null = null;

  constructor(
    private readonly settings: OidcSettings,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    logger.info('OIDC auth provider initialized', {
      issuer: settings.issuer,
      clientId: settings.clientId,
      audiences: settings.audiences,
    });
  }

  isConfigured(): boolean {
    return true;
  }

  /** Fetch (once) and cache the provider's discovery document. */
  private getDiscovery(): Promise<OidcDiscovery> {
    if (!this.discovery) {
      const url = `${this.settings.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      this.discovery = (async () => {
        const response = await this.fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(`OIDC discovery at ${url} failed with status ${response.status}`);
        }
        const doc = (await response.json()) as Partial<OidcDiscovery>;
        for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
          if (!doc[key]) throw new Error(`OIDC discovery document at ${url} is missing "${key}"`);
        }
        return doc as OidcDiscovery;
      })();
      // Retry discovery on the next call instead of caching a failure forever.
      this.discovery.catch(() => { this.discovery = null; });
    }
    return this.discovery;
  }

  private async getJwks(): Promise<JWTVerifyGetKey> {
    if (!this.jwks) {
      const { jwks_uri } = await this.getDiscovery();
      this.jwks = createRemoteJWKSet(new URL(jwks_uri));
    }
    return this.jwks;
  }

  async getAuthorizationUrl(state: string, baseUrl: string): Promise<string> {
    const { authorization_endpoint } = await this.getDiscovery();
    const url = new URL(authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('redirect_uri', `${baseUrl}/oauth/callback`);
    url.searchParams.set('scope', this.settings.scopes);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const { token_endpoint } = await this.getDiscovery();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const body = new URLSearchParams(params);

    if (this.settings.tokenAuthMethod === 'client_secret_basic') {
      const id = encodeURIComponent(this.settings.clientId);
      const secret = encodeURIComponent(this.settings.clientSecret);
      headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
    } else {
      body.set('client_id', this.settings.clientId);
      body.set('client_secret', this.settings.clientSecret);
    }

    const response = await this.fetchImpl(token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Token request failed: ${response.status} — ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  exchangeCodeForToken(code: string, redirectUri: string): Promise<Record<string, unknown>> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refreshAccessToken(refreshToken: string): Promise<Record<string, unknown>> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Verify signature, issuer, audience and expiry. Returns the token payload.
   * Throws if the token is invalid.
   */
  async validateToken(token: string): Promise<Record<string, unknown>> {
    const { issuer } = await this.getDiscovery();
    const { payload } = await jwtVerify(token, await this.getJwks(), {
      issuer,
      audience: this.settings.audiences,
    });
    return payload as Record<string, unknown>;
  }

  requireAuth() {
    return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized', error_description: 'Missing Bearer token' });
        return;
      }

      const token = authHeader.slice(7);

      try {
        const payload = await this.validateToken(token);
        (req as Request & { auth?: unknown }).auth = {
          token,
          clientId: this.settings.clientId,
          scopes: extractScopes(payload),
          expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
        };
        req.jwtToken = token;
        logger.debug('OIDC token validated successfully', { sub: payload.sub });
        next();
      } catch (err) {
        logger.debug('OIDC token validation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(401).json({ error: 'unauthorized', error_description: 'Invalid or expired token' });
      }
    };
  }

  getDiscoveryMetadata(baseUrl: string): Record<string, unknown> {
    return {
      issuer: this.settings.issuer,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: this.settings.scopes.split(/\s+/).filter(Boolean),
      registration_endpoint: `${baseUrl}/oauth/client-registration`,
    };
  }

  getClientCredentials(): StaticClientCredentials {
    return { clientId: this.settings.clientId, clientSecret: this.settings.clientSecret };
  }

  getRegistrationExtras(): Record<string, unknown> {
    return {};
  }
}
