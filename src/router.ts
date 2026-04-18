/**
 * Smart Router
 * 
 * The brain of Smallstore - routes data to optimal adapters based on:
 * - Data type (json, array, array-large, blob, vector, etc.)
 * - Data size (bytes)
 * - Adapter capabilities (supported types, size limits, cost, performance)
 * - User preferences (adapter override)
 * 
 * Architecture:
 * 1. Analyze data (type, size) using detector
 * 2. Find candidate adapters that can handle this data
 * 3. Score candidates (type match, cost, performance)
 * 4. Pick best adapter
 */

import type { StorageAdapter } from './adapters/adapter.ts';
import type { 
  Smallstore, 
  GetOptions, 
  SetOptions, 
  CollectionSchema,
  PathInfo,
  SearchOptions,
  SearchResult,
  IndexDefinition,
  ViewOptions,
  QueryFilter,
  QueryOptions,
  QueryResult,
  RoutingDecision,
  RetrievalAdapter,
  RetrievalStep,
  KeyIndex,
  KeyLocation,
  DeleteFromArrayOptions,
  ResyncOptions,
  ResyncResult,
  ValidationResult,
  MergeOptions,
  SliceOptions,
  SplitOptions,
  DeduplicateOptions,
  ExternalSource,
  RegisterExternalOptions,
  CacheStats,
  SignedUrlOptions,
} from './types.ts';
import { analyzeData, detectDataType, calculateSize } from './detector.ts';
import { parsePath, buildKey, buildMetadataKey, joinPath, buildIndexKey } from './utils/path.ts';
import { isGlobPattern, globToRegex, extractStaticPrefix, matchGlob } from './utils/glob.ts';
import { loadIndex, saveIndex, addKeyToIndex, removeKeyFromIndex, createEmptyIndex, getKeyLocation } from './keyindex/mod.ts';
import { wrapResponse, wrapResponseWithoutIndex } from './utils/response.ts';
import { analyzeData as analyzeDataForType } from './detector.ts';
import { canHandleType, canHandleSize, getCostTier } from './adapters/adapter.ts';
import { UnsupportedOperationError } from './adapters/errors.ts';
import { 
  MetadataRetriever,
  SliceRetriever,
  FilterRetriever,
  StructuredRetriever,
  TextRetriever,
  FlattenRetriever,
} from './retrievers/mod.ts';
import { ViewManager } from './views/mod.ts';
import { MaterializedViewManager } from './views/materialized.ts';
import { buildTree } from './namespace/tree.ts';
import { 
  getNamespace as getNamespaceOp,
  copy as copyOp,
  move as moveOp,
  copyNamespace as copyNamespaceOp
} from './namespace/operations.ts';
import { processInput } from './validation/mod.ts';
import { CacheManager } from './utils/cache-manager.ts';
import { retry } from './utils/retry.ts';
import type { RetrievalProvider, PipelineStep, RetrievalInput, RetrievalOutput } from './retrieval/types.ts';
import { RetrievalPipeline } from './retrieval/pipeline.ts';
import { RetrieverWrapper } from './retrieval/adapters/retriever-adapter.ts';
import { SearchProviderWrapper } from './retrieval/adapters/search-adapter.ts';
import { debug } from './utils/debug.ts';
import { AsyncKeyLock } from './utils/async-lock.ts';
import {
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
} from './materializers/mod.ts';
import type { MaterializedJson, CsvOptions } from './materializers/mod.ts';

// ============================================================================
// Smart Router Config
// ============================================================================

/**
 * Smart router configuration
 */
export interface SmartRouterConfig {
  /** Available adapters (key = adapter name) */
  adapters: Record<string, StorageAdapter>;
  
  /** Default adapter name (fallback if routing fails) */
  defaultAdapter: string;
  
  /** Metadata adapter name (for collection schemas) */
  metadataAdapter: string;
  
  // Phase 3.1: Config-based routing
  
  /** Type-based routing (data type → adapter) */
  typeRouting?: {
    blob?: string;      // Adapter for blobs
    object?: string;    // Adapter for objects
    kv?: string;        // Adapter for primitives
  };
  
  /** Pattern-based routing (collection pattern → adapter) */
  routing?: {
    [pattern: string]: { adapter: string };
  };

  /** Path-based adapter mounting — simpler alias for routing */
  mounts?: Record<string, string>;

  /** Enable smart routing (disabled by default in Phase 3.1) */
  smartRouting?: boolean;
  
  // Phase 3.6h: Query Result Caching
  
  /** Caching configuration */
  caching?: {
    /** Enable automatic query result caching */
    enableQueryCache?: boolean;
    /** Default TTL for cached queries (milliseconds) */
    defaultTTL?: number;
    /** Maximum cache size before eviction */
    maxCacheSize?: string;
    /** Cache eviction policy */
    evictionPolicy?: 'lru' | 'lfu' | 'ttl-only';
    /** Adapter to use for cache storage */
    cacheAdapter?: string;
    /** Auto-invalidate caches when source data is written */
    autoInvalidate?: boolean;
  };
}

// ============================================================================
// Smart Router
// ============================================================================

/**
 * Smart Router - Routes data to optimal adapters
 * 
 * Implements the Smallstore interface, coordinating between multiple adapters.
 * 
 * Phase 2: Extended with retrieval adapter support
 * Phase 2.5: Extended with views and namespace operations
 */
export class SmartRouter implements Smallstore {
  private adapters: Record<string, StorageAdapter>;
  private defaultAdapter: string;
  private metadataAdapter: string;
  private retrievers: Map<string, RetrievalAdapter> = new Map();
  private retrievalProviders: Map<string, RetrievalProvider> = new Map();
  private viewManager: ViewManager;
  private materializedViewManager: MaterializedViewManager;  // Phase 3.6h-b: Materialized views
  private config: SmartRouterConfig;  // Phase 3.1: Store full config
  private cacheManager: CacheManager;  // Phase 3.6h: Query result caching
  private keyLock = new AsyncKeyLock();  // Per-key async mutex for read-modify-write

  constructor(config: SmartRouterConfig) {
    this.config = config;
    this.adapters = config.adapters;
    this.defaultAdapter = config.defaultAdapter;
    this.metadataAdapter = config.metadataAdapter;
    
    // Validate config
    if (!this.adapters[this.defaultAdapter]) {
      throw new Error(`Default adapter "${this.defaultAdapter}" not found in adapters`);
    }
    if (!this.adapters[this.metadataAdapter]) {
      throw new Error(`Metadata adapter "${this.metadataAdapter}" not found in adapters`);
    }
    
    // Register default retrievers (Phase 2)
    this.registerDefaultRetrievers();

    // Register unified retrieval providers (wraps existing retrievers + search)
    this.registerDefaultRetrievalProviders();

    // Initialize view manager (Phase 2.5)
    this.viewManager = new ViewManager(
      this.adapters[this.metadataAdapter],
      this.retrievers
    );
    
    // Initialize materialized view manager (Phase 3.6h-b)
    this.materializedViewManager = new MaterializedViewManager(
      this,  // Pass router for query execution
      this.adapters[this.metadataAdapter]
    );
    
    // Initialize cache manager (Phase 3.6h)
    const cacheAdapterName = config.caching?.cacheAdapter || this.metadataAdapter;
    this.cacheManager = new CacheManager(
      this.adapters[cacheAdapterName],
      config.caching || {}
    );
  }
  
  /**
   * Register default retrieval adapters (Phase 2)
   */
  private registerDefaultRetrievers() {
    const retrievers = [
      new MetadataRetriever(),
      new SliceRetriever(),
      new FilterRetriever(),
      new StructuredRetriever(),
      new TextRetriever(),
      new FlattenRetriever(),
    ];
    
    for (const retriever of retrievers) {
      this.retrievers.set(retriever.name, retriever);
    }
  }
  
  // ============================================================================
  // Unified Retrieval Layer
  // ============================================================================

  /**
   * Register default retrieval providers (wraps existing retrievers + search)
   */
  private registerDefaultRetrievalProviders() {
    // Wrap all existing retrievers
    for (const [, retriever] of this.retrievers) {
      const wrapped = new RetrieverWrapper(retriever);
      this.retrievalProviders.set(wrapped.name, wrapped);
    }

    // Wrap search providers from all adapters
    for (const [adapterName, adapter] of Object.entries(this.adapters)) {
      if (adapter.searchProvider) {
        const wrapped = new SearchProviderWrapper(
          adapter.searchProvider,
          `search:${adapterName}`,
        );
        this.retrievalProviders.set(wrapped.name, wrapped);
      }
    }
  }

  /** Register a unified retrieval provider */
  registerRetrievalProvider(provider: RetrievalProvider): void {
    this.retrievalProviders.set(provider.name, provider);
  }

  /** Get a registered retrieval provider by name */
  getRetrievalProvider(name: string): RetrievalProvider | undefined {
    return this.retrievalProviders.get(name);
  }

  /** List all registered retrieval provider names */
  listRetrievalProviders(): string[] {
    return [...this.retrievalProviders.keys()];
  }

  /** Create a pipeline pre-loaded with this router's providers */
  createRetrievalPipeline(): RetrievalPipeline {
    return new RetrievalPipeline(this.retrievalProviders);
  }

  /**
   * Execute a retrieval pipeline against a collection.
   * Loads data first, then runs it through the pipeline steps.
   */
  async retrievePipeline(
    collectionPath: string,
    steps: PipelineStep[],
    options?: GetOptions,
  ): Promise<RetrievalOutput> {
    // Load data from collection
    const data = await this.get(collectionPath, { ...options, raw: true });

    const pipeline = RetrievalPipeline.fromSteps(
      steps,
      this.retrievalProviders,
    );

    return pipeline.execute({
      data,
      collection: collectionPath,
    });
  }

  // ============================================================================
  // Core CRUD Operations (Phase 1: IMPLEMENT)
  // ============================================================================
  
  /**
   * Get data from collection path
   * 
   * Phase 2: Extended with retrieval adapter support
   * Phase 3.2: Returns StorageFileResponse with metadata
   * Phase 3.6h-b: Check for materialized views (.view suffix)
   */
  async get(collectionPath: string, options?: GetOptions): Promise<any> {
    if (!collectionPath || typeof collectionPath !== 'string' || collectionPath.trim() === '') {
      throw new Error('Key must be a non-empty string');
    }

    // Phase 3.6h-b: Check if this is a materialized view
    if (collectionPath.endsWith('.view')) {
      const viewName = collectionPath.replace('.view', '');
      return await this.materializedViewManager.getData(viewName);
    }
    
    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    
    // Phase 3.6g-c: Check if this is an external source
    const externalSource = await this.getExternalSource(collectionPath);
    if (externalSource) {
      // This is a virtual collection - fetch external data
      return await this.getExternalData(collectionPath, externalSource);
    }
    
    // Determine which adapter stored this data
    const adapter = await this.getAdapterForKey(key);
    const adapterName = this.getAdapterName(adapter);
    
    // Get data from adapter (with retry logic for transient failures)
    let data = await retry(() => adapter.get(key), {
      maxRetries: 3,
      onRetry: (attempt, error, delay) => {
        console.warn(`[Smallstore] Retry ${attempt}/3 for get("${key}"): ${error.message}. Waiting ${delay}ms...`);
      }
    });
    
    // Auto-cleanup: If key not found in adapter but exists in index, remove it
    if (!data) {
      const metadataAdapter = this.adapters[this.metadataAdapter];
      const index = await loadIndex(metadataAdapter, parsed.collection);
      
      if (index) {
        const location = getKeyLocation(index, key);
        if (location) {
          console.warn(`[Smallstore] Key "${key}" not found in adapter "${adapterName}", removing from index (auto-cleanup)`);
          await this.removeFromKeyIndex(parsed, key);
        }
      }
      
      return null;
    }
    
    // Phase 2: Apply retrievers if specified
    if (options?.retriever) {
      // Single retriever
      const retriever = this.retrievers.get(options.retriever);
      if (!retriever) {
        throw new Error(`Retriever "${options.retriever}" not found`);
      }
      const result = await retriever.retrieve(data, options);
      data = result.data;
    } else if (options?.retrievers) {
      // Retrieval pipeline (compose multiple retrievers)
      for (const step of options.retrievers) {
        const retriever = this.retrievers.get(step.type);
        if (!retriever) {
          throw new Error(`Retriever "${step.type}" not found`);
        }
        const result = await retriever.retrieve(data, step.options);
        data = result.data;  // Feed output to next retriever
      }
    } else if (options?.pipeline) {
      // Unified retrieval pipeline
      const pipeline = RetrievalPipeline.fromSteps(
        options.pipeline,
        this.retrievalProviders,
      );
      const result = await pipeline.execute({
        data,
        collection: collectionPath,
        query: options.query,
      });
      data = result.data;
    } else if (options && !options.retriever && !options.retrievers && !options.pipeline) {
      // Phase 1: Apply legacy filter/sort/limit if no retrievers specified
      data = this.applyGetOptions(data, options);
    }
    
    // Phase 3.8: Return raw content if requested
    if (options?.raw) {
      return data;
    }

    // Phase 3.2: Wrap response in StorageFileResponse format
    // Try to get KeyLocation for full metadata
    const metadataAdapter = this.adapters[this.metadataAdapter];
    const index = await loadIndex(metadataAdapter, parsed.collection);

    if (index) {
      const location = getKeyLocation(index, key);
      if (location) {
        return wrapResponse(key, data, location);
      }
    }

    // Fallback: Wrap without index (estimate metadata)
    const analysis = analyzeDataForType(data);
    return wrapResponseWithoutIndex(key, data, adapterName, analysis.type);
  }
  
  /**
   * Set data in collection path
   * 
   * SMART ROUTING: Analyzes data and routes to best adapter!
   * 
   * Defaults to 'overwrite' mode. Use { mode: 'append' } for messy desk pattern.
   * 
   * HETEROGENEOUS: Nested objects with multiple sub-paths route independently
   */
  async set(collectionPath: string, data: any, options?: SetOptions): Promise<void> {
    if (!collectionPath || typeof collectionPath !== 'string' || collectionPath.trim() === '') {
      throw new Error('Key must be a non-empty string');
    }

    // Phase 2.6: Process input (validate + transform) BEFORE storage
    let processedData = data;
    if (options?.inputValidation || options?.inputTransform) {
      processedData = await processInput(data, options);
      
      // If processing resulted in null (e.g., all items filtered out in sieve mode)
      // then skip storing entirely
      if (processedData === null || processedData === undefined) {
        debug(`[Smallstore] Input processing filtered out all data for ${collectionPath}, skipping storage`);
        return;
      }
      
      // If processing resulted in empty array, also skip
      if (Array.isArray(processedData) && processedData.length === 0) {
        debug(`[Smallstore] Input processing resulted in empty array for ${collectionPath}, skipping storage`);
        return;
      }
    }
    
    // Default to OVERWRITE mode (store exactly what you pass in)
    // Use { mode: 'append' } for messy desk accumulator pattern
    const mode = options?.mode || 'overwrite';
    const mergedOptions = { ...options, mode };
    
    const parsed = parsePath(collectionPath);
    
    // Handle heterogeneous data: nested objects with multiple sub-paths
    // Example: { bookmarks: [...], notes: "...", images: [...] }
    // Each sub-path routes independently!
    if (this.isHeterogeneousObject(processedData) && parsed.path.length === 0) {
      // Store each sub-path independently
      for (const [subPath, subData] of Object.entries(processedData)) {
        const fullPath = joinPath(collectionPath, subPath);
        await this.set(fullPath, subData, mergedOptions);
      }
      return;
    }
    
    const key = buildKey(parsed);
    
    // Phase 3.1: Config-based routing with priority system
    const decision = await this.routeData(collectionPath, processedData, mergedOptions);
    
    // Get adapter
    const adapter = this.adapters[decision.adapter];
    if (!adapter) {
      throw new Error(`Adapter "${decision.adapter}" not found`);
    }
    
    // Handle merge/append modes (with lock to prevent race conditions)
    let finalData = processedData;
    const needsLock = mode === 'append' || mode === 'merge';
    const lockKey = `${parsed.collection}:${key}`;
    const release = needsLock ? await this.keyLock.acquire(lockKey) : null;
    try {
      if (needsLock) {
        const existing = await adapter.get(key);
        if (existing !== null && existing !== undefined) {
          if (mode === 'append') {
            // Append to array (or create array if not already)
            // NOTE: Treat incoming data as a SINGLE item, even if it's an array
            // This preserves the "messy desk" pattern where you can throw ANY data in
            if (Array.isArray(existing)) {
              finalData = [...existing, processedData];
            } else {
              // Existing is not array, wrap both in array
              finalData = [existing, processedData];
            }
          } else if (mode === 'merge') {
            // Merge objects (skip if either is array or primitive)
            if (
              typeof existing === 'object' &&
              typeof processedData === 'object' &&
              existing !== null &&
              processedData !== null &&
              !Array.isArray(existing) &&
              !Array.isArray(processedData)
            ) {
              finalData = { ...existing, ...processedData };
            } else {
              // Can't merge non-objects, treat as append
              if (Array.isArray(existing)) {
                finalData = [...existing, processedData];
              } else {
                finalData = [existing, processedData];
              }
            }
          }
        } else {
          // No existing data
          if (mode === 'append') {
            // First append: wrap in array for consistency
            finalData = [processedData];
          } else {
            // Merge mode with no existing: just store new data
            finalData = processedData;
          }
        }
      }

      // Store data in chosen adapter (with retry logic)
      try {
        await retry(() => adapter.set(key, finalData, mergedOptions?.ttl), {
          maxRetries: 3,
          onRetry: (attempt, error, delay) => {
            console.warn(`[Smallstore] Retry ${attempt}/3 for set("${key}"): ${error.message}. Waiting ${delay}ms...`);
          }
        });

        // Update metadata (collection schema)
        await this.updateMetadata(parsed, decision);

        // Phase 3: Update key index (track which adapter stores this key)
        await this.updateKeyIndex(parsed, decision);
      } catch (error: any) {
        console.error(`[Smallstore] Failed to set("${key}") after retries: ${error.message}`);

        // Auto-resync: If write failed, validate metadata to ensure consistency
        console.warn(`[Smallstore] Triggering metadata validation for collection "${parsed.collection}"...`);
        try {
          await this.validateAndCleanup(parsed.collection);
        } catch (resyncError) {
          console.error(`[Smallstore] Metadata validation failed:`, resyncError);
        }

        throw error; // Re-throw original error
      }
      // A075: Cache invalidation inside lock (before release)
      // Phase 3.6h: Auto-invalidate caches (if enabled)
      if (this.config.caching?.autoInvalidate && this.cacheManager.isEnabled()) {
        await this.cacheManager.clearCollection(parsed.collection);
      }

      // A082: Refresh materialized views after cache clear
      if (this.materializedViewManager) {
        await this.materializedViewManager.refreshBySource(collectionPath);
      }
    } finally {
      if (release) release();
    }
  }
  
  /**
   * Check if data is heterogeneous (nested object with multiple sub-paths)
   * 
   * Heterogeneous = plain object that looks like a "folder" of sub-collections
   * 
   * Heuristic: Split if at least 2 values are complex (arrays/objects/blobs)
   * This catches patterns like:
   * - { bookmarks: [...], notes: "...", images: blob } → Split!
   * - { name: "test", value: 42 } → DON'T split (normal object)
   * - { data: [...], metadata: {...} } → Split!
   */
  private isHeterogeneousObject(data: any): boolean {
    // Must be a plain object
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return false;
    }
    
    // Must have multiple keys (otherwise just single object)
    const keys = Object.keys(data);
    if (keys.length <= 1) {
      return false;
    }
    
    // Count complex values (arrays, objects, blobs)
    const complexCount = keys.filter(k => {
      const val = data[k];
      return (
        (typeof val === 'object' && val !== null) ||
        Array.isArray(val) ||
        val instanceof Uint8Array ||
        val instanceof Blob
      );
    }).length;
    
    // Split if at least 2 complex values
    // This means it's likely a "folder" pattern
    return complexCount >= 2;
  }
  
  /**
   * Partial update — shallow-merge patch into existing data.
   * If no existing data exists, behaves like set().
   */
  async patch(collectionPath: string, patch: Record<string, any>, options?: SetOptions): Promise<void> {
    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    const lockKey = `${parsed.collection}:${key}`;
    const release = await this.keyLock.acquire(lockKey);
    try {
      // Use raw: true to get the actual stored data, not the wrapped response
      let existing = await this.get(collectionPath, { raw: true });

      // Unwrap single-element arrays (from default append mode)
      if (Array.isArray(existing) && existing.length === 1) {
        existing = existing[0];
      }

      // Shallow merge if existing is a plain object; otherwise replace
      const merged = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...existing, ...patch }
        : patch;

      // Use overwrite mode to store the merged result directly
      await this.set(collectionPath, merged, { ...options, mode: 'overwrite' });

      // Invalidate query cache after patch
      const patchParsed = parsePath(collectionPath);
      if (this.config.caching?.autoInvalidate && this.cacheManager.isEnabled()) {
        await this.cacheManager.clearCollection(patchParsed.collection);
      }
    } finally {
      release();
    }
  }

  /**
   * Delete data from collection path
   */
  async delete(collectionPath: string): Promise<void> {
    if (!collectionPath || typeof collectionPath !== 'string' || collectionPath.trim() === '') {
      throw new Error('Key must be a non-empty string');
    }

    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    
    // Determine which adapter stored this data
    const adapter = await this.getAdapterForKey(key);
    
    // Delete from adapter (with retry logic)
    await retry(() => adapter.delete(key), {
      maxRetries: 3,
      onRetry: (attempt, error, delay) => {
        console.warn(`[Smallstore] Retry ${attempt}/3 for delete("${key}"): ${error.message}. Waiting ${delay}ms...`);
      }
    });
    
    // Update metadata (remove from schema)
    await this.removeFromMetadata(parsed);
    
    // Phase 3: Update key index (remove key)
    await this.removeFromKeyIndex(parsed, key);
    
    // Phase 3.6h: Auto-invalidate caches (if enabled)
    if (this.config.caching?.autoInvalidate && this.cacheManager.isEnabled()) {
      await this.cacheManager.clearCollection(parsed.collection);
    }
    
    // Phase 3.6h-b: Trigger on-write refresh for materialized views
    await this.materializedViewManager.refreshBySource(collectionPath);
  }
  
  // ============================================================================
  // Phase 3.6e: Granular Deletion
  // ============================================================================
  
  /**
   * Delete items from an array by filter
   */
  async deleteFromArray(
    collectionPath: string,
    options: DeleteFromArrayOptions
  ): Promise<{ deleted: number; items?: any[] }> {
    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    const lockKey = `${parsed.collection}:${key}`;
    const release = await this.keyLock.acquire(lockKey);
    try {
      // 1. Get current data
      const data = await this.get(collectionPath, { raw: true });

      if (!Array.isArray(data)) {
        throw new Error(`Path "${collectionPath}" is not an array`);
      }

      // 2. Build filter function
      const filterFn = typeof options.filter === 'function'
        ? options.filter
        : (item: any) => {
            // Object matcher - check if all properties match
            return Object.entries(options.filter as Record<string, any>).every(
              ([key, value]) => item[key] === value
            );
          };

      // 3. Separate items to keep vs delete
      const toKeep: any[] = [];
      const toDelete: any[] = [];

      for (const item of data) {
        if (filterFn(item)) {
          toDelete.push(item);
        } else {
          toKeep.push(item);
        }
      }

      // 4. Save filtered array
      await this.set(collectionPath, toKeep, { mode: 'overwrite' });

      debug(`[Smallstore] Deleted ${toDelete.length} items from ${collectionPath}`);

      // 5. Return result
      return {
        deleted: toDelete.length,
        items: options.returnDeleted ? toDelete : undefined
      };
    } finally {
      release();
    }
  }
  
  /**
   * Delete property/properties from an object
   */
  async deleteProperty(
    collectionPath: string,
    property: string | string[]
  ): Promise<void> {
    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    const lockKey = `${parsed.collection}:${key}`;
    const release = await this.keyLock.acquire(lockKey);
    try {
      // 1. Get current data
      const data = await this.get(collectionPath);

      if (typeof data !== 'object' || Array.isArray(data) || data === null) {
        throw new Error(`Path "${collectionPath}" is not an object`);
      }

      // 2. Remove properties
      const properties = Array.isArray(property) ? property : [property];
      const updated = { ...data };

      for (const prop of properties) {
        delete updated[prop];
      }

      // 3. Save updated object
      await this.set(collectionPath, updated, { mode: 'overwrite' });

      debug(`[Smallstore] Deleted ${properties.length} properties from ${collectionPath}`);
    } finally {
      release();
    }
  }
  
  // ============================================================================
  // Phase 3.6e: Metadata Resync
  // ============================================================================
  
  /**
   * Resync metadata with actual adapter state
   */
  async resyncMetadata(
    collection: string,
    options?: ResyncOptions
  ): Promise<ResyncResult> {
    const opts = {
      resyncKeys: true,
      resyncSchema: true,
      verbose: false,
      ...options
    };
    
    debug(`[Smallstore] Resyncing metadata for "${collection}"...`);
    
    // 1. Get current key index
    const metadataAdapter = this.adapters[this.metadataAdapter];
    const currentIndex = await loadIndex(metadataAdapter, collection);
    const currentKeys = Object.keys(currentIndex?.keys || {});
    
    const before = {
      keyCount: currentKeys.length
    };
    
    // 2. Scan actual adapter state
    const allActualKeys: string[] = [];
    
    for (const [adapterName, adapter] of Object.entries(this.adapters)) {
      try {
        const adapterKeys = await adapter.keys(collection);
        allActualKeys.push(...adapterKeys);
        
        if (opts.verbose) {
          debug(`[Smallstore]   ${adapterName}: ${adapterKeys.length} keys`);
        }
      } catch (error) {
        console.warn(`[Smallstore] Error scanning ${adapterName}:`, error);
      }
    }
    
    // 3. Find differences
    const currentKeySet = new Set(currentKeys);
    const actualKeySet = new Set(allActualKeys);
    
    const removed: string[] = [];
    const added: string[] = [];
    
    // Stale keys (in metadata but not in adapter)
    for (const key of currentKeySet) {
      if (!actualKeySet.has(key)) {
        removed.push(key);
        if (opts.verbose) {
          debug(`[Smallstore]   Removing stale key: ${key}`);
        }
      }
    }
    
    // Missing keys (in adapter but not in metadata)
    for (const key of actualKeySet) {
      if (!currentKeySet.has(key)) {
        added.push(key);
        if (opts.verbose) {
          debug(`[Smallstore]   Adding missing key: ${key}`);
        }
      }
    }
    
    // 4. Update key index if requested
    if (opts.resyncKeys) {
      // Remove stale keys
      for (const key of removed) {
        await this.removeFromKeyIndex({ collection, path: [] }, key);
      }
      
      // Add missing keys
      for (const key of added) {
        // Find which adapter has this key
        let foundAdapter: string | null = null;
        for (const [adapterName, adapter] of Object.entries(this.adapters)) {
          if (await adapter.has(key)) {
            foundAdapter = adapterName;
            break;
          }
        }
        
        if (foundAdapter) {
          const adapter = this.adapters[foundAdapter];
          const data = await adapter.get(key);
          const dataType = detectDataType(data);
          const size = calculateSize(data);
          
          // Update key index manually
          let index = await loadIndex(metadataAdapter, collection);
          if (!index) {
            index = createEmptyIndex(collection);
          }
          
          const location: KeyLocation = {
            key,
            collection,
            path: key.replace(`smallstore:${collection}`, '').replace(/^\//, '') || '/',
            adapter: foundAdapter,
            dataType,
            sizeBytes: size,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
          };
          
          index = addKeyToIndex(index, location);
          await saveIndex(metadataAdapter, index);
        }
      }
    }
    
    const after = {
      keyCount: currentKeys.length - removed.length + added.length
    };
    
    debug(`[Smallstore] ✅ Resync complete: +${added.length} -${removed.length}`);
    
    return {
      before,
      after,
      changes: { added, removed }
    };
  }
  
  /**
   * Validate metadata consistency
   */
  async validateMetadata(
    collection: string
  ): Promise<ValidationResult> {
    debug(`[Smallstore] Validating metadata for "${collection}"...`);
    
    const issues: ValidationResult['issues'] = [];
    
    // Get current key index
    const metadataAdapter = this.adapters[this.metadataAdapter];
    const currentIndex = await loadIndex(metadataAdapter, collection);
    const currentKeys = Object.keys(currentIndex?.keys || {});
    
    // Scan actual adapters
    const actualKeys = new Set<string>();
    
    for (const adapter of Object.values(this.adapters)) {
      try {
        const adapterKeys = await adapter.keys(collection);
        for (const key of adapterKeys) {
          actualKeys.add(key);
        }
      } catch (error) {
        console.warn('[Smallstore] Error scanning adapter:', error);
      }
    }
    
    // Check for stale keys (in metadata but not in adapters)
    for (const key of currentKeys) {
      if (!actualKeys.has(key)) {
        issues.push({
          type: 'stale_key',
          key,
          details: 'Key exists in metadata but not in any adapter'
        });
      }
    }
    
    // Check for missing keys (in adapters but not in metadata)
    for (const key of actualKeys) {
      if (!currentKeys.includes(key)) {
        issues.push({
          type: 'missing_key',
          key,
          details: 'Key exists in adapter but not in metadata'
        });
      }
    }
    
    const valid = issues.length === 0;
    
    debug(`[Smallstore] Validation ${valid ? '✅ passed' : `❌ failed (${issues.length} issues)`}`);
    
    return {
      valid,
      issues
    };
  }
  
  /**
   * Check if data exists at collection path
   */
  async has(collectionPath: string): Promise<boolean> {
    if (!collectionPath || typeof collectionPath !== 'string' || collectionPath.trim() === '') {
      throw new Error('Key must be a non-empty string');
    }

    const parsed = parsePath(collectionPath);
    const key = buildKey(parsed);
    
    // Check all adapters (we don't know which one has it)
    for (const adapter of Object.values(this.adapters)) {
      if (await adapter.has(key)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * List keys in collection
   */
  async keys(collectionPath: string, prefix?: string): Promise<string[]> {
    const parsed = parsePath(collectionPath);
    const keyPrefix = buildKey(parsed);

    // Check if prefix contains glob characters
    const useGlob = prefix ? isGlobPattern(prefix) : false;

    // For glob patterns, use the static prefix to narrow the adapter query,
    // then post-filter with the glob regex.
    // For plain prefixes, use the full prefix for direct adapter query.
    const staticPrefix = useGlob ? extractStaticPrefix(prefix!) : prefix;

    // Adapter keys use ":" separator — convert "/" in prefix to ":"
    // and join with ":" (not joinPath which uses "/")
    const adapterPrefix = staticPrefix
      ? `${keyPrefix}:${staticPrefix.replace(/\//g, ':')}`
      : keyPrefix;

    // Query all adapters and merge results
    const allKeys = new Set<string>();

    for (const adapter of Object.values(this.adapters)) {
      const keys = await adapter.keys(adapterPrefix);
      keys.forEach((key) => {
        // Remove "smallstore:<collection>:" prefix and convert ":" back to "/"
        // to return user-friendly sub-paths (e.g., "ai/2024" not "ai:2024")
        const withoutPrefix = key
          .replace(`smallstore:${parsed.collection}:`, '')
          .replace(/:/g, '/');
        allKeys.add(withoutPrefix);
      });
    }

    let result = Array.from(allKeys);

    // Post-filter with glob pattern
    if (useGlob && prefix) {
      const regex = globToRegex(prefix);
      result = result.filter((key) => regex.test(key));
    }

    return result;
  }
  
  /**
   * Clear all data in collection (for testing/cleanup)
   */
  async clear(collectionPath: string, prefix?: string): Promise<void> {
    const parsed = parsePath(collectionPath);
    const keyPrefix = buildKey(parsed);
    const fullPrefix = prefix ? joinPath(keyPrefix, prefix) : keyPrefix;
    
    // Clear from all adapters
    await Promise.all(
      Object.values(this.adapters).map(adapter => adapter.clear(fullPrefix))
    );
  }
  
  /**
   * List all collections in storage
   * 
   * Scans the metadata adapter for all index keys to discover collections.
   * This is fast because it only reads index keys, not actual data.
   * 
   * @param pattern - Optional glob or prefix pattern to filter collections
   * @returns Array of collection names
   */
  async listCollections(pattern?: string): Promise<string[]> {
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    try {
      // List all index keys (format: "smallstore:index:collectionName")
      const indexKeys = await metadataAdapter.keys("smallstore:index:");
      
      // Extract collection names from index keys
      const collections = indexKeys
        .map((key: string) => {
          const parts = key.split(':');
          return parts[2] || null; // "smallstore:index:<collection>"
        })
        .filter((name: string | null): name is string => name !== null && name.length > 0);
      
      // Remove duplicates and sort
      const uniqueCollections = Array.from(new Set(collections)).sort();
      
      // Apply pattern filtering if provided
      if (pattern) {
        if (isGlobPattern(pattern)) {
          return uniqueCollections.filter(name => matchGlob(name, pattern));
        }
        return uniqueCollections.filter(name => name.startsWith(pattern));
      }

      return uniqueCollections;
    } catch (error) {
      console.error('[Smallstore] Error listing collections:', error);
      return [];
    }
  }
  
  /**
   * Get collection schema (what's where, what type)
   */
  async getSchema(collection: string): Promise<CollectionSchema> {
    const metadataKey = buildMetadataKey(collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    const schema = await metadataAdapter.get(metadataKey);
    
    if (!schema) {
      // Phase 3: Try to reconstruct from adapters
      console.warn(`[Smallstore] Metadata missing for "${collection}", attempting reconstruction...`);
      
      try {
        const { schema: reconstructed } = await this.reconstructMetadata(collection);
        return reconstructed;
      } catch (err) {
        console.warn(`[Smallstore] Reconstruction failed for "${collection}":`, err);
        
        // Return empty schema as fallback
        return {
          collection,
          paths: {},
          metadata: {},
        };
      }
    }
    
    return schema;
  }
  
  // ============================================================================
  // Search & Indexing (BM25 implemented, vector/hybrid ready for providers)
  // ============================================================================

  /**
   * Search collection (BM25, vector, hybrid)
   *
   * Delegates to the adapter's SearchProvider. BM25 providers available now;
   * vector/hybrid providers can be plugged in via adapter.searchProvider.
   */
  async search(collectionPath: string, options: SearchOptions): Promise<SearchResult[]> {
    const parsed = parsePath(collectionPath);
    const adapter = this.resolveAdapterForPath(collectionPath);
    const provider = adapter?.searchProvider;

    // Check if provider supports the requested type
    if (!provider || !provider.supportedTypes.includes(options.type)) {
      throw new UnsupportedOperationError(
        'smallstore',
        'search',
        `Search type "${options.type}" is not available on this adapter.`,
        provider
          ? `Supported types: ${provider.supportedTypes.join(', ')}`
          : 'Attach a SearchProvider that supports this type, or use query() with filter',
      );
    }

    // Note: `metric` is intentionally not forwarded — MemoryVectorSearchProvider
    // and ZvecSearchProvider both bake the metric in at construction (schema-level
    // for zvec) and ignore a per-call value. To change metric, construct a new
    // provider instance.
    const rawResults = await provider.search(options.query || '', {
      limit: options.limit || options.topK || 20,
      collection: parsed.collection,
      threshold: options.threshold,
      type: options.type,
      vector: options.vector,
      topK: options.topK,
      query: options.query,
      hybridAlpha: options.hybridAlpha,
    });

    // Map to SearchResult format
    return rawResults.map(r => ({
      path: r.key,
      data: null, // Caller can use get() to load full data
      score: r.score,
      metadata: {
        snippet: r.snippet,
        ...(r.distance !== undefined ? { distance: r.distance } : {}),
      },
    }));
  }
  
  /**
   * Create index on collection
   * Phase 1: Stores definition only, doesn't build
   */
  async createIndex(collectionPath: string, indexDef: IndexDefinition): Promise<void> {
    const parsed = parsePath(collectionPath);
    const schema = await this.getSchema(parsed.collection);

    // Store index definition in metadata
    const metadataKey = buildMetadataKey(parsed.collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];

    const updatedSchema = {
      ...schema,
      indexes: {
        ...(schema as any).indexes,
        [indexDef.name]: indexDef,
      },
    };

    await metadataAdapter.set(metadataKey, updatedSchema);

    // Build the index if the adapter supports it
    if (indexDef.type === 'bm25') {
      const adapter = this.resolveAdapterForPath(collectionPath);
      if (adapter?.searchProvider) {
        const prefix = buildKey(parsed);
        const result = await adapter.searchProvider.rebuild(prefix);
        debug(
          `[Smallstore] Index "${indexDef.name}" built: ${result.indexed} indexed, ${result.skipped} skipped`
        );
        return;
      }
    }

    debug(`[Smallstore] Index "${indexDef.name}" definition stored (adapter does not support building this index type)`);
  }
  
  /**
   * Read through view/lens
   *
   * Phase 5: Delegates to named views or executes inline definitions.
   */
  async view(collectionPath: string, options: ViewOptions): Promise<any> {
    // Named view — delegate to existing getView
    if (options.lens) {
      return await this.getView(options.lens, options.params);
    }

    // Inline view definition — load source data and run retriever pipeline
    if (options.definition) {
      const sourceData = await this.get(collectionPath, { raw: true });
      if (sourceData === null) {
        throw new Error(`View source not found: ${collectionPath}`);
      }

      const retrievers = options.definition.retrievers || [];
      let data = sourceData;
      for (const step of retrievers) {
        const retriever = this.retrievers.get(step.type);
        if (!retriever) {
          throw new Error(`Unknown retriever: ${step.type}`);
        }
        const result = await retriever.retrieve(data, { ...step.options, ...options.params });
        data = result.data;
      }
      return data;
    }

    throw new Error('view() requires either a lens name or inline definition');
  }
  
  /**
   * Query with complex filters (Phase 3.6f-a)
   * 
   * Universal query interface supporting:
   * - MongoDB-style filters
   * - Function filters
   * - Page & cursor-based pagination
   * - Range requests
   * - Format transformation
   */
  async query(collectionPath: string, options: QueryOptions = {}): Promise<QueryResult> {
    // Phase 3.6h: Check cache first (if enabled for this query)
    const cacheEnabled = options.cache === true ||
                        (typeof options.cache === 'object' && options.cache.enabled);

    if (cacheEnabled && this.cacheManager.isEnabled()) {
      const cached = await this.cacheManager.get(collectionPath, options);
      if (cached) {
        // Cache hit! Return cached result with cache metadata
        const result = cached.data as QueryResult;
        if (result.meta) {
          result.meta.cached = true;
          result.meta.cachedAt = new Date(cached.cachedAt).toISOString();
        }
        return result;
      }
    }

    // Native adapter query: delegate to adapter when it supports query()
    // and the query uses filter (not the JS function-based where)
    if (options.filter && !options.where) {
      const adapter = this.resolveAdapterForPath(collectionPath);
      if (adapter.query) {
        const startTime = Date.now();
        const parsed = parsePath(collectionPath);
        const keyPrefix = buildKey(parsed);

        const adapterResult = await adapter.query({
          prefix: keyPrefix,
          filter: options.filter,
          sort: typeof options.sort === 'object' && !Array.isArray(options.sort) ? options.sort as Record<string, 1 | -1> : undefined,
          limit: options.limit || options.pageSize,
          skip: options.skip || (options.page && options.pageSize ? (options.page - 1) * options.pageSize : undefined),
        });

        const totalCount = adapterResult.totalCount ?? adapterResult.data.length;
        const limit = options.limit || options.pageSize;
        const skip = options.skip || (options.page && options.pageSize ? (options.page - 1) * options.pageSize : 0);

        const result: QueryResult = {
          data: adapterResult.data,
          total: totalCount,
          meta: {
            executionTime: Date.now() - startTime,
            itemsScanned: totalCount,
            itemsReturned: adapterResult.data.length,
            nativeQuery: true,
          },
          ...(limit ? {
            pagination: {
              page: Math.floor((skip || 0) / limit) + 1,
              pageSize: limit,
              totalItems: totalCount,
              totalPages: Math.ceil(totalCount / limit),
              hasNext: ((skip || 0) + adapterResult.data.length) < totalCount,
              hasPrevious: (skip || 0) > 0,
            },
          } : {}),
        };

        // Cache result if enabled
        if (cacheEnabled && this.cacheManager.isEnabled()) {
          const ttl = typeof options.cache === 'object' && options.cache.ttl
            ? options.cache.ttl
            : undefined;
          await this.cacheManager.set(collectionPath, options, result, ttl);
        }

        return result;
      }
    }

    // Import query engine (fallback: in-memory filtering)
    const { executeQuery } = await import('./utils/query-engine.ts');

    // Get data from collection
    const rawData = await this.get(collectionPath);
    
    // If no data, return empty result
    if (!rawData) {
      return {
        data: [],
        meta: {
          executionTime: 0,
          itemsScanned: 0,
          itemsReturned: 0
        }
      };
    }
    
    // Phase 3.2: Extract content from StorageFileResponse if needed
    const data = (rawData && typeof rawData === 'object' && 'content' in rawData) 
      ? rawData.content 
      : rawData;
    
    // If extracted content is null, return empty result
    if (!data) {
      return {
        data: [],
        meta: {
          executionTime: 0,
          itemsScanned: 0,
          itemsReturned: 0
        }
      };
    }
    
    // Normalize to array
    const items = Array.isArray(data) ? data : [data];
    
    // Execute query
    const result = executeQuery(items, options);
    
    // A081: Apply format transformation BEFORE caching so cached result includes formatting
    if (options.format && options.format !== 'json' && options.format !== 'raw') {
      const formatted = await this.formatResult(collectionPath, result.data, options.format);

      // Phase 3.6h: Cache the formatted result (if enabled)
      if (cacheEnabled && this.cacheManager.isEnabled()) {
        const ttl = typeof options.cache === 'object' && options.cache.ttl
          ? options.cache.ttl
          : undefined;
        await this.cacheManager.set(collectionPath, options, formatted, ttl);
      }

      // Return formatted string directly (not as QueryResult)
      return formatted as any;
    }

    // Phase 3.6h: Cache result (if enabled)
    if (cacheEnabled && this.cacheManager.isEnabled()) {
      const ttl = typeof options.cache === 'object' && options.cache.ttl
        ? options.cache.ttl
        : undefined;
      await this.cacheManager.set(collectionPath, options, result, ttl);
    }

    return result;
  }
  
  /**
   * Format query result to different output formats (Phase 3.6f-c)
   */
  private async formatResult(
    collectionPath: string,
    data: any[],
    format: 'markdown' | 'csv' | 'yaml' | 'text'
  ): Promise<string> {
    // Create a temporary collection path for formatting
    // We'll use the materializers but pass the filtered data directly
    
    switch (format) {
      case 'markdown': {
        // Format items as markdown
        let md = `# ${collectionPath}\n\n**Items:** ${data.length}\n\n`;
        for (const item of data) {
          if (typeof item === 'object' && item !== null) {
            md += '```json\n';
            md += JSON.stringify(item, null, 2);
            md += '\n```\n\n';
          } else {
            md += `${String(item)}\n\n`;
          }
        }
        return md;
      }
      
      case 'csv': {
        // Format items as CSV
        const headers = new Set<string>();
        
        // Collect all headers from objects
        for (const item of data) {
          if (typeof item === 'object' && item !== null) {
            Object.keys(item).forEach(k => headers.add(k));
          }
        }
        
        const headerArray = Array.from(headers);
        let csv = headerArray.join(',') + '\n';
        
        for (const item of data) {
          const row: string[] = [];
          for (const header of headerArray) {
            const value = typeof item === 'object' && item !== null ? item[header] : '';
            const csvValue = value === null || value === undefined ? '' : String(value).replace(/"/g, '""');
            row.push(`"${csvValue}"`);
          }
          csv += row.join(',') + '\n';
        }
        
        return csv;
      }
      
      case 'yaml': {
        // Format items as YAML (simple implementation)
        let yaml = `collection: ${collectionPath}\nitems: ${data.length}\ndata:\n`;
        for (const item of data) {
          if (typeof item === 'object' && item !== null) {
            yaml += '  - ' + JSON.stringify(item).replace(/\n/g, '\n    ') + '\n';
          } else {
            yaml += `  - ${String(item)}\n`;
          }
        }
        return yaml;
      }
      
      case 'text': {
        // Format items as text
        let text = `${collectionPath}\nItems: ${data.length}\n\n`;
        for (const item of data) {
          if (typeof item === 'object' && item !== null) {
            text += JSON.stringify(item, null, 2) + '\n';
          } else {
            text += `${String(item)}\n`;
          }
        }
        return text;
      }
      
      default:
        return JSON.stringify(data, null, 2);
    }
  }
  
  // ============================================================================
  // Phase 3.6f-b: Data Operations
  // ============================================================================
  
  /**
   * Merge multiple collections into one (Phase 3.6f-b)
   * 
   * @param sources - Array of source collection paths
   * @param dest - Destination collection path
   * @param options - Merge options
   */
  async merge(sources: string[], dest: string, options?: MergeOptions): Promise<void> {
    // Default to overwrite: re-running `merge(sources, dest)` should produce
    // the same result, not double the data. Callers that specifically want
    // to append to an existing dest must pass `overwrite: false` explicitly.
    const opts = {
      deduplicate: false,
      onConflict: 'replace',
      overwrite: true,
      ...options
    };
    
    debug(`[Smallstore] Merging ${sources.length} collections into "${dest}"...`);
    
    // Load all source collections
    const allData: any[] = [];
    
    for (const source of sources) {
      const data = await this.get(source, { raw: true });
      // Null-check (not truthy-check) so scalar 0, '', or false — valid
      // collection contents — aren't silently dropped.
      if (data !== null && data !== undefined) {
        const items = Array.isArray(data) ? data : [data];
        allData.push(...items);
      }
    }
    
    debug(`[Smallstore]   Loaded ${allData.length} total items`);
    
    // Deduplicate if requested
    let finalData = allData;
    if (opts.deduplicate && opts.idField) {
      const seen = new Set();
      const unique: any[] = [];
      
      for (const item of allData) {
        const id = item[opts.idField];
        if (id && !seen.has(id)) {
          seen.add(id);
          unique.push(item);
        } else if (id && opts.onConflict === 'skip') {
          // Skip duplicate
          continue;
        } else if (id && opts.onConflict === 'merge') {
          // Merge with existing
          const existingIdx = unique.findIndex(u => u[opts.idField!] === id);
          if (existingIdx >= 0) {
            unique[existingIdx] = { ...unique[existingIdx], ...item };
          }
        } else if (id && opts.onConflict === 'replace') {
          // Replace existing
          const existingIdx = unique.findIndex(u => u[opts.idField!] === id);
          if (existingIdx >= 0) {
            unique[existingIdx] = item;
          } else {
            unique.push(item);
          }
        } else {
          unique.push(item);
        }
      }
      
      finalData = unique;
      debug(`[Smallstore]   Deduplicated to ${finalData.length} unique items`);
    }
    
    // Write to destination
    const mode = opts.overwrite ? 'overwrite' : 'append';
    await this.set(dest, finalData, { mode: mode as any });
    
    debug(`[Smallstore] ✅ Merge complete: ${finalData.length} items written to "${dest}"`);
  }
  
  /**
   * Extract a subset (slice) of a collection (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to slice
   * @param options - Slice options
   * @returns Sliced data (if returnData is true)
   */
  async slice(collectionPath: string, options: SliceOptions): Promise<any[] | void> {
    const opts = {
      returnData: true,
      ...options
    };
    
    debug(`[Smallstore] Slicing "${collectionPath}" [${opts.start}:${opts.end}]...`);

    // Get data
    const data = await this.get(collectionPath, { raw: true });
    
    if (!data) {
      throw new Error(`Collection "${collectionPath}" not found`);
    }
    
    if (!Array.isArray(data)) {
      throw new Error(`Collection "${collectionPath}" is not an array`);
    }
    
    // Slice
    const sliced = data.slice(opts.start, opts.end);
    
    debug(`[Smallstore]   Sliced ${sliced.length} items`);
    
    // Save if requested
    if (opts.saveTo) {
      await this.set(opts.saveTo, sliced);
      debug(`[Smallstore]   Saved to "${opts.saveTo}"`);
    }
    
    debug(`[Smallstore] ✅ Slice complete`);
    
    // Return data if requested
    if (opts.returnData) {
      return sliced;
    }
  }
  
  /**
   * Split collection by field value (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to split
   * @param options - Split options
   */
  async split(collectionPath: string, options: SplitOptions): Promise<void> {
    debug(`[Smallstore] Splitting "${collectionPath}" by "${options.by}"...`);

    // Get data
    const data = await this.get(collectionPath, { raw: true });
    
    if (!data) {
      throw new Error(`Collection "${collectionPath}" not found`);
    }
    
    if (!Array.isArray(data)) {
      throw new Error(`Collection "${collectionPath}" is not an array`);
    }
    
    // Group by field value
    const groups = new Map<string, any[]>();
    
    for (const item of data) {
      let value: string;
      const rawValue = item[options.by];
      if (rawValue === null || rawValue === undefined) {
        // A079: Use '_unclassified' for null/undefined field values
        console.warn(`[Smallstore] split: item has null/undefined value for field "${options.by}", using '_unclassified'`);
        value = '_unclassified';
      } else {
        value = String(rawValue);
      }
      if (!groups.has(value)) {
        groups.set(value, []);
      }
      groups.get(value)!.push(item);
    }
    
    debug(`[Smallstore]   Found ${groups.size} groups`);
    
    // Write each group to its destination
    for (const [value, items] of groups.entries()) {
      const dest = options.destPattern.replace('{value}', value);
      
      // Apply max per split if specified
      const finalItems = options.maxPerSplit
        ? items.slice(0, options.maxPerSplit)
        : items;
      
      await this.set(dest, finalItems);
      debug(`[Smallstore]   Wrote ${finalItems.length} items to "${dest}"`);
    }
    
    debug(`[Smallstore] ✅ Split complete: ${groups.size} collections created`);
  }
  
  /**
   * Remove duplicates from a collection (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to deduplicate
   * @param options - Deduplication options
   */
  async deduplicate(collectionPath: string, options: DeduplicateOptions): Promise<void> {
    debug(`[Smallstore] Deduplicating "${collectionPath}"...`);

    // Get data
    const data = await this.get(collectionPath, { raw: true });
    
    if (!data) {
      throw new Error(`Collection "${collectionPath}" not found`);
    }
    
    if (!Array.isArray(data)) {
      throw new Error(`Collection "${collectionPath}" is not an array`);
    }
    
    const originalCount = data.length;
    const keep = options.keep || 'first';
    let unique: any[] = [];
    
    if (options.idField) {
      // Deduplicate by ID field
      const seen = new Map<any, any>();
      
      for (const item of data) {
        const id = item[options.idField];
        if (id !== undefined && id !== null) {
          if (!seen.has(id)) {
            seen.set(id, item);
          } else if (keep === 'last') {
            seen.set(id, item);
          }
        } else {
          // A078: Warn when idField is specified but item lacks it
          console.warn(`[Smallstore] deduplicate: item missing idField "${options.idField}", skipping: ${JSON.stringify(item).slice(0, 200)}`);
        }
      }
      
      unique = Array.from(seen.values());
    } else if (options.useContentHash) {
      // A080: O(n) deduplicate by content hash using Map
      if (keep === 'last') {
        // Map from hash -> index in unique array for O(n) replacement
        const hashToIndex = new Map<string, number>();
        for (const item of data) {
          const hash = JSON.stringify(item);
          if (hashToIndex.has(hash)) {
            // Replace previous occurrence in-place
            unique[hashToIndex.get(hash)!] = null; // mark old as removed
          }
          hashToIndex.set(hash, unique.length);
          unique.push(item);
        }
        // Filter out nulled slots
        unique = unique.filter(u => u !== null);
      } else {
        const seen = new Set<string>();
        for (const item of data) {
          const hash = JSON.stringify(item);
          if (!seen.has(hash)) {
            seen.add(hash);
            unique.push(item);
          }
        }
      }
    } else if (options.compareFields && options.compareFields.length > 0) {
      // Deduplicate by specific fields
      const seen = new Set<string>();
      
      for (const item of data) {
        const key = options.compareFields.map(f => String(item[f])).join('|');
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        } else if (keep === 'last') {
          unique = unique.filter(u => {
            const uKey = options.compareFields!.map(f => String(u[f])).join('|');
            return uKey !== key;
          });
          unique.push(item);
        }
      }
    } else {
      // No deduplication strategy specified - use content hash as default
      const seen = new Set<string>();
      
      for (const item of data) {
        const hash = JSON.stringify(item);
        if (!seen.has(hash)) {
          seen.add(hash);
          unique.push(item);
        }
      }
    }
    
    debug(`[Smallstore]   Removed ${originalCount - unique.length} duplicates`);
    debug(`[Smallstore]   Kept ${unique.length} unique items`);
    
    // Write back deduplicated data
    await this.set(collectionPath, unique, { mode: 'overwrite' });
    
    debug(`[Smallstore] ✅ Deduplication complete`);
  }
  
  // ============================================================================
  // Smart Routing Logic
  // ============================================================================
  
  /**
   * Route data to best adapter
   * 
   * Phase 3.1: New priority system
   * 1. Explicit adapter option
   * 2. Type-based routing
   * 3. Pattern-based routing
   * 4. Smart routing (if enabled)
   * 5. Default adapter
   * 
   * @param collectionPath - Collection path for pattern matching
   * @param data - Data to route
   * @param options - Set options (may include adapter override)
   * @returns Routing decision
   */
  private async routeData(
    collectionPath: string,
    data: any,
    options?: SetOptions
  ): Promise<RoutingDecision> {
    const analysis = analyzeData(data);
    const parsed = parsePath(collectionPath);
    
    // Priority 1: Explicit adapter option
    if (options?.adapter) {
      return this.validateAndRoute(options.adapter, analysis, 'explicit-option');
    }
    
    // Priority 2: Collection metadata adapter config
    // NEW: Check if collection has adapter specified in metadata
    const collectionMetadata = await this.getCollectionMetadata(parsed.collection);
    if (collectionMetadata?.adapter?.type) {
      const adapterType = collectionMetadata.adapter.type;
      // Check if adapter exists in config
      if (this.adapters[adapterType]) {
        debug(`[Smallstore] Using adapter "${adapterType}" from collection metadata`);
        return this.validateAndRoute(adapterType, analysis, 'collection-metadata');
      } else {
        console.warn(`[Smallstore] Adapter "${adapterType}" specified in collection metadata but not configured. Falling back to other routing.`);
      }
    }
    
    // Priority 3: Type-based routing
    if (this.config.typeRouting) {
      const typeAdapter = this.config.typeRouting[analysis.type];
      if (typeAdapter) {
        return this.validateAndRoute(typeAdapter, analysis, 'type-routing');
      }
    }
    
    // Priority 4: Pattern-based routing (routing + mounts)
    // Build combined routing rules from both routing and mounts configs
    const routingRules = this.config.routing || {};
    const mountRules: Record<string, { adapter: string }> = {};
    if (this.config.mounts) {
      for (const [pattern, adapter] of Object.entries(this.config.mounts)) {
        mountRules[pattern] = { adapter };
      }
    }
    const combinedRules = { ...mountRules, ...routingRules };

    if (Object.keys(combinedRules).length > 0) {
      // Match against full path (not just collection) for mount-like behavior
      const fullPath = [parsed.collection, ...parsed.path].join('/');
      const matchedAdapter = this.matchRoutingPattern(fullPath, combinedRules)
        || this.matchRoutingPattern(parsed.collection, combinedRules);
      if (matchedAdapter) {
        return this.validateAndRoute(matchedAdapter, analysis, 'pattern-routing');
      }
    }
    
    // Priority 5: TTL-aware routing — prefer TTL-capable adapters when TTL requested
    if (options?.ttl) {
      for (const [name, adapter] of Object.entries(this.adapters)) {
        if (adapter.capabilities.features?.ttl) {
          return this.validateAndRoute(name, analysis, 'ttl-routing');
        }
      }
      // No TTL-capable adapter found — fall through (best-effort)
    }

    // Priority 6: Smart routing (if enabled)
    if (this.config.smartRouting) {
      return await this.smartRoute(data);
    }

    // Priority 7: Default adapter
    return this.validateAndRoute(this.defaultAdapter, analysis, 'default-adapter');
  }
  
  /**
   * Validate adapter can handle data, then route to it
   * 
   * Phase 3.1: Validation ensures adapter compatibility
   */
  private validateAndRoute(
    adapterName: string,
    analysis: any,
    reason: string
  ): RoutingDecision {
    try {
      const adapter = this.adapters[adapterName];
      if (!adapter) {
        throw new Error(`Adapter "${adapterName}" not found in configured adapters`);
      }

      // Validate adapter can handle this data type
      if (!canHandleType(adapter, analysis.type)) {
        throw new Error(
          `Adapter "${adapterName}" cannot handle data type "${analysis.type}". ` +
          `Supported types: ${adapter.capabilities.supportedTypes.join(', ')}`
        );
      }

      // Validate adapter can handle this data size
      if (!canHandleSize(adapter, analysis.sizeBytes)) {
        const maxSize = adapter.capabilities.maxItemSize;
        throw new Error(
          `Adapter "${adapterName}" cannot handle data size ${analysis.sizeBytes} bytes. ` +
          `Maximum size: ${maxSize ? `${maxSize} bytes` : 'unlimited'}`
        );
      }
    } catch (originalError) {
      throw new Error(
        `Cannot store data: no suitable adapter found for this data type and size`,
        { cause: originalError }
      );
    }

    return {
      adapter: adapterName,
      analysis,
      reason: `Phase 3.1: ${reason}`,
    };
  }
  
  /**
   * Match collection path against routing patterns
   * 
   * Phase 3.1: Pattern matching (first match wins)
   * 
   * @param collection - Collection name to match
   * @param rules - Routing rules
   * @returns Matched adapter name, or null
   */
  private matchRoutingPattern(
    collection: string,
    rules: Record<string, { adapter: string }>
  ): string | null {
    // Match patterns in order (first match wins)
    for (const [pattern, config] of Object.entries(rules)) {
      if (this.patternMatches(collection, pattern)) {
        return config.adapter;
      }
    }
    return null;
  }
  
  /**
   * Check if collection matches pattern
   * 
   * Supports simple glob matching:
   * - '*' = catch-all
   * - 'cache:*' = starts with 'cache:'
   * - '*:temp' = ends with ':temp'
   * - 'cache:*:temp' = starts with 'cache:' and ends with ':temp'
   */
  private patternMatches(collection: string, pattern: string): boolean {
    if (pattern === '*') return true;  // Catch-all
    
    // Convert glob pattern to regex
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(collection);
  }
  
  /**
   * Legacy smart routing (Priority 4)
   * 
   * Kept for backward compatibility when smartRouting: true
   */
  private async smartRoute(data: any): Promise<RoutingDecision> {
    const analysis = analyzeData(data);
    
    // Find candidate adapters that can handle this data
    const candidates: Array<{ name: string; adapter: StorageAdapter; score: number }> = [];
    
    for (const [name, adapter] of Object.entries(this.adapters)) {
      // Check if adapter can handle this data type and size
      if (
        canHandleType(adapter, analysis.type) &&
        canHandleSize(adapter, analysis.sizeBytes)
      ) {
        // Score this adapter
        const score = this.scoreAdapter(adapter, analysis);
        candidates.push({ name, adapter, score });
      }
    }
    
    // No candidates? Use default adapter
    if (candidates.length === 0) {
      console.warn(
        `[Smallstore] No adapters can handle ${analysis.type} (${analysis.size}). ` +
        `Falling back to default adapter "${this.defaultAdapter}".`
      );
      
      return {
        adapter: this.defaultAdapter,
        analysis,
        reason: `Fallback: No adapters found for ${analysis.type}`,
        alternatives: [],
      };
    }
    
    // Sort by score (descending)
    candidates.sort((a, b) => b.score - a.score);
    
    // Pick best adapter
    const best = candidates[0];
    const alternatives = candidates.slice(1, 3).map((c) => c.name);
    
    return {
      adapter: best.name,
      analysis,
      reason: `Smart routing: ${this.explainChoice(best.adapter, analysis)}`,
      alternatives,
    };
  }
  
  /**
   * Score adapter for given data
   * 
   * Higher score = better fit
   * 
   * Scoring factors:
   * - Type match (1.0 = exact match)
   * - Cost (lower cost = higher score)
   * - Performance (lower latency = higher score)
   */
  private scoreAdapter(adapter: StorageAdapter, analysis: any): number {
    let score = 0;
    
    // Type match (most important): +10 points
    if (canHandleType(adapter, analysis.type)) {
      score += 10;
    }
    
    // Cost tier: free > cheap > moderate > expensive
    const costTier = getCostTier(adapter);
    if (costTier === 'free') score += 5;
    else if (costTier === 'cheap') score += 3;
    else if (costTier === 'moderate') score += 1;
    // expensive = 0
    
    // Performance: low latency = +2, medium = +1, high = 0
    const readLatency = adapter.capabilities.performance?.readLatency;
    if (readLatency === 'low') score += 2;
    else if (readLatency === 'medium') score += 1;
    
    return score;
  }
  
  /**
   * Explain why this adapter was chosen
   */
  private explainChoice(adapter: StorageAdapter, analysis: any): string {
    const costTier = getCostTier(adapter);
    const latency = adapter.capabilities.performance?.readLatency || 'medium';
    
    return (
      `Best fit for ${analysis.type} (${analysis.size}): ` +
      `${adapter.capabilities.name} - ${costTier} cost, ${latency} latency`
    );
  }
  
  /**
   * Get adapter for existing key
   * 
   * Checks metadata to see which adapter stored this key.
   * If not found in metadata, checks all adapters.
   */
  private async getAdapterForKey(key: string): Promise<StorageAdapter> {
    // Parse collection from key
    const parts = key.split(':');
    const collection = parts[1]; // "smallstore:<collection>:..."
    
    if (!collection) {
      return this.adapters[this.defaultAdapter];
    }
    
    // Check metadata for adapter info
    const schema = await this.getSchema(collection);
    const pathKey = key.replace(`smallstore:${collection}:`, '');
    const pathInfo = schema.paths[pathKey];
    
    if (pathInfo && this.adapters[pathInfo.adapter]) {
      return this.adapters[pathInfo.adapter];
    }
    
    // Metadata miss: Check all adapters
    for (const adapter of Object.values(this.adapters)) {
      if (await adapter.has(key)) {
        return adapter;
      }
    }
    
    // Not found anywhere: return default
    return this.adapters[this.defaultAdapter];
  }
  
  /**
   * Resolve which adapter handles a given collection path
   *
   * Uses mount patterns and routing rules to find the right adapter
   * WITHOUT needing actual data. Falls back to default adapter.
   */
  private resolveAdapterForPath(collectionPath: string): StorageAdapter {
    const parsed = parsePath(collectionPath);
    const fullPath = [parsed.collection, ...parsed.path].join('/');

    // Check mount patterns
    const mountRules: Record<string, { adapter: string }> = {};
    if (this.config.mounts) {
      for (const [pattern, adapter] of Object.entries(this.config.mounts)) {
        mountRules[pattern] = { adapter };
      }
    }
    const routingRules = this.config.routing || {};
    const combinedRules = { ...mountRules, ...routingRules };

    if (Object.keys(combinedRules).length > 0) {
      const matched = this.matchRoutingPattern(fullPath, combinedRules)
        || this.matchRoutingPattern(parsed.collection, combinedRules);
      if (matched && this.adapters[matched]) {
        return this.adapters[matched];
      }
    }

    return this.adapters[this.defaultAdapter];
  }

  /**
   * Get adapter name from adapter instance
   *
   * Phase 3.2: Helper to find adapter name by instance
   */
  private getAdapterName(adapter: StorageAdapter): string {
    for (const [name, adapterInstance] of Object.entries(this.adapters)) {
      if (adapterInstance === adapter) {
        return name;
      }
    }
    return this.defaultAdapter;
  }
  
  // ============================================================================
  // Metadata Management
  // ============================================================================
  
  /**
   * Update collection metadata after setting data
   */
  private async updateMetadata(parsed: any, decision: RoutingDecision): Promise<void> {
    const schema = await this.getSchema(parsed.collection);
    const pathKey = parsed.path.join('/') || '<root>';
    
    // Ensure schema.paths exists and is an object (defensive programming)
    if (!schema.paths || typeof schema.paths === 'string') {
      console.warn(`[Router] Schema paths was string instead of object for collection — resetting`);
      schema.paths = {};
    }
    
    // Ensure schema.metadata exists and is an object
    if (!schema.metadata || typeof schema.metadata === 'string') {
      // If metadata was serialized as a string, reset it
      schema.metadata = {};
    }
    
    // Update path info
    schema.paths[pathKey] = {
      adapter: decision.adapter,
      dataType: decision.analysis.type,
      size: decision.analysis.size,
      sizeBytes: decision.analysis.sizeBytes,
      count: (schema.paths[pathKey]?.count || 0) + 1,
    };
    
    // Update metadata timestamps
    schema.metadata.updated = new Date().toISOString();
    if (!schema.metadata.created) {
      schema.metadata.created = schema.metadata.updated;
    }
    
    // Save updated schema
    const metadataKey = buildMetadataKey(parsed.collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    await metadataAdapter.set(metadataKey, schema);
  }
  
  /**
   * Remove path from metadata after deletion
   */
  private async removeFromMetadata(parsed: any): Promise<void> {
    const schema = await this.getSchema(parsed.collection);
    const pathKey = parsed.path.join('/') || '<root>';
    
    // Ensure schema.paths exists and is an object (defensive programming)
    if (!schema.paths || typeof schema.paths === 'string') {
      console.warn(`[Router] Schema paths was string instead of object for collection — resetting`);
      schema.paths = {};
    }
    
    // Ensure schema.metadata exists and is an object
    if (!schema.metadata || typeof schema.metadata === 'string') {
      // If metadata was serialized as a string, reset it
      schema.metadata = {};
    }
    
    // Remove path info
    delete schema.paths[pathKey];
    
    // Update metadata timestamp
    schema.metadata.updated = new Date().toISOString();
    
    // Save updated schema
    const metadataKey = buildMetadataKey(parsed.collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    await metadataAdapter.set(metadataKey, schema);
  }
  
  // ============================================================================
  // Phase 3: Key Index Management
  // ============================================================================
  
  /**
   * Update key index after setting data
   * 
   * Phase 3: Track which adapter stores each key for multi-adapter setups
   */
  private async updateKeyIndex(parsed: any, decision: RoutingDecision): Promise<void> {
    const indexLockKey = `__keyindex__:${parsed.collection}`;
    const release = await this.keyLock.acquire(indexLockKey);
    try {
      const metadataAdapter = this.adapters[this.metadataAdapter];

      debug(`[Smallstore] updateKeyIndex: loading index for collection "${parsed.collection}"`);

      // Load existing index or create new one
      let index = await loadIndex(metadataAdapter, parsed.collection);
      debug(`[Smallstore] updateKeyIndex: index loaded, has keys?`, index ? Object.keys(index.keys || {}).length : 'null');

      if (!index) {
        debug(`[Smallstore] updateKeyIndex: creating empty index`);
        index = createEmptyIndex(parsed.collection);
      }

      // Build storage key
      const key = buildKey(parsed);
      debug(`[Smallstore] updateKeyIndex: built key "${key}"`);

      // Create key location
      const location: KeyLocation = {
        key,
        collection: parsed.collection,
        path: parsed.path.join('/') || '/',
        adapter: decision.adapter,
        dataType: decision.analysis.type,
        sizeBytes: decision.analysis.sizeBytes,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };

      debug(`[Smallstore] updateKeyIndex: adding key to index, index.keys is:`, typeof index.keys);

      // Add to index
      index = addKeyToIndex(index, location);

      debug(`[Smallstore] updateKeyIndex: saving index`);

      // Save updated index
      await saveIndex(metadataAdapter, index);

      debug(`[Smallstore] updateKeyIndex: complete`);
    } catch (error) {
      console.error(`[Smallstore] updateKeyIndex ERROR:`, error);
      console.error(`[Smallstore] updateKeyIndex ERROR stack:`, error instanceof Error ? error.stack : 'no stack');
      throw error;
    } finally {
      release();
    }
  }
  
  /**
   * Remove key from index after deletion
   */
  private async removeFromKeyIndex(parsed: any, key: string): Promise<void> {
    const indexLockKey = `__keyindex__:${parsed.collection}`;
    const release = await this.keyLock.acquire(indexLockKey);
    try {
      const metadataAdapter = this.adapters[this.metadataAdapter];

      // Load index
      const index = await loadIndex(metadataAdapter, parsed.collection);
      if (!index) {
        // No index exists, nothing to remove
        return;
      }

      // Remove key from index
      const updatedIndex = removeKeyFromIndex(index, key);

      // Save updated index
      await saveIndex(metadataAdapter, updatedIndex);
    } finally {
      release();
    }
  }
  
  /**
   * Reconstruct metadata and key index by scanning all adapters
   * 
   * Phase 3: Lazy reconstruction - rebuild from source of truth (the data itself!)
   * 
   * This is slow but guarantees correctness. Use when:
   * - Metadata is missing/corrupted
   * - After manual data changes
   * - As a "repair" operation
   * 
   * @param collection - Collection to rebuild
   * @returns Reconstructed schema and index
   */
  async reconstructMetadata(collection: string): Promise<{ schema: CollectionSchema; index: KeyIndex }> {
    debug(`[Smallstore] Reconstructing metadata for collection "${collection}"...`);
    
    // Initialize empty schema and index
    const schema: CollectionSchema = {
      collection,
      paths: {},
      metadata: {
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        itemCount: 0,
        totalSize: 'unknown',
      },
    };
    
    let index = createEmptyIndex(collection);
    let successCount = 0;
    let totalKeys = 0;

    // Scan all adapters for keys matching this collection
    const prefix = `smallstore:${collection}`;
    
    for (const [adapterName, adapter] of Object.entries(this.adapters)) {
      try {
        // List keys with this collection prefix
        const keys = await adapter.keys(prefix);
        
        for (const key of keys) {
          // Skip metadata/index keys
          if (key.includes(':meta:') || key.includes(':index:') || key.includes(':view:')) {
            continue;
          }

          totalKeys++;
          try {
            // Get data to analyze
            const data = await adapter.get(key);
            if (!data) continue;
            
            // Analyze data
            const analysis = analyzeData(data);
            
            // Parse key to extract path
            // Key format: "smallstore:collection/path/subpath"
            const pathPart = key.replace(`smallstore:${collection}`, '').replace(/^\//, '');
            const pathSegments = pathPart ? pathPart.split('/') : [];
            const pathKey = pathSegments.join('/') || '<root>';
            
            // Update schema
            schema.paths[pathKey] = {
              adapter: adapterName,
              dataType: analysis.type,
              size: analysis.size,
              sizeBytes: analysis.sizeBytes,
              count: (schema.paths[pathKey]?.count || 0) + 1,
            };
            
            // Update index
            const location: KeyLocation = {
              key,
              collection,
              path: pathSegments.join('/') || '/',
              adapter: adapterName,
              dataType: analysis.type,
              sizeBytes: analysis.sizeBytes,
              created: new Date().toISOString(),
              updated: new Date().toISOString(),
            };
            index = addKeyToIndex(index, location);
            successCount++;

          } catch (err) {
            console.warn(`[Smallstore] Failed to analyze key "${key}":`, err);
            // Continue with other keys
          }
        }
      } catch (err) {
        console.warn(`[Smallstore] Failed to scan adapter "${adapterName}":`, err);
        // Continue with other adapters
      }
    }
    
    if (successCount === 0 && totalKeys > 0) {
      console.warn(`[Router] Metadata reconstruction failed for all ${totalKeys} keys in collection "${collection}"`);
    }

    // Save reconstructed metadata
    const metadataAdapter = this.adapters[this.metadataAdapter];
    await metadataAdapter.set(buildMetadataKey(collection), schema);
    await saveIndex(metadataAdapter, index);

    debug(`[Smallstore] Reconstructed ${Object.keys(schema.paths).length} paths, ${Object.keys(index.keys).length} keys`);
    
    return { schema, index };
  }
  
  // ============================================================================
  // Get Options Filtering (Phase 1: Simple in-memory)
  // ============================================================================
  
  /**
   * Apply get options (filter, sort, limit, offset)
   * 
   * Phase 1: Simple in-memory operations
   * Future: Push down to adapters for efficiency
   */
  private applyGetOptions(data: any, options: GetOptions): any {
    // If data is not an array, can't filter/sort
    if (!Array.isArray(data)) {
      return data;
    }
    
    let result = [...data];
    
    // Filter
    if (options.filter) {
      result = result.filter((item) => {
        return Object.entries(options.filter!).every(([key, value]) => {
          return item[key] === value;
        });
      });
    }
    
    // Sort (simple: "field ASC" or "field DESC")
    if (options.sort && typeof options.sort === 'string') {
      const [field, direction] = options.sort.split(' ');
      const asc = direction?.toUpperCase() !== 'DESC';
      
      result.sort((a, b) => {
        const aVal = a[field];
        const bVal = b[field];
        
        if (aVal < bVal) return asc ? -1 : 1;
        if (aVal > bVal) return asc ? 1 : -1;
        return 0;
      });
    }
    
    // Offset
    if (options.offset) {
      result = result.slice(options.offset);
    }
    
    // Limit
    if (options.limit) {
      result = result.slice(0, options.limit);
    }
    
    return result;
  }
  
  // ============================================================================
  // Phase 2.5: Views & Namespace Operations
  // ============================================================================
  
  /**
   * Create a named view (saved retrieval pipeline)
   */
  async createView(name: string, definition: any): Promise<void> {
    await this.viewManager.createView(name, definition);
  }
  
  /**
   * Execute a view (load source data and apply retrieval pipeline)
   */
  async getView(name: string, options?: any): Promise<any> {
    // Get view definition
    const viewDef = await this.viewManager.getViewDefinition(name);
    
    if (!viewDef) {
      throw new Error(`View not found: ${name}`);
    }
    
    // Load source data (raw: true to get actual data, not StorageFileResponse wrapper)
    const sourceData = await this.get(viewDef.source, { raw: true });

    if (sourceData === null) {
      throw new Error(`View source not found: ${viewDef.source}`);
    }

    // Execute view
    return await this.viewManager.executeView(name, sourceData, options);
  }
  
  /**
   * Update view definition
   */
  async updateView(name: string, definition: any): Promise<void> {
    await this.viewManager.updateView(name, definition);
  }
  
  /**
   * Delete a view
   */
  async deleteView(name: string): Promise<void> {
    await this.viewManager.deleteView(name);
  }
  
  /**
   * List all views (optionally filtered by namespace)
   */
  async listViews(namespace?: string): Promise<string[]> {
    return await this.viewManager.listViews(namespace);
  }
  
  /**
   * Get folder tree structure
   */
  async tree(path: string, options?: any): Promise<any> {
    const adapter = this.adapters[this.defaultAdapter];
    const metadataAdapter = this.adapters[this.metadataAdapter];
    return await buildTree(adapter, metadataAdapter, path, options);
  }
  
  /**
   * Get all data under a namespace
   */
  async getNamespace(path: string, options?: any): Promise<any> {
    const adapter = this.adapters[this.defaultAdapter];
    return await getNamespaceOp(adapter, path, options);
  }
  
  /**
   * Copy data from one path to another
   */
  async copy(source: string, dest: string): Promise<void> {
    const adapter = this.adapters[this.defaultAdapter];
    return await copyOp(adapter, source, dest);
  }
  
  /**
   * Move data (copy + delete)
   */
  async move(source: string, dest: string): Promise<void> {
    const adapter = this.adapters[this.defaultAdapter];
    return await moveOp(adapter, source, dest);
  }
  
  /**
   * Copy entire namespace
   */
  async copyNamespace(source: string, dest: string, options?: any): Promise<void> {
    const adapter = this.adapters[this.defaultAdapter];
    return await copyNamespaceOp(adapter, source, dest, options);
  }

  // ============================================================================
  // Namespace Operations (Folder-like)
  // ============================================================================

  /**
   * List child namespaces under a path
   */
  async listNamespaces(parentPath?: string): Promise<string[]> {
    const adapter = this.adapters[this.defaultAdapter];
    const prefix = parentPath ? `smallstore:${parentPath.replace(/\//g, ':')}` : 'smallstore:';
    const allKeys = await adapter.keys(prefix);

    // Extract unique immediate children
    const children = new Set<string>();
    const prefixLen = prefix.length;

    for (const key of allKeys) {
      // Skip metadata/index/view keys
      if (key.includes(':__') || key.includes(':view:')) continue;

      const remainder = key.slice(prefixLen);
      // Remove leading colon if present
      const cleanRemainder = remainder.startsWith(':') ? remainder.slice(1) : remainder;
      if (!cleanRemainder) continue;

      // Get first segment (immediate child)
      const firstSegment = cleanRemainder.split(':')[0];
      if (firstSegment) {
        children.add(firstSegment);
      }
    }

    return Array.from(children).sort();
  }

  /**
   * Delete an entire namespace and all data under it
   */
  async deleteNamespace(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ deleted: number }> {
    const adapter = this.adapters[this.defaultAdapter];
    const prefix = `smallstore:${path.replace(/\//g, ':')}`;
    const allKeys = await adapter.keys(prefix);

    if (allKeys.length === 0) {
      return { deleted: 0 };
    }

    // Check if non-recursive delete was requested but namespace has children
    if (!options?.recursive) {
      // Check if there are sub-namespaces (keys with more path segments)
      const hasChildren = allKeys.some(key => {
        const remainder = key.slice(prefix.length);
        const clean = remainder.startsWith(':') ? remainder.slice(1) : remainder;
        return clean.includes(':');
      });
      if (hasChildren) {
        throw new Error(
          `Namespace "${path}" has children. Use { recursive: true } to delete.`
        );
      }
    }

    // Delete all keys
    let deleted = 0;
    for (const key of allKeys) {
      await adapter.delete(key);
      deleted++;
    }

    return { deleted };
  }

  /**
   * Get stats about a namespace or item
   */
  async stat(path: string): Promise<any> {
    const adapter = this.adapters[this.defaultAdapter];
    const prefix = `smallstore:${path.replace(/\//g, ':')}`;
    const allKeys = await adapter.keys(prefix);

    // Check if path is an exact item match
    const exactKey = prefix;
    const isItem = await adapter.has(exactKey);

    // Get immediate children
    const children = new Set<string>();
    const prefixLen = prefix.length;
    for (const key of allKeys) {
      if (key.includes(':__') || key.includes(':view:')) continue;
      const remainder = key.slice(prefixLen);
      const clean = remainder.startsWith(':') ? remainder.slice(1) : remainder;
      if (!clean) continue;
      const firstSegment = clean.split(':')[0];
      if (firstSegment) children.add(firstSegment);
    }

    // Detect adapters used
    const adaptersUsed = new Set<string>();
    adaptersUsed.add(this.defaultAdapter);

    return {
      path,
      type: isItem && children.size === 0 ? 'item' : 'namespace',
      itemCount: allKeys.filter(k => !k.includes(':__') && !k.includes(':view:')).length,
      children: Array.from(children).sort(),
      adapters: Array.from(adaptersUsed),
    };
  }

  /**
   * Rename a namespace (copy + delete)
   */
  async renameNamespace(source: string, dest: string): Promise<void> {
    await this.copyNamespace(source, dest, { overwrite: false });
    try {
      await this.deleteNamespace(source, { recursive: true });
    } catch (deleteError) {
      const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
      throw new Error(
        `renameNamespace: copy from '${source}' to '${dest}' succeeded, but deleting source failed: ${msg}. ` +
        `Data now exists in BOTH '${source}' and '${dest}'. Manually delete the source or destination to resolve.`
      );
    }
  }

  // ============================================================================
  // Phase 3: Metadata Reconstruction (Public API)
  // ============================================================================
  
  /**
   * Manually rebuild metadata and key index for a collection
   * 
   * Phase 3: Public API for metadata reconstruction
   * 
   * Use this when:
   * - You suspect metadata is corrupted
   * - You made manual changes to storage
   * - You want to force a rebuild for diagnostics
   * 
   * This scans all adapters and rebuilds metadata from the actual stored data.
   * 
   * @param collection - Collection to rebuild
   * @returns Reconstructed schema and index
   * 
   * @example
   * ```typescript
   * // Rebuild metadata after manual changes
   * const { schema, index } = await storage.rebuildMetadata("research");
   * console.log(`Rebuilt ${Object.keys(schema.paths).length} paths`);
   * ```
   */
  async rebuildMetadata(collection: string): Promise<{ schema: CollectionSchema; index: KeyIndex }> {
    return await this.reconstructMetadata(collection);
  }
  
  // ============================================================================
  // Phase 3.5: Smart Upsert
  // ============================================================================
  
  /**
   * Upsert object(s) by key field (insert if new, update if exists)
   * 
   * Automatically constructs storage keys from a specified field in the objects,
   * enabling ID-based upsert patterns similar to Airtable, Notion, and traditional databases.
   * 
   * This is a convenience method that:
   * 1. Extracts the ID from each object (via idField or keyGenerator)
   * 2. Constructs the full key: `collection/id`
   * 3. Calls set() with mode: 'overwrite'
   * 
   * @param collection - Collection name
   * @param data - Single object or array of objects to upsert
   * @param options - Options (idField defaults to 'id', can override with keyGenerator)
   */
  async upsertByKey(collection: string, data: any | any[], options?: SetOptions): Promise<void> {
    // Default idField to 'id'
    const idField = options?.idField || 'id';
    const keyGenerator = options?.keyGenerator;
    
    // Normalize to array
    const items = Array.isArray(data) ? data : [data];
    
    // Validate we have objects
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(
          `upsertByKey requires object(s), got ${typeof item}. ` +
          `Did you mean to use set() instead?`
        );
      }
    }
    
    // A077+A083: Two-phase upsert — validate all items first, then write
    // Phase 1: Validate all items and generate keys (no writes)
    const validated: Array<{ key: string; item: any }> = [];

    for (const item of items) {
      let id: string;

      // Extract ID
      if (keyGenerator) {
        // Use custom key generator
        try {
          id = keyGenerator(item);
        } catch (error) {
          throw new Error(
            `keyGenerator failed for object ${JSON.stringify(item).slice(0, 100)}: ` +
            `${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        // Use idField
        id = item[idField];
      }

      // Validate ID exists and is a string
      if (id === undefined || id === null) {
        throw new Error(
          `Missing ${idField} in object: ${JSON.stringify(item).slice(0, 200)}. ` +
          `Specify a different idField or provide a keyGenerator.`
        );
      }

      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(
          `ID field '${idField}' must be string or number, got ${typeof id}: ${JSON.stringify(id)}`
        );
      }

      // Convert to string if number
      const idStr = String(id);

      // Construct full key
      const key = `${collection}/${idStr}`;

      validated.push({ key, item });
    }

    // Phase 2: Write all pre-validated items
    for (const { key, item } of validated) {
      await this.set(key, item, {
        ...options,
        mode: 'overwrite',  // Always overwrite for upsert
      });
    }
  }
  
  // ============================================================================
  // Phase 3.2: Content Negotiation Methods
  // ============================================================================
  
  /**
   * Get collection as structured JSON
   * 
   * Phase 3.2: Materialize collection with metadata
   * Phase 3.4: Supports filtering by type, adapter, schema, and key search
   * 
   * Returns collection items with full metadata about:
   * - Each item (key, type, data, adapter, size)
   * - Collection totals (count, size, adapters)
   * - Timestamps (created, updated)
   * 
   * @param collectionPath - Collection to materialize
   * @param options - Optional filtering, sorting, pagination options
   * @returns Structured JSON
   * 
   * @example
   * const json = await storage.getAsJson("bookmarks/tech");
   * // → { collection: "bookmarks/tech", count: 42, items: [...], metadata: {...} }
   * 
   * @example
   * // Filter by type and schema
   * const json = await storage.getAsJson("collection", {
   *   filterType: "object",
   *   filterSchema: { required: ["name", "role"] }
   * });
   */
  async getAsJson(collectionPath: string, options?: GetOptions): Promise<MaterializedJson> {
    return await materializeJson(this, collectionPath, options);
  }
  
  /**
   * Get collection as markdown
   * 
   * Phase 3.2: Materialize collection as human-readable markdown
   * 
   * Returns markdown with:
   * - Header with collection info
   * - Metadata summary
   * - Items as headings with code blocks
   * 
   * @param collectionPath - Collection to materialize
   * @returns Markdown string
   * 
   * @example
   * const md = await storage.getAsMarkdown("bookmarks/tech");
   * // → # bookmarks/tech
   * //   **Items:** 42
   * //   ## article1 (object)
   * //   ```json
   * //   {...}
   * //   ```
   */
  async getAsMarkdown(collectionPath: string): Promise<string> {
    return await materializeMarkdown(this, collectionPath);
  }
  
  /**
   * Get collection as CSV
   * 
   * Phase 3.2: Materialize collection as CSV for spreadsheets
   * 
   * Returns CSV with:
   * - Metadata columns (key, type, adapter, size)
   * - Data columns (extracted from objects)
   * - RFC 4180 compliant escaping
   * 
   * Works best with homogeneous object collections.
   * 
   * @param collectionPath - Collection to materialize
   * @param options - CSV options
   * @returns CSV string
   * 
   * @example
   * const csv = await storage.getAsCsv("bookmarks/tech");
   * // → key,type,adapter,title,url
   * //   article1,object,upstash,Cool Post,https://...
   */
  async getAsCsv(collectionPath: string, options?: CsvOptions): Promise<string> {
    return await materializeCsv(this, collectionPath, options);
  }
  
  /**
   * Get collection as plain text
   * 
   * Phase 3.2: Materialize collection as simple text format
   * 
   * Returns text with:
   * - Collection name
   * - Item count and size
   * - Items as key:value pairs
   * 
   * Good for quick viewing and grep-able output.
   * 
   * @param collectionPath - Collection to materialize
   * @returns Plain text string
   * 
   * @example
   * const text = await storage.getAsText("settings");
   * // → settings
   * //   Items: 3
   * //   theme: "dark"
   * //   language: "en"
   */
  async getAsText(collectionPath: string): Promise<string> {
    return await materializeText(this, collectionPath);
  }
  
  /**
   * Get collection as YAML
   * 
   * Phase 3.2: Materialize collection as YAML format
   * 
   * Returns YAML with:
   * - Collection metadata
   * - Items as nested YAML structure
   * 
   * Good for configuration files and structured data.
   * 
   * @param collectionPath - Collection to materialize
   * @returns YAML string
   * 
   * @example
   * const yaml = await storage.getAsYaml("config/app");
   * // → collection: config/app
   * //   items: 3
   * //   data:
   * //     database:
   * //       host: localhost
   */
  async getAsYaml(collectionPath: string): Promise<string> {
    return await materializeYaml(this, collectionPath);
  }
  
  // ============================================================================
  // Phase 3.6g-c: External Data Sources
  // ============================================================================
  
  /**
   * Get data from external source (with caching)
   * 
   * @param collectionPath - Virtual collection path
   * @param source - External source configuration
   * @returns Fetched data
   */
  private async getExternalData(collectionPath: string, source: ExternalSource): Promise<any> {
    const { fetchExternal, CacheValidError } = await import('./utils/external-fetcher.ts');
    
    // Check if we have cached data and it's still valid
    if (source.cacheKey && source.lastFetched && source.cacheTTL) {
      const cacheAge = Date.now() - source.lastFetched;
      if (cacheAge < source.cacheTTL) {
        // Cache is valid, try to get cached data
        try {
          const cachedData = await this.get(source.cacheKey);
          if (cachedData) {
            return cachedData;
          }
        } catch {
          // Cache miss, fetch fresh
        }
      }
    }
    
    // Fetch fresh data
    try {
      const result = await fetchExternal(source, false);
      
      // Update schema with new metadata
      const { collection } = parsePath(collectionPath);
      const schemaKey = buildMetadataKey(collection);
      const metadataAdapter = this.adapters[this.metadataAdapter];
      const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
      schema.externalSource = result.source;
      schema.metadata.updated = new Date().toISOString();
      
      // Cache the data if TTL > 0
      if (result.source.cacheTTL && result.source.cacheTTL > 0) {
        const cacheKey = source.cacheKey || `${collectionPath}/_cache`;
        result.source.cacheKey = cacheKey;
        await this.set(cacheKey, result.data);
        schema.externalSource.cacheKey = cacheKey;
      }
      
      await metadataAdapter.set(schemaKey, schema);
      
      return result.data;
    } catch (err) {
      if (err instanceof CacheValidError) {
        // Conditional request returned 304 or cache is still fresh; serve cached payload.
        if (source.cacheKey) {
          return await this.get(source.cacheKey);
        }
        // No cacheKey — caller can't fall back. Translate to a clearer error
        // instead of surfacing the internal sentinel.
        throw new Error(
          `External source for "${collectionPath}" is still valid (304/fresh) but has no cacheKey to serve from. Set cacheTTL > 0 and do an initial fetch to populate the cache.`,
        );
      }
      throw err;
    }
  }
  
  /**
   * Register external data source as virtual collection
   * 
   * Virtual collections point to remote data (JSON, CSV, Parquet) without storing it.
   * Data is fetched on demand and cached according to TTL settings.
   * 
   * @param collectionPath - Virtual collection path (e.g., "external/github-stars")
   * @param options - External source configuration
   */
  async registerExternal(collectionPath: string, options: RegisterExternalOptions): Promise<void> {
    const { collection } = parsePath(collectionPath);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    // Create external source metadata
    const externalSource: ExternalSource = {
      url: options.url,
      type: options.type || 'auto',
      cacheTTL: options.cacheTTL ?? 300000, // Default: 5 minutes
      headers: options.headers || {},
      auth: options.auth,
      lastFetched: undefined,
      cacheKey: undefined,
      etag: undefined,
      lastModified: undefined,
    };
    
    // Store in collection schema
    const schemaKey = buildMetadataKey(collection);
    let schema: CollectionSchema;
    
    try {
      const existing = await metadataAdapter.get(schemaKey);
      if (existing) {
        schema = existing as CollectionSchema;
      } else {
        // Schema doesn't exist, create new
        schema = {
          collection,
          paths: {},
          metadata: {
            created: new Date().toISOString(),
            itemCount: 0,
          },
        };
      }
    } catch {
      // Error getting schema, create new
      schema = {
        collection,
        paths: {},
        metadata: {
          created: new Date().toISOString(),
          itemCount: 0,
        },
      };
    }
    
    // Mark as external collection
    schema.externalSource = externalSource;
    schema.metadata.updated = new Date().toISOString();
    
    // Save schema
    await metadataAdapter.set(schemaKey, schema);
  }
  
  /**
   * Refresh external data source (force fetch)
   * 
   * @param collectionPath - Virtual collection path
   * @returns Fresh data
   */
  async refreshExternal(collectionPath: string): Promise<any> {
    const { collection } = parsePath(collectionPath);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    // Get external source config
    const source = await this.getExternalSource(collectionPath);
    if (!source) {
      throw new Error(`No external source registered for ${collectionPath}`);
    }
    
    // Fetch fresh data
    const { fetchExternal, CacheValidError } = await import('./utils/external-fetcher.ts');
    const result = await fetchExternal(source, true);
    
    // Update schema with new metadata
    const schemaKey = buildMetadataKey(collection);
    const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
    schema.externalSource = result.source;
    schema.metadata.updated = new Date().toISOString();
    await metadataAdapter.set(schemaKey, schema);
    
    // Cache the data if TTL > 0
    if (result.source.cacheTTL && result.source.cacheTTL > 0) {
      const cacheKey = `${collectionPath}/_cache`;
      result.source.cacheKey = cacheKey;
      await this.set(cacheKey, result.data);
      
      // Update schema with cache key
      schema.externalSource.cacheKey = cacheKey;
      await metadataAdapter.set(schemaKey, schema);
    }
    
    return result.data;
  }
  
  /**
   * List all registered external sources
   * 
   * @param pattern - Optional pattern to filter sources
   * @returns Array of external source paths
   */
  async listExternalSources(pattern?: string): Promise<string[]> {
    const collections = await this.listCollections(pattern);
    const externalSources: string[] = [];
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    for (const collection of collections) {
      const schemaKey = buildMetadataKey(collection);
      try {
        const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
        if (schema.externalSource) {
          externalSources.push(collection);
        }
      } catch {
        // Skip if schema doesn't exist
      }
    }
    
    return externalSources;
  }
  
  /**
   * Get external source configuration
   * 
   * @param collectionPath - Virtual collection path
   * @returns External source metadata
   */
  async getExternalSource(collectionPath: string): Promise<ExternalSource | null> {
    const { collection } = parsePath(collectionPath);
    const schemaKey = buildMetadataKey(collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    try {
      const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
      return schema.externalSource || null;
    } catch {
      return null;
    }
  }
  
  /**
   * Update external source configuration
   * 
   * @param collectionPath - Virtual collection path
   * @param options - Updated configuration
   */
  async updateExternalSource(collectionPath: string, options: Partial<RegisterExternalOptions>): Promise<void> {
    const { collection } = parsePath(collectionPath);
    const schemaKey = buildMetadataKey(collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
    if (!schema.externalSource) {
      throw new Error(`No external source registered for ${collectionPath}`);
    }
    
    // Update external source
    if (options.url) schema.externalSource.url = options.url;
    if (options.type) schema.externalSource.type = options.type;
    if (options.cacheTTL !== undefined) schema.externalSource.cacheTTL = options.cacheTTL;
    if (options.headers) schema.externalSource.headers = options.headers;
    if (options.auth) schema.externalSource.auth = options.auth;
    
    schema.metadata.updated = new Date().toISOString();
    
    await metadataAdapter.set(schemaKey, schema);
  }
  
  /**
   * Unregister external source (remove virtual collection)
   * 
   * @param collectionPath - Virtual collection path
   * @param deleteCachedData - Whether to also delete cached data
   */
  async unregisterExternal(collectionPath: string, deleteCachedData = true): Promise<void> {
    const { collection } = parsePath(collectionPath);
    const schemaKey = buildMetadataKey(collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    
    // Get schema
    const schema = await metadataAdapter.get(schemaKey) as CollectionSchema;
    if (!schema.externalSource) {
      throw new Error(`No external source registered for ${collectionPath}`);
    }
    
    // Delete cached data if requested
    if (deleteCachedData && schema.externalSource.cacheKey) {
      try {
        await this.delete(schema.externalSource.cacheKey);
      } catch {
        // Ignore if cache doesn't exist
      }
    }
    
    // Remove external source from schema
    delete schema.externalSource;
    schema.metadata.updated = new Date().toISOString();
    
    // If schema is now empty, delete it
    if (Object.keys(schema.paths).length === 0) {
      await metadataAdapter.delete(schemaKey);
    } else {
      await metadataAdapter.set(schemaKey, schema);
    }
  }
  
  // ============================================================================
  // Phase 3.6h: Query Result Caching & Cache Management
  // ============================================================================
  
  /**
   * Clear cache for a specific query
   * 
   * @param collectionPath - Collection path
   * @param options - Query options to identify cached result
   */
  async clearQueryCache(collectionPath: string, options?: QueryOptions): Promise<void> {
    if (!options) {
      // No options provided - can't identify specific query, clear all for collection
      await this.clearCollectionCache(collectionPath);
      return;
    }
    
    await this.cacheManager.clearQuery(collectionPath, options);
  }
  
  /**
   * Clear all caches for a collection
   * 
   * @param collectionPath - Collection path
   * @returns Number of caches cleared
   */
  async clearCollectionCache(collectionPath: string): Promise<number> {
    const { collection } = parsePath(collectionPath);
    return await this.cacheManager.clearCollection(collection);
  }
  
  /**
   * Clear all query caches
   * 
   * @returns Number of caches cleared
   */
  async clearAllCaches(): Promise<number> {
    return await this.cacheManager.clearAll();
  }
  
  /**
   * Get cache statistics
   * 
   * @param collectionPath - Optional collection to filter stats
   * @returns Cache statistics (hits, misses, size, etc.)
   */
  async getCacheStats(collectionPath?: string): Promise<CacheStats> {
    if (collectionPath) {
      const { collection } = parsePath(collectionPath);
      return await this.cacheManager.getStats(collection);
    }
    return await this.cacheManager.getStats();
  }
  
  // ============================================================================
  // Phase 3.6h-b: Materialized Views API
  // ============================================================================
  
  /**
   * Create a materialized view
   * 
   * @param name - View name
   * @param definition - View definition
   */
  async createMaterializedView(name: string, definition: any): Promise<void> {
    return await this.materializedViewManager.create(name, definition);
  }
  
  /**
   * Refresh a materialized view
   * 
   * @param name - View name
   * @param options - Refresh options
   */
  async refreshView(name: string, options?: any): Promise<any> {
    return await this.materializedViewManager.refresh(name, options);
  }
  
  /**
   * Update materialized view definition
   * 
   * @param name - View name
   * @param updates - Partial definition updates
   */
  async updateMaterializedView(name: string, updates: any): Promise<void> {
    return await this.materializedViewManager.update(name, updates);
  }
  
  /**
   * Delete a materialized view
   * 
   * @param name - View name
   * @param deleteData - Whether to delete materialized data
   */
  async deleteMaterializedView(name: string, deleteData = true): Promise<void> {
    return await this.materializedViewManager.delete(name, deleteData);
  }
  
  /**
   * List all materialized views
   * 
   * @param filter - Optional filter criteria
   */
  async listMaterializedViews(filter?: any): Promise<any[]> {
    return await this.materializedViewManager.list(filter);
  }
  
  /**
   * Get materialized view metadata
   * 
   * @param name - View name
   */
  async getViewMetadata(name: string): Promise<any> {
    return await this.materializedViewManager.getMetadata(name);
  }
  
  /**
   * Refresh all views matching filter
   * 
   * @param filter - Optional filter criteria
   */
  async refreshAllViews(filter?: any): Promise<any[]> {
    return await this.materializedViewManager.refreshAll(filter);
  }
  
  // ============================================================================
  // Collection Metadata (User-Defined + System)
  // ============================================================================
  
  /**
   * Get collection metadata
   * 
   * @param collection - Collection name
   * @returns Metadata object (user-defined + system)
   */
  async getCollectionMetadata(collection: string): Promise<Record<string, any>> {
    const parsed = parsePath(collection);
    
    try {
      const schema = await this.getSchema(parsed.collection);
      return schema?.metadata || {};
    } catch {
      // If schema doesn't exist, return empty metadata
      return {};
    }
  }
  
  /**
   * Set collection metadata (merges with existing)
   * 
   * @param collection - Collection name
   * @param metadata - Metadata to set/merge
   */
  async setCollectionMetadata(
    collection: string,
    metadata: Record<string, any>
  ): Promise<void> {
    const parsed = parsePath(collection);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    const metadataKey = buildMetadataKey(parsed.collection);
    
    // Load existing schema
    let schema: CollectionSchema;
    try {
      schema = await this.getSchema(parsed.collection);
    } catch {
      // If schema doesn't exist, create minimal schema
      schema = {
        collection: parsed.collection,
        paths: {},
        metadata: {
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        }
      };
    }
    
    // Merge metadata (preserving system metadata)
    schema.metadata = {
      ...schema.metadata,
      ...metadata,
      updated: new Date().toISOString(),  // Always update timestamp
    };
    
    // Save schema
    await metadataAdapter.set(metadataKey, schema);
    
    debug(`[Smallstore] Updated metadata for collection "${parsed.collection}"`);
  }
  
  // ============================================================================
  // Graceful Degradation & Auto-Cleanup
  // ============================================================================
  
  /**
   * Validate metadata and cleanup orphaned keys
   * 
   * Removes keys from index that no longer exist in adapters.
   * 
   * @param collectionPath - Collection to validate
   * @returns Cleanup statistics
   */
  private async validateAndCleanup(collectionPath: string): Promise<{
    keysChecked: number;
    keysRemoved: number;
    errors: string[];
  }> {
    const parsed = parsePath(collectionPath);
    const metadataAdapter = this.adapters[this.metadataAdapter];
    const index = await loadIndex(metadataAdapter, parsed.collection);
    
    if (!index) {
      return { keysChecked: 0, keysRemoved: 0, errors: [] };
    }
    
    let keysChecked = 0;
    let keysRemoved = 0;
    const errors: string[] = [];
    
    // Check each key in index
    for (const [key, location] of Object.entries(index.keys)) {
      keysChecked++;
      
      try {
        const adapter = this.adapters[location.adapter];
        if (!adapter) {
          console.warn(`[Smallstore] Adapter "${location.adapter}" not found for key "${key}", removing from index`);
          await this.removeFromKeyIndex(parsed, key);
          keysRemoved++;
          continue;
        }
        
        // Check if key exists in adapter
        const exists = await adapter.has?.(key) ?? (await adapter.get(key) !== null);
        
        if (!exists) {
          console.warn(`[Smallstore] Key "${key}" not found in adapter "${location.adapter}", removing from index`);
          await this.removeFromKeyIndex(parsed, key);
          keysRemoved++;
        }
      } catch (error: any) {
        errors.push(`Failed to check key "${key}": ${error.message}`);
      }
    }
    
    debug(`[Smallstore] Validation complete: ${keysChecked} checked, ${keysRemoved} removed, ${errors.length} errors`);

    return { keysChecked, keysRemoved, errors };
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Get multiple keys in parallel
   */
  async batchGet(paths: string[], options?: GetOptions): Promise<Map<string, any>> {
    const results = new Map<string, any>();
    const settled = await Promise.allSettled(
      paths.map(async (p) => {
        const value = await this.get(p, options);
        return { path: p, value };
      })
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.path, outcome.value.value);
      } else {
        // Key not found or error — store null
        const idx = settled.indexOf(outcome);
        results.set(paths[idx], null);
      }
    }
    return results;
  }

  /**
   * Set multiple keys in parallel
   */
  async batchSet(entries: Array<{ path: string; data: any; options?: SetOptions }>): Promise<(any | null)[]> {
    const results = await Promise.allSettled(
      entries.map((entry) => this.set(entry.path, entry.data, entry.options))
    );
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      const error = new Error(`batchSet: ${failures.length}/${results.length} operations failed`);
      (error as any).results = results;
      throw error;
    }
    return results.map(r => r.status === 'fulfilled' ? r.value : null);
  }

  /**
   * Delete multiple keys in parallel
   */
  async batchDelete(paths: string[]): Promise<(void | null)[]> {
    const results = await Promise.allSettled(
      paths.map((p) => this.delete(p))
    );
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      const error = new Error(`batchDelete: ${failures.length}/${results.length} operations failed`);
      (error as any).results = results;
      throw error;
    }
    return results.map(r => r.status === 'fulfilled' ? r.value : null);
  }

  // ============================================================================
  // Signed URLs
  // ============================================================================

  async getSignedUploadUrl(
    collectionPath: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const adapter = await this.getAdapterForKey(collectionPath);
    if (!('getSignedUploadUrl' in adapter) || typeof (adapter as any).getSignedUploadUrl !== 'function') {
      throw new UnsupportedOperationError(
        adapter.capabilities.name,
        'getSignedUploadUrl',
        'This adapter does not support signed upload URLs.',
        'R2Direct adapter (S3-compatible presigned URLs)',
      );
    }
    return (adapter as any).getSignedUploadUrl(collectionPath, {
      expiresIn: options?.expiresIn,
      maxSize: options?.maxSize,
      contentType: options?.contentType,
    });
  }

  async getSignedDownloadUrl(
    collectionPath: string,
    options?: SignedUrlOptions,
  ): Promise<string> {
    const adapter = await this.getAdapterForKey(collectionPath);
    if (!('getSignedDownloadUrl' in adapter) || typeof (adapter as any).getSignedDownloadUrl !== 'function') {
      throw new UnsupportedOperationError(
        adapter.capabilities.name,
        'getSignedDownloadUrl',
        'This adapter does not support signed download URLs.',
        'R2Direct adapter (S3-compatible presigned URLs)',
      );
    }
    return (adapter as any).getSignedDownloadUrl(collectionPath, {
      expiresIn: options?.expiresIn,
      filename: options?.filename,
    });
  }

  // ============================================================================
  // Adapter Access (public API for materializers, explorers, etc.)
  // ============================================================================

  /**
   * Get the metadata adapter instance.
   */
  getMetadataAdapter(): StorageAdapter {
    return this.adapters[this.metadataAdapter];
  }

  /**
   * Get a named adapter instance, or undefined if not found.
   */
  getAdapter(name: string): StorageAdapter | undefined {
    return this.adapters[name];
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new SmartRouter instance
 * 
 * @param config - Router configuration
 * @returns SmartRouter (implements Smallstore)
 */
export function createSmartRouter(config: SmartRouterConfig): SmartRouter {
  return new SmartRouter(config);
}

