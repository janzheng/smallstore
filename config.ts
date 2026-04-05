/**
 * Smallstore Configuration Hub
 *
 * Single source of truth for all adapter configuration:
 * - Env var resolvers (shared by presets.ts and serve.ts)
 * - Adapter factory (creates adapter instances from config objects)
 * - Server config loader (.smallstore.json > env vars > defaults)
 * - All adapter config types
 *
 * Priority: .smallstore.json > environment variables > defaults
 *
 * @example
 * ```typescript
 * import { loadConfig, buildAdapterInstance } from './config.ts';
 *
 * const config = await loadConfig();
 * const adapter = buildAdapterInstance('upstash', config.adapters.upstash);
 * ```
 */

import { getEnv, getEnvOrDefault } from './src/utils/env.ts';

// ============================================================================
// Types
// ============================================================================

export interface SmallstoreServerConfig {
  /** Server port (default: 9999) */
  port: number;

  /** Base directory for local file storage (default: ./data) */
  dataDir: string;

  /** Use a named preset as the base configuration */
  preset?: 'memory' | 'local' | 'local-sqlite' | 'cloud' | 'hybrid';

  /** Adapter configurations */
  adapters: Record<string, AdapterConfig>;

  /** Default adapter name (default: 'memory') */
  defaultAdapter: string;

  /** Path-based adapter mounting (e.g., "media/*": "local") */
  mounts?: Record<string, string>;

  /** Type-based routing (e.g., blob: "local", kv: "memory") */
  typeRouting?: {
    blob?: string;
    object?: string;
    kv?: string;
  };
}

export type AdapterConfig =
  | MemoryAdapterConfig
  | LocalAdapterConfig
  | LocalFileAdapterConfig
  | UpstashAdapterConfig
  | SQLiteAdapterServerConfig
  | AirtableAdapterConfig
  | NotionAdapterConfig
  | SheetlogAdapterConfig
  | CloudflareKVAdapterConfig
  | CloudflareD1AdapterConfig
  | CloudflareDOAdapterConfig
  | R2DirectAdapterConfig;

export interface MemoryAdapterConfig {
  type?: 'memory';
}

export interface LocalAdapterConfig {
  type?: 'local';
  baseDir?: string;
}

export interface UpstashAdapterConfig {
  type?: 'upstash';
  url?: string;
  token?: string;
}

export interface LocalFileAdapterConfig {
  type?: 'local-file';
  /** Base directory for storing files (default: ./data/files) */
  baseDir?: string;
}

export interface SQLiteAdapterServerConfig {
  type?: 'sqlite';
  /** Database file path (default: ./data/store.db) */
  path?: string;
  /** Table name (default: kv_store) */
  table?: string;
}

export interface AirtableAdapterConfig {
  type?: 'airtable';
  apiKey?: string;
  baseId?: string;
  table?: string;
}

export interface NotionAdapterConfig {
  type?: 'notion';
  secret?: string;
  databaseId?: string;
}

export interface SheetlogAdapterConfig {
  type?: 'sheetlog';
  sheetUrl?: string;
  sheet?: string;
}

export interface CloudflareKVAdapterConfig {
  type?: 'cloudflare-kv';
  baseUrl?: string;
  namespace?: string;
}

export interface CloudflareD1AdapterConfig {
  type?: 'cloudflare-d1';
  baseUrl?: string;
  table?: string;
}

export interface CloudflareDOAdapterConfig {
  type?: 'cloudflare-do';
  baseUrl?: string;
  instanceId?: string;
}

export interface R2DirectAdapterConfig {
  type?: 'r2';
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName?: string;
}

// ============================================================================
// Shared Env Var Resolvers
//
// Single source of truth for env var names + fallback order.
// Used by buildAdaptersFromEnv() and presets.ts.
// ============================================================================

export function resolveUpstashEnv() {
  return {
    url: getEnv('SM_UPSTASH_URL') || getEnv('UPSTASH_REDIS_REST_URL'),
    token: getEnv('SM_UPSTASH_TOKEN') || getEnv('UPSTASH_REDIS_REST_TOKEN'),
  };
}

export function resolveAirtableEnv() {
  return {
    apiKey: getEnv('SM_AIRTABLE_API_KEY') || getEnv('AIRTABLE_API_KEY'),
    baseId: getEnv('SM_AIRTABLE_BASE_ID') || getEnv('AIRTABLE_BASE_ID'),
    table: getEnv('SM_AIRTABLE_TABLE') || getEnv('AIRTABLE_TABLE'),
  };
}

export function resolveNotionEnv() {
  return {
    secret: getEnv('SM_NOTION_SECRET') || getEnv('NOTION_API_KEY'),
    databaseId: getEnv('SM_NOTION_DATABASE_ID') || getEnv('NOTION_DATABASE_ID'),
  };
}

export function resolveSheetlogEnv() {
  return {
    sheetUrl: getEnv('SM_SHEET_URL') || getEnv('SHEET_URL'),
    sheet: getEnv('SM_SHEET_NAME') || getEnv('SHEET_NAME') || 'Sheet1',
  };
}

export function resolveCloudflareWorkersEnv() {
  return {
    baseUrl: getEnv('SM_WORKERS_URL') || getEnv('COVERFLOW_WORKERS_URL'),
  };
}

export function resolveR2Env() {
  return {
    accountId: getEnv('SM_R2_ACCOUNT_ID') || getEnv('R2_ACCOUNT_ID'),
    accessKeyId: getEnv('SM_R2_ACCESS_KEY_ID') || getEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getEnv('SM_R2_SECRET_ACCESS_KEY') || getEnv('R2_SECRET_ACCESS_KEY'),
    bucketName: getEnv('SM_R2_BUCKET_NAME') || getEnv('R2_BUCKET_NAME'),
  };
}

export function resolveF2Env() {
  return {
    f2Url: getEnv('F2_DEFAULT_URL') || getEnv('F2_URL') || getEnv('FUZZYFILE_URL'),
    authKey: getEnv('F2_AUTH_KEY') || getEnv('F2_DELETE_AUTH_KEY'),
  };
}

/** Check if credentials are present for a given adapter type */
export function hasEnvCredentials(type: 'upstash' | 'airtable' | 'notion' | 'sheetlog' | 'cloudflare' | 'r2'): boolean {
  switch (type) {
    case 'upstash': { const e = resolveUpstashEnv(); return !!(e.url && e.token); }
    case 'airtable': { const e = resolveAirtableEnv(); return !!(e.apiKey && e.baseId); }
    case 'notion': { const e = resolveNotionEnv(); return !!(e.secret && e.databaseId); }
    case 'sheetlog': { const e = resolveSheetlogEnv(); return !!e.sheetUrl; }
    case 'cloudflare': { const e = resolveCloudflareWorkersEnv(); return !!e.baseUrl; }
    case 'r2': { const e = resolveR2Env(); return !!(e.accountId && e.accessKeyId && e.secretAccessKey && e.bucketName); }
  }
}

// ============================================================================
// Adapter Factory
//
// Creates adapter instances from config objects. Used by serve.ts and presets.ts.
// Lazy-imports adapter modules to avoid loading unused SDKs at startup.
// ============================================================================

import type { StorageAdapter } from './src/adapters/adapter.ts';

/**
 * Create an adapter instance from a type name and config object.
 * Returns null if required credentials are missing.
 */
export async function buildAdapterInstance(
  type: string,
  config: AdapterConfig,
  defaults?: { dataDir?: string },
): Promise<StorageAdapter | null> {
  const dataDir = defaults?.dataDir || './data';

  switch (type) {
    case 'memory': {
      const { createMemoryAdapter } = await import('./src/adapters/memory.ts');
      return createMemoryAdapter();
    }

    case 'local': {
      const { createLocalJsonAdapter } = await import('./src/adapters/local-json.ts');
      const c = config as LocalAdapterConfig;
      return createLocalJsonAdapter({ baseDir: c.baseDir || dataDir });
    }

    case 'local-file': {
      const { createLocalFileAdapter } = await import('./src/adapters/local-file.ts');
      const c = config as LocalFileAdapterConfig;
      return createLocalFileAdapter({ baseDir: c.baseDir || `${dataDir}/files` });
    }

    case 'sqlite': {
      const { createSQLiteAdapter } = await import('./src/adapters/sqlite.ts');
      const c = config as SQLiteAdapterServerConfig;
      return createSQLiteAdapter({ path: c.path || `${dataDir}/store.db`, table: c.table });
    }

    case 'upstash': {
      const { createUpstashAdapter } = await import('./src/adapters/upstash.ts');
      const c = config as UpstashAdapterConfig;
      if (!c.url || !c.token) { console.warn('[Smallstore] Skipping upstash: missing url or token'); return null; }
      return createUpstashAdapter({ url: c.url, token: c.token });
    }

    case 'airtable': {
      const { createAirtableAdapter } = await import('./src/adapters/airtable.ts');
      const c = config as AirtableAdapterConfig;
      if (!c.apiKey || !c.baseId) { console.warn('[Smallstore] Skipping airtable: missing apiKey or baseId'); return null; }
      return createAirtableAdapter({ apiKey: c.apiKey, baseId: c.baseId, tableIdOrName: c.table || 'smallstore' });
    }

    case 'notion': {
      const { createNotionAdapter } = await import('./src/adapters/notion.ts');
      const c = config as NotionAdapterConfig;
      if (!c.secret || !c.databaseId) { console.warn('[Smallstore] Skipping notion: missing secret or databaseId'); return null; }
      return createNotionAdapter({ notionSecret: c.secret, databaseId: c.databaseId });
    }

    case 'sheetlog': {
      const { createSheetlogAdapter } = await import('./src/adapters/sheetlog.ts');
      const c = config as SheetlogAdapterConfig;
      if (!c.sheetUrl) { console.warn('[Smallstore] Skipping sheetlog: missing sheetUrl'); return null; }
      return createSheetlogAdapter({ sheetUrl: c.sheetUrl, sheet: c.sheet || 'Sheet1' });
    }

    case 'cloudflare-kv': {
      const { CloudflareKVAdapter } = await import('./src/adapters/cloudflare-kv.ts');
      const c = config as CloudflareKVAdapterConfig;
      if (!c.baseUrl) { console.warn('[Smallstore] Skipping cloudflare-kv: missing baseUrl'); return null; }
      return new CloudflareKVAdapter({ baseUrl: c.baseUrl, namespace: c.namespace || 'smallstore' });
    }

    case 'cloudflare-d1': {
      const { CloudflareD1Adapter } = await import('./src/adapters/cloudflare-d1.ts');
      const c = config as CloudflareD1AdapterConfig;
      if (!c.baseUrl) { console.warn('[Smallstore] Skipping cloudflare-d1: missing baseUrl'); return null; }
      return new CloudflareD1Adapter({ baseUrl: c.baseUrl, table: c.table || 'smallstore' });
    }

    case 'cloudflare-do': {
      const { CloudflareDOAdapter } = await import('./src/adapters/cloudflare-do.ts');
      const c = config as CloudflareDOAdapterConfig;
      if (!c.baseUrl) { console.warn('[Smallstore] Skipping cloudflare-do: missing baseUrl'); return null; }
      return new CloudflareDOAdapter({ baseUrl: c.baseUrl, instanceId: c.instanceId || 'smallstore' });
    }

    case 'r2': {
      const { R2DirectAdapter } = await import('./src/adapters/r2-direct.ts');
      const c = config as R2DirectAdapterConfig;
      if (!c.accountId || !c.accessKeyId || !c.secretAccessKey || !c.bucketName) {
        console.warn('[Smallstore] Skipping r2: missing credentials');
        return null;
      }
      return new R2DirectAdapter({ accountId: c.accountId, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, bucketName: c.bucketName });
    }

    default:
      console.warn(`[Smallstore] Unknown adapter type "${type}", skipping`);
      return null;
  }
}

/**
 * Build all adapter instances from a config record.
 * Ensures at least 'memory' is always available.
 */
export async function buildAdapters(
  adapterConfigs: Record<string, AdapterConfig>,
  defaults?: { dataDir?: string },
): Promise<Record<string, StorageAdapter>> {
  const adapters: Record<string, StorageAdapter> = {};

  for (const [name, config] of Object.entries(adapterConfigs)) {
    const type = (config as any).type || name;
    const instance = await buildAdapterInstance(type, config, defaults);
    if (instance) adapters[name] = instance;
  }

  // Always ensure memory is available (needed by SmartRouter for metadata)
  if (!adapters.memory) {
    const { createMemoryAdapter } = await import('./src/adapters/memory.ts');
    adapters.memory = createMemoryAdapter();
  }

  return adapters;
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load configuration from .smallstore.json, env vars, or defaults.
 *
 * @param configPath - Path to config file (default: .smallstore.json in cwd)
 * @returns Resolved server configuration
 */
export async function loadConfig(
  configPath?: string,
): Promise<SmallstoreServerConfig> {
  const filePath = configPath || '.smallstore.json';

  // Try to load config file
  let fileConfig: Partial<SmallstoreServerConfig> = {};
  try {
    const text = await Deno.readTextFile(filePath);
    const raw = JSON.parse(text);
    fileConfig = substituteEnvVars(raw);
    console.log(`[Smallstore] Loaded config from ${filePath}`);
  } catch {
    // No config file — that's fine, use env/defaults
  }

  const hasPreset = !!(fileConfig as any).preset;
  const dataDir = fileConfig.dataDir ?? getEnvOrDefault('SM_DATA_DIR', './data');

  // Build config with priority: file > env > defaults
  // When a preset is specified, don't fall back to env adapters — preset provides them
  const config: SmallstoreServerConfig = {
    port: fileConfig.port
      ?? parseInt(getEnvOrDefault('SM_PORT', '9999'), 10),
    dataDir,
    preset: (fileConfig as any).preset,
    adapters: fileConfig.adapters
      ?? (hasPreset ? {} : buildAdapterConfigsFromEnv(dataDir)),
    defaultAdapter: fileConfig.defaultAdapter
      ?? (hasPreset ? 'memory' : getEnvOrDefault('SM_DEFAULT_ADAPTER', 'memory')),
    mounts: fileConfig.mounts,
    typeRouting: fileConfig.typeRouting,
  };

  return config;
}

/**
 * Build adapter config objects from environment variables.
 * Always includes memory + local. Adds cloud adapters if credentials are present.
 */
export function buildAdapterConfigsFromEnv(dataDir = './data'): Record<string, AdapterConfig> {
  const adapters: Record<string, AdapterConfig> = {
    memory: {},
    local: { type: 'local', baseDir: dataDir },
  };

  const upstash = resolveUpstashEnv();
  if (upstash.url && upstash.token) {
    adapters.upstash = { type: 'upstash', ...upstash };
  }

  const airtable = resolveAirtableEnv();
  if (airtable.apiKey && airtable.baseId) {
    adapters.airtable = { type: 'airtable', ...airtable };
  }

  const notion = resolveNotionEnv();
  if (notion.secret && notion.databaseId) {
    adapters.notion = { type: 'notion', ...notion };
  }

  const sheetlog = resolveSheetlogEnv();
  if (sheetlog.sheetUrl) {
    adapters.sheetlog = { type: 'sheetlog', ...sheetlog };
  }

  const cf = resolveCloudflareWorkersEnv();
  if (cf.baseUrl) {
    adapters['cloudflare-kv'] = { type: 'cloudflare-kv', baseUrl: cf.baseUrl };
    adapters['cloudflare-d1'] = { type: 'cloudflare-d1', baseUrl: cf.baseUrl };
    adapters['cloudflare-do'] = { type: 'cloudflare-do', baseUrl: cf.baseUrl };
  }

  const r2 = resolveR2Env();
  if (r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucketName) {
    adapters.r2 = { type: 'r2', ...r2 };
  }

  return adapters;
}

/**
 * Recursively substitute $VAR references in config values with env var values.
 *
 * @example
 * { "url": "$UPSTASH_URL" } → { "url": "https://..." }
 */
function substituteEnvVars(obj: unknown): any {
  if (typeof obj === 'string') {
    // Replace $VAR patterns
    if (obj.startsWith('$') && !obj.includes(' ')) {
      const envKey = obj.slice(1);
      return getEnv(envKey) ?? obj;
    }
    // Replace ${VAR} patterns within strings
    return obj.replace(/\$\{([^}]+)\}/g, (_match, key) => {
      return getEnv(key) ?? `\${${key}}`;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}
