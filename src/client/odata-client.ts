import { executeHttpRequest, type HttpResponse } from '@sap-cloud-sdk/http-client';
import type { HttpDestinationOrFetchOptions } from '@sap-cloud-sdk/connectivity';
import { logger } from '../utils/logger.js';
import { parseODataError } from './odata-error.js';

/**
 * Response body that is neither JSON nor valid UTF-8 text (e.g. an iflow zip
 * from `.../$value`), returned base64-encoded so no byte is lost.
 */
export interface BinaryResponseBody {
  contentType: string;
  encoding: 'base64';
  size: number;
  data: string;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function toBuffer(data: unknown): Buffer | undefined {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function contentTypeOf(response: { headers?: Record<string, unknown> }): string {
  return String(response.headers?.['content-type'] ?? '');
}

/**
 * Decode a raw response body by its content: JSON content types are parsed
 * (falling back to the raw text if parsing fails); any other body is returned
 * as text when it is valid UTF-8, since content types alone miss text payloads
 * such as Groovy scripts served as `application/vnd.sap.integration.groovyscript`.
 * Everything else is returned as a {@link BinaryResponseBody}.
 */
export function decodeResponseBody(data: unknown, contentType: string): unknown {
  const bytes = toBuffer(data);
  if (!bytes) return data;

  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    const text = bytes.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  try {
    return strictUtf8.decode(bytes);
  } catch {
    const envelope: BinaryResponseBody = {
      contentType: contentType || 'application/octet-stream',
      encoding: 'base64',
      size: bytes.length,
      data: bytes.toString('base64'),
    };
    return envelope;
  }
}

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
    logger.debug('OData GET', { url: `${this.pathPrefix}/${path}` });
    const response = await this.getRaw(path, { Accept: 'application/json' });
    return decodeResponseBody(response.data, contentTypeOf(response)) as T;
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
      logger.debug('OData execute GET', { url: `${this.pathPrefix}/${path}` });
      const response = await this.getRaw(path, { Accept: 'application/json', ...extraHeaders }, jwt);

      if (response.status === 204) {
        return undefined;
      }

      return decodeResponseBody(response.data, contentTypeOf(response));
    }

    // Mutating request — SDK handles CSRF token automatically
    return this.mutatingRequest(upperMethod, path, body, extraHeaders, jwt);
  }

  /**
   * GET raw binary content (for downloading artifact resources, log files, etc.).
   * Returns the response as a Buffer with its content type.
   */
  async getBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
    logger.debug('OData GET binary', { url: `${this.pathPrefix}/${path}` });
    const response = await this.getRaw(path, {});

    return {
      data: toBuffer(response.data) ?? Buffer.alloc(0),
      contentType: contentTypeOf(response) || 'application/octet-stream',
    };
  }

  /**
   * GET without CSRF handling, keeping the response body as raw bytes.
   * Without `responseType: 'arraybuffer'` axios decodes every body as UTF-8,
   * irreversibly replacing invalid byte sequences in binary content.
   */
  private async getRaw(
    path: string,
    headers: Record<string, string>,
    jwt?: string,
  ): Promise<HttpResponse> {
    try {
      const destination = await this.getDestination(jwt);
      return await executeHttpRequest(destination, {
        method: 'GET',
        url: `${this.pathPrefix}/${path}`,
        headers,
        responseType: 'arraybuffer',
        signal: AbortSignal.timeout(this.timeout),
      }, { fetchCsrfToken: false });
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
        responseType: 'arraybuffer',
        signal: AbortSignal.timeout(this.timeout),
      }, this.csrfProtected ? undefined : { fetchCsrfToken: false });

      // Some operations (DELETE, PATCH) return 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return decodeResponseBody(response.data, contentTypeOf(response)) as T;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Convert SDK/axios errors into ODataApiError for consistent error handling.
   * Error bodies arrive as raw bytes (all requests use `arraybuffer`), so they
   * are decoded to text before the OData error is parsed.
   */
  private handleError(error: unknown): unknown {
    const response = (error as { response?: { status?: number; data?: unknown } })?.response;
    if (response?.status) {
      const bytes = toBuffer(response.data);
      return parseODataError(response.status, bytes ? bytes.toString('utf8') : response.data);
    }
    return error;
  }
}
