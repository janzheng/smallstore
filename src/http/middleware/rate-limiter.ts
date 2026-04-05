/**
 * Rate Limiting Middleware for Smallstore HTTP
 *
 * Per-IP sliding window rate limiter with separate limits for
 * read vs write operations. Stops abusive bot traffic before
 * it hits storage adapters.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { rateLimiter } from '@smallstore/http/middleware/rate-limiter.ts';
 *
 * const app = new Hono();
 * app.use('*', rateLimiter({ maxRequests: 100, maxWrite: 20 }));
 * ```
 */

import type { Context, MiddlewareHandler } from 'hono';

// ============================================================================
// Configuration
// ============================================================================

export interface RateLimitConfig {
  /** Enable rate limiting (default: true) */
  enabled?: boolean;

  /** Sliding window size in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;

  /** Max read requests (GET/HEAD) per window per IP (default: 100) */
  maxRequests?: number;

  /** Max write requests (POST/PUT/PATCH/DELETE) per window per IP (default: 20) */
  maxWrite?: number;

  /** Cleanup interval in milliseconds (default: 120000 = 2 minutes) */
  cleanupInterval?: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  enabled: true,
  windowMs: 60_000,
  maxRequests: 100,
  maxWrite: 20,
  cleanupInterval: 120_000,
};

// ============================================================================
// Rate Limiter Store
// ============================================================================

interface BucketEntry {
  timestamps: number[];
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Rate limiter store with per-IP sliding window tracking.
 */
export class RateLimiterStore {
  private buckets = new Map<string, BucketEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private blocked = 0;
  private allowed = 0;

  constructor(private config: Required<RateLimitConfig>) {
    if (config.cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), config.cleanupInterval);
      if (typeof Deno !== 'undefined') {
        Deno.unrefTimer(this.cleanupTimer as number);
      }
    }
  }

  /** Extract client IP from request headers */
  static getClientIP(headers: Record<string, string>): string {
    return (
      headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      headers['x-real-ip'] ||
      'unknown'
    );
  }

  /**
   * Check if a request should be allowed.
   * Returns { allowed, remaining, retryAfter }
   */
  check(ip: string, isWrite: boolean): {
    allowed: boolean;
    limit: number;
    remaining: number;
    retryAfterSeconds: number;
    resetAt: number;
  } {
    const limit = isWrite ? this.config.maxWrite : this.config.maxRequests;
    const bucketKey = isWrite ? `w:${ip}` : `r:${ip}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.buckets.get(bucketKey);
    if (!entry) {
      entry = { timestamps: [] };
      this.buckets.set(bucketKey, entry);
    }

    // Prune timestamps outside window, then check limit, then push — all synchronous
    // with no awaits in between. This is safe in single-threaded JS because the entire
    // prune-check-push sequence runs in a single microtask with no yield points, so no
    // other call to check() can interleave between these operations.
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    if (entry.timestamps.length >= limit) {
      this.blocked++;
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + this.config.windowMs - now;
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        resetAt: Math.ceil((now + retryAfterMs) / 1000),
      };
    }

    // Record this request
    entry.timestamps.push(now);
    this.allowed++;

    return {
      allowed: true,
      limit,
      remaining: limit - entry.timestamps.length,
      retryAfterSeconds: 0,
      resetAt: Math.ceil((now + this.config.windowMs) / 1000),
    };
  }

  /** Remove stale buckets */
  cleanup(): number {
    const cutoff = Date.now() - this.config.windowMs;
    let removed = 0;
    for (const [key, entry] of this.buckets) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Get stats */
  getStats(): {
    activeBuckets: number;
    allowed: number;
    blocked: number;
    blockRate: number;
  } {
    return {
      activeBuckets: this.buckets.size,
      allowed: this.allowed,
      blocked: this.blocked,
      blockRate: this.allowed + this.blocked > 0
        ? this.blocked / (this.allowed + this.blocked)
        : 0,
    };
  }

  /** Stop cleanup timer */
  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Hono middleware for per-IP rate limiting.
 *
 * - Separate limits for read (GET/HEAD) and write (POST/PUT/PATCH/DELETE) operations
 * - Sliding window per IP
 * - Returns 429 Too Many Requests when limit exceeded
 * - Sets X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After headers
 *
 * Returns the middleware function AND the store for stats/manual control.
 */
export function rateLimiter(userConfig: RateLimitConfig = {}): {
  middleware: (c: Context, next: () => Promise<void>) => Promise<void | Response>;
  store: RateLimiterStore;
} {
  const config: Required<RateLimitConfig> = { ...DEFAULT_CONFIG, ...userConfig };
  const store = new RateLimiterStore(config);

  const middleware = async (c: Context, next: () => Promise<void>) => {
    if (!config.enabled) {
      await next();
      return;
    }

    const ip = RateLimiterStore.getClientIP(
      Object.fromEntries(c.req.raw.headers.entries())
    );
    const isWrite = WRITE_METHODS.has(c.req.method.toUpperCase());
    const result = store.check(ip, isWrite);

    // Always set rate limit headers
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json(
        { error: 'Too many requests', retryAfter: result.retryAfterSeconds },
        429,
      );
    }

    await next();
  };

  return { middleware, store };
}

/**
 * Simple version that returns just the middleware function.
 * The returned function has a `destroy()` method to stop the cleanup timer.
 */
export function rateLimiterMiddleware(config: RateLimitConfig = {}): MiddlewareHandler & { destroy: () => void } {
  const { middleware, store } = rateLimiter(config);
  const fn = middleware as typeof middleware & { destroy: () => void };
  fn.destroy = () => store.destroy();
  return fn;
}
