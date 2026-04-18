/**
 * Retry-aware fetch wrapper
 *
 * Drop-in replacement for fetch() that retries on transient HTTP errors
 * (429 rate limit, 5xx server errors) with exponential backoff.
 * Respects Retry-After headers.
 */

import { retry, isRetryableError, type RetryOptions } from './retry.ts';

/**
 * HTTP error thrown when a fetch response is not OK.
 * Carries status code and optional Retry-After delay for the retry system.
 */
export class HttpError extends Error {
  status: number;
  statusText: string;
  retryAfterMs?: number;

  constructor(status: number, statusText: string, retryAfterMs?: number) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusCode = status; // Alias for isRetryableError compatibility
    this.statusText = statusText;
    this.retryAfterMs = retryAfterMs;
  }

  // Alias so isRetryableError() can check either .status or .statusCode
  statusCode: number;
}

/**
 * Parse Retry-After header value to milliseconds.
 * Supports both seconds (integer) and HTTP-date formats.
 */
export function parseRetryAfter(value: string): number | undefined {
  if (!value) return undefined;

  // Try as integer seconds first
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.max(0, delayMs);
  }

  return undefined;
}

export interface RetryFetchOptions extends RetryOptions {
  /** Set to false to disable retry entirely (default: enabled) */
  enabled?: boolean;
}

/**
 * Fetch with automatic retry on transient failures.
 *
 * Retries on:
 * - 429 Too Many Requests (respects Retry-After header)
 * - 5xx Server Errors
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 *
 * Does NOT retry on:
 * - 4xx Client Errors (except 429)
 * - Successful responses (2xx, 3xx)
 *
 * @param url - URL to fetch
 * @param init - Standard fetch RequestInit options
 * @param retryOptions - Retry configuration (or pass enabled:false to skip)
 * @returns Response on success
 * @throws HttpError on non-retryable failure or retry exhaustion
 */
export async function retryFetch(
  url: string | URL,
  init?: RequestInit,
  retryOptions?: RetryFetchOptions
): Promise<Response> {
  if (retryOptions?.enabled === false) {
    return fetch(url, init);
  }

  return retry(
    async () => {
      const response = await fetch(url, init);
      // 304 Not Modified is a valid conditional-request response, not an error.
      // Let callers using If-None-Match / If-Modified-Since handle it.
      if (!response.ok && response.status !== 304) {
        // Extract Retry-After header before consuming body
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : undefined;

        // Consume body to prevent resource leak
        await response.text().catch(() => {});

        throw new HttpError(response.status, response.statusText, retryAfterMs);
      }
      return response;
    },
    {
      maxRetries: retryOptions?.maxRetries ?? 3,
      initialDelay: retryOptions?.initialDelay ?? 1000,
      maxDelay: retryOptions?.maxDelay ?? 30000,
      backoffMultiplier: retryOptions?.backoffMultiplier ?? 2,
      isRetryable: retryOptions?.isRetryable ?? isRetryableError,
      onRetry: retryOptions?.onRetry ?? ((attempt, error, delay) => {
        console.warn(
          `[RetryFetch] Attempt ${attempt} failed: ${error.message}. ` +
          `Retrying in ${delay}ms...`
        );
      }),
      getDelayOverride: (err) => err.retryAfterMs,
    }
  );
}
