// =============================================================================
// Auth provider factory
// =============================================================================

import type { Config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { OidcAuth } from './oidc-auth.js';
import { XsuaaAuth } from './xsuaa-auth.js';
import type { AuthProvider } from './types.js';

export type { AuthProvider, AuthRequest, StaticClientCredentials } from './types.js';
export { OidcAuth } from './oidc-auth.js';
export { XsuaaAuth } from './xsuaa-auth.js';

/** Provider that leaves the server open (local development only). */
class NoAuth implements AuthProvider {
  readonly kind = 'none' as const;
  readonly forwardsUserToken = false;
  isConfigured() { return false; }
  async getAuthorizationUrl(): Promise<string> { throw new Error('Auth not configured'); }
  async exchangeCodeForToken(): Promise<Record<string, unknown>> { throw new Error('Auth not configured'); }
  async refreshAccessToken(): Promise<Record<string, unknown>> { throw new Error('Auth not configured'); }
  requireAuth() { return async (_req: unknown, _res: unknown, next: () => void) => next(); }
  getDiscoveryMetadata() { return null; }
  getClientCredentials() { return null; }
  getRegistrationExtras() { return {}; }
}

type AuthSettings = Pick<
  Config,
  | 'authProvider' | 'oidcIssuer' | 'oidcClientId' | 'oidcClientSecret'
  | 'oidcScopes' | 'oidcAudience' | 'oidcTokenAuthMethod'
>;

/**
 * Select the inbound auth provider:
 *   - `oidc`  — generic OpenID Connect (requires OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET)
 *   - `xsuaa` — SAP XSUAA from VCAP_SERVICES (open when not bound, as before)
 *   - `none`  — no authentication
 *   - `auto`  — `oidc` when OIDC_ISSUER is set, otherwise `xsuaa`
 */
export function createAuthProvider(settings: AuthSettings): AuthProvider {
  const kind = settings.authProvider === 'auto'
    ? (settings.oidcIssuer ? 'oidc' : 'xsuaa')
    : settings.authProvider;

  if (kind === 'oidc') {
    // Presence is enforced by the config schema; re-checked for type narrowing.
    if (!settings.oidcIssuer || !settings.oidcClientId || !settings.oidcClientSecret) {
      throw new Error('OIDC auth requires OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');
    }
    const audiences = (settings.oidcAudience ?? settings.oidcClientId)
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    return new OidcAuth({
      issuer: settings.oidcIssuer,
      clientId: settings.oidcClientId,
      clientSecret: settings.oidcClientSecret,
      scopes: settings.oidcScopes,
      audiences,
      tokenAuthMethod: settings.oidcTokenAuthMethod,
    });
  }

  if (kind === 'none') {
    logger.warn('AUTH_PROVIDER=none — the /mcp endpoint is unauthenticated');
    return new NoAuth();
  }

  return new XsuaaAuth();
}
