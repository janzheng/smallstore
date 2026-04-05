/**
 * Environment Variable Utilities for Standalone Operation
 *
 * Cross-runtime support for Deno and Node.js environments.
 * This replaces the dependency on core/runner/config.ts
 */

// Runtime detection
const isDeno = typeof Deno !== 'undefined';

/**
 * Get environment variable (cross-runtime)
 * Works in both Deno and Node.js
 */
export function getEnv(key: string): string | undefined {
  if (isDeno) {
    try {
      return Deno.env.get(key);
    } catch (e) {
      if (e instanceof Deno.errors.PermissionDenied) {
        // Permission denied — can't read env var; distinguishable from "not set"
        // only at debug level since callers treat both as undefined
        console.debug(`[smallstore] env permission denied for "${key}"`);
      }
      return undefined;
    }
  }
  // Node.js or other runtime
  // @ts-ignore - process may not exist in Deno types
  return typeof process !== 'undefined' ? process?.env?.[key] : undefined;
}

/**
 * Get environment variable with default value
 */
export function getEnvOrDefault(key: string, defaultValue: string): string {
  return getEnv(key) ?? defaultValue;
}

/**
 * Check if environment variable is set and non-empty
 */
export function hasEnv(key: string): boolean {
  const value = getEnv(key);
  return value !== undefined && value !== '';
}

/**
 * Get required environment variable (throws if not set)
 */
export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}
