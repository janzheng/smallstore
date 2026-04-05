/**
 * Smallstore API App Builder
 *
 * Builds the Hono app separately from the server, so it can be tested in-process.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Smallstore } from '../../src/types.ts';

export interface ApiAppOptions {
  apiKey?: string;
}

/**
 * Create a Hono app wired to a smallstore instance.
 * Usable both as a live server and in tests via app.request().
 */
export function createApiApp(store: Smallstore, options: ApiAppOptions = {}): Hono {
  const app = new Hono();

  // CORS
  app.use('*', cors());

  // Global error handler — always return JSON
  app.onError((err, c) => {
    console.error('[API]', err.message);
    return c.json({ error: 'Internal Server Error', message: err.message }, 500);
  });

  // Optional API key auth
  if (options.apiKey) {
    app.use('*', async (c, next) => {
      if (c.req.path === '/health') return next();
      const authHeader = c.req.header('Authorization');
      if (!authHeader || authHeader !== `Bearer ${options.apiKey}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return next();
    });
  }

  // ── Info ──────────────────────────────────────────────────────────────────

  app.get('/', (c) => {
    return c.json({ name: 'smallstore-api', version: '0.1.0', endpoints: ['/collections', '/store/:path', '/tree', '/namespaces', '/_batch/*'] });
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/collections', async (c) => {
    const pattern = c.req.query('pattern');
    const collections = await store.listCollections(pattern);
    return c.json({ collections });
  });

  // ── Store: Specific routes BEFORE wildcards ──────────────────────────────

  // Keys
  app.get('/store/:collection/_keys', async (c) => {
    const collection = c.req.param('collection');
    const keys = await store.keys(collection);
    return c.json({ collection, keys });
  });

  // Search
  app.get('/store/:collection/_search', async (c) => {
    const collection = c.req.param('collection');
    const q = c.req.query('q') || '';
    const limit = parseInt(c.req.query('limit') || '20', 10);
    if (!q) return c.json({ error: 'Missing ?q= parameter' }, 400);
    const results = await store.search(collection, { query: q, type: 'bm25', limit });
    return c.json({ collection, query: q, results });
  });

  // Has
  app.get('/store/:collection/_has', async (c) => {
    const path = c.req.param('collection');
    const exists = await store.has(path);
    return c.json({ path, exists });
  });

  // Metadata
  app.get('/store/:collection/_metadata', async (c) => {
    const collection = c.req.param('collection');
    const metadata = await store.getCollectionMetadata(collection);
    return c.json({ collection, metadata });
  });

  app.put('/store/:collection/_metadata', async (c) => {
    const collection = c.req.param('collection');
    const body = await c.req.json();
    await store.setCollectionMetadata(collection, body);
    return c.json({ ok: true, collection });
  });

  // Schema
  app.get('/store/:collection/_schema', async (c) => {
    const collection = c.req.param('collection');
    const schema = await store.getSchema(collection);
    return c.json({ collection, schema });
  });

  // Structured query
  app.post('/store/:collection/_query', async (c) => {
    const collection = c.req.param('collection');
    const body = await c.req.json();
    const results = await store.query(collection, body);
    return c.json({ collection, results });
  });

  // Upsert
  app.post('/store/:collection/_upsert', async (c) => {
    const collection = c.req.param('collection');
    const body = await c.req.json();
    const { data, idField } = body;
    if (!data) return c.json({ error: 'Missing "data" field' }, 400);
    const result = await store.upsertByKey(collection, data, { idField }) as any;
    return c.json({ ok: true, collection, result }, 201);
  });

  // Clear
  app.delete('/store/:collection/_clear', async (c) => {
    const collection = c.req.param('collection');
    await store.clear(collection);
    return c.json({ ok: true, cleared: collection });
  });

  // ── Store: Wildcard CRUD (must come AFTER specific _underscore routes) ──

  // GET data
  app.get('/store/:collection{.+}', async (c) => {
    const path = c.req.param('collection');
    const data = await store.get(path);
    if (data === null) return c.json({ error: 'Not found', path }, 404);
    return c.json({ path, data });
  });

  // POST — set data
  app.post('/store/:collection{.+}', async (c) => {
    const path = c.req.param('collection');
    const body = await c.req.json();
    await store.set(path, body);
    return c.json({ ok: true, path }, 201);
  });

  // PUT — overwrite
  app.put('/store/:collection{.+}', async (c) => {
    const path = c.req.param('collection');
    const body = await c.req.json();
    await store.set(path, body);
    return c.json({ ok: true, path });
  });

  // PATCH — merge
  app.patch('/store/:collection{.+}', async (c) => {
    const path = c.req.param('collection');
    const body = await c.req.json();
    await store.patch(path, body);
    return c.json({ ok: true, path });
  });

  // DELETE
  app.delete('/store/:collection{.+}', async (c) => {
    const path = c.req.param('collection');
    await store.delete(path);
    return c.json({ ok: true, deleted: path });
  });

  // ── Batch (with size limits) ───────────────────────────────────────────

  const MAX_BATCH_SIZE = 1000;

  app.post('/_batch/get', async (c) => {
    const { paths } = await c.req.json();
    if (!Array.isArray(paths)) return c.json({ error: '"paths" must be an array' }, 400);
    if (paths.length > MAX_BATCH_SIZE) return c.json({ error: `Batch size exceeds limit of ${MAX_BATCH_SIZE}` }, 400);
    const results = await store.batchGet(paths);
    return c.json({ results });
  });

  app.post('/_batch/set', async (c) => {
    const { entries } = await c.req.json();
    if (!Array.isArray(entries)) return c.json({ error: '"entries" must be an array of {path, data}' }, 400);
    if (entries.length > MAX_BATCH_SIZE) return c.json({ error: `Batch size exceeds limit of ${MAX_BATCH_SIZE}` }, 400);
    await store.batchSet(entries);
    return c.json({ ok: true, count: entries.length });
  });

  app.post('/_batch/delete', async (c) => {
    const { paths } = await c.req.json();
    if (!Array.isArray(paths)) return c.json({ error: '"paths" must be an array' }, 400);
    if (paths.length > MAX_BATCH_SIZE) return c.json({ error: `Batch size exceeds limit of ${MAX_BATCH_SIZE}` }, 400);
    await store.batchDelete(paths);
    return c.json({ ok: true, count: paths.length });
  });

  // ── Tree / Namespaces ──────────────────────────────────────────────────

  app.get('/tree', async (c) => {
    if (!store.tree) return c.json({ error: 'tree not available' }, 501);
    const path = c.req.query('path') || '';
    const tree = await store.tree(path);
    return c.json(tree);
  });

  app.get('/namespaces', async (c) => {
    if (!store.listNamespaces) return c.json({ error: 'listNamespaces not available' }, 501);
    const parent = c.req.query('parent');
    const namespaces = await store.listNamespaces(parent);
    return c.json({ namespaces });
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  app.post('/hooks/:collection', async (c) => {
    const collection = c.req.param('collection');
    const body = await c.req.json();
    const timestamp = Date.now();
    const key = `${collection}/${timestamp}`;
    const payload = {
      _ts: new Date(timestamp).toISOString(),
      _source: c.req.header('X-Source') || 'webhook',
      ...body,
    };
    await store.set(key, payload);
    return c.json({ ok: true, key }, 201);
  });

  return app;
}
