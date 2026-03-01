import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import { logger } from '../utils/logger.js';
import { parseODataError } from './odata-error.js';

/**
 * Base OData V2 HTTP client for SAP Cloud Integration APIs.
 *
 * Uses the SAP Cloud SDK's `executeHttpRequest` which handles:
 * - Destination-based authentication (OAuth2, etc.)
 * - CSRF token management for mutating operations
 * - OData error parsing with structured error messages
 */
export class ODataClient {
  constructor(
    private readonly getDestination: (jwt?: string) => Promise<HttpDestinationOrFetchOptions>,
    private readonly pathPrefix: string = '/api/v1',
    private readonly timeout: number = 60000,
    private readonly csrfProtected: boolean = true,
  ) {}

  /**
   * GET an OData entity collection or single entity.
   *
   * @param path - Relative path (may include query string), e.g. "IntegrationPackages" or "IntegrationPackages('MyPkg')?$select=Id,Name"
   */
  async get<T>(path: string): Promise<T> {
    const url = `${this.pathPrefix}/${path}`;
    logger.debug('OData GET', { url });

    try {
      const destination = await this.getDestination();
      const response = await executeHttpRequest(destination, {
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      }, { fetchCsrfToken: false });

      return response.data as T;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * POST to create a new OData entity or trigger an action.
   */
  async post<T>(path: string, data?: Record<string, unknown>): Promise<T> {
    return this.mutatingRequest<T>('POST', path, data);
  }

  /**
   * PATCH to update an existing OData entity (partial update).
   */
  async patch(path: string, data: Record<string, unknown>): Promise<void> {
    await this.mutatingRequest('PATCH', path, data);
  }

  /**
   * PUT to fully replace an existing OData entity.
   */
  async put(path: string, data: Record<string, unknown>): Promise<void> {
    await this.mutatingRequest('PUT', path, data);
  }

  /**
   * DELETE an OData entity.
   */
  async delete(path: string): Promise<void> {
    await this.mutatingRequest('DELETE', path);
  }

  /**
   * Generic execute method — thin proxy for any OData request.
   *
   * The caller provides a pre-built path (which may already include query params)
   * and the HTTP method. For GET requests no CSRF token is needed; mutating
   * requests go through the SDK's automatic CSRF token flow.
   *
   * @param method - HTTP method (GET, POST, PATCH, PUT, DELETE)
   * @param path   - Relative path, may include query string
   * @param body   - Optional request body for POST/PATCH/PUT
   * @param extraHeaders - Optional additional HTTP headers
   */
  async execute(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    jwt?: string,
  ): Promise<unknown> {
    const upperMethod = method.toUpperCase();

    if (upperMethod === 'GET') {
      const url = `${this.pathPrefix}/${path}`;
      logger.debug('OData execute GET', { url });

      try {
        const destination = await this.getDestination(jwt);
        const response = await executeHttpRequest(destination, {
          method: 'GET',
          url,
          headers: {
            Accept: 'application/json',
            ...extraHeaders,
          },
          signal: AbortSignal.timeout(this.timeout),
        }, { fetchCsrfToken: false });

        if (response.status === 204) {
          return undefined;
        }

        return response.data;
      } catch (error: unknown) {
        throw this.handleError(error);
      }
    }

    // Mutating request — SDK handles CSRF token automatically
    return this.mutatingRequest(upperMethod, path, body, extraHeaders, jwt);
  }

  /**
   * GET raw binary content (for downloading artifact resources, log files, etc.).
   * Returns the response as a Buffer with its content type.
   */
  async getBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
    const url = `${this.pathPrefix}/${path}`;
    logger.debug('OData GET binary', { url });

    try {
      const destination = await this.getDestination();
      const response = await executeHttpRequest(destination, {
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        signal: AbortSignal.timeout(this.timeout),
      }, { fetchCsrfToken: false });

      const contentType = response.headers?.['content-type'] ?? 'application/octet-stream';

      return {
        data: Buffer.from(response.data as ArrayBuffer),
        contentType,
      };
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Execute a mutating request (POST, PUT, PATCH, DELETE).
   * The SDK handles CSRF token fetching, caching, and retry automatically.
   */
  private async mutatingRequest<T>(
    method: string,
    path: string,
    data?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    jwt?: string,
  ): Promise<T> {
    const url = `${this.pathPrefix}/${path}`;
    logger.debug(`OData ${method}`, { url });

    try {
      const destination = await this.getDestination(jwt);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...extraHeaders,
      };

      if (data) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await executeHttpRequest(destination, {
        method: method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url,
        data,
        headers,
        signal: AbortSignal.timeout(this.timeout),
      }, this.csrfProtected ? undefined : { fetchCsrfToken: false });

      // Some operations (DELETE, PATCH) return 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return response.data as T;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Convert SDK/axios errors into ODataApiError for consistent error handling.
   */
  private handleError(error: unknown): unknown {
    const response = (error as { response?: { status?: number; data?: unknown } })?.response;
    if (response?.status) {
      return parseODataError(response.status, response.data);
    }
    return error;
  }
}
