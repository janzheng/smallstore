/**
 * Tests for the webhook channel + HTTP route.
 *
 *   - WebhookChannel.parse — field mapping, default behavior, id derivation
 *   - verifyHmac           — sha256 valid/invalid, sha1, malformed input
 *   - extractByPath        — dotted path navigation
 *   - POST /webhook/:peer  — full request flow (HMAC, ingest, dedup, errors)
 */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { MemoryAdapter } from '../src/adapters/memory.ts';
import { InboxRegistry } from '../src/messaging/registry.ts';
import { registerMessagingRoutes } from '../src/messaging/http-routes.ts';
import { createInbox } from '../src/messaging/inbox.ts';
import type { InboxConfig } from '../src/messaging/types.ts';
import {
  webhookChannel,
  verifyHmac,
  extractByPath,
  type WebhookConfig,
} from '../src/messaging/channels/webhook.ts';

// ============================================================================
// Channel.parse
// ============================================================================

Deno.test('webhook channel — default field-mapping (no config)', async () => {
  const result = await webhookChannel.parse({
    payload: { event: 'pr.opened', title: 'fix typo' },
    peer_name: 'github',
  });
  assertExists(result);
  assertEquals(result.item.source, 'webhook');
  assertEquals(result.item.source_version, 'webhook/v1');
  assertEquals(result.item.fields.event, 'pr.opened');
  assertEquals(result.item.fields.title, 'fix typo');
  assertEquals((result.item.fields as any)._webhook.peer, 'github');
  // Without `fields.id`, id is content-addressed over the whole payload.
  assertEquals(result.item.id.length, 32);
});

Deno.test('webhook channel — promotes mapped fields to InboxItem level', async () => {
  const cfg: WebhookConfig = {
    target_inbox: 'github',
    fields: {
      id: 'pull_request.id',
      summary: 'pull_request.title',
      body: 'pull_request.body',
      sent_at: 'pull_request.created_at',
      thread_id: 'pull_request.id',
    },
  };
  const result = await webhookChannel.parse(
    {
      payload: {
        action: 'opened',
        pull_request: {
          id: 12345,
          title: 'Fix race in cache',
          body: 'Closes #99',
          created_at: '2026-04-26T10:00:00Z',
        },
      },
      peer_name: 'github',
    },
    cfg,
  );
  assertExists(result);
  assertEquals(result.item.summary, 'Fix race in cache');
  assertEquals(result.item.body, 'Closes #99');
  assertEquals(result.item.sent_at, '2026-04-26T10:00:00.000Z');
  assertEquals(result.item.thread_id, '12345');
  // mapped fields are also retained in `fields` for traceability
  assertEquals((result.item.fields as any).pull_request.id, 12345);
});

Deno.test('webhook channel — same upstream id → same InboxItem id', async () => {
  const cfg: WebhookConfig = {
    target_inbox: 'github',
    fields: { id: 'pull_request.id' },
  };
  const a = await webhookChannel.parse(
    { payload: { pull_request: { id: 12345, title: 'a' } }, peer_name: 'github' },
    cfg,
  );
  const b = await webhookChannel.parse(
    { payload: { pull_request: { id: 12345, title: 'b-different' } }, peer_name: 'github' },
    cfg,
  );
  assertExists(a);
  assertExists(b);
  assertEquals(a.item.id, b.item.id);
});

Deno.test('webhook channel — different peers with same upstream id → different InboxItem ids', async () => {
  const cfg: WebhookConfig = { target_inbox: 'inbox', fields: { id: 'id' } };
  const a = await webhookChannel.parse(
    { payload: { id: 100 }, peer_name: 'peer-a' },
    cfg,
  );
  const b = await webhookChannel.parse(
    { payload: { id: 100 }, peer_name: 'peer-b' },
    cfg,
  );
  assertExists(a);
  assertExists(b);
  assert(a.item.id !== b.item.id);
});

Deno.test('webhook channel — default_labels applied', async () => {
  const result = await webhookChannel.parse(
    { payload: {}, peer_name: 'github' },
    { target_inbox: 'github', default_labels: ['github', 'pr'] },
  );
  assertExists(result);
  assertEquals(result.item.labels, ['github', 'pr']);
});

Deno.test('webhook channel — source / source_version overrides', async () => {
  const result = await webhookChannel.parse(
    { payload: {}, peer_name: 'github' },
    {
      target_inbox: 'github',
      source: 'github',
      source_version: 'github-pr/v1',
    },
  );
  assertExists(result);
  assertEquals(result.item.source, 'github');
  assertEquals(result.item.source_version, 'github-pr/v1');
});

Deno.test('webhook channel — non-object payload wrapped under `value`', async () => {
  const result = await webhookChannel.parse(
    { payload: 'plain string event', peer_name: 'p' },
  );
  assertExists(result);
  assertEquals((result.item.fields as any).value, 'plain string event');
});

Deno.test('webhook channel — unix-seconds sent_at coerces to ISO', async () => {
  const result = await webhookChannel.parse(
    { payload: { ts: 1761480000 }, peer_name: 'p' },
    { target_inbox: 'i', fields: { sent_at: 'ts' } },
  );
  assertExists(result);
  assertEquals(result.item.sent_at, new Date(1761480000 * 1000).toISOString());
});

// ============================================================================
// extractByPath
// ============================================================================

Deno.test('extractByPath — happy path', () => {
  assertEquals(extractByPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
});

Deno.test('extractByPath — missing segment returns undefined', () => {
  assertEquals(extractByPath({ a: { b: 1 } }, 'a.b.c'), undefined);
  assertEquals(extractByPath({}, 'foo.bar'), undefined);
  assertEquals(extractByPath(null, 'a'), undefined);
});

Deno.test('extractByPath — empty path returns undefined', () => {
  assertEquals(extractByPath({ a: 1 }, ''), undefined);
});

// ============================================================================
// verifyHmac
// ============================================================================

async function computeHmacHex(
  body: string,
  secret: string,
  algo: 'sha256' | 'sha1' = 'sha256',
): Promise<string> {
  const enc = new TextEncoder();
  const algoName = algo === 'sha1' ? 'SHA-1' : 'SHA-256';
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: algoName },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.test('verifyHmac — sha256 happy path', async () => {
  const body = '{"event":"x"}';
  const secret = 'super-secret';
  const sig = await computeHmacHex(body, secret, 'sha256');
  assertEquals(await verifyHmac(body, sig, secret, 'sha256'), true);
});

Deno.test('verifyHmac — wrong secret fails', async () => {
  const body = '{"event":"x"}';
  const sig = await computeHmacHex(body, 'right', 'sha256');
  assertEquals(await verifyHmac(body, sig, 'wrong', 'sha256'), false);
});

Deno.test('verifyHmac — tampered body fails', async () => {
  const sig = await computeHmacHex('{"event":"x"}', 'k', 'sha256');
  assertEquals(await verifyHmac('{"event":"y"}', sig, 'k', 'sha256'), false);
});

Deno.test('verifyHmac — sha1 supported', async () => {
  const body = '{"a":1}';
  const sig = await computeHmacHex(body, 's', 'sha1');
  assertEquals(await verifyHmac(body, sig, 's', 'sha1'), true);
});

Deno.test('verifyHmac — empty signature returns false', async () => {
  assertEquals(await verifyHmac('body', '', 'k'), false);
});

Deno.test('verifyHmac — non-hex signature returns false', async () => {
  assertEquals(await verifyHmac('body', 'not-hex', 'k'), false);
});

Deno.test('verifyHmac — odd-length hex returns false', async () => {
  assertEquals(await verifyHmac('body', 'abc', 'k'), false);
});

// ============================================================================
// HTTP route — POST /webhook/:peer
// ============================================================================

interface Fixture {
  app: Hono;
  registry: InboxRegistry;
  configs: Map<string, WebhookConfig>;
  envSecrets: Map<string, string>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

function buildApp(): Fixture {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();

  const buildInbox = async (name: string, cfg: InboxConfig) =>
    createInbox({ name, channel: cfg.channel, storage: { items } });

  // boot-register a target inbox
  const inbox = createInbox({ name: 'webhooks', channel: 'webhook', storage: { items } });
  registry.register('webhooks', inbox, { channel: 'webhook', storage: 'items' } as InboxConfig, 'boot');

  const configs = new Map<string, WebhookConfig>();
  const envSecrets = new Map<string, string>();

  const app = new Hono();
  registerMessagingRoutes(app, {
    registry,
    requireAuth,
    createInbox: buildInbox,
    webhookConfigFor: (name) => configs.get(name) ?? null,
    resolveHmacSecret: (env) => envSecrets.get(env),
  });

  const fetch = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { app, registry, configs, envSecrets, fetch };
}

Deno.test('POST /webhook/:peer — happy path, no HMAC', async () => {
  const fx = buildApp();
  fx.configs.set('github', { target_inbox: 'webhooks', default_labels: ['gh'] });

  const res = await fx.fetch('/webhook/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'opened' }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.peer, 'github');
  assertEquals(body.inbox, 'webhooks');
  assertEquals(body.item.source, 'webhook');
  assertEquals(body.item.labels, ['gh']);
});

Deno.test('POST /webhook/:peer — 404 unknown peer', async () => {
  const fx = buildApp();
  const res = await fx.fetch('/webhook/nope', {
    method: 'POST',
    body: '{}',
  });
  assertEquals(res.status, 404);
});

Deno.test('POST /webhook/:peer — 404 missing target inbox', async () => {
  const fx = buildApp();
  fx.configs.set('orphan', { target_inbox: 'nonexistent' });
  const res = await fx.fetch('/webhook/orphan', {
    method: 'POST',
    body: '{}',
  });
  assertEquals(res.status, 404);
});

Deno.test('POST /webhook/:peer — invalid JSON returns 400', async () => {
  const fx = buildApp();
  fx.configs.set('p', { target_inbox: 'webhooks' });
  const res = await fx.fetch('/webhook/p', {
    method: 'POST',
    body: 'not json',
  });
  assertEquals(res.status, 400);
});

Deno.test('POST /webhook/:peer — HMAC valid succeeds', async () => {
  const fx = buildApp();
  fx.configs.set('gh', {
    target_inbox: 'webhooks',
    hmac: { header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=', secret_env: 'GH_SECRET' },
  });
  fx.envSecrets.set('GH_SECRET', 'shhh');

  const body = JSON.stringify({ pr: 1 });
  const sig = 'sha256=' + (await computeHmacHex(body, 'shhh', 'sha256'));
  const res = await fx.fetch('/webhook/gh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body,
  });
  assertEquals(res.status, 200);
});

Deno.test('POST /webhook/:peer — HMAC invalid returns 401', async () => {
  const fx = buildApp();
  fx.configs.set('gh', {
    target_inbox: 'webhooks',
    hmac: { header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=', secret_env: 'GH_SECRET' },
  });
  fx.envSecrets.set('GH_SECRET', 'shhh');

  const body = JSON.stringify({ pr: 1 });
  const wrongSig = 'sha256=' + (await computeHmacHex(body, 'wrong', 'sha256'));
  const res = await fx.fetch('/webhook/gh', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': wrongSig },
    body,
  });
  assertEquals(res.status, 401);
});

Deno.test('POST /webhook/:peer — HMAC missing header returns 401', async () => {
  const fx = buildApp();
  fx.configs.set('gh', {
    target_inbox: 'webhooks',
    hmac: { header: 'x-sig', secret_env: 'S' },
  });
  fx.envSecrets.set('S', 'k');
  const res = await fx.fetch('/webhook/gh', {
    method: 'POST',
    body: '{}',
  });
  assertEquals(res.status, 401);
});

Deno.test('POST /webhook/:peer — HMAC missing env secret returns 500', async () => {
  const fx = buildApp();
  fx.configs.set('gh', {
    target_inbox: 'webhooks',
    hmac: { header: 'x-sig', secret_env: 'NOT_SET' },
  });
  const res = await fx.fetch('/webhook/gh', {
    method: 'POST',
    headers: { 'x-sig': 'whatever' },
    body: '{}',
  });
  assertEquals(res.status, 500);
});

Deno.test('POST /webhook/:peer — re-delivery dedups via content-addressed id', async () => {
  const fx = buildApp();
  fx.configs.set('gh', {
    target_inbox: 'webhooks',
    fields: { id: 'pr.id' },
  });
  const body = JSON.stringify({ pr: { id: 42, title: 'x' } });
  const r1 = await fx.fetch('/webhook/gh', { method: 'POST', body });
  const r2 = await fx.fetch('/webhook/gh', { method: 'POST', body });
  const j1 = await r1.json();
  const j2 = await r2.json();
  assertEquals(j1.item.id, j2.item.id);
});

Deno.test('POST /webhook/:peer — 501 when webhookConfigFor not provided', async () => {
  const items = new MemoryAdapter();
  const registry = new InboxRegistry();
  const requireAuth = (_c: Context, next: Next) => next();
  const buildInbox = async (n: string, cfg: InboxConfig) =>
    createInbox({ name: n, channel: cfg.channel, storage: { items } });
  const app = new Hono();
  registerMessagingRoutes(app, { registry, requireAuth, createInbox: buildInbox });
  const res = await app.fetch(new Request('http://localhost/webhook/anything', { method: 'POST', body: '{}' }));
  assertEquals(res.status, 501);
});
