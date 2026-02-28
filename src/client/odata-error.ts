import type { ODataError } from '../types/odata.js';

/**
 * Structured error thrown when an OData API call fails.
 */
export class ODataApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly odataCode?: string,
    public readonly odataMessage?: string,
  ) {
    super(message);
    this.name = 'ODataApiError';
  }
}

/**
 * Parse an OData V2 error response and return a structured ODataApiError.
 *
 * Accepts either a pre-parsed object (from axios/SDK response) or a raw
 * JSON string (legacy compatibility).
 *
 * SAP Cloud Integration returns errors in the format:
 * ```json
 * {
 *   "error": {
 *     "code": "Not Found",
 *     "message": { "lang": "en", "value": "Integration package not found" }
 *   }
 * }
 * ```
 */
export function parseODataError(
  httpStatus: number,
  responseData: unknown,
): ODataApiError {
  if (!responseData) {
    return new ODataApiError(
      `OData API request failed with HTTP ${httpStatus}`,
      httpStatus,
    );
  }

  // If already a parsed object (e.g. from axios), extract OData error fields directly
  if (typeof responseData === 'object') {
    const parsed = responseData as ODataError;
    const code = parsed.error?.code;
    const message = parsed.error?.message?.value;

    return new ODataApiError(
      message ?? `OData API request failed with HTTP ${httpStatus}`,
      httpStatus,
      code,
      message,
    );
  }

  // If string, try JSON.parse
  if (typeof responseData === 'string') {
    try {
      const parsed = JSON.parse(responseData) as ODataError;
      const code = parsed.error?.code;
      const message = parsed.error?.message?.value;

      return new ODataApiError(
        message ?? `OData API request failed with HTTP ${httpStatus}`,
        httpStatus,
        code,
        message,
      );
    } catch {
      // Response body is not valid JSON — return raw text in the error
      return new ODataApiError(
        `OData API request failed with HTTP ${httpStatus}: ${responseData.substring(0, 500)}`,
        httpStatus,
      );
    }
  }

  return new ODataApiError(
    `OData API request failed with HTTP ${httpStatus}`,
    httpStatus,
  );
}
