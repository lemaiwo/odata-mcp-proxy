// =============================================================================
// BTP Destination Service
//
// Resolves a BTP destination by name, returning an HttpDestination that can be
// passed directly to the SAP Cloud SDK's executeHttpRequest().
//
// Resolution strategy:
//   1. If running on BTP (VCAP_SERVICES present), use @sap-cloud-sdk/connectivity
//      to resolve the named destination from the Destination Service.
//   2. If running locally (no VCAP_SERVICES), fall back to environment variables:
//      fetch an OAuth2 client-credentials token (cached until expiry) and attach
//      it as an explicit Authorization header.
// =============================================================================

import type { HttpDestination, HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import { logger } from '../utils/logger.js';

// -----------------------------------------------------------------------------
// Local OAuth2 client-credentials fallback
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

// Cached OAuth2 client-credentials tokens per env var prefix. The SDK does not
// fetch tokens for programmatically-built OAuth2ClientCredentials destinations
// ("no auth tokens could be fetched"), so the fallback fetches them itself.
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

/**
 * Fetch (or reuse) an OAuth2 client-credentials access token for the local
 * fallback destination. Tokens are cached until shortly before they expire.
 */
async function getLocalAccessToken(
  prefix: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const cached = tokenCache.get(prefix);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  logger.debug('Fetching OAuth2 client-credentials token (local fallback)', { prefix, tokenUrl });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
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
  tokenCache.set(prefix, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_EXPIRY_MARGIN_MS, 0),
  });

  return payload.access_token;
}

/**
 * Construct an HttpDestination from local environment variables when running
 * outside of BTP (i.e. no VCAP_SERVICES).
 *
 * The OAuth2 client-credentials token is fetched (and cached) here and
 * attached as an explicit Authorization header on a NoAuthentication
 * destination. The SDK only fetches tokens for destinations resolved from the
 * BTP Destination Service; a programmatically-built OAuth2ClientCredentials
 * destination fails with "no auth tokens could be fetched".
 *
 * Required environment variables (where PREFIX is the destination name
 * uppercased with non-alphanumeric characters replaced by underscores):
 *  - {PREFIX}_BASE_URL      - Base URL of the target system
 *  - {PREFIX}_TOKEN_URL     - OAuth2 token endpoint URL
 *  - {PREFIX}_CLIENT_ID     - OAuth2 client ID
 *  - {PREFIX}_CLIENT_SECRET - OAuth2 client secret
 *
 * Example: destination "CPI_DESTINATION" → CPI_DESTINATION_BASE_URL, etc.
 */
async function resolveLocal(destinationName: string): Promise<HttpDestination> {
  const prefix = getEnvVarPrefix(destinationName);

  logger.info('VCAP_SERVICES not found; using local environment variable fallback', {
    destinationName,
    envVarPrefix: prefix,
  });

  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];

  if (!baseUrl) {
    throw new Error(
      `Local fallback: ${prefix}_BASE_URL environment variable is not set. ` +
      'Provide the base URL of the target system (e.g. https://tenant.it-cpi018.cfapps.eu10.hana.ondemand.com).',
    );
  }
  if (!tokenUrl) {
    throw new Error(
      `Local fallback: ${prefix}_TOKEN_URL environment variable is not set. ` +
      'Provide the OAuth2 token endpoint URL (e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token).',
    );
  }
  if (!clientId) {
    throw new Error(
      `Local fallback: ${prefix}_CLIENT_ID environment variable is not set. ` +
      'Provide the OAuth2 client ID for your service key.',
    );
  }
  if (!clientSecret) {
    throw new Error(
      `Local fallback: ${prefix}_CLIENT_SECRET environment variable is not set. ` +
      'Provide the OAuth2 client secret for your service key.',
    );
  }

  // Strip any trailing slash from the base URL for consistent usage downstream
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  const accessToken = await getLocalAccessToken(prefix, tokenUrl, clientId, clientSecret);

  logger.info('Destination resolved via local fallback', {
    destinationName,
    baseUrl: normalizedBaseUrl,
  });

  return {
    url: normalizedBaseUrl,
    authentication: 'NoAuthentication',
    headers: { Authorization: `Bearer ${accessToken}` },
  } satisfies HttpDestination;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Resolve a named BTP destination and return an {@link HttpDestinationOrFetchOptions}
 * that can be passed directly to `executeHttpRequest()`.
 *
 * **Resolution strategy:**
 * 1. When running on BTP (VCAP_SERVICES is present), returns
 *    `DestinationFetchOptions` with the destination name and optional JWT.
 *    The SDK resolves the destination lazily (including token exchange for
 *    user-dependent auth types like OAuth2UserTokenExchange).
 * 2. When running locally (no VCAP_SERVICES), environment variables
 *    (`{PREFIX}_BASE_URL`, `{PREFIX}_TOKEN_URL`, `{PREFIX}_CLIENT_ID`,
 *    `{PREFIX}_CLIENT_SECRET`) are used: an OAuth2 client-credentials
 *    token is fetched (and cached until shortly before expiry) and
 *    attached as an Authorization header on a NoAuthentication destination.
 *
 * @param destinationName - The name of the BTP destination to resolve.
 * @param jwt - Optional user JWT for token exchange on BTP.
 * @returns An {@link HttpDestinationOrFetchOptions} for use with `executeHttpRequest()`.
 * @throws Error if the destination cannot be resolved or required
 *         configuration is missing.
 */
export async function resolveDestination(
  destinationName: string,
  jwt?: string,
): Promise<HttpDestinationOrFetchOptions> {
  try {
    const isOnBtp = Boolean(process.env.VCAP_SERVICES);

    if (isOnBtp) {
      logger.info('Using BTP Destination Service (lazy resolution via SDK)', { destinationName });
      return {
        destinationName,
        jwt,
        useCache: Boolean(jwt),
      } as HttpDestinationOrFetchOptions;
    }

    return await resolveLocal(destinationName);
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
