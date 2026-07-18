// =============================================================================
// BTP Destination Service
//
// Resolves a BTP destination by name, returning an HttpDestination that can be
// passed directly to the SAP Cloud SDK's executeHttpRequest().
//
// Resolution strategy:
//   1. If running on BTP (VCAP_SERVICES present), use @sap-cloud-sdk/connectivity
//      to resolve the named destination from the Destination Service.
//   2. If running locally (no VCAP_SERVICES), fall back to environment variables,
//      fetch an OAuth2 client-credentials token ourselves (the SDK only performs
//      OAuth flows for destinations fetched from the Destination Service), and
//      construct a Destination carrying the Bearer token as a header.
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

/**
 * Cache of OAuth2 client-credentials tokens keyed by token URL + client ID,
 * refreshed shortly before expiry.
 */
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Safety margin (ms) subtracted from the token lifetime before refresh. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Fetch (or return a cached) OAuth2 client-credentials access token.
 *
 * The SAP Cloud SDK only executes OAuth flows for destinations retrieved from
 * the BTP Destination Service; for locally constructed destinations it expects
 * an auth token to already be present. So in local mode we fetch the token
 * ourselves against the XSUAA token endpoint.
 */
async function fetchClientCredentialsToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const cacheKey = `${tokenUrl}|${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken;
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `OAuth2 token request to ${tokenUrl} failed with status ${response.status} ${response.statusText}` +
      (body ? `: ${body}` : ''),
    );
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error(`OAuth2 token response from ${tokenUrl} did not contain an access_token.`);
  }

  const lifetimeMs = (data.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0),
  });

  logger.debug('Fetched new OAuth2 client-credentials token', { tokenUrl });

  return data.access_token;
}

/**
 * Construct an HttpDestination from local environment variables when running
 * outside of BTP (i.e. no VCAP_SERVICES).
 *
 * Fetches an OAuth2 client-credentials token (cached until shortly before
 * expiry) and attaches it as an Authorization header on the destination.
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

  const accessToken = await fetchClientCredentialsToken(tokenUrl, clientId, clientSecret);

  logger.info('Destination resolved via local fallback', {
    destinationName,
    baseUrl: normalizedBaseUrl,
  });

  // The Authorization header on the destination takes precedence over the
  // authentication type, so the SDK uses the token as-is.
  return {
    url: normalizedBaseUrl,
    authentication: 'NoAuthentication',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
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
 *    `{PREFIX}_CLIENT_SECRET`) are used to fetch an OAuth2 client-credentials
 *    token (cached until shortly before expiry) that is attached to the
 *    constructed Destination as an Authorization header.
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
