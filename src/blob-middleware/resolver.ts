/**
 * Blob Resolver
 *
 * Normalizes blob inputs (file path, buffer, base64, URL) into bytes,
 * uploads them to R2 via R2-Direct or F2-R2, and returns a BlobReference.
 */

import type {
  BlobInput,
  BlobReference,
  BlobBackendConfig,
  NormalizedBlob,
  FilenameStrategy,
} from './types.ts';

// ============================================================================
// MIME Type Detection
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  // Images
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'ico': 'image/x-icon',
  'avif': 'image/avif',
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'm4a': 'audio/mp4',
  'flac': 'audio/flac',
  // Video
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  // Documents
  'pdf': 'application/pdf',
  'zip': 'application/zip',
  'json': 'application/json',
  'csv': 'text/csv',
  'txt': 'text/plain',
  'html': 'text/html',
  'md': 'text/markdown',
};

function mimeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// ============================================================================
// Filename Generation
// ============================================================================

function generateFilename(
  originalFilename: string,
  strategy: FilenameStrategy,
  bytes?: Uint8Array,
): string {
  const ext = originalFilename.includes('.')
    ? '.' + originalFilename.split('.').pop()
    : '';

  switch (strategy) {
    case 'preserve':
      return originalFilename;
    case 'content-hash': {
      // Simple hash from bytes — not cryptographic, just for dedup
      if (bytes) {
        let hash = 0;
        for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
          hash = ((hash << 5) - hash + bytes[i]) | 0;
        }
        return `${Math.abs(hash).toString(36)}${ext}`;
      }
      return `${crypto.randomUUID()}${ext}`;
    }
    case 'uuid':
    default:
      return `${crypto.randomUUID()}${ext}`;
  }
}

// ============================================================================
// Input Normalization
// ============================================================================

/**
 * Normalize any BlobInput into bytes + filename + contentType.
 */
async function normalizeInput(input: BlobInput): Promise<NormalizedBlob> {
  // Direct Uint8Array
  if (input instanceof Uint8Array) {
    return {
      bytes: input,
      filename: 'blob.bin',
      contentType: 'application/octet-stream',
    };
  }

  // Blob
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const buffer = await input.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      filename: (input as any).name || 'blob.bin',
      contentType: input.type || 'application/octet-stream',
    };
  }

  // Object shapes
  const obj = input as Record<string, any>;

  // { file: string } — local file path
  if (typeof obj.file === 'string') {
    const bytes = await Deno.readFile(obj.file);
    const filename = obj.file.split('/').pop() ?? 'file.bin';
    return {
      bytes,
      filename,
      contentType: mimeFromFilename(filename),
    };
  }

  // { buffer: Uint8Array }
  if (obj.buffer instanceof Uint8Array) {
    return {
      bytes: obj.buffer,
      filename: obj.filename ?? 'buffer.bin',
      contentType: obj.contentType ?? 'application/octet-stream',
    };
  }

  // { base64: string }
  if (typeof obj.base64 === 'string') {
    // Decode base64 — works in Deno
    const binaryStr = atob(obj.base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const filename = obj.filename ?? 'base64.bin';
    return {
      bytes,
      filename,
      contentType: mimeFromFilename(filename),
    };
  }

  // { url: string, reupload: true } — fetch the URL and re-upload
  if (typeof obj.url === 'string' && obj.reupload) {
    const response = await fetch(obj.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch blob URL: ${response.status} ${obj.url}`);
    }
    const buffer = await response.arrayBuffer();
    const urlPath = new URL(obj.url).pathname;
    const filename = urlPath.split('/').pop() ?? 'download.bin';
    return {
      bytes: new Uint8Array(buffer),
      filename,
      contentType: response.headers.get('content-type') ?? mimeFromFilename(filename),
    };
  }

  throw new Error(`Unrecognized blob input shape: ${JSON.stringify(Object.keys(obj))}`);
}

// ============================================================================
// AWS SDK lazy-load (only the r2-direct backend touches it)
// ============================================================================
//
// Same recipe as `src/messaging/channels/cf-email.ts` for `postal-mime`:
// dynamic import + module-level cache + helpful error if the dep is
// missing. Keeps the SDK out of the bundle for consumers who only use
// `f2-r2` (or no blob middleware at all).
//
// The aws-sdk packages are declared as `peerDependencies` (optional) in
// `scripts/build-npm.ts` so npm consumers don't force-install them; the
// loaders below throw a clear "install @aws-sdk/..." instruction when
// the r2-direct path is hit without the SDK on disk.

// `any` rather than `typeof import(...)` is intentional — dnt treats a
// `typeof import('@aws-sdk/...')` annotation as a static import and adds
// the package to `dependencies` even when it's only used dynamically,
// defeating the peerDeps split. Match the cf-email/postal-mime pattern:
// loose typing on the cache slots, real types only at the destructure.
let _S3Module: any | undefined;
let _S3PresignerModule: any | undefined;

async function loadS3(): Promise<any> {
  if (_S3Module) return _S3Module;
  try {
    _S3Module = await import('@aws-sdk/client-s3');
    return _S3Module;
  } catch (err) {
    throw new Error(
      "The r2-direct blob backend requires '@aws-sdk/client-s3'. Install it:\n" +
        "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner\n" +
        "  (or use the 'f2-r2' backend if you don't want the AWS SDK dep)\n" +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

async function loadS3Presigner(): Promise<any> {
  if (_S3PresignerModule) return _S3PresignerModule;
  try {
    _S3PresignerModule = await import('@aws-sdk/s3-request-presigner');
    return _S3PresignerModule;
  } catch (err) {
    throw new Error(
      "The r2-direct blob backend (with signed URLs) requires '@aws-sdk/s3-request-presigner'. Install it:\n" +
        "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner\n" +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ============================================================================
// Blob Resolver
// ============================================================================

export class BlobResolver {
  private config: BlobBackendConfig;
  private filenameStrategy: FilenameStrategy;

  constructor(config: BlobBackendConfig, filenameStrategy: FilenameStrategy = 'uuid') {
    this.config = config;
    this.filenameStrategy = filenameStrategy;
  }

  /**
   * Upload a blob input to R2 and return a BlobReference.
   *
   * @param input - The blob input (file path, buffer, base64, URL)
   * @param r2KeyPrefix - R2 key prefix (e.g. "posts/image/")
   * @returns BlobReference with URL, r2Key, metadata
   */
  async upload(input: BlobInput, r2KeyPrefix: string): Promise<BlobReference> {
    const normalized = await normalizeInput(input);
    const uploadFilename = generateFilename(
      normalized.filename,
      this.filenameStrategy,
      normalized.bytes,
    );
    const r2Key = `${r2KeyPrefix}${uploadFilename}`;

    let url: string;

    if (this.config.type === 'r2-direct') {
      url = await this.uploadR2Direct(r2Key, normalized);
    } else {
      url = await this.uploadF2R2(r2Key, normalized);
    }

    const ref: BlobReference = {
      url,
      r2Key,
      filename: normalized.filename,
      contentType: normalized.contentType,
      sizeBytes: normalized.bytes.length,
      uploadedAt: new Date().toISOString(),
      backend: this.config.type,
    };

    // Add expiry for signed URLs
    if (this.config.type === 'r2-direct' && this.config.urlStrategy === 'signed') {
      const ttl = this.config.signedUrlTTL ?? 3600;
      ref.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    }

    return ref;
  }

  /**
   * Generate the public URL for a given R2 key (without uploading).
   */
  generateUrl(r2Key: string): string {
    if (this.config.type === 'f2-r2') {
      const f2Url = this.config.f2Url ?? 'https://f2.phage.directory';
      const scope = this.config.defaultScope ?? 'blobs';
      return `${f2Url}/${scope}/${r2Key}`;
    }

    // R2 Direct — public URL via custom domain
    if (this.config.type === 'r2-direct' && this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl}/${r2Key}`;
    }

    // No public URL path available — caller misconfigured (missing publicBaseUrl for r2-direct)
    throw new Error(
      `Cannot generate URL for R2 key "${r2Key}": r2-direct requires publicBaseUrl or signed URL strategy`,
    );
  }

  /**
   * Delete a blob from R2 by its reference.
   */
  async delete(ref: BlobReference): Promise<void> {
    if (this.config.type === 'f2-r2') {
      await this.deleteF2R2(ref.r2Key);
    } else {
      await this.deleteR2Direct(ref.r2Key);
    }
  }

  // ==========================================================================
  // R2 Direct Upload
  // ==========================================================================

  /**
   * Build an S3 client wired for an r2-direct config. Dedup helper so
   * `uploadR2Direct` and `deleteR2Direct` share the same construction.
   * Doesn't cache the client itself — config can change across resolver
   * instances; the underlying SDK module IS cached via `loadS3()`.
   */
  private async buildR2Client() {
    const cfg = this.config as Extract<BlobBackendConfig, { type: 'r2-direct' }>;
    const { S3Client } = await loadS3();
    const endpoint = cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    return new S3Client({
      region: cfg.region ?? 'auto',
      endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  private async uploadR2Direct(r2Key: string, blob: NormalizedBlob): Promise<string> {
    const cfg = this.config as Extract<BlobBackendConfig, { type: 'r2-direct' }>;
    const { PutObjectCommand, GetObjectCommand } = await loadS3();
    const client = await this.buildR2Client();

    // Upload
    await client.send(new PutObjectCommand({
      Bucket: cfg.bucketName,
      Key: r2Key,
      Body: blob.bytes,
      ContentType: blob.contentType,
    }));

    // Generate URL
    if (cfg.urlStrategy === 'signed') {
      const { getSignedUrl } = await loadS3Presigner();
      const ttl = cfg.signedUrlTTL ?? 3600;
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: cfg.bucketName, Key: r2Key }),
        { expiresIn: ttl },
      );
    }

    if (cfg.publicBaseUrl) {
      return `${cfg.publicBaseUrl}/${r2Key}`;
    }

    // Fallback: signed URL with default TTL
    const { getSignedUrl } = await loadS3Presigner();
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: cfg.bucketName, Key: r2Key }),
      { expiresIn: 3600 },
    );
  }

  // ==========================================================================
  // F2-R2 Upload
  // ==========================================================================

  private async uploadF2R2(r2Key: string, blob: NormalizedBlob): Promise<string> {
    const cfg = this.config as Extract<BlobBackendConfig, { type: 'f2-r2' }>;
    const f2Url = cfg.f2Url ?? 'https://f2.phage.directory';
    const scope = cfg.defaultScope ?? 'blobs';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    // Step 1: Get presigned upload URL from F2
    const presignResponse = await fetch(f2Url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cmd: 'presign',
        key: r2Key,
        scope,
        nanoid: '',           // deterministic mode
        useVersioning: false,
      }),
    });

    if (!presignResponse.ok) {
      const errorText = await presignResponse.text();
      throw new Error(`F2 presign failed: ${presignResponse.status} - ${errorText}`);
    }

    const presignData = await presignResponse.json();
    if (!presignData?.url) {
      throw new Error('No presigned URL returned from F2');
    }

    // Step 2: Upload binary to R2 via presigned URL
    const uploadResponse = await fetch(presignData.url, {
      method: 'PUT',
      headers: { 'Content-Type': blob.contentType },
      body: blob.bytes as BodyInit,
    });

    if (!uploadResponse.ok) {
      throw new Error(`R2 upload via presigned URL failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }
    await uploadResponse.body?.cancel();

    // F2 serves files at /{scope}/{filename}
    return `${f2Url}/${scope}/${r2Key}`;
  }

  // ==========================================================================
  // Deletion
  // ==========================================================================

  private async deleteR2Direct(r2Key: string): Promise<void> {
    const cfg = this.config as Extract<BlobBackendConfig, { type: 'r2-direct' }>;
    const { DeleteObjectCommand } = await loadS3();
    const client = await this.buildR2Client();

    await client.send(new DeleteObjectCommand({
      Bucket: cfg.bucketName,
      Key: r2Key,
    }));
  }

  private async deleteF2R2(r2Key: string): Promise<void> {
    const cfg = this.config as Extract<BlobBackendConfig, { type: 'f2-r2' }>;
    const f2Url = cfg.f2Url ?? 'https://f2.phage.directory';
    const scope = cfg.defaultScope ?? 'blobs';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.token) {
      headers['Authorization'] = `Bearer ${cfg.token}`;
    }

    const response = await fetch(f2Url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cmd: 'delete',
        key: r2Key,
        scope,
        authKey: cfg.authKey,
      }),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`F2 blob delete failed: ${response.status}`);
    }
    await response.body?.cancel();
  }
}
