// =============================================================================
// BTP Destination Service
//
// Resolves a BTP destination by name, returning an HttpDestination that can be
// passed directly to the SAP Cloud SDK's executeHttpRequest().
//
// Resolution strategy:
//   1. If a Destination Service is bound (VCAP_SERVICES contains "destination"),
//      use @sap-cloud-sdk/connectivity to resolve the named destination.
//   2. Otherwise (local / self-hosted), fall back to environment variables:
//      fetch a backend token (cached until expiry) and attach it as an
//      explicit Authorization header. By default this is a client-credentials
//      token (technical user); {PREFIX}_AUTH_TYPE selects a per-user grant.
// =============================================================================

import type { HttpDestination, HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import { logger } from '../utils/logger.js';
import {
  USER_AUTH_TYPES, buildUserGrantParams, decodeJwtPayload, readPem,
  type UserAuthType, type UserGrantSettings,
} from './user-propagation.js';

// -----------------------------------------------------------------------------
// Local (environment variable) fallback
// -----------------------------------------------------------------------------

/**
 * Derive the environment variable prefix for a destination name.
 *
 * The destination name is uppercased and any non-alphanumeric characters are
 * replaced with underscores.
 *
 * Examples:
 *   "CPI_DESTINATION"     -> "CPI_DESTINATION"
 *   "my-cpi-tenant"       -> "MY_CPI_TENANT"
 *   "S4H Integration"     -> "S4H_INTEGRATION"
 */
function getEnvVarPrefix(destinationName: string): string {
  return destinationName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

// Cached backend tokens. Keyed by env var prefix for client-credentials, and by
// prefix + user (issuer and subject) for user-propagating grants so users never
// share a backend token. The SDK does not fetch tokens for programmatically-
// built OAuth2 destinations ("no auth tokens could be fetched"), so the
// fallback fetches them itself.
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Safety margin (ms) subtracted from a token's lifetime before re-fetching. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Clear the local-fallback token cache (used by tests). */
export function clearLocalTokenCache(): void {
  tokenCache.clear();
}

function purgeExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}

/**
 * Return a cached token for `cacheKey`, or POST `params` to the token endpoint
 * (HTTP Basic client authentication) and cache the result until shortly
 * before it expires.
 */
async function getCachedToken(
  cacheKey: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  params: () => URLSearchParams,
): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  logger.debug('Fetching backend token (local fallback)', { tokenUrl });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: params().toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Token request to ${tokenUrl} failed with status ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
    );
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error(`Token request to ${tokenUrl} returned no access_token`);
  }

  const expiresInMs = (payload.expires_in ?? 3600) * 1000;
  purgeExpiredTokens();
  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_EXPIRY_MARGIN_MS, 0),
  });

  return payload.access_token;
}

function requireEnv(prefix: string, suffix: string, hint: string): string {
  const value = process.env[`${prefix}_${suffix}`];
  if (!value) {
    throw new Error(`Local fallback: ${prefix}_${suffix} environment variable is not set. ${hint}`);
  }
  return value;
}

/** Read the per-user grant settings for a destination from `{PREFIX}_*` env vars. */
function readUserGrantSettings(prefix: string, type: UserAuthType, tokenUrl: string, clientId: string): UserGrantSettings {
  const env = (suffix: string) => process.env[`${prefix}_${suffix}`] || undefined;
  const settings: UserGrantSettings = { type, tokenUrl, clientId, scope: env('SCOPE') };

  if (type === 'saml-bearer') {
    const hint = 'Required for AUTH_TYPE=saml-bearer (see docs/SSO.md).';
    settings.samlIssuer = requireEnv(prefix, 'SAML_ISSUER', hint);
    settings.samlAudience = requireEnv(prefix, 'SAML_AUDIENCE', hint);
    settings.samlSigningKey = readPem(requireEnv(prefix, 'SAML_SIGNING_KEY', hint));
    settings.samlSigningCert = readPem(requireEnv(prefix, 'SAML_SIGNING_CERT', hint));
    if (!settings.samlSigningCert.includes('BEGIN CERTIFICATE')) {
      throw new Error(`${prefix}_SAML_SIGNING_CERT must be a PEM X.509 certificate`);
    }
    settings.samlNameIdClaim = env('SAML_NAMEID_CLAIM');
    settings.samlNameIdFormat = env('SAML_NAMEID_FORMAT');
    const encoding = env('SAML_ASSERTION_ENCODING');
    if (encoding && encoding !== 'base64url' && encoding !== 'base64') {
      throw new Error(`${prefix}_SAML_ASSERTION_ENCODING must be "base64url" or "base64"`);
    }
    settings.samlAssertionEncoding = encoding as UserGrantSettings['samlAssertionEncoding'];
  } else if (type === 'token-exchange') {
    settings.exchangeAudience = env('TOKEN_EXCHANGE_AUDIENCE');
    settings.exchangeResource = env('TOKEN_EXCHANGE_RESOURCE');
  }

  return settings;
}

/**
 * Construct an HttpDestination from environment variables when no BTP
 * Destination Service is bound.
 *
 * The backend token is fetched (and cached) here and attached as an explicit
 * Authorization header on a NoAuthentication destination. The SDK only
 * fetches tokens for destinations resolved from the BTP Destination Service;
 * a programmatically-built OAuth2 destination fails with "no auth tokens
 * could be fetched".
 *
 * Environment variables (PREFIX = destination name uppercased, with
 * non-alphanumeric characters replaced by underscores):
 *  - {PREFIX}_BASE_URL      - Base URL of the target system
 *  - {PREFIX}_TOKEN_URL     - OAuth2 token endpoint URL
 *  - {PREFIX}_CLIENT_ID     - OAuth2 client ID
 *  - {PREFIX}_CLIENT_SECRET - OAuth2 client secret
 *  - {PREFIX}_AUTH_TYPE     - client-credentials (default, technical user),
 *                             saml-bearer, jwt-bearer or token-exchange
 *                             (per-user; see user-propagation.ts)
 *
 * Example: destination "CPI_DESTINATION" → CPI_DESTINATION_BASE_URL, etc.
 */
async function resolveLocal(destinationName: string, jwt?: string): Promise<HttpDestination> {
  const prefix = getEnvVarPrefix(destinationName);
  const authType = process.env[`${prefix}_AUTH_TYPE`] || 'client-credentials';

  logger.info('No Destination Service binding; using environment variable credentials', {
    destinationName,
    envVarPrefix: prefix,
    authType,
  });

  if (authType !== 'client-credentials' && !USER_AUTH_TYPES.includes(authType as UserAuthType)) {
    throw new Error(
      `${prefix}_AUTH_TYPE "${authType}" is not supported. ` +
      `Use client-credentials, ${USER_AUTH_TYPES.join(', ')}.`,
    );
  }

  const baseUrl = requireEnv(prefix, 'BASE_URL',
    'Provide the base URL of the target system (e.g. https://tenant.it-cpi018.cfapps.eu10.hana.ondemand.com).');
  const tokenUrl = requireEnv(prefix, 'TOKEN_URL',
    'Provide the OAuth2 token endpoint URL (e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token).');
  const clientId = requireEnv(prefix, 'CLIENT_ID', 'Provide the OAuth2 client ID for your service key.');
  const clientSecret = requireEnv(prefix, 'CLIENT_SECRET', 'Provide the OAuth2 client secret for your service key.');

  // Strip any trailing slash from the base URL for consistent usage downstream
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  let accessToken: string;
  if (authType === 'client-credentials') {
    accessToken = await getCachedToken(prefix, tokenUrl, clientId, clientSecret,
      () => new URLSearchParams({ grant_type: 'client_credentials' }));
  } else {
    // Per-user: fail closed — never fall back to the technical user.
    if (!jwt) {
      throw new Error(
        `${prefix}_AUTH_TYPE=${authType} propagates the signed-in user, but the request carries no ` +
        'authenticated user token. Use the HTTP transport with SSO enabled (see docs/SSO.md).',
      );
    }
    const settings = readUserGrantSettings(prefix, authType as UserAuthType, tokenUrl, clientId);
    const claims = decodeJwtPayload(jwt);
    if (!claims.sub) throw new Error('User token has no "sub" claim');
    const userKey = `${String(claims.iss ?? '')}|${String(claims.sub)}`;
    accessToken = await getCachedToken(`${prefix}|${userKey}`, tokenUrl, clientId, clientSecret,
      () => buildUserGrantParams(settings, jwt, claims));
  }

  logger.info('Destination resolved via local fallback', {
    destinationName,
    baseUrl: normalizedBaseUrl,
    authType,
  });

  return {
    url: normalizedBaseUrl,
    authentication: 'NoAuthentication',
    headers: { Authorization: `Bearer ${accessToken}` },
  } satisfies HttpDestination;
}

/**
 * Whether a BTP Destination Service binding is present in VCAP_SERVICES.
 *
 * Checks for the `destination` service specifically rather than any
 * VCAP_SERVICES, so a server running outside BTP can bind only XSUAA (for SSO)
 * and still use the env-var credentials for its backends.
 */
export function hasDestinationBinding(): boolean {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) return false;
  try {
    const services = JSON.parse(raw) as Record<string, Array<{ label?: string }>>;
    if (Array.isArray(services.destination) && services.destination.length > 0) return true;
    return Object.values(services).some(
      (instances) => Array.isArray(instances) && instances.some((i) => i?.label === 'destination'),
    );
  } catch {
    logger.warn('VCAP_SERVICES is not valid JSON; ignoring it for destination resolution');
    return false;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Resolve a named BTP destination and return an {@link HttpDestinationOrFetchOptions}
 * that can be passed directly to `executeHttpRequest()`.
 *
 * **Resolution strategy:**
 * 1. When a Destination Service is bound (see {@link hasDestinationBinding}), returns
 *    `DestinationFetchOptions` with the destination name and optional JWT.
 *    The SDK resolves the destination lazily (including token exchange for
 *    user-dependent auth types like OAuth2UserTokenExchange).
 * 2. Otherwise (local / self-hosted), environment variables
 *    (`{PREFIX}_BASE_URL`, `{PREFIX}_TOKEN_URL`, `{PREFIX}_CLIENT_ID`,
 *    `{PREFIX}_CLIENT_SECRET`, optional `{PREFIX}_AUTH_TYPE`) are used: a
 *    backend token — technical user, or per user when `{PREFIX}_AUTH_TYPE`
 *    selects a user grant — is fetched (and cached until shortly before
 *    expiry) and attached as an Authorization header.
 *
 * @param destinationName - The name of the BTP destination to resolve.
 * @param jwt - Optional validated user JWT, for user-dependent auth.
 * @param options.forwardToDestinationService - Pass `jwt` to the BTP
 *        Destination Service (default true). Disable for tokens it cannot
 *        use, e.g. from a non-XSUAA identity provider.
 * @returns An {@link HttpDestinationOrFetchOptions} for use with `executeHttpRequest()`.
 * @throws Error if the destination cannot be resolved or required
 *         configuration is missing.
 */
export async function resolveDestination(
  destinationName: string,
  jwt?: string,
  options: { forwardToDestinationService?: boolean } = {},
): Promise<HttpDestinationOrFetchOptions> {
  try {
    if (hasDestinationBinding()) {
      const btpJwt = options.forwardToDestinationService === false ? undefined : jwt;
      logger.info('Using BTP Destination Service (lazy resolution via SDK)', { destinationName });
      return {
        destinationName,
        jwt: btpJwt,
        useCache: Boolean(btpJwt),
      } as HttpDestinationOrFetchOptions;
    }

    return await resolveLocal(destinationName, jwt);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);

    logger.error('Failed to resolve destination', {
      destinationName,
      error: message,
    });

    throw new Error(
      `Failed to resolve destination "${destinationName}": ${message}`,
    );
  }
}
