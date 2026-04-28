/**
 * R2DirectAdapter offline mock tests.
 *
 * The TASKS-TESTS.md gap "R2 Direct adapter — live tests pass, no mocked
 * offline test" was real. This file mocks the adapter's S3 client by
 * pre-injecting a stub `s3Client` so `getClient()` returns our recorder
 * on first call (it caches on `this.s3Client`). The stub's `send(command)`
 * inspects `command.constructor.name` to dispatch per-command behavior.
 *
 * Coverage (~20 cases):
 *   - Constructor + capabilities
 *   - set: PutObjectCommand with right Bucket+Key+Body+ContentType for
 *     JSON object, plain string, Uint8Array (binary)
 *   - get: GetObjectCommand returns parsed JSON when autoParse on, raw
 *     bytes when raw:true, null on NoSuchKey error
 *   - delete: DeleteObjectCommand
 *   - has: HeadObjectCommand returns true on success, false on NotFound,
 *     throws on other errors
 *   - keys: ListObjectsV2Command maps Contents[].Key → keys, empty
 *     Contents → []
 *   - clear: lists then deletes each
 *   - getSignedUploadUrl + getSignedDownloadUrl: return strings (we mock
 *     the presigner module)
 *
 * Note: `@aws-sdk/client-s3` is a real npm dep (per dist/package.json
 * peerDependencies). The dynamic `await loadS3()` resolves real classes;
 * we only stub the *client.send* path, not the command constructors.
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { R2DirectAdapter } from '../src/adapters/r2-direct.ts';

// ============================================================================
// S3 client stub
// ============================================================================

interface SendCall {
  cmd: string; // command constructor name
  input: any;  // command.input — { Bucket, Key, Body, ContentType, Prefix, ... }
}

interface StubResponses {
  /** Default response for unknown commands. Default = empty object. */
  default?: any;
  /** Per-command-name responses or factories. */
  byCmd?: Record<string, any | ((input: any) => any)>;
  /** Throw an error from `send()`. */
  throwError?: Error;
}

function buildAdapterWithStub(responses: StubResponses = {}) {
  const adapter = new R2DirectAdapter({
    accountId: 'TEST',
    accessKeyId: 'AKIA-TEST',
    secretAccessKey: 'TEST-SECRET',
    bucketName: 'test-bucket',
    retry: false,
  });
  const calls: SendCall[] = [];

  const stubClient = {
    send: async (command: any) => {
      const cmd = command?.constructor?.name ?? 'unknown';
      const input = command?.input ?? {};
      calls.push({ cmd, input });
      if (responses.throwError) throw responses.throwError;
      const handler = responses.byCmd?.[cmd];
      if (handler === undefined) return responses.default ?? {};
      return typeof handler === 'function' ? handler(input) : handler;
    },
  };
  // deno-lint-ignore no-explicit-any
  (adapter as any).s3Client = stubClient;
  return { adapter, calls };
}

/** Build a response.Body whose transformToString returns the given string. */
function bodyOf(s: string) {
  return {
    Body: {
      transformToString: async () => s,
    },
  };
}

// ============================================================================
// Constructor + capabilities
// ============================================================================

Deno.test('r2-direct — constructor stores config + builds capabilities', () => {
  const a = new R2DirectAdapter({
    accountId: 'X',
    accessKeyId: 'A',
    secretAccessKey: 'S',
    bucketName: 'b',
  });
  assertEquals(a.capabilities.name, 'r2-direct');
  assert(a.capabilities.supportedTypes.includes('object'));
  assert(a.capabilities.supportedTypes.includes('blob'));
});

// ============================================================================
// set
// ============================================================================

Deno.test('r2-direct — set(object) sends PutObjectCommand with JSON body + application/json', async () => {
  const { adapter, calls } = buildAdapterWithStub();
  await adapter.set('docs/note.json', { title: 'Hello', count: 1 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].cmd, 'PutObjectCommand');
  assertEquals(calls[0].input.Bucket, 'test-bucket');
  assertEquals(calls[0].input.Key, 'docs/note.json');
  // Body is the JSON string of the object.
  assertEquals(calls[0].input.Body, JSON.stringify({ title: 'Hello', count: 1 }));
  assertEquals(calls[0].input.ContentType, 'application/json');
});

Deno.test('r2-direct — set(string) sends string body with text/plain', async () => {
  const { adapter, calls } = buildAdapterWithStub();
  await adapter.set('logs/line.txt', 'plain string');
  assertEquals(calls[0].input.Body, 'plain string');
  // Content-type detection from the .txt extension or generic text/plain.
  assert(typeof calls[0].input.ContentType === 'string' && calls[0].input.ContentType.startsWith('text/'));
});

Deno.test('r2-direct — set(Uint8Array) sends binary body', async () => {
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
  const { adapter, calls } = buildAdapterWithStub();
  await adapter.set('img/photo.png', binary);
  assertEquals(calls[0].input.Body, binary);
  // Content-type derived from .png extension.
  assertEquals(calls[0].input.ContentType, 'image/png');
});

// ============================================================================
// get
// ============================================================================

Deno.test('r2-direct — get() returns parsed JSON when autoParse + content-type matches', async () => {
  const { adapter } = buildAdapterWithStub({
    byCmd: {
      GetObjectCommand: () => ({
        ...bodyOf(JSON.stringify({ value: 42 })),
        ContentType: 'application/json',
      }),
    },
  });
  const result = await adapter.get('docs/note.json');
  assertEquals(result, { value: 42 });
});

Deno.test('r2-direct — get(key, { raw: true }) returns the body string verbatim', async () => {
  const { adapter } = buildAdapterWithStub({
    byCmd: {
      GetObjectCommand: () => ({
        ...bodyOf('{"value":42}'),
        ContentType: 'application/json',
      }),
    },
  });
  const result = await adapter.get('docs/note.json', { raw: true });
  assertEquals(result, '{"value":42}');
});

Deno.test('r2-direct — get() returns null on NoSuchKey error', async () => {
  const noKeyError = Object.assign(new Error('No such key'), { name: 'NoSuchKey' });
  const { adapter } = buildAdapterWithStub({ throwError: noKeyError });
  const result = await adapter.get('missing/file.json');
  assertEquals(result, null);
});

Deno.test('r2-direct — get() returns null when response.Body is missing', async () => {
  const { adapter } = buildAdapterWithStub({
    byCmd: { GetObjectCommand: () => ({}) }, // no Body
  });
  const result = await adapter.get('empty/file.json');
  assertEquals(result, null);
});

Deno.test('r2-direct — get() rethrows non-NoSuchKey errors', async () => {
  const networkError = Object.assign(new Error('connection reset'), { name: 'NetworkError' });
  const { adapter } = buildAdapterWithStub({ throwError: networkError });
  await assertRejects(async () => await adapter.get('any/key'), Error, 'connection reset');
});

Deno.test('r2-direct — get() returns body string when autoParse off', async () => {
  const a = new R2DirectAdapter({
    accountId: 'X',
    accessKeyId: 'A',
    secretAccessKey: 'S',
    bucketName: 'b',
    autoParse: false,
    retry: false,
  });
  // Manually inject the stub client.
  // deno-lint-ignore no-explicit-any
  (a as any).s3Client = {
    send: async () => ({ ...bodyOf('{"value":42}'), ContentType: 'application/json' }),
  };
  const result = await a.get('docs/note.json');
  // autoParse off → returns the raw string, not the parsed object.
  assertEquals(result, '{"value":42}');
});

// ============================================================================
// delete
// ============================================================================

Deno.test('r2-direct — delete sends DeleteObjectCommand', async () => {
  const { adapter, calls } = buildAdapterWithStub();
  await adapter.delete('docs/note.json');
  assertEquals(calls[0].cmd, 'DeleteObjectCommand');
  assertEquals(calls[0].input.Bucket, 'test-bucket');
  assertEquals(calls[0].input.Key, 'docs/note.json');
});

// ============================================================================
// has
// ============================================================================

Deno.test('r2-direct — has() returns true when HeadObjectCommand succeeds', async () => {
  const { adapter, calls } = buildAdapterWithStub();
  assertEquals(await adapter.has('docs/note.json'), true);
  assertEquals(calls[0].cmd, 'HeadObjectCommand');
});

Deno.test('r2-direct — has() returns false on NotFound error', async () => {
  const notFound = Object.assign(new Error('Not found'), { name: 'NotFound' });
  const { adapter } = buildAdapterWithStub({ throwError: notFound });
  assertEquals(await adapter.has('missing/file.json'), false);
});

Deno.test('r2-direct — has() returns false on NoSuchKey', async () => {
  const noKey = Object.assign(new Error('No such key'), { name: 'NoSuchKey' });
  const { adapter } = buildAdapterWithStub({ throwError: noKey });
  assertEquals(await adapter.has('missing/file.json'), false);
});

Deno.test('r2-direct — has() rethrows non-not-found errors', async () => {
  const networkError = Object.assign(new Error('boom'), { name: 'NetworkError' });
  const { adapter } = buildAdapterWithStub({ throwError: networkError });
  await assertRejects(async () => await adapter.has('any/file.json'), Error, 'boom');
});

// ============================================================================
// keys
// ============================================================================

Deno.test('r2-direct — keys() maps Contents[].Key → keys array', async () => {
  const { adapter, calls } = buildAdapterWithStub({
    byCmd: {
      ListObjectsV2Command: () => ({
        Contents: [{ Key: 'a' }, { Key: 'b' }, { Key: 'c' }],
      }),
    },
  });
  const keys = await adapter.keys();
  assertEquals(keys, ['a', 'b', 'c']);
  assertEquals(calls[0].cmd, 'ListObjectsV2Command');
  assertEquals(calls[0].input.Bucket, 'test-bucket');
});

Deno.test('r2-direct — keys() with prefix passes Prefix to S3', async () => {
  const { adapter, calls } = buildAdapterWithStub({
    byCmd: { ListObjectsV2Command: () => ({ Contents: [] }) },
  });
  await adapter.keys('docs/');
  assertEquals(calls[0].input.Prefix, 'docs/');
});

Deno.test('r2-direct — keys() returns [] when Contents is missing', async () => {
  const { adapter } = buildAdapterWithStub({
    byCmd: { ListObjectsV2Command: () => ({}) },
  });
  assertEquals(await adapter.keys(), []);
});

// ============================================================================
// clear
// ============================================================================

Deno.test('r2-direct — clear lists then deletes each key', async () => {
  const { adapter, calls } = buildAdapterWithStub({
    byCmd: {
      ListObjectsV2Command: () => ({
        Contents: [{ Key: 'docs/a' }, { Key: 'docs/b' }],
      }),
    },
  });
  await adapter.clear('docs/');
  // 1 list + 2 deletes
  assertEquals(calls[0].cmd, 'ListObjectsV2Command');
  assertEquals(calls[0].input.Prefix, 'docs/');
  const deletes = calls.filter((c) => c.cmd === 'DeleteObjectCommand');
  assertEquals(deletes.length, 2);
  assertEquals(deletes.map((d) => d.input.Key).sort(), ['docs/a', 'docs/b']);
});

Deno.test('r2-direct — clear with no matching keys is a no-op', async () => {
  const { adapter, calls } = buildAdapterWithStub({
    byCmd: { ListObjectsV2Command: () => ({ Contents: [] }) },
  });
  await adapter.clear('empty/');
  assertEquals(calls.filter((c) => c.cmd === 'DeleteObjectCommand').length, 0);
});

// ============================================================================
// Signed URLs (getSignedUploadUrl / getSignedDownloadUrl)
// ============================================================================
//
// These call `getSignedUrl` from `@aws-sdk/s3-request-presigner` which
// reads `client.config.endpointProvider` — our stub doesn't carry that.
// Use a *real* S3Client built lazily by the adapter's own `getClient()`.
// The presigner is a pure local function: it constructs the URL from
// credentials + command without making any AWS call, so this works
// offline with synthetic credentials.

function buildAdapterRealClient() {
  return new R2DirectAdapter({
    accountId: 'TEST',
    accessKeyId: 'AKIA-TEST',
    secretAccessKey: 'TEST-SECRET',
    bucketName: 'test-bucket',
    retry: false,
  });
}

Deno.test('r2-direct — getSignedUploadUrl returns a signed PUT URL string', async () => {
  const url = await buildAdapterRealClient().getSignedUploadUrl('uploads/file.pdf', { expiresIn: 600 });
  assert(typeof url === 'string' && url.startsWith('https://'));
  assert(url.includes('test-bucket'));
  assert(url.includes('uploads/file.pdf'));
  // expiresIn shows up in the X-Amz-Expires query param.
  assert(url.includes('X-Amz-Expires=600'));
});

Deno.test('r2-direct — getSignedDownloadUrl returns a signed GET URL string', async () => {
  const url = await buildAdapterRealClient().getSignedDownloadUrl('downloads/file.pdf');
  assert(typeof url === 'string' && url.startsWith('https://'));
  assert(url.includes('test-bucket'));
  assert(url.includes('downloads/file.pdf'));
});

Deno.test('r2-direct — getSignedDownloadUrl with filename adds Content-Disposition param', async () => {
  const url = await buildAdapterRealClient().getSignedDownloadUrl(
    'downloads/file.pdf',
    { filename: 'report.pdf' },
  );
  // ResponseContentDisposition shows up URL-encoded in the query string.
  assert(
    url.toLowerCase().includes('response-content-disposition'),
    `expected response-content-disposition in URL, got ${url}`,
  );
  // The filename gets percent-encoded in the URL (`.` and lowercase letters
  // pass through, but the surrounding quotes + spaces don't).
  assert(url.includes('report.pdf'));
});
