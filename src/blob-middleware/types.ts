/**
 * Blob Middleware Types
 *
 * Type definitions for the blob middleware that makes multimedia
 * storage first-class in Smallstore. Upload files to R2, automatically
 * place URLs into Airtable attachment columns or Notion file properties.
 */

// ============================================================================
// Blob Input Types (what users pass in)
// ============================================================================

/** Local file path input */
export interface BlobFileInput {
  file: string;
}

/** Raw bytes input */
export interface BlobBufferInput {
  buffer: Uint8Array;
}

/** Base64-encoded input */
export interface BlobBase64Input {
  base64: string;
  filename?: string;
}

/** External URL (optionally re-upload to R2) */
export interface BlobUrlInput {
  url: string;
  reupload?: boolean;
}

/**
 * What users can pass as a blob field value.
 * The middleware detects these shapes and handles upload automatically.
 */
export type BlobInput =
  | BlobFileInput
  | BlobBufferInput
  | BlobBase64Input
  | BlobUrlInput
  | Uint8Array
  | Blob;

// ============================================================================
// Blob Reference (stored as metadata sidecar)
// ============================================================================

/**
 * Metadata stored alongside each uploaded blob.
 * Persisted as a sidecar at `{key}/_blobs` for cleanup and URL refresh.
 */
export interface BlobReference {
  /** Public or signed URL to access the blob */
  url: string;
  /** R2 object key — needed for re-signing or deletion */
  r2Key: string;
  /** Original filename */
  filename: string;
  /** MIME content type */
  contentType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** ISO timestamp of upload */
  uploadedAt: string;
  /** ISO timestamp when signed URL expires (only for signed URLs) */
  expiresAt?: string;
  /** Which backend was used */
  backend: 'r2-direct' | 'f2-r2';
}

/** Sidecar document shape stored at `{key}/_blobs` */
export interface BlobSidecar {
  /** Map of field name → blob reference */
  [field: string]: BlobReference;
}

// ============================================================================
// Normalized Blob (internal, after resolving input)
// ============================================================================

/** Internal representation after normalizing any BlobInput */
export interface NormalizedBlob {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

// ============================================================================
// Target Format
// ============================================================================

/** How the blob URL should be formatted for the target platform */
export type TargetFormat = 'airtable' | 'notion' | 'url-only' | 'blob-reference';

// ============================================================================
// Field Mapping Configuration
// ============================================================================

/**
 * Per-field blob configuration.
 * Tells the middleware which fields contain blobs and how to handle them.
 */
export interface BlobFieldMapping {
  /** Dot-notation path to the field in the data object (e.g. "image", "attachments.photo") */
  field: string;
  /** R2 key prefix — defaults to "{collection}/{field}/" */
  r2Prefix?: string;
  /** How to format the URL for the target platform */
  targetFormat?: TargetFormat;
}

// ============================================================================
// Backend Configuration
// ============================================================================

/** URL generation strategy */
export type UrlStrategy = 'public' | 'signed' | 'f2-proxy';

/** Backend type for blob storage */
export type BlobBackendType = 'r2-direct' | 'f2-r2';

/**
 * R2 Direct backend configuration.
 * Uses AWS S3-compatible API to talk directly to Cloudflare R2.
 */
export interface R2DirectBackendConfig {
  type: 'r2-direct';
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  endpoint?: string;
  region?: string;
  urlStrategy?: 'public' | 'signed';
  /** Base URL for public R2 bucket (e.g. custom domain) */
  publicBaseUrl?: string;
  /** TTL for signed URLs in seconds (default: 3600) */
  signedUrlTTL?: number;
}

/**
 * F2-R2 backend configuration.
 * Uses the F2 (Fuzzyfile) Cloudflare Worker as a proxy to R2.
 * Files are accessible at `{f2Url}/{scope}/{filename}`.
 */
export interface F2R2BackendConfig {
  type: 'f2-r2';
  /** F2 service URL (default: https://f2.phage.directory) */
  f2Url?: string;
  /** Auth token for F2 */
  token?: string;
  /** Auth key for F2 delete operations (must match DELETE_AUTH_KEY on the F2 worker) */
  authKey?: string;
  /** Default scope for uploads (default: "blobs") */
  defaultScope?: string;
  urlStrategy?: 'f2-proxy';
}

/** Union of backend configs */
export type BlobBackendConfig = R2DirectBackendConfig | F2R2BackendConfig;

// ============================================================================
// Filename Strategy
// ============================================================================

/** How to name uploaded files in R2 */
export type FilenameStrategy = 'uuid' | 'content-hash' | 'preserve';

// ============================================================================
// Sidecar Mode
// ============================================================================

/**
 * Where to store blob sidecar metadata (R2 keys, sizes, etc.)
 *
 * - `'separate'` — Store as a separate key at `{key}/_blobs` (default).
 *   Good for memory/local-json adapters where extra keys are cheap.
 *
 * - `'inline'` — Merge sidecar into the same record as a `_blob_meta` field.
 *   Better for Airtable/Notion where extra rows are visible clutter.
 *
 * - `'none'` — Don't store sidecar metadata at all.
 *   The attachment URLs are still written to the record; you just lose
 *   the ability to refresh signed URLs or clean up R2 objects.
 */
export type SidecarMode = 'separate' | 'inline' | 'none';

/** Field name used for inline sidecar storage */
export const INLINE_SIDECAR_FIELD = '_blob_meta';

// ============================================================================
// Main Middleware Config
// ============================================================================

/**
 * Configuration for the blob middleware.
 *
 * @example
 * ```ts
 * const config: BlobMiddlewareConfig = {
 *   backend: {
 *     type: 'f2-r2',
 *     f2Url: 'https://f2.phage.directory',
 *     token: 'secret',
 *     urlStrategy: 'f2-proxy',
 *   },
 *   collections: {
 *     'posts/*': [
 *       { field: 'image', targetFormat: 'airtable' },
 *       { field: 'thumbnail', targetFormat: 'airtable' },
 *     ],
 *   },
 *   autoDetect: true,
 *   filenameStrategy: 'uuid',
 *   sidecarMode: 'inline',  // store blob metadata on the same row
 * };
 * ```
 */
export interface BlobMiddlewareConfig {
  /** Backend storage configuration (R2 direct or F2 proxy) */
  backend: BlobBackendConfig;
  /** Collection pattern → blob field mappings */
  collections: Record<string, BlobFieldMapping[]>;
  /** Auto-detect blob inputs by shape (default: true) */
  autoDetect?: boolean;
  /** How to name files in R2 (default: 'uuid') */
  filenameStrategy?: FilenameStrategy;
  /** Where to store sidecar metadata (default: 'separate') */
  sidecarMode?: SidecarMode;
}
