/**
 * View Manager
 * 
 * Manages view lifecycle with in-memory caching for performance.
 */

import type { StorageAdapter } from '../adapters/adapter.ts';
import type { ViewDefinition, RetrievalAdapter, RetrievalStep } from '../types.ts';
import { saveView, loadView, deleteView, listViews } from './storage.ts';

/**
 * View Manager - Manages views with caching
 */
export class ViewManager {
  private adapter: StorageAdapter;
  private cache: Map<string, ViewDefinition> = new Map();
  private retrievers: Map<string, RetrievalAdapter>;
  
  /**
   * Create view manager
   * 
   * @param adapter - Storage adapter for persistence
   * @param retrievers - Available retrieval adapters
   */
  constructor(adapter: StorageAdapter, retrievers: Map<string, RetrievalAdapter>) {
    this.adapter = adapter;
    this.retrievers = retrievers;
  }
  
  // ============================================================================
  // View CRUD
  // ============================================================================
  
  /**
   * Create a new view
   * 
   * @param name - View name (should include .view suffix)
   * @param definition - View definition
   */
  async createView(name: string, definition: Omit<ViewDefinition, 'name'>): Promise<void> {
    // Ensure .view suffix
    const viewName = name.endsWith('.view') ? name : `${name}.view`;
    
    const viewDef: ViewDefinition = {
      ...definition,
      name: viewName,
    };
    
    // Validate source exists (we'll check this when executing)
    // Validate retrievers exist
    for (const step of viewDef.retrievers) {
      if (!this.retrievers.has(step.type)) {
        throw new Error(`Unknown retriever type: ${step.type}`);
      }
    }
    
    // Save to storage
    await saveView(this.adapter, viewDef);
    
    // Cache it
    this.cache.set(viewName, viewDef);
  }
  
  /**
   * Get view definition (from cache or storage)
   * 
   * @param name - View name
   * @returns View definition, or null if not found
   */
  async getViewDefinition(name: string): Promise<ViewDefinition | null> {
    // Ensure .view suffix
    const viewName = name.endsWith('.view') ? name : `${name}.view`;
    
    // Check cache first
    if (this.cache.has(viewName)) {
      return this.cache.get(viewName)!;
    }
    
    // Load from storage
    const viewDef = await loadView(this.adapter, viewName);
    
    if (viewDef) {
      // Cache it
      this.cache.set(viewName, viewDef);
    }
    
    return viewDef;
  }
  
  /**
   * Update view definition
   * 
   * @param name - View name
   * @param definition - New view definition
   */
  async updateView(name: string, definition: Omit<ViewDefinition, 'name'>): Promise<void> {
    // Ensure .view suffix
    const viewName = name.endsWith('.view') ? name : `${name}.view`;
    
    // Get existing view to preserve created timestamp
    const existing = await this.getViewDefinition(viewName);
    
    const viewDef: ViewDefinition = {
      ...definition,
      name: viewName,
      created: existing?.created,
    };
    
    // Validate retrievers
    for (const step of viewDef.retrievers) {
      if (!this.retrievers.has(step.type)) {
        throw new Error(`Unknown retriever type: ${step.type}`);
      }
    }
    
    // Save to storage
    await saveView(this.adapter, viewDef);
    
    // Update cache
    this.cache.set(viewName, viewDef);
  }
  
  /**
   * Delete a view
   * 
   * @param name - View name
   */
  async deleteView(name: string): Promise<void> {
    // Ensure .view suffix
    const viewName = name.endsWith('.view') ? name : `${name}.view`;
    
    // Delete from storage
    await deleteView(this.adapter, viewName);
    
    // Remove from cache
    this.cache.delete(viewName);
  }
  
  /**
   * List all views (optionally filtered by namespace)
   * 
   * @param namespace - Optional namespace filter
   * @returns Array of view names
   */
  async listViews(namespace?: string): Promise<string[]> {
    return await listViews(this.adapter, namespace);
  }
  
  // ============================================================================
  // View Execution
  // ============================================================================
  
  /**
   * Execute a view (load source data and apply pipeline)
   * 
   * This is called by SmartRouter.getView()
   * 
   * @param name - View name
   * @param sourceData - Source data (already loaded by router)
   * @param options - Additional options
   * @returns Retrieved data after pipeline
   */
  async executeView(
    name: string,
    sourceData: any,
    options?: any
  ): Promise<any> {
    // Get view definition
    const viewDef = await this.getViewDefinition(name);
    
    if (!viewDef) {
      throw new Error(`View not found: ${name}`);
    }
    
    // Apply retrieval pipeline
    let data = sourceData;
    
    for (const step of viewDef.retrievers) {
      const retriever = this.retrievers.get(step.type);
      
      if (!retriever) {
        throw new Error(`Unknown retriever type: ${step.type}`);
      }
      
      // Merge step options with any additional options
      const retrievalOptions = {
        ...step.options,
        ...options,
      };
      
      const result = await retriever.retrieve(data, retrievalOptions);
      data = result.data;
    }
    
    return data;
  }
  
  /**
   * Clear the cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

