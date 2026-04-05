/**
 * Smallstore - Big surface area for small pockets of data storage
 * 
 * A standalone, architecture-first storage abstraction library with:
 * - Collection-based addressing ("favorites", "research/papers/2024")
 * - Smart routing (analyze data → route to best adapter)
 * - Heterogeneous data (JSON, arrays, blobs, vectors in one collection)
 * - Multiple backends (Memory, Upstash, SQLite, R2, Cloudflare Workers, etc.)
 * - Full-text search (FTS5/BM25), views, retrievers
 * - Structured SQL tables with typed columns
 * 
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter, createUpstashAdapter } from '@smallstore/core';
 *
 * // Create instance
 * const storage = createSmallstore({
 *   adapters: {
 *     memory: createMemoryAdapter(),
 *     upstash: createUpstashAdapter({ url: '...', token: '...' }),
 *   },
 *   defaultAdapter: 'memory',
 * });
 * 
 * // Store heterogeneous data (smart routing!)
 * await storage.set("podcast-research-2024", {
 *   episodes: [...],      // Array
 *   transcripts: [...],   // Large blobs
 *   notes: "..."          // Small text
 * });
 * 
 * // Folder-like paths
 * await storage.set("research/papers/2024/quantum", paperData);
 * 
 * // Get data
 * const data = await storage.get("podcast-research-2024");
 * 
 * // List collection
 * const keys = await storage.keys("research/papers");
 * 
 * // Get schema (what's stored where)
 * const schema = await storage.getSchema("podcast-research-2024");
 * ```
 */

// ============================================================================
// Core Types
// ============================================================================

import type { Smallstore } from './src/types.ts';

export type {
  // Main interface
  Smallstore,
  
  // Data types
  DataType,
  DataAnalysis,
  
  // Adapter
  AdapterCapabilities,
  
  // Options
  GetOptions,
  SetOptions,
  
  // Schema
  CollectionSchema,
  PathInfo,
  
  // Routing
  RoutingDecision,
  
  // Phase 2: Retrieval types
  RetrievalAdapter,
  RetrievalCapabilities,
  RetrievalOptions,
  RetrievalResult,
  RetrievalMetadata,
  RetrievalStep,
  
  // Phase 2.5: Views & Namespace types
  ViewDefinition,
  NamespaceTree,
  NamespaceOptions,
  NamespaceStat,
  TreeOptions,
  CopyOptions,

  // Phase 2.6: Input Validation & Filtering types
  FieldFilter,
  
  // Phase 3: Key Index types
  KeyIndex,
  KeyLocation,
  
  // Search & Views
  SearchOptions,
  SearchResult,
  IndexDefinition,
  ViewOptions,
  QueryFilter,

  // Search Provider Plugin
  SearchProvider,
  SearchProviderOptions,
  SearchProviderResult,

  // Query & Cache types
  QueryOptions,
  QueryResult,
  QueryMetadata,
  PaginationMetadata,
  RangeMetadata,
  Cursor,
  QueryCacheOptions,
  CachingConfig,
  CachedResult,
  CacheStats,
  ExternalQueryOptions,
  ExternalSource,
  RegisterExternalOptions,

  // Data operation types
  SliceOptions,
  SplitOptions,
  DeduplicateOptions,
  MergeOptions,
  MoveOptions,
  CopyOperationOptions,
  DeleteFromArrayOptions,
  ResyncOptions,
  ResyncResult,
  ValidationResult,
  FilterOperators,
  FilterObject,
  SignedUrlOptions,
} from './src/types.ts';

// ============================================================================
// Adapters
// ============================================================================

export type { StorageAdapter, AdapterQueryOptions, AdapterQueryResult } from './src/adapters/adapter.ts';
export {
  canHandleType,
  canHandleSize,
  getCostTier,
  getReadLatency,
  getWriteLatency,
  validateAdapter,
} from './src/adapters/adapter.ts';

export { MemoryAdapter, createMemoryAdapter } from './src/adapters/memory.ts';
export type { UpstashConfig } from './src/adapters/upstash.ts';
export { UpstashAdapter, createUpstashAdapter } from './src/adapters/upstash.ts';
// R2 Direct adapter (S3-compatible, uses @aws-sdk/client-s3)
export type { R2DirectAdapterConfig } from './src/adapters/r2-direct.ts';
export { R2DirectAdapter, createR2DirectAdapter } from './src/adapters/r2-direct.ts';

// F2-R2 adapter (Cloudflare R2 via F2 proxy service)
export type { F2R2AdapterConfig } from './src/adapters/f2-r2.ts';
export { F2R2Adapter, createF2R2Adapter } from './src/adapters/f2-r2.ts';

// Phase 3.1: Unstorage adapters
export type { UnstorageDriver, UnstorageAdapterConfig } from './src/adapters/unstorage.ts';
export { UnstorageAdapter, createUnstorageAdapter } from './src/adapters/unstorage.ts';

// Phase 3.1: Structured data adapters
export type { NotionAdapterConfig, NotionSchemaMapping } from './src/adapters/notion.ts';
export { NotionDatabaseAdapter, createNotionAdapter } from './src/adapters/notion.ts';
export type { AirtableAdapterConfig, AirtableSchemaMapping } from './src/adapters/airtable.ts';
export { AirtableAdapter, createAirtableAdapter } from './src/adapters/airtable.ts';
export type { SheetlogConfig } from './src/adapters/sheetlog.ts';
export { SheetlogAdapter, createSheetlogAdapter } from './src/adapters/sheetlog.ts';

// Cloudflare Workers adapters
export { CloudflareKVAdapter, createCloudflareKVAdapter } from './src/adapters/cloudflare-kv.ts';
export type { CloudflareKVConfig } from './src/adapters/cloudflare-kv.ts';

export { CloudflareR2Adapter, createCloudflareR2Adapter } from './src/adapters/cloudflare-r2.ts';
export type { CloudflareR2Config } from './src/adapters/cloudflare-r2.ts';

export { CloudflareD1Adapter, createCloudflareD1Adapter } from './src/adapters/cloudflare-d1.ts';
export type { CloudflareD1Config } from './src/adapters/cloudflare-d1.ts';

export { CloudflareDOAdapter, createCloudflareDOAdapter } from './src/adapters/cloudflare-do.ts';
export type { CloudflareDOConfig } from './src/adapters/cloudflare-do.ts';

// Cloudflare Workers helpers
export { getCloudflareWorkersUrl, getCloudflareConfig } from './src/adapters/helpers/cloudflare-config.ts';

// Local JSON file adapter (for development/testing)
export type { LocalJsonConfig } from './src/adapters/local-json.ts';
export { LocalJsonAdapter, createLocalJsonAdapter } from './src/adapters/local-json.ts';

// SQLite adapter (local file or remote Turso)
export type { SQLiteAdapterConfig } from './src/adapters/sqlite.ts';
export { SQLiteAdapter, createSQLiteAdapter } from './src/adapters/sqlite.ts';

// Local file adapter (raw binary/blob storage on disk)
export type { LocalFileConfig } from './src/adapters/local-file.ts';
export { LocalFileAdapter, createLocalFileAdapter } from './src/adapters/local-file.ts';

// Deno filesystem adapter (real directory as a store)
export type { DenoFsConfig } from './src/adapters/deno-fs.ts';
export { DenoFsAdapter, createDenoFsAdapter } from './src/adapters/deno-fs.ts';

// Overlay adapter (COW read-through for speculative execution)
export type { OverlayAdapterOptions, OverlayDiff, CommitResult, SnapshotInfo } from './src/adapters/overlay.ts';
export { OverlayAdapter, createOverlayAdapter } from './src/adapters/overlay.ts';

// Structured SQLite adapter (real SQL tables with typed columns)
export type { StructuredSQLiteConfig, TableSchema, ColumnDef, IndexDef, ColumnType } from './src/adapters/structured-sqlite.ts';
export { StructuredSQLiteAdapter, createStructuredSQLiteAdapter } from './src/adapters/structured-sqlite.ts';

// ============================================================================
// Phase 2: Retrieval Adapters
// ============================================================================

export {
  MetadataRetriever,
  SliceRetriever,
  FilterRetriever,
  StructuredRetriever,
  TextRetriever,
  FlattenRetriever,
  createMetadata,
} from './src/retrievers/mod.ts';

export type {
  MetadataRetrieverOptions,
  SliceRetrieverOptions,
  FilterRetrieverOptions,
  StructuredRetrieverOptions,
  TextRetrieverOptions,
  FlattenRetrieverOptions,
} from './src/retrievers/mod.ts';

// ============================================================================
// Phase 2.5: Views & Namespace
// ============================================================================

export { ViewManager } from './src/views/mod.ts';
export {
  buildViewKey,
  isViewKey,
  getViewNameFromKey,
  saveView,
  loadView,
  deleteView as deleteViewStorage,
  listViews as listViewsStorage,
} from './src/views/mod.ts';

export { buildTree } from './src/namespace/tree.ts';
export {
  getNamespace as getNamespaceOp,
  copy as copyOp,
  move as moveOp,
  copyNamespace as copyNamespaceOp,
} from './src/namespace/operations.ts';

// ============================================================================
// Phase 2.6: Input Validation & Filtering
// ============================================================================

export {
  processInput,
  validateInput,
  transformInput,
} from './src/validation/mod.ts';

// ============================================================================
// Phase 3: Key Index Management
// ============================================================================

export {
  saveIndex,
  loadIndex,
  deleteIndex,
  addKeyToIndex,
  removeKeyFromIndex,
  getKeyLocation,
  createEmptyIndex,
} from './src/keyindex/mod.ts';

// ============================================================================
// Search Providers
// ============================================================================

export { extractSearchableText, SqliteFtsSearchProvider, MemoryBm25SearchProvider } from './src/search/mod.ts';
export { MemoryVectorSearchProvider, type MemoryVectorConfig } from './src/search/mod.ts';
export { MemoryHybridSearchProvider, type MemoryHybridConfig } from './src/search/mod.ts';
export { ZvecSearchProvider, type ZvecConfig } from './src/search/mod.ts';
export {
  createEmbed,
  createHuggingFaceEmbed,
  createOpenAIEmbed,
  type EmbedFunction,
  type BatchEmbedFunction,
  type EmbedConfig,
  type HuggingFaceEmbedConfig,
  type OpenAIEmbedConfig,
} from './src/search/mod.ts';

// ============================================================================
// Router
// ============================================================================

export type { SmartRouterConfig } from './src/router.ts';
export { SmartRouter, createSmartRouter } from './src/router.ts';
import { createSmartRouter } from './src/router.ts'; // For factory function

// ============================================================================
// Utilities
// ============================================================================

export { analyzeData, detectDataType, calculateSize, formatSize } from './src/detector.ts';
export type { ParsedPath } from './src/utils/path.ts';
export {
  parsePath,
  buildKey,
  joinPath,
  buildMetadataKey,
  isMetadataKey,
  getCollectionFromMetadataKey,
  // Phase 2.5: View & namespace utilities
  isViewPath,
  stripViewSuffix,
  getNamespace,
  getAllPathsUnder,
  getPathFromKey,
  isUnderNamespace,
  // Phase 3: Key index utilities
  buildIndexKey,
  isIndexKey,
  getCollectionFromIndexKey,
} from './src/utils/path.ts';
export {
  parseSize,
  isWithinLimit,
  validateSize,
  formatSizeBytes,
} from './src/utils/size.ts';
export {
  isGlobPattern,
  globToRegex,
  matchGlob,
  extractStaticPrefix,
} from './src/utils/glob.ts';

// Phase 3.2: Extensions and response utilities
export type { ParsedExtension } from './src/utils/extensions.ts';
export {
  parseExtension,
  getMimeType,
  inferDataType,
  getImplicitExtension,
  getMimeTypeForDataType,
} from './src/utils/extensions.ts';

export type { StorageFileResponse, WrapResponseOptions } from './src/utils/response.ts';
export {
  wrapResponse,
  wrapResponseWithoutIndex,
  extractContent,
  isBlob,
  isObject,
  isPrimitive,
} from './src/utils/response.ts';

// Phase 3.2: Materializers
export type { MaterializedJson, CsvOptions } from './src/materializers/mod.ts';
export {
  materializeJson,
  materializeJsonItem,
  materializeMarkdown,
  materializeMarkdownItem,
  materializeCsv,
  materializeCsvItem,
  materializeText,
  materializeTextItem,
  materializeYaml,
  materializeYamlItem,
} from './src/materializers/mod.ts';

// Phase 3.2: File Explorer
export { FileExplorer } from './src/explorer/mod.ts';
export type { FileMetadata, TreeOptions as FileExplorerTreeOptions } from './src/explorer/mod.ts';

// ============================================================================
// Graph Module
// ============================================================================

export { GraphStore, createGraphStore } from './src/graph/mod.ts';
export type {
  GraphNode,
  GraphNodeInput,
  GraphEdge,
  GraphEdgeInput,
  GraphRelationship,
  GraphQuery,
  GraphQueryResult,
  GraphQueryMetadata,
  TraversalPattern,
  GraphPath,
  GraphStats,
  GraphStoreOptions,
} from './src/graph/mod.ts';
export { GraphQueryBuilder, bfs, dfs, shortestPath as graphShortestPath } from './src/graph/mod.ts';

// ============================================================================
// HTTP Module (Framework-Agnostic Handlers)
// ============================================================================

// Re-export HTTP types and handlers for convenience
// Full module available at './http/mod.ts'
export type {
  SmallstoreRequest,
  SmallstoreResponse,
  SmallstoreHandler,
  SmallstoreInstance,
} from './src/http/types.ts';

export {
  createHonoRoutes,
  createHonoRouter,
  handleGet as httpHandleGet,
  handleSet as httpHandleSet,
  handleDelete as httpHandleDelete,
  handleListCollections as httpHandleListCollections,
} from './src/http/mod.ts';

// ============================================================================
// Factory: Simplified Smallstore Creation
// ============================================================================

// SmallstoreConfig — defined in types.ts to avoid circular imports
export type { SmallstoreConfig } from './src/types.ts';
import type { SmallstoreConfig } from './src/types.ts';

// ============================================================================
// Presets
// ============================================================================

export type { PresetName, PresetConfig } from './presets.ts';
export { getPreset, resolvePreset } from './presets.ts';
import { resolvePreset } from './presets.ts';
import type { PresetConfig } from './presets.ts';

/**
 * Create a Smallstore instance
 *
 * Accepts either a full config or a preset-based config.
 *
 * @param config - Smallstore configuration (with optional preset)
 * @returns Smallstore instance
 *
 * @example
 * ```typescript
 * import { createSmallstore, createMemoryAdapter, createUpstashAdapter } from '@smallstore/core';
 *
 * // One-liner with preset
 * const store = createSmallstore({ preset: 'local' });
 *
 * // Preset with overrides
 * const store = createSmallstore({
 *   preset: 'local',
 *   mounts: { 'archive/*': 'sqlite-archive' },
 * });
 *
 * // Full manual config
 * const storage = createSmallstore({
 *   adapters: {
 *     memory: createMemoryAdapter(),
 *     upstash: createUpstashAdapter({
 *       url: UPSTASH_URL!,
 *       token: UPSTASH_TOKEN!,
 *     }),
 *   },
 *   defaultAdapter: 'memory',
 * });
 * ```
 */
export function createSmallstore(config: SmallstoreConfig | PresetConfig): Smallstore {
  // Resolve preset if present
  const resolved = 'preset' in config && config.preset
    ? resolvePreset(config as PresetConfig)
    : config as SmallstoreConfig;

  return createSmartRouter({
    adapters: resolved.adapters,
    defaultAdapter: resolved.defaultAdapter,
    metadataAdapter: resolved.metadataAdapter || 'memory',
    typeRouting: resolved.typeRouting,
    routing: resolved.routing,
    mounts: resolved.mounts,
    smartRouting: resolved.smartRouting ?? false,
    caching: resolved.caching,
  });
}

// ============================================================================
// Progressive Disclosure
// ============================================================================

export {
  ProgressiveStore,
  createProgressiveStore,
  RelevanceScorer,
  createRelevanceScorer,
  Summarizer,
  createSummarizer,
  SkillsManager,
  createSkillsManager,
  createSkill,
  EXAMPLE_SKILLS,
  sortByRelevance,
  filterByThreshold,
  topN,
} from './src/disclosure/mod.ts';

export type {
  DisclosureLevel,
  Skill,
  DisclosureContext,
  DisclosedData,
  DisclosedOverview,
  DiscoveryResult,
  CollectionOverview,
  SummarizationOptions,
  RelevanceConfig,
  ProgressiveStoreConfig,
} from './src/disclosure/mod.ts';

// ============================================================================
// Episodic Memory Module
// ============================================================================

export { EpisodicStore, createEpisodicStore } from './src/episodic/mod.ts';

export type {
  Episode,
  EpisodeContext,
  Sequence,
  RecallQuery,
  DecayOptions,
  DecayResult,
  EpisodicStoreConfig,
} from './src/episodic/mod.ts';

// Episodic decay algorithms (for advanced use)
export {
  DEFAULT_DECAY_OPTIONS,
  calculateCurrentImportance,
  hasDecayed,
  analyzeDecay,
  filterActive as filterActiveEpisodes,
  filterDecayed as filterDecayedEpisodes,
  boostImportance,
} from './src/episodic/mod.ts';

// Episodic timeline operations (for advanced use)
export {
  filterByTimeRange,
  filterBySequence,
  filterByTags,
  sortByTimestamp,
  applyQuery as applyEpisodicQuery,
  getTimeWindow,
  getMostRecent,
  getOldest,
} from './src/episodic/mod.ts';

// Episodic recall functions (for advanced use)
export {
  recallByRelevance,
  recallRecent,
  recallImportant,
  recallFrequent,
  getRecallStats,
} from './src/episodic/mod.ts';

// ============================================================================
// Blob Middleware
// ============================================================================

export { withBlobs } from './src/blob-middleware/mod.ts';
export { BlobResolver } from './src/blob-middleware/resolver.ts';
export { isBlobInput, detectBlobFields } from './src/blob-middleware/detector.ts';
export { formatForPlatform, toAirtableAttachment, toNotionFile } from './src/blob-middleware/formats.ts';
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
} from './src/blob-middleware/types.ts';
export type { DetectedBlobField } from './src/blob-middleware/detector.ts';
export type { AirtableAttachment, NotionFile } from './src/blob-middleware/formats.ts';

// ============================================================================
// Adapter Sync
// ============================================================================

export { syncAdapters } from './src/sync.ts';
export type {
  SyncMode,
  SyncAdapterOptions,
  SyncResult,
  SyncError,
  SyncProgressEvent,
  ConflictResolution,
  SyncBaseline,
} from './src/sync.ts';

// ============================================================================
// Notion Block Utilities
// ============================================================================

export {
  markdownToBlocks,
  blocksToMarkdown,
  parseMarkdownInline,
  notionRichTextToMarkdown,
} from './src/clients/notion/notionBlocks.ts';
export type { RichTextItem, NotionBlock } from './src/clients/notion/notionBlocks.ts';

// ============================================================================
// VFS — Bash-like virtual filesystem for agents
// ============================================================================

export { vfs } from './apps/cli/vfs.ts';
export type { VfsState, VfsResult, VfsOptions, VfsContext, VfsCommandResult, VfsCommandFn } from './apps/cli/vfs.ts';

// ============================================================================
// Unified Retrieval Layer
// ============================================================================

export type {
  RetrievalProvider,
  RetrievalProviderType,
  RetrievalInput,
  RetrievalOutput,
  RetrievalOutputMeta,
  PipelineStep,
} from './src/retrieval/mod.ts';

export {
  RetrievalPipeline,
  SearchProviderWrapper,
  RetrieverWrapper,
  DisclosureWrapper,
} from './src/retrieval/mod.ts';

