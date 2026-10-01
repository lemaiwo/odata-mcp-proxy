// =============================================================================
// Auth Provider Contract
//
// Shared shape for the inbound (MCP client → this server) auth providers.
// The HTTP layer only talks to this interface, so XSUAA (BTP) and generic
// OIDC (Entra ID, Okta, Keycloak, SAP IAS, …) are interchangeable.
// =============================================================================

import { type Request, type Response, type NextFunction } from 'express';

/**
 * Extended Express Request that carries the validated JWT token string.
 * Set by `requireAuth()` when a valid Bearer token is provided.
 */
export interface AuthRequest extends Request {
  /** Raw JWT string extracted (and validated) from the Bearer header. */
  jwtToken?: string;
}

/** Static OAuth client handed out by the client-registration endpoint. */
export interface StaticClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthProvider {
  /** Provider identifier, used for logging and the health endpoint. */
  readonly kind: 'xsuaa' | 'oidc' | 'none';

  /**
   * Whether the validated user token may be handed to the BTP Destination
   * Service. Only XSUAA tokens qualify (the SDK uses them for user token
   * exchange / principal propagation). Env-var destinations receive the token
   * regardless and use it only for per-user AUTH_TYPEs.
   */
  readonly forwardsUserToken: boolean;

  /** Whether the provider is configured; OAuth endpoints are wired only when true. */
  isConfigured(): boolean;

  /** Build the IdP authorization redirect URL (redirect_uri = `${baseUrl}/oauth/callback`). */
  getAuthorizationUrl(state: string, baseUrl: string): Promise<string>;

  /** Exchange an authorization code for a token response. */
  exchangeCodeForToken(code: string, redirectUri: string): Promise<Record<string, unknown>>;

  /** Use a refresh token to obtain a new token response. */
  refreshAccessToken(refreshToken: string): Promise<Record<string, unknown>>;

  /** Express middleware: 401 on missing/invalid Bearer token when configured, no-op otherwise. */
  requireAuth(): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;

  /** RFC 8414 Authorization Server Metadata, or `null` when not configured. */
  getDiscoveryMetadata(baseUrl: string): Record<string, unknown> | null;

  /** Static client credentials for the client-registration endpoint, or `null`. */
  getClientCredentials(): StaticClientCredentials | null;

  /** Provider-specific extra fields merged into the client-registration response. */
  getRegistrationExtras(): Record<string, unknown>;
}
