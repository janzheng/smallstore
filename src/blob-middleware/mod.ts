/**
 * Blob Middleware — withBlobs()
 *
 * Wraps a Smallstore instance with automatic blob handling.
 * Detects blob fields in `set()` calls, uploads them to R2,
 * replaces values with platform-formatted URLs, and stores
 * sidecar metadata for cleanup.
 *
 * @example
 * ```ts
 * import { withBlobs } from './blob-middleware/mod.ts';
 *
 * const blobStore = withBlobs(store, {
 *   backend: { type: 'f2-r2', f2Url: 'https://f2.example.com' },
 *   collections: {
 *     'posts/*': [{ field: 'image', targetFormat: 'airtable' }],
 *   },
 * });
 *
 * await blobStore.set('posts/sunset', {
 *   title: 'Sunset',
 *   image: { file: './sunset.jpg' },  // auto-uploaded to R2
 * });
 * ```
 */

import type { Smallstore } from '../types.ts';
import type {
  BlobMiddlewareConfig,
  BlobFieldMapping,
  BlobSidecar,
  TargetFormat,
  SidecarMode,
} from './types.ts';
import { INLINE_SIDECAR_FIELD } from './types.ts';
import { isBlobInput, detectBlobFields } from './detector.ts';
import { BlobResolver } from './resolver.ts';
import { formatForPlatform } from './formats.ts';

// ============================================================================
// Collection Pattern Matching
// ============================================================================

/**
 * Check if a collection path matches a pattern from the config.
 * Supports `*` wildcard at end (e.g. "posts/*" matches "posts/sunset").
 */
function matchesPattern(pattern: string, collectionPath: string): boolean {
  if (pattern === collectionPath) return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return collectionPath.startsWith(prefix + '/') || collectionPath === prefix;
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return collectionPath.startsWith(prefix);
  }
  return false;
}

/**
 * Find the blob field mappings for a given collection path.
 */
function findMappings(
  collections: Record<string, BlobFieldMapping[]>,
  collectionPath: string,
): BlobFieldMapping[] {
  for (const [pattern, mappings] of Object.entries(collections)) {
    if (matchesPattern(pattern, collectionPath)) {
      return mappings;
    }
  }
  return [];
}

// ============================================================================
// Dot-notation helpers
// ============================================================================

/** Get a nested value by dot-notation path */
function getByPath(obj: Record<string, any>, path: string): any {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Set a nested value by dot-notation path */
function setByPath(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ============================================================================
// withBlobs() — Main Middleware Factory
// ============================================================================

/**
 * Wrap a Smallstore instance with blob middleware.
 *
 * Intercepts `set()` to detect and upload blob fields, `delete()` to
 * clean up R2 blobs via sidecar metadata.
 *
 * @param store - The underlying Smallstore instance
 * @param config - Blob middleware configuration
 * @returns A proxied Smallstore with blob handling
 */
export function withBlobs(
  store: Smallstore,
  config: BlobMiddlewareConfig,
): Smallstore {
  const resolver = new BlobResolver(config.backend, config.filenameStrategy ?? 'uuid');
  const autoDetect = config.autoDetect ?? true;
  const sidecarMode: SidecarMode = config.sidecarMode ?? 'separate';

  return new Proxy(store, {
    get(target, prop, receiver) {
      // Intercept set()
      if (prop === 'set') {
        return async (collectionPath: string, data: any, options?: any): Promise<any> => {
          if (data == null || typeof data !== 'object' || Array.isArray(data)) {
            // Not an object — pass through
            return target.set(collectionPath, data, options);
          }

          const transformedData = { ...data };
          const sidecar: BlobSidecar = {};
          let hasBlobFields = false;

          // 1. Check configured field mappings
          const mappings = findMappings(config.collections, collectionPath);

          for (const mapping of mappings) {
            const value = getByPath(data, mapping.field);
            if (value != null && isBlobInput(value)) {
              const r2Prefix = mapping.r2Prefix ?? `${collectionPath}/${mapping.field}/`;
              const ref = await resolver.upload(value, r2Prefix);
              const format = mapping.targetFormat ?? 'url-only';
              setByPath(transformedData, mapping.field, formatForPlatform(ref, format));
              sidecar[mapping.field] = ref;
              hasBlobFields = true;
            }
          }

          // 2. Auto-detect additional blob fields (if enabled)
          if (autoDetect) {
            const configuredFields = new Set(mappings.map((m) => m.field));
            const detected = detectBlobFields(data);

            for (const { path, value } of detected) {
              if (configuredFields.has(path)) continue; // already handled

              const r2Prefix = `${collectionPath}/${path}/`;
              const ref = await resolver.upload(value, r2Prefix);
              // Auto-detected fields default to url-only
              setByPath(transformedData, path, formatForPlatform(ref, 'url-only'));
              sidecar[path] = ref;
              hasBlobFields = true;
            }
          }

          // 3. Store sidecar metadata based on mode
          if (hasBlobFields) {
            if (sidecarMode === 'inline') {
              // Merge sidecar into the same record as a JSON field
              transformedData[INLINE_SIDECAR_FIELD] = JSON.stringify(sidecar);
            } else if (sidecarMode === 'separate') {
              // Store as a separate key (original behavior)
              const sidecarKey = `${collectionPath}/_blobs`;
              try {
                await target.set(sidecarKey, sidecar, { mode: 'overwrite' });
              } catch (e) {
                console.warn(`[blob-middleware] Failed to store sidecar at ${sidecarKey}:`, e);
              }
            }
            // sidecarMode === 'none' → skip sidecar entirely
          }

          // 4. Pass transformed data to underlying store.
          // Default to mode: 'overwrite' so structured adapters (Airtable, Notion)
          // receive the object directly instead of wrapped in an array by SmartRouter's
          // default 'append' mode.
          const setOptions = { mode: 'overwrite' as const, ...options };
          return target.set(collectionPath, transformedData, setOptions);
        };
      }

      // Intercept delete() — clean up R2 blobs
      if (prop === 'delete') {
        return async (collectionPath: string): Promise<any> => {
          // Try to load sidecar for cleanup
          try {
            let sidecar: BlobSidecar | null = null;

            if (sidecarMode === 'inline') {
              // Read sidecar from the inline field on the same record
              const record = await target.get(collectionPath);
              const content = record?.content ?? record;
              const data = Array.isArray(content) ? content[0] : content;
              if (data && data[INLINE_SIDECAR_FIELD]) {
                sidecar = typeof data[INLINE_SIDECAR_FIELD] === 'string'
                  ? JSON.parse(data[INLINE_SIDECAR_FIELD])
                  : data[INLINE_SIDECAR_FIELD];
              }
            } else if (sidecarMode === 'separate') {
              // Read sidecar from separate key
              const sidecarKey = `${collectionPath}/_blobs`;
              sidecar = await target.get(sidecarKey) as BlobSidecar | null;
            }

            if (sidecar) {
              // Delete each blob from R2
              const deletePromises = Object.values(sidecar)
                .filter((ref) => ref && ref.r2Key)
                .map((ref) => resolver.delete(ref).catch((e: Error) => {
                  console.warn(`[blob-middleware] Failed to delete blob ${ref.r2Key}:`, e);
                }));
              await Promise.all(deletePromises);

              // Delete separate sidecar key if applicable
              if (sidecarMode === 'separate') {
                await target.delete(`${collectionPath}/_blobs`).catch((err: Error) => {
                  console.warn('[BlobMiddleware] Sidecar cleanup failed:', err);
                });
              }
            }
          } catch (err) {
            console.warn('[BlobMiddleware] Blob deletion failed:', err);
          }

          // Delete the main record
          return target.delete(collectionPath);
        };
      }

      // Everything else passes through
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  BlobInput,
  BlobReference,
  BlobSidecar,
  BlobFieldMapping,
  BlobBackendConfig,
  BlobMiddlewareConfig,
  R2DirectBackendConfig,
  F2R2BackendConfig,
  TargetFormat,
  FilenameStrategy,
  NormalizedBlob,
  SidecarMode,
} from './types.ts';
export { INLINE_SIDECAR_FIELD } from './types.ts';

export { isBlobInput, detectBlobFields } from './detector.ts';
export type { DetectedBlobField } from './detector.ts';
export { formatForPlatform, toAirtableAttachment, toNotionFile } from './formats.ts';
export type { AirtableAttachment, NotionFile } from './formats.ts';
export { BlobResolver } from './resolver.ts';
