import { logger } from '../utils/logger.js';
import { ODataApiError } from './odata-error.js';

/**
 * Configuration options for the retry utility.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 2). */
  maxRetries?: number;
  /** Base delay in milliseconds before the first retry (default: 1000). */
  baseDelayMs?: number;
  /** HTTP status codes that are eligible for retry (default: [408, 429, 502, 503, 504]). */
  retryableStatuses?: number[];
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_RETRYABLE_STATUSES = [408, 429, 502, 503, 504];

/**
 * Determine whether an error is a transient failure that may succeed on retry.
 *
 * - ODataApiError: retried only when its HTTP status is in the retryable set.
 * - TypeError / errors with code ECONNRESET, ENOTFOUND, ETIMEDOUT, etc.:
 *   treated as network errors and always retried.
 * - All other errors (including 400, 401, 403, 404) are **not** retried.
 */
function isRetryable(error: unknown, retryableStatuses: number[]): boolean {
  if (error instanceof ODataApiError) {
    return retryableStatuses.includes(error.httpStatus);
  }

  // Network-level errors thrown by Node's fetch / http layer
  if (error instanceof TypeError) {
    // fetch() throws TypeError for network failures (e.g. DNS, connection refused)
    return true;
  }

  // Node.js system errors carry a `code` property
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  ) {
    const code = (error as NodeJS.ErrnoException).code;
    const networkCodes = [
      'ECONNRESET',
      'ECONNABORTED',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EPIPE',
      'EAI_AGAIN',
    ];
    return networkCodes.includes(code!);
  }

  return false;
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an asynchronous operation with exponential-backoff retry logic.
 *
 * Retries are attempted only for transient / retryable errors (specific HTTP
 * status codes and network failures). Client errors such as 400, 401, 403,
 * and 404 are thrown immediately without retry.
 *
 * @param operation - An async function that returns a promise.
 * @param options   - Optional retry configuration.
 * @returns The resolved value of the operation.
 *
 * @example
 * ```typescript
 * const result = await withRetry(() => odataClient.get('/api/resource'), {
 *   maxRetries: 3,
 *   baseDelayMs: 500,
 * });
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const retryableStatuses =
    options?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      // If this was the last allowed attempt, don't evaluate retryability
      if (attempt === maxRetries) {
        break;
      }

      if (!isRetryable(error, retryableStatuses)) {
        // Non-retryable error — throw immediately
        throw error;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.warn('Retryable error encountered; scheduling retry', {
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: errorMessage,
      });

      await sleep(delayMs);
    }
  }

  // All retries exhausted — throw the last error
  throw lastError;
}
