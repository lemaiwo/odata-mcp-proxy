// =============================================================================
// BTP Destination Service
//
// Resolves a BTP destination by name, returning an HttpDestination that can be
// passed directly to the SAP Cloud SDK's executeHttpRequest().
//
// Resolution strategy:
//   1. If running on BTP (VCAP_SERVICES present), use @sap-cloud-sdk/connectivity
//      to resolve the named destination from the Destination Service.
//   2. If running locally (no VCAP_SERVICES), fall back to environment variables
//      and construct a Destination with OAuth2ClientCredentials auth type.
//      The SDK handles token fetch/cache/refresh automatically.
// =============================================================================

import type { HttpDestination, HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import { logger } from '../utils/logger.js';

// -----------------------------------------------------------------------------
// Local OAuth2 client-credentials fallback
// -----------------------------------------------------------------------------

/**
 * Construct an HttpDestination from local environment variables when running
 * outside of BTP (i.e. no VCAP_SERVICES).
 *
 * The SDK's executeHttpRequest handles the OAuth2 client-credentials token
 * fetch, caching, and refresh automatically when `authentication`,
 * `tokenServiceUrl`, `clientId`, and `clientSecret` are set on the destination.
 *
 * Required environment variables:
 *  - SAP_CPI_BASE_URL     - Base URL of the Cloud Integration tenant
 *  - SAP_CPI_TOKEN_URL    - OAuth2 token endpoint URL
 *  - SAP_CPI_CLIENT_ID    - OAuth2 client ID
 *  - SAP_CPI_CLIENT_SECRET - OAuth2 client secret
 */
function resolveLocal(destinationName: string): HttpDestination {
  logger.info('VCAP_SERVICES not found; using local environment variable fallback', {
    destinationName,
  });

  const baseUrl = process.env.SAP_CPI_BASE_URL;
  const tokenUrl = process.env.SAP_CPI_TOKEN_URL;
  const clientId = process.env.SAP_CPI_CLIENT_ID;
  const clientSecret = process.env.SAP_CPI_CLIENT_SECRET;

  if (!baseUrl) {
    throw new Error(
      'Local fallback: SAP_CPI_BASE_URL environment variable is not set. ' +
      'Provide the base URL of your Cloud Integration tenant (e.g. https://tenant.it-cpi018.cfapps.eu10.hana.ondemand.com).',
    );
  }
  if (!tokenUrl) {
    throw new Error(
      'Local fallback: SAP_CPI_TOKEN_URL environment variable is not set. ' +
      'Provide the OAuth2 token endpoint URL (e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token).',
    );
  }
  if (!clientId) {
    throw new Error(
      'Local fallback: SAP_CPI_CLIENT_ID environment variable is not set. ' +
      'Provide the OAuth2 client ID for your Cloud Integration service key.',
    );
  }
  if (!clientSecret) {
    throw new Error(
      'Local fallback: SAP_CPI_CLIENT_SECRET environment variable is not set. ' +
      'Provide the OAuth2 client secret for your Cloud Integration service key.',
    );
  }

  // Strip any trailing slash from the base URL for consistent usage downstream
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  logger.info('Destination resolved via local fallback', {
    destinationName,
    baseUrl: normalizedBaseUrl,
  });

  return {
    url: normalizedBaseUrl,
    authentication: 'OAuth2ClientCredentials',
    tokenServiceUrl: tokenUrl,
    clientId,
    clientSecret,
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
 *    (`SAP_CPI_BASE_URL`, `SAP_CPI_TOKEN_URL`, `SAP_CPI_CLIENT_ID`,
 *    `SAP_CPI_CLIENT_SECRET`) are used to construct a Destination with
 *    OAuth2ClientCredentials authentication. The SDK handles token
 *    fetch, caching, and refresh automatically.
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
      return { destinationName, jwt, useCache: true } as HttpDestinationOrFetchOptions;
    }

    return resolveLocal(destinationName);
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
