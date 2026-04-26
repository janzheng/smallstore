/**
 * Smallstore - Big surface area for small pockets of data storage
 * 
 * Core type system for architecture-first approach:
 * - Data type detection (json, array, array-large, blob, vector, etc.)
 * - Adapter capabilities (what each adapter can handle)
 * - Smart routing (match data to best adapter)
 * 
 * Completely standalone - no external framework dependencies!
 */

// ============================================================================
// Data Types
// ============================================================================

/**
 * Data types Smallstore understands
 * 
 * Ultra-simple 3-type system for "messy desk" / data mesh pattern:
 * - Just throw stuff in (append), figure out organization later (views)
 */
export type DataType = 
  | 'object'        // ANY JSON-serializable data (single object, array, nested - anything!)
  | 'blob'          // Binary data (images, audio, PDFs, large text)
  | 'kv';           // Simple primitives (string, number, boolean, null) - rarely used directly

// ============================================================================
// Adapter Capabilities
// ============================================================================

/**
 * Adapter capability declaration
 * 
 * Each adapter MUST declare what it can handle.
 * Router uses this to make intelligent routing decisions.
 */
/**
 * Options for paged key listing. Adapters that support it natively honor
 * all fields; adapters that don't can rely on the router's fallback which
 * wraps `keys()` and slices by offset/limit.
 */
export interface KeysPageOptions {
  /** Key prefix filter. */
  prefix?: string;
  /** Max keys to return in this page. Undefined = no limit. */
  limit?: number;
  /** Absolute offset into the full key list (ignored if `cursor` is given). */
  offset?: number;
  /** Opaque, adapter-specific cursor from the previous page's response. */
  cursor?: string;
}

/**
 * A page of keys plus metadata for continuation.
 */
export interface KeysPage {
  keys: string[];
  /** True if more keys exist past this page. */
  hasMore: boolean;
  /** Pass back to the next `listKeys()` call to continue (if the adapter uses cursors). */
  cursor?: string;
  /** Total matching keys, only populated when the adapter can return it cheaply. */
  total?: number;
}

export interface AdapterCapabilities {
  /** Adapter name (e.g., "memory", "upstash") */
  name: string;
  
  /** Which data types can this adapter handle? */
  supportedTypes: DataType[];
  
  /** Maximum item size in bytes (undefined = unlimited) */
  maxItemSize?: number;
  
  /** Maximum total storage in bytes (undefined = unlimited) */
  maxTotalSize?: number;
  
  /** Cost characteristics */
  cost?: {
    /** Cost per GB (e.g., "$0.20/GB") */
    perGB?: string;
    /** Cost per operation (e.g., "$0.0001/request") */
    perOperation?: string;
    /** Overall cost tier */
    tier: 'free' | 'cheap' | 'moderate' | 'expensive';
  };
  
  /** Performance characteristics */
  performance?: {
    readLatency: 'low' | 'medium' | 'high';
    writeLatency: 'low' | 'medium' | 'high';
    throughput: 'low' | 'medium' | 'high';
  };
  
  /** Special features this adapter supports */
  features?: {
    ttl?: boolean;
    transactions?: boolean;
    query?: boolean;
    search?: boolean;
    vectorSearch?: boolean;
    /** True if this adapter rejects all writes — routers should not select it for a set(). */
    readOnly?: boolean;
  };
}

// ============================================================================
// Data Analysis
// ============================================================================

/**
 * Data analysis result
 * 
 * Router analyzes data and produces this analysis for routing decisions
 */
export interface DataAnalysis {
  /** Detected data type */
  type: DataType;
  
  /** Size in bytes */
  sizeBytes: number;
  
  /** Human-readable size (e.g., "2.5MB") */
  size: string;
  
  /** Item count (for arrays) */
  itemCount?: number;
  
  /** Vector dimensions (for embeddings) */
  dimensions?: number;
  
  /** Recommended adapter based on analysis (optional) */
  recommendedAdapter?: string;
}

/**
 * Routing decision
 * 
 * Result of router analyzing data and picking best adapter
 */
export interface RoutingDecision {
  /** Chosen adapter name */
  adapter: string;
  
  /** Data analysis that led to this decision */
  analysis: DataAnalysis;
  
  /** Human-readable reason for this choice */
  reason: string;
  
  /** Alternative adapters that could also work (fallbacks) */
  alternatives?: string[];
}

// ============================================================================
// Main Smallstore Interface
// ============================================================================

/**
 * Smallstore - Universal storage interface
 * 
 * Supports:
 * - Folder-like paths: "collection/folder1/folder2/item"
 * - Automatic data type detection
 * - Smart routing to optimal adapters
 * - Heterogeneous data in one collection
 */
export interface Smallstore {
  // ============================================================================
  // Phase 1: IMPLEMENT THESE
  // ============================================================================
  
  /**
   * Get data from collection path
   * 
   * @param collectionPath - Folder-like path: "collection" or "collection/folder/item"
   * @param options - Optional filtering, sorting, pagination
   * @returns Data at that path, or null if not found
   * 
   * @example
   * // Get entire collection
   * await storage.get("api-cache");
   * 
   * // Folder-like paths
   * await storage.get("research/papers/2024");
   * await storage.get("research/papers/2024/quantum");
   * 
   * // With filtering
   * await storage.get("favorites/bookmarks", {
   *   filter: { topic: "AI" },
   *   sort: "date DESC",
   *   limit: 10
   * });
   */
  get(collectionPath: string, options?: GetOptions): Promise<any>;
  
  /**
   * Set data in collection path
   * 
   * SMART ROUTING: Automatically detects data type and routes to best adapter!
   * 
   * @param collectionPath - Folder-like path
   * @param data - Data to store (any type)
   * @param options - Optional TTL, mode, adapter override
   * 
   * @example
   * // Simple KV
   * await storage.set("api-cache/pipeline/abc123", data, { ttl: 3600 });
   * 
   * // Heterogeneous data (smart routing!)
   * await storage.set("podcast-research-2024", {
   *   episodes: [...],      // Array → analyze size, route accordingly
   *   transcripts: [...],   // Large blobs → future R2
   *   notes: "..."          // Small text → Upstash/Memory
   * });
   * 
   * // Large arrays (PubMed use case!)
   * await storage.set("research/pubmed-results", largePubMedArray);
   * // → Router detects: array-large (5000 items, 2.5MB)
   * // → Routes to: Memory (now) or appropriate DB (future)
   * // → NOT Upstash (exceeds 1MB limit)
   */
  set(collectionPath: string, data: any, options?: SetOptions): Promise<void>;

  /**
   * Partial update — shallow-merge patch into existing data.
   * If no existing data, behaves like set().
   *
   * @param collectionPath - Folder-like path to patch
   * @param patch - Fields to merge (shallow)
   * @param options - Optional set options (adapter, ttl)
   */
  patch(collectionPath: string, patch: Record<string, any>, options?: SetOptions): Promise<void>;

  /**
   * Delete data from collection path
   *
   * @param collectionPath - Folder-like path to delete
   */
  delete(collectionPath: string): Promise<void>;
  
  /**
   * Delete items from an array by filter (Phase 3.6e)
   * 
   * @param collectionPath - Path to array
   * @param options - Filter and options
   * @returns Number of deleted items and optionally the items themselves
   */
  deleteFromArray(
    collectionPath: string,
    options: DeleteFromArrayOptions
  ): Promise<{ deleted: number; items?: any[] }>;
  
  /**
   * Delete property/properties from an object (Phase 3.6e)
   * 
   * @param collectionPath - Path to object
   * @param property - Property name(s) to delete
   */
  deleteProperty(
    collectionPath: string,
    property: string | string[]
  ): Promise<void>;
  
  /**
   * Resync metadata with actual adapter state (Phase 3.6e)
   * 
   * @param collection - Collection to resync
   * @param options - Resync options
   * @returns Summary of changes
   */
  resyncMetadata(
    collection: string,
    options?: ResyncOptions
  ): Promise<ResyncResult>;
  
  /**
   * Validate metadata consistency (Phase 3.6e)
   * 
   * @param collection - Collection to validate
   * @returns Validation result with any issues found
   */
  validateMetadata(
    collection: string
  ): Promise<ValidationResult>;
  
  /**
   * Check if data exists at collection path
   * 
   * @param collectionPath - Folder-like path to check
   * @returns true if data exists
   */
  has(collectionPath: string): Promise<boolean>;
  
  /**
   * List keys in collection
   * 
   * @param collectionPath - Collection to list
   * @param prefix - Optional prefix filter
   * @returns Array of paths
   * 
   * @example
   * // List all items in folder
   * await storage.keys("research/papers");
   * // Returns: ["2024", "2023", ...]
   * 
   * await storage.keys("research/papers/2024");
   * // Returns: ["quantum", "ai", ...]
   */
  keys(collectionPath: string, prefix?: string): Promise<string[]>;
  
  /**
   * Clear all data in collection (for testing/cleanup)
   * 
   * @param collectionPath - Collection path to clear
   * @param prefix - Optional prefix to clear only specific namespace
   */
  clear(collectionPath: string, prefix?: string): Promise<void>;
  
  /**
   * List all collections in storage
   * 
   * @param pattern - Optional pattern to filter collections
   * @returns Array of collection names
   * 
   * @example
   * // List all collections
   * await storage.listCollections();
   * // Returns: ["favorites", "research", "documents", ...]
   * 
   * // Filter by pattern (future)
   * await storage.listCollections("research*");
   * // Returns: ["research", "research-2024", ...]
   */
  listCollections(pattern?: string): Promise<string[]>;
  
  /**
   * Get collection schema (what's where, what type)
   * 
   * Shows data types and adapter assignments for introspection
   * 
   * @param collection - Collection name (first segment of path)
   * @returns Schema with paths, types, and metadata
   */
  getSchema(collection: string): Promise<CollectionSchema>;
  
  /**
   * Get collection metadata (user-defined + system)
   * 
   * @param collection - Collection name
   * @returns Collection metadata object
   */
  getCollectionMetadata(collection: string): Promise<Record<string, any>>;
  
  /**
   * Set collection metadata (merges with existing)
   * 
   * Perfect for "folder prompts", workflow notes, and organization!
   * 
   * @param collection - Collection name
   * @param metadata - Metadata to set/merge
   * 
   * @example
   * // Set folder prompt
   * await storage.setCollectionMetadata('research/ai-papers', {
   *   name: 'AI Research Papers',
   *   description: 'Papers about AI agents and LLMs',
   *   prompt: 'All items in this collection are for AI agent research. Focus on agentic workflows.',
   *   workflow: 'research-pipeline',
   *   tags: ['ai', 'agents', 'research']
   * });
   * 
   * // Add notes
   * await storage.setCollectionMetadata('bookmarks/favorites', {
   *   notes: 'High-quality resources to revisit'
   * });
   */
  setCollectionMetadata(
    collection: string,
    metadata: Record<string, any>
  ): Promise<void>;
  
  // ============================================================================
  // Phase 1: STUB THESE (throw "not implemented")
  // ============================================================================
  
  /**
   * Search collection (BM25, vector, hybrid)
   * Phase 1: Throws error
   * Future: Full-text and semantic search
   */
  search(collectionPath: string, options: SearchOptions): Promise<SearchResult[]>;
  
  /**
   * Create index on collection
   * Phase 1: Stores definition, doesn't build
   * Future: Build actual indexes
   */
  createIndex(collectionPath: string, indexDef: IndexDefinition): Promise<void>;
  
  /**
   * Read through view/lens
   * Phase 1: Throws error
   * Future: Materialized views, transformations
   */
  view(collectionPath: string, options: ViewOptions): Promise<any>;
  
  /**
   * Query with complex filters (Phase 3.6f-a)
   * 
   * Universal query interface supporting:
   * - MongoDB-style filters
   * - Function filters
   * - Page & cursor-based pagination
   * - Range requests
   * - Format transformation
   * 
   * @param collectionPath - Collection to query
   * @param options - Query options
   * @returns Query result with data and metadata
   * 
   * @example
   * // MongoDB-style filter
   * await storage.query("papers", {
   *   filter: { year: { $gt: 2020 }, citations: { $gte: 100 } },
   *   sort: { citations: -1 },
   *   page: 1,
   *   pageSize: 10
   * });
   * 
   * // Function filter
   * await storage.query("papers", {
   *   where: (p) => p.citations > 100,
   *   limit: 20
   * });
   * 
   * // Range request
   * await storage.query("papers", {
   *   range: { start: 0, end: 99 }
   * });
   */
  query(collectionPath: string, options?: QueryOptions): Promise<QueryResult>;
  
  // ============================================================================
  // Unified Retrieval Layer
  // ============================================================================

  /** Register a unified retrieval provider */
  registerRetrievalProvider(provider: import('./retrieval/types.ts').RetrievalProvider): void;

  /** Get a registered retrieval provider by name */
  getRetrievalProvider(name: string): import('./retrieval/types.ts').RetrievalProvider | undefined;

  /** List all registered retrieval provider names */
  listRetrievalProviders(): string[];

  /** Create a pipeline pre-loaded with this router's providers */
  createRetrievalPipeline(): import('./retrieval/pipeline.ts').RetrievalPipeline;

  /** Execute a retrieval pipeline against a collection */
  retrievePipeline(
    collectionPath: string,
    steps: import('./retrieval/types.ts').PipelineStep[],
    options?: GetOptions,
  ): Promise<import('./retrieval/types.ts').RetrievalOutput>;

  // ============================================================================
  // Phase 2.5: Views & Namespace Operations
  // ============================================================================
  
  /**
   * Create a named view (saved retrieval pipeline)
   * 
   * Views persist across restarts and can be global or namespace-scoped.
   * Use `.view` suffix to distinguish from collections.
   * 
   * @param name - View name (e.g., "hn-bookmarks.view", "favorites/recent.view")
   * @param definition - View definition with source and retrievers
   * 
   * @example
   * await storage.createView("hn-bookmarks.view", {
   *   source: "favorites/bookmarks",
   *   retrievers: [
   *     { type: "filter", options: { where: { source: "hackernews" } } }
   *   ]
   * });
   */
  createView(name: string, definition: Omit<ViewDefinition, 'name'>): Promise<void>;
  
  /**
   * Execute a view (load source data and apply retrieval pipeline)
   * 
   * @param name - View name
   * @param options - Additional options (passed to retrievers)
   * @returns Retrieved data after pipeline
   */
  getView(name: string, options?: any): Promise<any>;
  
  /**
   * Update view definition (replace entirely)
   * 
   * @param name - View name
   * @param definition - New view definition
   */
  updateView(name: string, definition: Omit<ViewDefinition, 'name'>): Promise<void>;
  
  /**
   * Delete a view
   * 
   * @param name - View name
   */
  deleteView(name: string): Promise<void>;
  
  /**
   * List all views (optionally filtered by namespace)
   * 
   * @param namespace - Optional namespace to filter views
   * @returns Array of view names
   * 
   * @example
   * const allViews = await storage.listViews();
   * const favViews = await storage.listViews("favorites");
   */
  listViews(namespace?: string): Promise<string[]>;
  
  /**
   * Get folder tree structure
   * 
   * Visualize collections, folders, and views as a tree.
   * 
   * @param path - Namespace path (e.g., "favorites", "work/projects")
   * @param options - Tree options
   * @returns Tree structure
   * 
   * @example
   * const tree = await storage.tree("favorites");
   * // → { path: "favorites", type: "folder", children: { ... } }
   */
  tree(path: string, options?: TreeOptions): Promise<NamespaceTree>;
  
  /**
   * Get all data under a namespace
   * 
   * @param path - Namespace path
   * @param options - Namespace options
   * @returns Object with all data under namespace
   * 
   * @example
   * const allFavorites = await storage.getNamespace("favorites");
   * // → { bookmarks: [...], notes: [...], ... }
   */
  getNamespace(path: string, options?: NamespaceOptions): Promise<any>;
  
  /**
   * Copy data from one path to another
   * 
   * @param source - Source path
   * @param dest - Destination path
   */
  copy(source: string, dest: string): Promise<void>;
  
  /**
   * Move data (copy + delete)
   * 
   * @param source - Source path
   * @param dest - Destination path
   */
  move(source: string, dest: string): Promise<void>;
  
  /**
   * Copy entire namespace
   * 
   * @param source - Source namespace
   * @param dest - Destination namespace
   * @param options - Copy options
   */
  copyNamespace(source: string, dest: string, options?: CopyOptions): Promise<void>;

  // ============================================================================
  // Namespace Operations (Folder-like)
  // ============================================================================

  /**
   * List child namespaces under a path (like ls for directories)
   *
   * @param parentPath - Parent namespace path (empty for root)
   * @returns Array of immediate child namespace names
   *
   * @example
   * await storage.set("notes/work/meeting", data);
   * await storage.set("notes/personal/diary", data);
   * await storage.listNamespaces("notes");
   * // → ["work", "personal"]
   */
  listNamespaces(parentPath?: string): Promise<string[]>;

  /**
   * Delete an entire namespace and all data under it
   *
   * @param path - Namespace path to delete
   * @param options - Delete options (recursive required for non-empty namespaces)
   *
   * @example
   * await storage.deleteNamespace("notes/work", { recursive: true });
   */
  deleteNamespace(path: string, options?: { recursive?: boolean }): Promise<{ deleted: number }>;

  /**
   * Get stats about a namespace or item
   *
   * @param path - Path to inspect
   * @returns Stats including type, item count, children, adapters used
   */
  stat(path: string): Promise<NamespaceStat>;

  /**
   * Rename a namespace (copy + delete)
   *
   * @param source - Source namespace path
   * @param dest - Destination namespace path
   */
  renameNamespace(source: string, dest: string): Promise<void>;

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Get multiple keys in parallel
   *
   * @param paths - Array of collection paths to retrieve
   * @param options - Optional get options applied to each
   * @returns Map of path → result (null for missing keys)
   *
   * @example
   * const results = await store.batchGet([
   *   'users/alice', 'users/bob', 'config/app'
   * ]);
   * // → Map { 'users/alice' => {...}, 'users/bob' => {...}, 'config/app' => {...} }
   */
  batchGet(paths: string[], options?: GetOptions): Promise<Map<string, any>>;

  /**
   * Set multiple keys in parallel
   *
   * @param entries - Array of { path, data, options? } to store
   * @returns void (all entries stored)
   *
   * @example
   * await store.batchSet([
   *   { path: 'users/alice', data: { name: 'Alice' } },
   *   { path: 'users/bob', data: { name: 'Bob' }, options: { mode: 'overwrite' } },
   * ]);
   */
  batchSet(entries: Array<{ path: string; data: any; options?: SetOptions }>): Promise<(any | null)[]>;

  /**
   * Delete multiple keys in parallel
   *
   * @param paths - Array of collection paths to delete
   * @returns array of results (void or null per key)
   *
   * @example
   * await store.batchDelete(['users/alice', 'users/bob', 'temp/scratch']);
   */
  batchDelete(paths: string[]): Promise<(void | null)[]>;

  // ============================================================================
  // Phase 3: Metadata Reconstruction
  // ============================================================================
  
  /**
   * Manually rebuild metadata and key index for a collection
   * 
   * Scans all adapters and rebuilds metadata from actual stored data.
   * Use when metadata is missing/corrupted or after manual changes.
   * 
   * @param collection - Collection to rebuild
   * @returns Reconstructed schema and index
   */
  rebuildMetadata(collection: string): Promise<{ schema: CollectionSchema; index: KeyIndex }>;
  
  // ============================================================================
  // Phase 3.5: Smart Upsert
  // ============================================================================
  
  /**
   * Upsert object(s) by key field (insert if new, update if exists)
   * 
   * Automatically constructs storage keys from a specified field in the objects,
   * enabling ID-based upsert patterns similar to Airtable, Notion, and traditional databases.
   * 
   * @param collection - Collection name
   * @param data - Single object or array of objects to upsert
   * @param options - Upsert options (idField, keyGenerator, etc.)
   * 
   * @example
   * // Single object with 'id' field (default)
   * await storage.upsertByKey("users", { 
   *   id: "abc-123", 
   *   name: "Alice", 
   *   age: 25 
   * });
   * // Stores as: users/abc-123
   * 
   * // Batch upsert
   * await storage.upsertByKey("products", [
   *   { id: "prod-1", name: "Widget", price: 10 },
   *   { id: "prod-2", name: "Gadget", price: 20 }
   * ]);
   * // Stores as: products/prod-1, products/prod-2
   * 
   * // Custom ID field
   * await storage.upsertByKey("contacts", { 
   *   email: "alice@example.com", 
   *   name: "Alice" 
   * }, { idField: 'email' });
   * // Stores as: contacts/alice@example.com
   * 
   * // Custom key generator
   * await storage.upsertByKey("items", { 
   *   firstName: "Alice", 
   *   lastName: "Smith" 
   * }, { 
   *   keyGenerator: (obj) => `${obj.firstName}-${obj.lastName}`.toLowerCase()
   * });
   * // Stores as: items/alice-smith
   */
  upsertByKey(collection: string, data: any | any[], options?: SetOptions): Promise<void>;
  
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
  merge(sources: string[], dest: string, options?: MergeOptions): Promise<void>;
  
  /**
   * Extract a subset (slice) of a collection (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to slice
   * @param options - Slice options
   * @returns Sliced data (if returnData is true)
   */
  slice(collectionPath: string, options: SliceOptions): Promise<any[] | void>;
  
  /**
   * Split collection by field value (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to split
   * @param options - Split options
   */
  split(collectionPath: string, options: SplitOptions): Promise<void>;
  
  /**
   * Remove duplicates from a collection (Phase 3.6f-b)
   * 
   * @param collectionPath - Collection to deduplicate
   * @param options - Deduplication options
   */
  deduplicate(collectionPath: string, options: DeduplicateOptions): Promise<void>;
  
  // ============================================================================
  // Phase 3.6g-c: External Data Sources
  // ============================================================================
  
  /**
   * Register external data source as virtual collection
   * 
   * Virtual collections point to remote data (JSON, CSV, Parquet) without storing it.
   * Data is fetched on demand and cached according to TTL settings.
   * 
   * @param collectionPath - Virtual collection path (e.g., "external/github-stars")
   * @param options - External source configuration
   * 
   * @example
   * // Register GitHub API as virtual collection
   * await storage.registerExternal("external/github-stars", {
   *   url: "https://api.github.com/users/janzheng/starred",
   *   type: "json",
   *   cacheTTL: 3600000, // 1 hour
   *   headers: { "Accept": "application/vnd.github.v3+json" }
   * });
   * 
   * // Query like any collection
   * const stars = await storage.get("external/github-stars");
   */
  registerExternal(collectionPath: string, options: RegisterExternalOptions): Promise<void>;
  
  /**
   * Refresh external data source (force fetch)
   * 
   * @param collectionPath - Virtual collection path
   * @returns Fresh data
   */
  refreshExternal(collectionPath: string): Promise<any>;
  
  /**
   * List all registered external sources
   * 
   * @param pattern - Optional pattern to filter sources
   * @returns Array of external source paths
   */
  listExternalSources(pattern?: string): Promise<string[]>;
  
  /**
   * Get external source configuration
   * 
   * @param collectionPath - Virtual collection path
   * @returns External source metadata
   */
  getExternalSource(collectionPath: string): Promise<ExternalSource | null>;
  
  /**
   * Update external source configuration
   * 
   * @param collectionPath - Virtual collection path
   * @param options - Updated configuration
   */
  updateExternalSource(collectionPath: string, options: Partial<RegisterExternalOptions>): Promise<void>;
  
  /**
   * Unregister external source (remove virtual collection)
   * 
   * @param collectionPath - Virtual collection path
   * @param deleteCachedData - Whether to also delete cached data
   */
  unregisterExternal(collectionPath: string, deleteCachedData?: boolean): Promise<void>;
  
  // ============================================================================
  // Phase 3.2: Content Negotiation
  // ============================================================================
  
  /**
   * Get collection as structured JSON
   * 
   * Phase 3.2: Materialize collection with metadata
   * Phase 3.4: Supports filtering by type, adapter, schema, and key search
   * 
   * @param collectionPath - Collection to materialize
   * @param options - Optional filtering, sorting, pagination options
   * @returns Structured JSON with items and metadata
   */
  getAsJson(collectionPath: string, options?: GetOptions): Promise<any>;
  
  /**
   * Get collection as markdown
   * 
   * Phase 3.2: Materialize collection as human-readable markdown
   * 
   * @param collectionPath - Collection to materialize
   * @returns Markdown string
   */
  getAsMarkdown(collectionPath: string): Promise<string>;
  
  /**
   * Get collection as CSV
   * 
   * Phase 3.2: Materialize collection as CSV for spreadsheets
   * 
   * @param collectionPath - Collection to materialize
   * @param options - CSV options
   * @returns CSV string
   */
  getAsCsv(collectionPath: string, options?: any): Promise<string>;
  
  /**
   * Get collection as plain text
   * 
   * Phase 3.2: Materialize collection as simple text format
   * 
   * @param collectionPath - Collection to materialize
   * @returns Plain text string
   */
  getAsText(collectionPath: string): Promise<string>;
  
  /**
   * Get collection as YAML
   * 
   * Phase 3.2: Materialize collection as YAML format
   * 
   * @param collectionPath - Collection to materialize
   * @returns YAML string
   */
  getAsYaml(collectionPath: string): Promise<string>;
  
  // ============================================================================
  // Phase 3.6h: Query Result Caching & Materialized Views
  // ============================================================================
  
  /**
   * Clear cache for a specific query
   * 
   * @param collectionPath - Collection path
   * @param options - Query options to identify cached result
   */
  clearQueryCache(collectionPath: string, options?: QueryOptions): Promise<void>;
  
  /**
   * Clear all caches for a collection
   * 
   * @param collectionPath - Collection path
   * @returns Number of caches cleared
   */
  clearCollectionCache(collectionPath: string): Promise<number>;
  
  /**
   * Clear all query caches
   * 
   * @returns Number of caches cleared
   */
  clearAllCaches(): Promise<number>;
  
  /**
   * Get cache statistics
   * 
   * @param collectionPath - Optional collection to filter stats
   * @returns Cache statistics (hits, misses, size, etc.)
   */
  getCacheStats(collectionPath?: string): Promise<CacheStats>;
  
  // ============================================================================
  // Phase 3.6h-b: Materialized Views
  // ============================================================================
  
  /**
   * Create a materialized view
   * 
   * @param name - View name
   * @param definition - View definition
   */
  createMaterializedView(name: string, definition: any): Promise<void>;
  
  /**
   * Refresh a materialized view
   * 
   * @param name - View name
   * @param options - Refresh options
   */
  refreshView(name: string, options?: any): Promise<any>;
  
  /**
   * Update materialized view definition
   * 
   * @param name - View name
   * @param updates - Partial definition updates
   */
  updateMaterializedView(name: string, updates: any): Promise<void>;
  
  /**
   * Delete a materialized view
   * 
   * @param name - View name
   * @param deleteData - Whether to delete materialized data
   */
  deleteMaterializedView(name: string, deleteData?: boolean): Promise<void>;
  
  /**
   * List all materialized views
   * 
   * @param filter - Optional filter criteria
   */
  listMaterializedViews(filter?: any): Promise<any[]>;
  
  /**
   * Get materialized view metadata
   * 
   * @param name - View name
   */
  getViewMetadata(name: string): Promise<any>;
  
  /**
   * Refresh all views matching filter
   *
   * @param filter - Optional filter criteria
   */
  refreshAllViews(filter?: any): Promise<any[]>;

  // ============================================================================
  // Signed URLs (for adapters that support direct client uploads/downloads)
  // ============================================================================

  /**
   * Generate a signed upload URL for direct client uploads
   *
   * Only works when the resolved adapter supports signed URLs (e.g., R2Direct).
   * Throws if the adapter doesn't support this operation.
   *
   * @param collectionPath - Storage key/path
   * @param options - Upload options (expiry, content type, max size)
   * @returns Signed URL that the client can PUT to
   *
   * @example
   * const url = await store.getSignedUploadUrl("uploads/photo.jpg", {
   *   expiresIn: 3600,
   *   contentType: "image/jpeg",
   * });
   * // Client uploads directly:
   * await fetch(url, { method: 'PUT', body: fileData });
   */
  getSignedUploadUrl(
    collectionPath: string,
    options?: SignedUrlOptions,
  ): Promise<string>;

  /**
   * Generate a signed download URL for direct client downloads
   *
   * Only works when the resolved adapter supports signed URLs (e.g., R2Direct).
   * Throws if the adapter doesn't support this operation.
   *
   * @param collectionPath - Storage key/path
   * @param options - Download options (expiry, forced filename)
   * @returns Signed URL that the client can GET from
   *
   * @example
   * const url = await store.getSignedDownloadUrl("uploads/photo.jpg", {
   *   expiresIn: 3600,
   *   filename: "my-photo.jpg",
   * });
   */
  getSignedDownloadUrl(
    collectionPath: string,
    options?: SignedUrlOptions,
  ): Promise<string>;

  // ============================================================================
  // Adapter Access (public API for materializers, explorers, etc.)
  // ============================================================================

  /**
   * Get the metadata adapter instance.
   * Used by materializers and explorers to load key indexes.
   */
  getMetadataAdapter(): import('./adapters/adapter.ts').StorageAdapter;

  /**
   * Get a named adapter instance, or undefined if not found.
   * Used by explorers that need direct adapter access (e.g., URL generation).
   *
   * @param name - Adapter name (e.g., "memory", "r2")
   */
  getAdapter(name: string): import('./adapters/adapter.ts').StorageAdapter | undefined;
}

// ============================================================================
// Options Interfaces
// ============================================================================

/**
 * Options for signed URL generation (upload or download)
 */
export interface SignedUrlOptions {
  /** URL expiry in seconds (default: 3600 = 1 hour) */
  expiresIn?: number;
  /** Content type for upload URLs */
  contentType?: string;
  /** Max upload size in bytes */
  maxSize?: number;
  /** Force download with this filename (download URLs only) */
  filename?: string;
}

/**
 * Get options for filtering, sorting, pagination
 *
 * Phase 2: Extended with retrieval adapters support
 * Phase 3.4: Extended with JSON Schema filtering
 */
export interface GetOptions {
  /** Simple filter (in-memory, exact match) - Phase 1 legacy */
  filter?: Record<string, any>;
  
  /** Sort order - string like "date DESC" or object {date: -1, title: 1} */
  sort?: string | Record<string, 1 | -1>;
  
  /** Limit number of results - Phase 1 legacy */
  limit?: number;
  
  /** Offset for pagination - Phase 1 legacy */
  offset?: number;
  
  // ============================================================================
  // Phase 2: Retrieval Adapters
  // ============================================================================
  
  /** Single retriever name (e.g., "metadata", "slice", "filter") */
  retriever?: string;
  
  /** Pipeline of retrievers (compose multiple retrievers) */
  retrievers?: RetrievalStep[];

  /** Unified retrieval pipeline (compose search, transform, filter, disclosure) */
  pipeline?: import('./retrieval/types.ts').PipelineStep[];

  /** Text query (used with pipeline search steps) */
  query?: string;
  
  // ============================================================================
  // Phase 3.4: JSON Schema Filtering
  // ============================================================================
  
  /**
   * JSON Schema to filter objects by (only applies to type='object')
   * 
   * Objects must match this schema to be included in results.
   * 
   * @example
   * // Find all objects with 'name' and 'role' fields
   * await storage.get("collection", {
   *   filterSchema: {
   *     type: "object",
   *     required: ["name", "role"],
   *     properties: {
   *       name: { type: "string" },
   *       role: { type: "string" }
   *     }
   *   }
   * });
   */
  filterSchema?: Record<string, any>;
  
  /**
   * Filter by data type (object, blob, kv)
   * 
   * @example
   * await storage.get("collection", { filterType: "object" });
   */
  filterType?: DataType | 'all';
  
  /**
   * Filter by adapter name
   * 
   * @example
   * await storage.get("collection", { filterAdapter: "upstash" });
   */
  filterAdapter?: string;
  
  /**
   * Search in keys (substring match)
   *
   * @example
   * await storage.get("collection", { searchKeys: "profile" });
   */
  searchKeys?: string;

  // ============================================================================
  // Phase 3.8: Raw Content Option
  // ============================================================================

  /**
   * Return raw content without StorageFileResponse wrapper
   *
   * By default, get() returns a StorageFileResponse with metadata.
   * Set raw: true to get just the content directly.
   *
   * @example
   * // With raw: true
   * const data = await storage.get("users", { raw: true });
   * // → { name: "Alice", age: 30 }
   *
   * // Without raw (default)
   * const response = await storage.get("users");
   * // → { content: { name: "Alice", age: 30 }, adapter: "memory", ... }
   */
  raw?: boolean;

  // Retriever-specific options can be passed as additional properties
  [key: string]: any;
}

/**
 * Set options for TTL, mode, adapter override
 */
export interface SetOptions {
  /** Time to live in seconds */
  ttl?: number;
  
  /** How to handle existing data */
  mode?: 'overwrite' | 'append' | 'merge';
  
  /** Force specific adapter (overrides smart routing) */
  adapter?: string;
  
  /** Additional metadata (for future use) */
  metadata?: Record<string, any>;
  
  // ============================================================================
  // Phase 3.5: Smart Upsert
  // ============================================================================
  
  /**
   * Which field to use as the key for upsert operations
   * 
   * When set, Smallstore will automatically construct the storage key
   * from this field in the object, enabling automatic upsert behavior.
   * 
   * @example
   * // Use 'id' field as key
   * await storage.set("users", { id: "abc-123", name: "Alice" }, { 
   *   idField: 'id' 
   * });
   * // Stores as: users/abc-123
   * 
   * // Use custom field as key
   * await storage.set("products", { productId: "prod-456", name: "Widget" }, { 
   *   idField: 'productId' 
   * });
   * // Stores as: products/prod-456
   */
  idField?: string;
  
  /**
   * Custom function to generate key from object
   * 
   * Overrides idField if provided. Useful for composite keys or transformations.
   * 
   * @example
   * await storage.set("contacts", { 
   *   firstName: "Alice", 
   *   lastName: "Smith" 
   * }, {
   *   keyGenerator: (obj) => `${obj.firstName}-${obj.lastName}`.toLowerCase()
   * });
   * // Stores as: contacts/alice-smith
   */
  keyGenerator?: (obj: any) => string;
  
  // ============================================================================
  // Phase 2.6: Input Validation & Filtering
  // ============================================================================
  
  /**
   * Validate data before storing
   * 
   * Use this to ensure data quality at write time.
   * 
   * @example
   * await storage.set("users", userData, {
   *   inputValidation: {
   *     schema: userSchema,
   *     mode: 'strict'  // Throw on invalid
   *   }
   * });
   * 
   * await storage.set("scraped", messyData, {
   *   inputValidation: {
   *     schema: dataSchema,
   *     mode: 'sieve',  // Keep valid, drop invalid
   *     onInvalid: (item, err) => console.log('Dropped:', item)
   *   }
   * });
   */
  inputValidation?: {
    /** JSON Schema for validation */
    schema?: any;
    /** Zod schema (takes precedence over JSON Schema) */
    zodSchema?: any;
    /** Validation mode */
    mode: 'strict' | 'sieve';
    /** Callback for invalid items (sieve mode only) */
    onInvalid?: (item: any, error: any) => void;
  };
  
  /**
   * Transform/filter data before storing
   * 
   * Use this to clean, select, or transform data at write time.
   * 
   * @example
   * await storage.set("bookmarks", scrapedData, {
   *   inputTransform: {
   *     pick: ['url', 'title', 'description'],  // Only these fields
   *     where: { url: { $contains: 'github.com' } }  // Only GitHub links
   *   }
   * });
   * 
   * await storage.set("normalized", rawData, {
   *   inputTransform: {
   *     transform: (item) => ({
   *       ...item,
   *       timestamp: Date.now(),
   *       normalized: true
   *     })
   *   }
   * });
   */
  inputTransform?: {
    /** Only keep these fields */
    pick?: string[];
    /** Remove these fields */
    omit?: string[];
    /** Filter items using field-based conditions */
    where?: FieldFilter;
    /** Custom transform function */
    transform?: (item: any) => any;
  };
}

// ============================================================================
// Collection Schema
// ============================================================================

/**
 * Collection schema - tracks what's stored where
 */
export interface CollectionSchema {
  /** Collection name */
  collection: string;
  
  /** Information about each path in this collection */
  paths: Record<string, PathInfo>;
  
  /** Collection-level metadata */
  metadata: {
    // System metadata (auto-tracked)
    created?: string;
    updated?: string;
    totalSize?: string;
    itemCount?: number;
    
    // Adapter configuration (for structured adapters)
    adapter?: {
      type?: 'notion' | 'airtable' | 'postgres' | string;  // Adapter type
      location?: string;         // Database ID, Base ID, connection string, URL
      table?: string;            // Table name (for databases)
      view?: string;             // View ID (for Airtable)
      [key: string]: any;        // Other adapter-specific config
    };
    
    // User-defined metadata (arbitrary key-value pairs)
    // Perfect for "folder prompts" and workflow notes!
    name?: string;               // Human-readable collection name
    description?: string;        // Collection description
    prompt?: string;             // Workflow prompt or instructions
    tags?: string[];             // Tags for organization
    workflow?: string;           // Associated workflow/pipeline
    notes?: string;              // Free-form notes
    [key: string]: any;          // Any other custom metadata
  };
  
  /** External source configuration (if this is a virtual collection) */
  externalSource?: ExternalSource;
}

/**
 * Information about data at a specific path
 */
export interface PathInfo {
  /** Which adapter is storing this data */
  adapter: string;
  
  /** Data type at this path */
  dataType: DataType;
  
  /** Number of times written (count) */
  count?: number;
  
  /** Human-readable size */
  size?: string;
  
  /** Size in bytes */
  sizeBytes?: number;
}

// ============================================================================
// Phase 3: Key Index (Multi-Adapter Routing)
// ============================================================================

/**
 * Key Index - Tracks exact storage locations for multi-adapter setups
 * 
 * This is the "database index" for Smallstore. It tracks:
 * - Which adapter stores each key
 * - What collection/path each key belongs to
 * - Metadata about each key (size, type, timestamps)
 * 
 * Purpose:
 * - Fast lookups: Don't scan all adapters
 * - Persistence: Survives restarts
 * - Reconstruction: Can rebuild from adapters if lost
 */
export interface KeyIndex {
  /** Collection name this index belongs to */
  collection: string;
  
  /** Map of storage key → location info */
  keys: Record<string, KeyLocation>;
  
  /** Index-level metadata */
  metadata: {
    created?: string;
    updated?: string;
    keyCount?: number;
  };
}

/**
 * Location information for a single key
 */
export interface KeyLocation {
  /** Full storage key (e.g., "smallstore:research/paper") */
  key: string;
  
  /** Collection name (e.g., "research") */
  collection: string;
  
  /** Path within collection (e.g., "/paper") */
  path: string;
  
  /** Which adapter stores this key */
  adapter: string;
  
  /** Data type */
  dataType: DataType;
  
  /** Size in bytes */
  sizeBytes: number;
  
  /** When this key was created */
  created: string;
  
  /** When this key was last updated */
  updated: string;
}

// ============================================================================
// Phase 2: Retrieval System Types
// ============================================================================

/**
 * Retrieval adapter interface
 * 
 * Retrievers transform/filter data on read without changing stored data.
 * Like views in databases, but composable and flexible.
 */
export interface RetrievalAdapter {
  /** Retriever name (e.g., "metadata", "slice", "filter") */
  readonly name: string;
  
  /** Retriever capabilities */
  readonly capabilities: RetrievalCapabilities;
  
  /**
   * Retrieve/transform data
   * 
   * @param data - Raw data from storage
   * @param options - Retriever-specific options
   * @returns Transformed data + metadata
   */
  retrieve(data: any, options?: RetrievalOptions): Promise<RetrievalResult>;
}

/**
 * Retrieval capabilities
 */
export interface RetrievalCapabilities {
  /** Retriever name */
  name: string;
  
  /** Type of retrieval operation */
  type: 'transform' | 'filter' | 'metadata';
  
  /** Supported input data types */
  supportedTypes: DataType[];
  
  /** Can this retriever be streamed? (future) */
  streamable?: boolean;
}

/**
 * Retrieval options (retriever-specific)
 */
export interface RetrievalOptions {
  /** Retriever-specific options */
  [key: string]: any;
}

/**
 * Retrieval result
 */
export interface RetrievalResult {
  /** Retrieved/transformed data */
  data: any;
  
  /** Metadata about retrieval operation */
  metadata: RetrievalMetadata;
}

/**
 * Retrieval metadata
 */
export interface RetrievalMetadata {
  /** Which retriever was used */
  retriever: string;
  
  /** Number of items returned */
  itemsReturned: number;
  
  /** Total items available before retrieval */
  itemsTotal: number;
  
  /** Processing time in milliseconds (optional) */
  processingTime?: number;
  
  /** Additional retriever-specific metadata */
  [key: string]: any;
}

/**
 * Retrieval step (for pipeline composition)
 */
export interface RetrievalStep {
  /** Retriever type/name */
  type: string;
  
  /** Retriever-specific options */
  options?: RetrievalOptions;
}

// ============================================================================
// Future Types (Defined but not implemented in Phase 1)
// ============================================================================

/**
 * Search options (future)
 */
export interface SearchOptions {
  query?: string;
  vector?: number[];
  type: 'bm25' | 'vector' | 'hybrid';
  /** @deprecated Unused. The collection path passed to router.search() already scopes results — there's no sub-path below collection for search. Remove in a future major. */
  path?: string;
  /**
   * Optional MongoDB-style filter applied to results AFTER the search
   * provider ranks them. Matches the shape of `query()` filters:
   *   { field: value }, { field: { $gt: 10 } }, { $and: [...] }, etc.
   * The filter needs to find the field on the stored record, so
   * router.search() hydrates result data via get() before filtering.
   */
  filter?: Record<string, any>;
  limit?: number;
  topK?: number;
  threshold?: number;
  /** Weight for BM25 vs vector in hybrid search (0 = pure vector, 1 = pure BM25). */
  hybridAlpha?: number;
  /** Distance metric for vector search. Providers that bake metric at construction ignore this. */
  metric?: 'cosine' | 'euclidean' | 'dot';
}

/**
 * Index definition (future)
 */
export interface IndexDefinition {
  name: string;
  type: 'bm25' | 'vector' | 'structured';
  source: string;
  fields?: string[];
  field?: string;
  dimensions?: number;
  adapter?: string;
}

/**
 * View options (future)
 */
export interface ViewOptions {
  lens: string;
  definition?: any;
  forceRefresh?: boolean;
  params?: Record<string, any>;
}

/**
 * Query filter (Phase 3.6f)
 */
export interface QueryFilter {
  path?: string;
  where?: Record<string, any> | string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/**
 * Field-based filter for input transformation
 * 
 * Supports operators like $eq, $ne, $gt, $contains, $in, etc.
 */
export type FieldFilter = Record<string, any | {
  $eq?: any;
  $ne?: any;
  $gt?: any;
  $gte?: any;
  $lt?: any;
  $lte?: any;
  $contains?: string;
  $startsWith?: string;
  $endsWith?: string;
  $in?: any[];
  $nin?: any[];
}>;

/**
 * Search result (future)
 */
export interface SearchResult {
  path: string;
  data: any;
  score: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// Search Provider Plugin
// ============================================================================

/**
 * SearchProvider — pluggable search capability for adapters.
 *
 * Adapters that support search expose this via an optional `searchProvider`
 * property on StorageAdapter. The router delegates search() and createIndex()
 * to it instead of duck-typing individual methods.
 */
export interface SearchProvider {
  /** Provider name (e.g., "sqlite-fts5", "upstash-redis") */
  readonly name: string;
  /** Which search types this provider supports */
  readonly supportedTypes: ReadonlyArray<'bm25' | 'vector' | 'hybrid'>;
  /** Search indexed content */
  search(query: string, options?: SearchProviderOptions): SearchProviderResult[] | Promise<SearchProviderResult[]>;
  /** Index a single key/value (called by adapter's set()) */
  index(key: string, value: any): void | Promise<void>;
  /** Remove a key from index (called by adapter's delete()) */
  remove(key: string): void | Promise<void>;
  /** Rebuild entire index (or prefix subset) */
  rebuild(prefix?: string): { indexed: number; skipped: number } | Promise<{ indexed: number; skipped: number }>;
}

/** Options passed from router to SearchProvider.search() */
export interface SearchProviderOptions {
  limit?: number;
  collection?: string;
  threshold?: number;
  /** Search type being requested */
  type?: 'bm25' | 'vector' | 'hybrid';
  /** Query embedding vector (for vector/hybrid search) */
  vector?: number[];
  /** Number of nearest neighbors to return (vector search) */
  topK?: number;
  /** Distance metric for vector search */
  metric?: 'cosine' | 'euclidean' | 'dot';
  /** BM25 text query (for hybrid search, passed alongside vector) */
  query?: string;
  /** Weight for BM25 vs vector in hybrid search (0=pure vector, 1=pure BM25) */
  hybridAlpha?: number;
}

/** Raw result from a SearchProvider (router maps to SearchResult) */
export interface SearchProviderResult {
  key: string;
  score: number;
  snippet: string;
  /** Vector distance (for vector search results) */
  distance?: number;
  /** Original embedding vector (if requested) */
  vector?: number[];
}

// ============================================================================
// Phase 2.5: Views & Namespace Types
// ============================================================================

/**
 * View definition - Saved retrieval pipeline
 * 
 * Views persist in metadata storage and can be executed like collections.
 * Use `.view` suffix to distinguish from collections.
 */
export interface ViewDefinition {
  /** View name (with .view suffix) */
  name: string;
  
  /** Source collection path */
  source: string;
  
  /** Retrieval pipeline */
  retrievers: RetrievalStep[];
  
  /** When view was created */
  created?: string;
  
  /** When view was last updated */
  updated?: string;
  
  /** Optional description */
  description?: string;
}

/**
 * Namespace tree node
 * 
 * Represents a folder, collection, or view in the tree structure.
 */
export interface NamespaceTree {
  /** Path to this node */
  path: string;
  
  /** Node type */
  type: 'folder' | 'collection' | 'view';
  
  /** Child nodes (for folders) */
  children?: Record<string, NamespaceTree>;
  
  /** Item count (for collections) */
  itemCount?: number;
  
  /** Data type (for collections) */
  dataType?: DataType;
  
  /** Human-readable size (for collections) */
  size?: string;
  
  /** Source collection (for views) */
  source?: string;
  
  /** Retrieval pipeline (for views) */
  pipeline?: RetrievalStep[];
}

/**
 * Options for namespace operations
 */
export interface NamespaceOptions {
  /** Include metadata for each collection? */
  includeMetadata?: boolean;
  
  /** Recursively get all nested data? */
  recursive?: boolean;
}

/**
 * Options for tree visualization
 */
export interface TreeOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;
  
  /** Include views in tree? */
  includeViews?: boolean;
}

/**
 * Options for copy operations
 */
export interface CopyOptions {
  /** Overwrite if destination exists? */
  overwrite?: boolean;

  /** Copy views too? */
  includeViews?: boolean;
}

/**
 * Stats for a namespace or item
 */
export interface NamespaceStat {
  /** Path that was inspected */
  path: string;

  /** Whether this is a namespace (folder) or a leaf item */
  type: 'namespace' | 'item';

  /** Number of items under this path */
  itemCount: number;

  /** Immediate child namespaces */
  children: string[];

  /** Which adapters store data under this path */
  adapters: string[];
}

// ============================================================================
// Phase 3.6e: Granular Deletion + Metadata Resync
// ============================================================================

/**
 * Options for deleteFromArray
 */
export interface DeleteFromArrayOptions {
  /** Filter function or object matcher */
  filter: ((item: any) => boolean) | Record<string, any>;
  
  /** Return deleted items (default: false) */
  returnDeleted?: boolean;
}

/**
 * Options for metadata resync
 */
export interface ResyncOptions {
  /** Resync key index (default: true) */
  resyncKeys?: boolean;
  
  /** Resync schema (default: true) */
  resyncSchema?: boolean;
  
  /** Verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Result of metadata resync
 */
export interface ResyncResult {
  /** State before resync */
  before: {
    keyCount: number;
  };
  
  /** State after resync */
  after: {
    keyCount: number;
  };
  
  /** Changes made */
  changes: {
    added: string[];
    removed: string[];
  };
}

/**
 * Result of metadata validation
 */
export interface ValidationResult {
  /** Whether metadata is valid */
  valid: boolean;
  
  /** List of issues found */
  issues: Array<{
    type: 'missing_key' | 'stale_key' | 'schema_mismatch';
    key: string;
    details: string;
  }>;
}

// ============================================================================
// Phase 3.6f: Universal Query & Data Operations
// ============================================================================

/**
 * Filter operators (MongoDB-style)
 */
export interface FilterOperators {
  // Comparison
  $eq?: any;         // Equal
  $ne?: any;         // Not equal
  $gt?: any;         // Greater than
  $gte?: any;        // Greater than or equal
  $lt?: any;         // Less than
  $lte?: any;        // Less than or equal
  $in?: any[];       // In array
  $nin?: any[];      // Not in array
  
  // Logical
  $and?: FilterObject[];   // AND
  $or?: FilterObject[];    // OR
  $not?: FilterObject;     // NOT
  
  // String
  $contains?: string;      // Contains substring
  $startsWith?: string;    // Starts with
  $endsWith?: string;      // Ends with
  $regex?: string;         // Regex match
  
  // Array
  $size?: number;          // Array size
  $all?: any[];            // Contains all
  $elemMatch?: FilterObject;  // Array element matches
  
  // Existence
  $exists?: boolean;       // Field exists
  $type?: string;          // Type check
}

/**
 * Filter object - field name → value or operator
 */
export type FilterObject = Record<string, any | FilterOperators>;

/**
 * Universal query options (Phase 3.6f-a)
 */
export interface QueryOptions {
  // ============================================================================
  // FILTERING
  // ============================================================================
  
  /** MongoDB-style filter object */
  filter?: FilterObject;
  
  /** Function filter */
  where?: (item: any) => boolean;
  
  /** JSONPath expression (future) */
  jsonPath?: string;
  
  // ============================================================================
  // PROJECTION (Field Selection)
  // ============================================================================
  
  /** Fields to include */
  select?: string[];
  
  /** Fields to exclude */
  omit?: string[];
  
  /** Transform each item */
  transform?: (item: any) => any;
  
  // ============================================================================
  // SORTING
  // ============================================================================
  
  /** Sort field(s) - string like "date DESC" or object {date: -1, title: 1} */
  sort?: string | Record<string, 1 | -1>;
  
  // ============================================================================
  // PAGINATION
  // ============================================================================
  
  /**
   * Pagination precedence (highest to lowest):
   *   1. cursor — cursor-based pagination (overrides all others)
   *   2. page / pageSize — page-based pagination
   *   3. limit / offset (on QueryOptions) — offset-based pagination
   *   4. skip — alias for offset (legacy)
   */

  /** Page number (1-based) */
  page?: number;

  /** Items per page */
  pageSize?: number;

  /** Cursor for cursor-based pagination */
  cursor?: string;

  /** Limit total results */
  limit?: number;

  /** Skip N items */
  skip?: number;
  
  // ============================================================================
  // RANGE (Array/File Slicing)
  // ============================================================================
  
  /** Range selection (like HTTP Range header) */
  range?: {
    start: number;
    end: number;
  } | string;  // "0-99" or "bytes=0-1023"
  
  // ============================================================================
  // OUTPUT
  // ============================================================================
  
  /** Output format */
  format?: 'json' | 'markdown' | 'csv' | 'yaml' | 'text' | 'raw';
  
  /** Include metadata in response */
  includeMeta?: boolean;
  
  // ============================================================================
  // CACHING (Phase 3.6h)
  // ============================================================================
  
  /** Enable query result caching */
  cache?: boolean | QueryCacheOptions;
}

/**
 * Pagination metadata
 */
export interface PaginationMetadata {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextCursor?: string;
  previousCursor?: string;
}

/**
 * Range metadata
 */
export interface RangeMetadata {
  start: number;
  end: number;
  total: number;
  contentRange: string;  // "items 0-99/1000"
}

/**
 * Query result metadata
 */
export interface QueryMetadata {
  executionTime: number;
  itemsScanned: number;
  itemsReturned: number;
  /** Whether this result was served from cache */
  cached?: boolean;
  /** ISO timestamp when result was cached */
  cachedAt?: string;
  /** Whether the query was executed natively by the adapter (e.g. SQL) */
  nativeQuery?: boolean;
}

/**
 * Universal query result (Phase 3.6f-a)
 */
export interface QueryResult<T = any> {
  /** Result data */
  data: T[];

  /** Total matching items (before limit/skip) */
  total?: number;

  /** Pagination metadata */
  pagination?: PaginationMetadata;
  
  /** Range metadata (if range used) */
  range?: RangeMetadata;
  
  /** Query execution info */
  meta?: QueryMetadata;
}

/**
 * Cursor for cursor-based pagination
 */
export interface Cursor {
  /** Last item ID seen */
  lastId: string;
  
  /** Last sort value (for ordering) */
  lastValue: any;
  
  /** Direction */
  direction: 'forward' | 'backward';
}

// ============================================================================
// Phase 3.6f-b: Data Operations
// ============================================================================

/**
 * Options for copy operation
 */
export interface CopyOperationOptions {
  /** Overwrite if destination exists */
  overwrite?: boolean;
  
  /** Filter items to copy */
  filter?: FilterObject;
  
  /** Transform during copy */
  transform?: (item: any) => any;
  
  /** Copy metadata/views too */
  includeMetadata?: boolean;
}

/**
 * Options for move operation
 */
export interface MoveOptions {
  /** Overwrite if destination exists */
  overwrite?: boolean;
  
  /** Filter items to move (leaves non-matching items) */
  filter?: FilterObject;
}

/**
 * Options for merge operation
 */
export interface MergeOptions {
  /** Deduplication strategy */
  deduplicate?: boolean;
  
  /** ID field for deduplication */
  idField?: string;
  
  /** Merge strategy for conflicts */
  onConflict?: 'replace' | 'skip' | 'merge';
  
  /** Overwrite destination (default: `true` — re-running `merge` is idempotent). Set `false` to append to existing dest. */
  overwrite?: boolean;
}

/**
 * Options for slice operation
 */
export interface SliceOptions {
  /** Start index */
  start: number;
  
  /** End index (exclusive) */
  end: number;
  
  /** Save to new collection */
  saveTo?: string;
  
  /** Return data or just save */
  returnData?: boolean;
}

/**
 * Options for split operation
 */
export interface SplitOptions {
  /** Split by field value */
  by: string;
  
  /** Destination pattern (uses {value} placeholder) */
  destPattern: string;
  
  /** Max items per split */
  maxPerSplit?: number;
}

/**
 * Options for deduplicate operation
 */
export interface DeduplicateOptions {
  /** ID field for comparison */
  idField?: string;
  
  /** Use content hash */
  useContentHash?: boolean;
  
  /** Custom comparison fields */
  compareFields?: string[];
  
  /** Keep first or last occurrence */
  keep?: 'first' | 'last';
}

/**
 * External data source configuration
 */
export interface ExternalSource {
  /** Source URL */
  url: string;
  
  /** Source type */
  type: 'json' | 'csv' | 'parquet' | 'auto';
  
  /** Cache TTL in milliseconds (0 = no cache, -1 = forever) */
  cacheTTL?: number;
  
  /** Headers for fetch */
  headers?: Record<string, string>;
  
  /**
   * Authentication config. Required fields depend on `type`:
   *  - `bearer`: requires `token`
   *  - `basic`: requires `username` and `password`
   *  - `api-key`: requires `token` and optionally `headerName` (defaults to "X-API-Key")
   */
  auth?: {
    type: 'bearer' | 'basic' | 'api-key';
    token?: string;
    username?: string;
    password?: string;
    headerName?: string; // For api-key
  };
  
  /** Last fetch timestamp */
  lastFetched?: number;
  
  /** Cached data location (if cached) */
  cacheKey?: string;
  
  /** ETag for conditional requests */
  etag?: string;
  
  /** Last-Modified for conditional requests */
  lastModified?: string;
}

/**
 * Options for registering external data source
 */
export interface RegisterExternalOptions {
  /** Source URL */
  url: string;
  
  /** Source type (auto-detect if not specified) */
  type?: 'json' | 'csv' | 'parquet' | 'auto';
  
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTTL?: number;
  
  /** Headers for fetch */
  headers?: Record<string, string>;
  
  /** Authentication */
  auth?: ExternalSource['auth'];
  
  /** Polling interval for auto-refresh (0 = manual only) */
  pollInterval?: number;
}

/**
 * Options for querying external sources
 */
export interface ExternalQueryOptions extends QueryOptions {
  /** Force refresh (ignore cache) */
  forceRefresh?: boolean;
  
  /** Download and store locally */
  download?: boolean;
  
  /** Adapter to use if downloading */
  downloadAdapter?: string;
}

// ============================================================================
// Phase 3.6h: Query Result Caching & Materialized Views
// ============================================================================

/**
 * Cache configuration for Smallstore
 */
export interface CachingConfig {
  /** Enable automatic query result caching */
  enableQueryCache?: boolean;
  
  /** Default TTL for cached queries (milliseconds) */
  defaultTTL?: number;
  
  /** Maximum cache size before eviction (e.g., "100MB") */
  maxCacheSize?: string;
  
  /** Cache eviction policy */
  evictionPolicy?: 'lru' | 'lfu' | 'ttl-only';
  
  /** Adapter to use for cache storage (defaults to metadataAdapter) */
  cacheAdapter?: string;
  
  /** Auto-invalidate caches when source data is written */
  autoInvalidate?: boolean;
}

/**
 * Cache options for individual queries
 */
export interface QueryCacheOptions {
  /** Enable caching for this query */
  enabled: boolean;
  
  /** TTL for this cached result (milliseconds) */
  ttl?: number;
  
  /** Custom cache key (optional, auto-generated if not provided) */
  key?: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Cache hits */
  hits: number;
  
  /** Cache misses */
  misses: number;
  
  /** Hit rate (hits / total) */
  hitRate: number;
  
  /** Total cache size */
  size: string;
  
  /** Number of cache entries */
  entries: number;
  
  /** Oldest cache entry timestamp */
  oldestEntry?: string;
  
  /** Newest cache entry timestamp */
  newestEntry?: string;
}

/**
 * Cached query result metadata
 */
export interface CachedResult<T = any> {
  /** Cached data */
  data: T;
  
  /** When this was cached */
  cachedAt: number;
  
  /** TTL in milliseconds */
  ttl: number;
  
  /** Cache key */
  key: string;
  
  /** Original query options */
  query: QueryOptions;
}

// ============================================================================
// Factory Configuration
// ============================================================================

/**
 * Configuration for creating Smallstore instance
 */
export interface SmallstoreConfig {
  /** Available adapters (key = adapter name) */
  adapters: Record<string, any>; // StorageAdapter, but using any for flexibility

  /** Default adapter name */
  defaultAdapter: string;

  /** Metadata adapter name (defaults to 'memory') */
  metadataAdapter?: string;

  // Phase 3.1: Config-based routing

  /** Type-based routing (data type → adapter) */
  typeRouting?: {
    blob?: string;
    object?: string;
    kv?: string;
  };

  /** Pattern-based routing (collection pattern → adapter) */
  routing?: {
    [pattern: string]: { adapter: string };
  };

  /** Path-based adapter mounting — simpler syntax for routing */
  mounts?: Record<string, string>;

  /** Enable smart routing (default: false in Phase 3.1) */
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

