/**
 * Airtable API Client
 * 
 * Base HTTP client for the Airtable REST API.
 * Handles authentication, rate limiting, retries, and error handling.
 */

import type {
  AirtableClientConfig,
  RequestOptions,
  RateLimitInfo,
  AirtableError,
} from "./types.ts";

import { retry } from '../../utils/retry.ts';
import type { RetryOptions } from '../../utils/retry.ts';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Partial<AirtableClientConfig> = {
  baseUrl: 'https://api.airtable.com/v0',
  timeout: 30000,
  retryOnRateLimit: true,
  maxRetries: 3,
};

/**
 * Airtable API Client
 * 
 * Base client for making authenticated requests to Airtable API.
 */
export class AirtableClient {
  private config: Required<AirtableClientConfig>;
  private rateLimitInfo: RateLimitInfo | null = null;

  constructor(config: AirtableClientConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as Required<AirtableClientConfig>;
  }

  /**
   * Get current rate limit information
   */
  getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  /**
   * Make an authenticated request to the Airtable API
   */
  async request<T>(
    path: string,
    options: RequestOptions = { method: 'GET' }
  ): Promise<T> {
    // Use custom base URL if provided, otherwise use default
    const opts = options as RequestOptions & { customBaseUrl?: string };
    const baseUrl = opts.customBaseUrl || this.config.baseUrl;
    const url = `${baseUrl}${path}`;
    const headers = this.buildHeaders(options.headers);

    // Track the last Retry-After value seen (used by getDelayOverride)
    let lastRetryAfterMs: number | undefined;

    const retryOpts: RetryOptions = {
      maxRetries: this.config.maxRetries,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      isRetryable: (error: any) => {
        // Rate limit: only retry if config allows it
        if (error instanceof AirtableApiError && error.statusCode === 429) {
          return this.config.retryOnRateLimit;
        }
        if (error instanceof AirtableApiError) {
          return this.isRetryableError(error);
        }
        // Network errors are retryable
        return true;
      },
      getDelayOverride: (_error: any) => {
        // Respect Retry-After header if present
        if (lastRetryAfterMs !== undefined) {
          const delay = lastRetryAfterMs;
          lastRetryAfterMs = undefined;
          return delay;
        }
        return undefined;
      },
    };

    return retry(async () => {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout
      );

      // Determine body content
      const reqOpts = options as RequestOptions & { rawBody?: string };
      let bodyContent: string | undefined;
      if (reqOpts.rawBody) {
        bodyContent = reqOpts.rawBody;
      } else if (options.body) {
        bodyContent = JSON.stringify(options.body);
      }

      const response = await fetch(url, {
        method: options.method,
        headers,
        body: bodyContent,
        signal: options.signal || controller.signal,
      });

      clearTimeout(timeoutId);

      // Update rate limit info from headers
      this.updateRateLimitInfo(response);

      // Handle rate limiting
      if (response.status === 429) {
        lastRetryAfterMs = this.getRetryAfterDelay(response);
        throw new AirtableApiError(
          'RATE_LIMITED',
          'Rate limit exceeded',
          response.status
        );
      }

      // Handle other HTTP errors
      if (!response.ok) {
        const errorData = await this.parseErrorResponse(response);
        throw new AirtableApiError(
          errorData.error.type || 'UNKNOWN_ERROR',
          errorData.error.message || 'An unknown error occurred',
          response.status,
          errorData
        );
      }

      // Parse successful response
      const data = await response.json();
      return data as T;
    }, retryOpts);
  }

/**
 * Make a GET request
 */
async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const queryString = params ? this.buildQueryString(params) : '';
  const fullPath = queryString ? `${path}?${queryString}` : path;
  return this.request<T>(fullPath, { method: 'GET' });
}

/**
 * Make a GET request to the Meta API
 * 
 * The Meta API uses /v0/meta/... paths, which are already included in the baseUrl.
 * This is a convenience method that clarifies Meta API usage.
 */
async getMeta<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  return this.get<T>(path, params);
}

  /**
   * Make a POST request
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  /**
   * Make a PUT request
   */
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body });
  }

  /**
   * Make a PATCH request
   */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  /**
   * Make a DELETE request
   */
  async delete<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const queryString = params ? this.buildQueryString(params) : '';
    const fullPath = queryString ? `${path}?${queryString}` : path;
    return this.request<T>(fullPath, { method: 'DELETE' });
  }

  /**
   * Build request headers
   */
  private buildHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      ...additionalHeaders,
    };
  }

  /**
   * Build query string from parameters
   */
  private buildQueryString(params: Record<string, unknown>): string {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        // Handle array parameters
        // For 'records' (delete operation), use records[]=value1&records[]=value2
        // For 'sort', 'recordMetadata', use JSON encoding
        // For 'fields', use fields[]=value1&fields[]=value2
        value.forEach((item) => {
          if (typeof item === 'object') {
            // Objects (like sort items) are JSON-encoded
            searchParams.append(key, JSON.stringify(item));
          } else {
            // Simple values use key[]=value format
            searchParams.append(`${key}[]`, String(item));
          }
        });
      } else if (typeof value === 'object') {
        searchParams.append(key, JSON.stringify(value));
      } else {
        searchParams.append(key, String(value));
      }
    }

    return searchParams.toString();
  }

  /**
   * Update rate limit information from response headers
   */
  private updateRateLimitInfo(response: Response): void {
    const limit = response.headers.get('x-ratelimit-limit');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');

    if (limit && remaining && reset) {
      this.rateLimitInfo = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
      };
    }
  }

  /**
   * Get retry delay from response headers
   */
  private getRetryAfterDelay(response: Response): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const delay = parseInt(retryAfter, 10);
      return isNaN(delay) ? 30000 : delay * 1000;
    }
    return 30000; // Default to 30 seconds
  }

  /**
   * Parse error response
   */
  private async parseErrorResponse(response: Response): Promise<AirtableError> {
    try {
      const data = await response.json();
      return data as AirtableError;
    } catch {
      return {
        error: {
          type: 'UNKNOWN_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
        },
      };
    }
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: AirtableApiError): boolean {
    // Retry on network errors, timeouts, and 5xx errors
    if (error.statusCode && error.statusCode >= 500) {
      return true;
    }
    if (error.message.includes('timeout') || error.message.includes('network')) {
      return true;
    }
    return false;
  }

  // NOTE: sleep() removed — retry delays are now handled by retry() from utils/retry.ts
}

/**
 * Custom error class for Airtable API errors
 */
export class AirtableApiError extends Error {
  constructor(
    public type: string,
    message: string,
    public statusCode?: number,
    public response?: AirtableError
  ) {
    super(message);
    this.name = 'AirtableApiError';
  }
}

/**
 * Create a new Airtable API client
 * 
 * @param apiKey - Airtable API key (can use keyResolver)
 * @param config - Additional client configuration
 */
export function createAirtableClient(
  apiKey: string,
  config?: Partial<AirtableClientConfig>
): AirtableClient {
  return new AirtableClient({
    apiKey,
    ...config,
  });
}

/**
 * Create Airtable client from keyResolver context
 * 
 * @param keyResolver - KeyResolver instance
 * @param config - Additional client configuration
 * @returns AirtableClient or null if keys not found
 */
export function createAirtableClientFromResolver(
  keyResolver?: any,
  config?: Partial<AirtableClientConfig>
): AirtableClient | null {
  if (!keyResolver) {
    return null;
  }

  const apiKey = keyResolver.getKey?.('AIRTABLE_PRIVATE_API') || 
                 keyResolver.getKey?.('AIRTABLE_API_KEY');

  if (!apiKey) {
    return null;
  }

  return new AirtableClient({
    apiKey,
    ...config,
  });
}

