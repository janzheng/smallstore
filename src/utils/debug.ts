/**
 * Debug logger for smallstore — gated behind SMALLSTORE_DEBUG env var.
 *
 * Usage:
 *   import { debug } from '../utils/debug.ts';
 *   debug('[Adapter]', 'doing something', value);
 *
 * Enable:  SMALLSTORE_DEBUG=1 deno task serve
 * Disable: (default) — all debug() calls are no-ops
 *
 * console.warn and console.error are never suppressed.
 */

let _enabled: boolean | null = null;

function isEnabled(): boolean {
  if (_enabled !== null) return _enabled;
  try {
    const val = Deno.env.get('SMALLSTORE_DEBUG');
    _enabled = val === '1' || val === 'true';
  } catch {
    // Deno.env not available (e.g. restricted permissions)
    _enabled = false;
  }
  return _enabled;
}

/** Debug log — only prints when SMALLSTORE_DEBUG=1 */
export function debug(...args: unknown[]): void {
  if (isEnabled()) console.log(...args);
}

/** Always log — for important operational messages (startup, commit, etc.) */
export function info(...args: unknown[]): void {
  console.log(...args);
}

/** Reset cached state (for testing) */
export function _resetDebug(): void {
  _enabled = null;
}
