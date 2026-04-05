/**
 * Cache Headers Middleware for Smallstore HTTP
 *
 * Adds Cache-Control, ETag, and conditional request (304 Not Modified)
 * handling to GET responses. This is the outermost caching layer —
 * browsers and CDNs cache responses so repeat requests never hit the server.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { cacheHeaders } from '@smallstore/http/middleware/cache-headers.ts';
 *
 * const app = new Hono();
 * app.use('*', cacheHeaders({ defaultMaxAge: 120 }));
 * ```
 */

import type { Context } from 'hono';
import { simpleHash } from '../../utils/cache-key.ts';

// ============================================================================
// Configuration
// ============================================================================

export interface CacheHeadersConfig {
  /** Enable cache headers (default: true) */
  enabled?: boolean;

  /** Default max-age in seconds for Cache-Control (default: 60) */
  defaultMaxAge?: number;

  /** stale-while-revalidate directive in seconds (default: 300) */
  swrSeconds?: number;

  /** Route-specific max-age overrides. Keys are path patterns (substring match). */
  routeTTLs?: Record<string, number>;

  /** Use Cache-Control: private instead of public (default: false) */
  private?: boolean;
}

const DEFAULT_CONFIG: Required<CacheHeadersConfig> = {
  enabled: true,
  defaultMaxAge: 60,
  swrSeconds: 300,
  routeTTLs: {},
  private: false,
};

/** Paths that should never have cache headers (mutations are handled separately) */
const LONG_CACHE_PATTERNS = [
  '/collections',
  '/metadata',
  '/schema',
  '/namespaces',
  '/tree',
  '/views',
];

const SHORT_CACHE_PATTERNS = [
  '/search',
  '/query',
  '/pipeline',
];

// ============================================================================
// Middleware
// ============================================================================

/**
 * Resolve the max-age for a given path.
 *
 * Priority: routeTTLs config > pattern-based defaults > defaultMaxAge
 */
function resolveMaxAge(path: string, config: Required<CacheHeadersConfig>): number {
  // Check explicit route TTL overrides first
  for (const [pattern, ttl] of Object.entries(config.routeTTLs)) {
    if (path.includes(pattern)) {
      return ttl;
    }
  }

  // Pattern-based defaults
  for (const pattern of LONG_CACHE_PATTERNS) {
    if (path.includes(pattern)) {
      return 300; // 5 minutes for stable data
    }
  }

  for (const pattern of SHORT_CACHE_PATTERNS) {
    if (path.includes(pattern)) {
      return 30; // 30 seconds for dynamic data
    }
  }

  return config.defaultMaxAge;
}

/**
 * Compute ETag from response body.
 *
 * Uses FNV-1a hash (fast, good distribution). The ETag is a weak validator
 * since JSON serialization order may vary.
 */
function computeETag(body: unknown): string {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return `W/"${simpleHash(serialized)}"`;
}

/**
 * Hono middleware that adds Cache-Control, ETag, and 304 support to GET responses.
 *
 * - Sets `Cache-Control: public, max-age=X, stale-while-revalidate=Y` on GET 200 responses
 * - Sets `ETag` header with FNV-1a hash of response body
 * - Returns 304 Not Modified when `If-None-Match` matches the ETag
 * - Skips mutation methods (POST, PUT, PATCH, DELETE)
 * - Sets `Vary: Accept, Accept-Encoding` for correct CDN keying
 */
export function cacheHeaders(userConfig: CacheHeadersConfig = {}) {
  const config: Required<CacheHeadersConfig> = { ...DEFAULT_CONFIG, ...userConfig };

  return async (c: Context, next: () => Promise<void>) => {
    if (!config.enabled) {
      await next();
      return;
    }

    // Only cache GET/HEAD requests
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      // Set no-store on mutation responses
      await next();
      c.header('Cache-Control', 'no-store');
      return;
    }

    // Get the If-None-Match header before calling handler
    const ifNoneMatch = c.req.header('if-none-match');

    // Execute the handler
    await next();

    // Only add cache headers to successful responses
    const status = c.res.status;
    if (status < 200 || status >= 300) {
      return;
    }

    // Compute ETag from response body
    // We need to clone the response to read the body without consuming it
    const cloned = c.res.clone();
    let body: unknown;
    try {
      body = await cloned.json();
    } catch {
      // Non-JSON response, skip caching headers
      return;
    }

    const etag = computeETag(body);

    // Check If-None-Match for conditional request
    if (ifNoneMatch) {
      // Handle multiple ETags: If-None-Match: "abc", "def"
      const clientETags = ifNoneMatch.split(',').map(t => t.trim());
      if (clientETags.includes(etag) || clientETags.includes('*')) {
        // Content hasn't changed — return 304
        // Copy all original response headers, then override status and remove body
        const headers = new Headers(c.res.headers);
        headers.set('ETag', etag);
        c.res = new Response(null, { status: 304, headers });
        return;
      }
    }

    // Set caching headers
    const maxAge = resolveMaxAge(c.req.path, config);
    const visibility = config.private ? 'private' : 'public';
    const cacheControl = `${visibility}, max-age=${maxAge}, stale-while-revalidate=${config.swrSeconds}`;

    c.header('Cache-Control', cacheControl);
    c.header('ETag', etag);
    c.header('Vary', 'Accept, Accept-Encoding');
  };
}
