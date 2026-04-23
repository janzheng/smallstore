/**
 * Cloudflare Workers Configuration Helper
 * 
 * Automatically loads environment variables for Cloudflare adapters.
 */

// NOTE: dotenv loading is the app's responsibility, not the library's.
// CLI/server entry points should `import "jsr:@std/dotenv@^0.225/load"`
// themselves before calling these helpers. Keeping it here forced the
// load at module init time, which broke the Cloudflare Workers bundle
// (Workers ESM has no `Deno` global; the dotenv module references it).
import { resolveCloudflareWorkersEnv } from '../../../config.ts';

/**
 * Get the Cloudflare Workers URL from environment
 *
 * @returns Worker URL (production or local dev)
 * @throws Error if SM_WORKERS_URL is not set
 */
export function getCloudflareWorkersUrl(): string {
  const url = resolveCloudflareWorkersEnv().baseUrl;
  if (!url) {
    throw new Error(
      'SM_WORKERS_URL not set in environment. ' +
      'Add to .env: SM_WORKERS_URL=https://your-workers.your-subdomain.workers.dev'
    );
  }
  return url;
}

/**
 * Create Cloudflare adapter config with automatic URL loading
 * 
 * @param namespace Optional namespace for the adapter
 * @returns Config object with baseUrl from environment
 * 
 * @example
 * const kvAdapter = createCloudflareKVAdapter({
 *   ...getCloudflareConfig(),
 *   namespace: 'my-app',
 * });
 */
export function getCloudflareConfig(): { baseUrl: string } {
  return {
    baseUrl: getCloudflareWorkersUrl(),
  };
}

