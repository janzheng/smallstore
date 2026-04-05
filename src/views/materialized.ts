/**
 * Materialized View Manager
 * 
 * Manages pre-computed, named query results with smart refresh strategies.
 * 
 * Phase 3.6h-b: Materialized Views
 */

import type { QueryOptions, QueryResult } from '../types.ts';
import { debug } from '../utils/debug.ts';

/**
 * Refresh strategy for materialized views
 */
export type RefreshStrategy = 
  | 'lazy'      // Refresh on first access if stale (TTL-based)
  | 'on-write'  // Auto-refresh when source collection changes
  | 'manual'    // Only via explicit refreshView() call
  | 'external'; // External trigger (cron, scheduled job)

/**
 * Materialized view definition
 */
export interface MaterializedViewDefinition {
  /** Source collection to query */
  source: string;
  
  /** Query to materialize */
  query: QueryOptions;
  
  /** Refresh strategy */
  refresh: RefreshStrategy;
  
  /** TTL for lazy refresh (milliseconds) */
  ttl?: number;
  
  /** Human-readable description */
  description?: string;
}

/**
 * Materialized view metadata (stored)
 */
export interface MaterializedView extends MaterializedViewDefinition {
  /** View name */
  name: string;
  
  /** When view was created */
  created: string;
  
  /** When view was last refreshed */
  lastRefreshed: string;
  
  /** Next scheduled refresh (for external strategy) */
  nextRefresh?: string;
  
  /** View statistics */
  stats?: {
    itemCount: number;
    computeTime: number;
    size: string;
  };
}

/**
 * Options for refreshing a view
 */
export interface RefreshOptions {
  /** Force refresh even if not stale */
  force?: boolean;
  
  /** Refresh in background (return immediately) */
  background?: boolean;
}

/**
 * Result of a view refresh operation
 */
export interface RefreshResult {
  /** View name */
  view: string;
  
  /** Whether refresh succeeded */
  success: boolean;
  
  /** Number of items in refreshed view */
  itemCount: number;
  
  /** Time taken to compute (ms) */
  computeTime: number;
  
  /** Previous item count (if available) */
  previousCount?: number;
  
  /** Error message (if failed) */
  error?: string;
}

/**
 * Filter for listing views
 */
export interface ViewFilter {
  /** Filter by source collection */
  source?: string;
  
  /** Filter by refresh strategy */
  refresh?: RefreshStrategy;
}

/**
 * Materialized View Manager
 * 
 * Manages lifecycle of materialized views:
 * - Create/update/delete view definitions
 * - Execute queries and store results
 * - Implement refresh strategies
 * - Track metadata and statistics
 */
export class MaterializedViewManager {
  private router: any; // SmartRouter (avoid circular dependency)
  private metadataAdapter: any; // StorageAdapter
  private refreshInFlight = new Set<string>();

  constructor(router: any, metadataAdapter: any) {
    this.router = router;
    this.metadataAdapter = metadataAdapter;
  }
  
  // ============================================================================
  // Core CRUD Operations
  // ============================================================================
  
  /**
   * Create a materialized view
   * 
   * @param name - View name
   * @param definition - View definition
   */
  async create(name: string, definition: MaterializedViewDefinition): Promise<void> {
    debug(`[MaterializedViews] Creating view "${name}"...`);
    
    // Validate definition
    this.validateDefinition(definition);
    
    // Check if view already exists
    const existing = await this.getMetadata(name);
    if (existing) {
      throw new Error(`Materialized view "${name}" already exists`);
    }
    
    // Create view metadata
    const view: MaterializedView = {
      name,
      ...definition,
      created: new Date().toISOString(),
      lastRefreshed: new Date().toISOString(),
    };
    
    // Store metadata
    await this.saveMetadata(view);
    
    // Initial refresh (compute first result)
    await this.refresh(name, { force: true });
    
    debug(`[MaterializedViews] ✅ View "${name}" created`);
  }
  
  /**
   * Get view data (materialized result)
   * 
   * Implements lazy refresh if strategy is 'lazy' and view is stale.
   * 
   * @param name - View name
   * @returns Materialized data
   */
  async getData(name: string): Promise<any> {
    // Get metadata
    const view = await this.getMetadata(name);
    if (!view) {
      throw new Error(`Materialized view "${name}" not found`);
    }
    
    // Check if refresh needed (lazy strategy only)
    if (view.refresh === 'lazy' && this.isStale(view)) {
      debug(`[MaterializedViews] View "${name}" is stale, refreshing...`);
      const refreshResult = await this.refresh(name, { force: true });
      if (!refreshResult.success) {
        console.warn(`[MaterializedViews] Refresh failed for view "${name}", returning stale data`);
      }
    }
    
    // Get stored data
    const dataKey = this.buildDataKey(name);
    const data = await this.metadataAdapter.get(dataKey);
    
    if (!data) {
      console.warn(`[MaterializedViews] View "${name}" has no data, refreshing...`);
      await this.refresh(name, { force: true });
      return await this.metadataAdapter.get(dataKey);
    }
    
    return data;
  }
  
  /**
   * Refresh a materialized view
   * 
   * Executes the source query and stores the result.
   * 
   * @param name - View name
   * @param options - Refresh options
   * @returns Refresh result
   */
  async refresh(name: string, options: RefreshOptions = {}): Promise<RefreshResult> {
    // Check and set in-flight flag synchronously (before any await) to prevent race conditions
    if (this.refreshInFlight.has(name)) {
      return { view: name, success: true, itemCount: 0, computeTime: 0, error: 'already-in-flight' };
    }
    this.refreshInFlight.add(name);

    const startTime = Date.now();

    try {
      // Get view metadata
      const view = await this.getMetadata(name);
      if (!view) {
        throw new Error(`Materialized view "${name}" not found`);
      }

      // Check if refresh needed (unless forced)
      if (!options.force && view.refresh === 'lazy' && !this.isStale(view)) {
        debug(`[MaterializedViews] View "${name}" is fresh, skipping refresh`);
        return {
          view: name,
          success: true,
          itemCount: view.stats?.itemCount || 0,
          computeTime: 0,
          previousCount: view.stats?.itemCount,
        };
      }
      
      debug(`[MaterializedViews] Refreshing view "${name}"...`);
      
      // Execute source query
      const result: QueryResult = await this.router.query(view.source, view.query);
      
      // Store materialized data
      const dataKey = this.buildDataKey(name);
      await this.metadataAdapter.set(dataKey, result.data);
      
      // Update metadata
      const computeTime = Date.now() - startTime;
      view.lastRefreshed = new Date().toISOString();
      view.stats = {
        itemCount: result.data?.length || 0,
        computeTime,
        size: this.calculateSize(result.data),
      };
      
      await this.saveMetadata(view);
      
      debug(`[MaterializedViews] ✅ View "${name}" refreshed: ${view.stats.itemCount} items in ${computeTime}ms`);
      
      return {
        view: name,
        success: true,
        itemCount: view.stats.itemCount,
        computeTime,
        previousCount: result.meta?.itemsReturned,
      };
      
    } catch (error) {
      const computeTime = Date.now() - startTime;
      console.error(`[MaterializedViews] Failed to refresh view "${name}":`, error);

      return {
        view: name,
        success: false,
        itemCount: 0,
        computeTime,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.refreshInFlight.delete(name);
    }
  }
  
  /**
   * Update view definition
   * 
   * @param name - View name
   * @param updates - Partial definition updates
   */
  async update(name: string, updates: Partial<MaterializedViewDefinition>): Promise<void> {
    debug(`[MaterializedViews] Updating view "${name}"...`);
    
    // Get existing view
    const view = await this.getMetadata(name);
    if (!view) {
      throw new Error(`Materialized view "${name}" not found`);
    }
    
    // Apply updates
    const updated: MaterializedView = {
      ...view,
      ...updates,
    };
    
    // Validate
    this.validateDefinition(updated);
    
    // Save
    await this.saveMetadata(updated);
    
    // Refresh if query changed
    if (updates.query || updates.source) {
      await this.refresh(name, { force: true });
    }
    
    debug(`[MaterializedViews] ✅ View "${name}" updated`);
  }
  
  /**
   * Delete a materialized view
   * 
   * @param name - View name
   * @param deleteData - Whether to delete materialized data (default: true)
   */
  async delete(name: string, deleteData = true): Promise<void> {
    debug(`[MaterializedViews] Deleting view "${name}"...`);
    
    // Delete metadata
    const metadataKey = this.buildMetadataKey(name);
    await this.metadataAdapter.delete(metadataKey);
    
    // Delete data if requested
    if (deleteData) {
      const dataKey = this.buildDataKey(name);
      await this.metadataAdapter.delete(dataKey);
    }
    
    debug(`[MaterializedViews] ✅ View "${name}" deleted`);
  }
  
  /**
   * List all materialized views
   * 
   * @param filter - Optional filter criteria
   * @returns Array of view metadata
   */
  async list(filter?: ViewFilter): Promise<MaterializedView[]> {
    // Get all view metadata keys
    const prefix = 'smallstore:_views:';
    const keys = await this.metadataAdapter.keys(prefix);
    
    // Load all views
    const views: MaterializedView[] = [];
    for (const key of keys) {
      try {
        const view = await this.metadataAdapter.get(key);
        if (view) {
          views.push(view);
        }
      } catch (error) {
        console.warn(`[MaterializedViews] Failed to load view from ${key}:`, error);
      }
    }
    
    // Apply filters
    let filtered = views;
    
    if (filter?.source) {
      filtered = filtered.filter(v => v.source === filter.source);
    }
    
    if (filter?.refresh) {
      filtered = filtered.filter(v => v.refresh === filter.refresh);
    }
    
    return filtered;
  }
  
  /**
   * Get view metadata
   * 
   * @param name - View name
   * @returns View metadata or null if not found
   */
  async getMetadata(name: string): Promise<MaterializedView | null> {
    const key = this.buildMetadataKey(name);
    
    try {
      const view = await this.metadataAdapter.get(key);
      return view || null;
    } catch (error) {
      console.error('[MaterializedViews] Failed to load view metadata:', error);
      throw error;
    }
  }
  
  // ============================================================================
  // Batch Operations
  // ============================================================================
  
  /**
   * Refresh all views matching filter
   * 
   * @param filter - Optional filter criteria
   * @returns Array of refresh results
   */
  async refreshAll(filter?: ViewFilter): Promise<RefreshResult[]> {
    debug('[MaterializedViews] Refreshing all views...');
    
    // Get views
    const views = await this.list(filter);
    
    // Refresh all in parallel
    const results = await Promise.all(
      views.map(view => this.refresh(view.name, { force: true }))
    );
    
    const successCount = results.filter(r => r.success).length;
    debug(`[MaterializedViews] ✅ Refreshed ${successCount}/${results.length} views`);
    
    return results;
  }
  
  /**
   * Trigger refresh for views that depend on a source collection
   * 
   * Called automatically when source collection is modified (on-write strategy).
   * 
   * @param source - Source collection path
   */
  async refreshBySource(source: string): Promise<void> {
    // Find views that depend on this source and use on-write refresh
    const views = await this.list({ source, refresh: 'on-write' });
    
    if (views.length === 0) {
      return; // No views to refresh
    }
    
    debug(`[MaterializedViews] Auto-refreshing ${views.length} views for source "${source}"...`);
    
    // Refresh all in parallel
    await Promise.all(
      views.map(view => this.refresh(view.name, { force: true }))
    );
  }
  
  // ============================================================================
  // Helpers
  // ============================================================================
  
  /**
   * Check if view is stale (needs refresh)
   * 
   * @param view - View metadata
   * @returns True if stale
   */
  private isStale(view: MaterializedView): boolean {
    if (!view.ttl) {
      return false; // No TTL = never stale
    }
    
    const lastRefreshed = new Date(view.lastRefreshed).getTime();
    const now = Date.now();
    
    return (now - lastRefreshed) > view.ttl;
  }
  
  /**
   * Validate view definition
   * 
   * @param definition - View definition to validate
   */
  private validateDefinition(definition: MaterializedViewDefinition): void {
    if (!definition.source) {
      throw new Error('View definition must have a source collection');
    }
    
    if (!definition.query) {
      throw new Error('View definition must have a query');
    }
    
    if (!definition.refresh) {
      throw new Error('View definition must have a refresh strategy');
    }
    
    if (definition.refresh === 'lazy' && !definition.ttl) {
      throw new Error('Lazy refresh strategy requires a TTL');
    }
  }
  
  /**
   * Build metadata key for a view
   * 
   * @param name - View name
   * @returns Metadata key
   */
  private buildMetadataKey(name: string): string {
    return `smallstore:_views:${name}`;
  }
  
  /**
   * Build data key for a view
   * 
   * @param name - View name
   * @returns Data key
   */
  private buildDataKey(name: string): string {
    return `smallstore:_viewdata:${name}`;
  }
  
  /**
   * Save view metadata
   * 
   * @param view - View metadata
   */
  private async saveMetadata(view: MaterializedView): Promise<void> {
    const key = this.buildMetadataKey(view.name);
    await this.metadataAdapter.set(key, view);
  }
  
  /**
   * Calculate size of data
   * 
   * @param data - Data to measure
   * @returns Human-readable size
   */
  private calculateSize(data: any): string {
    const bytes = JSON.stringify(data).length;
    
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }
}

