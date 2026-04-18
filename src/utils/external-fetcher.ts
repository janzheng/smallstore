/**
 * External Data Fetcher for Virtual Collections
 * 
 * Fetches and parses remote data sources (JSON, CSV, Parquet).
 * Supports caching, conditional requests, and multiple data formats.
 * 
 * Phase 3.6g-c: External Data Sources
 */

import type { ExternalSource } from '../types.ts';
import { UnsupportedOperationError } from '../adapters/errors.ts';
import { retryFetch } from './retry-fetch.ts';

/**
 * Thrown when the remote source indicates its payload is still valid
 * (cacheTTL not expired, or 304 Not Modified). Callers should fall back
 * to their previously cached data. Typed so instanceof checks survive
 * any message wrapping.
 */
export class CacheValidError extends Error {
  constructor(message = 'CACHE_VALID') {
    super(message);
    this.name = 'CacheValidError';
  }
}

/**
 * Fetch result from external source
 */
export interface FetchResult {
  /** Fetched data (parsed) */
  data: any;
  
  /** Whether data was fetched from cache */
  fromCache: boolean;
  
  /** Updated source metadata */
  source: ExternalSource;
  
  /** Fetch timestamp */
  fetchedAt: number;
}

/**
 * Fetch external data source
 * 
 * Handles:
 * - Content-type detection
 * - JSON/CSV/Parquet parsing
 * - Conditional requests (ETag, Last-Modified)
 * - Authentication
 * 
 * @param source - External source configuration
 * @param forceRefresh - Bypass cache and fetch fresh
 * @returns Fetch result with data and metadata
 */
export async function fetchExternal(
  source: ExternalSource,
  forceRefresh = false
): Promise<FetchResult> {
  // Check if we should use cache (use current time for age check)
  if (!forceRefresh && source.cacheTTL && source.cacheTTL > 0 && source.lastFetched) {
    const cacheAge = Date.now() - source.lastFetched;
    if (cacheAge < source.cacheTTL) {
      // Cache is still valid - caller should use cached data
      throw new CacheValidError();
    }
  }
  
  // Build fetch headers
  const headers: Record<string, string> = {
    ...source.headers,
  };
  
  // Add authentication
  if (source.auth) {
    switch (source.auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${source.auth.token}`;
        break;
      case 'basic':
        const credentials = btoa(`${source.auth.username}:${source.auth.password}`);
        headers['Authorization'] = `Basic ${credentials}`;
        break;
      case 'api-key':
        if (source.auth.headerName) {
          headers[source.auth.headerName] = source.auth.token!;
        }
        break;
    }
  }
  
  // Add conditional request headers
  if (!forceRefresh) {
    if (source.etag) {
      headers['If-None-Match'] = source.etag;
    }
    if (source.lastModified) {
      headers['If-Modified-Since'] = source.lastModified;
    }
  }
  
  // Fetch the data (with retry for transient failures)
  const response = await retryFetch(source.url, { headers }, { maxRetries: 2, initialDelay: 500 });

  // Handle 304 Not Modified — use the typed error so callers can survive
  // message wrapping via `err instanceof CacheValidError`.
  if (response.status === 304) {
    throw new CacheValidError();
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch external source: ${response.status} ${response.statusText}`);
  }

  // A076: Only record fetchedAt AFTER successful fetch (not before)
  const fetchedAt = Date.now();
  
  // Extract response headers for caching
  const newEtag = response.headers.get('ETag') || undefined;
  const newLastModified = response.headers.get('Last-Modified') || undefined;
  const contentType = response.headers.get('Content-Type') || '';
  
  // Detect data type
  let dataType = source.type;
  if (dataType === 'auto') {
    if (contentType.includes('application/json')) {
      dataType = 'json';
    } else if (contentType.includes('text/csv')) {
      dataType = 'csv';
    } else if (contentType.includes('parquet')) {
      dataType = 'parquet';
    } else {
      // Fallback: try to infer from URL
      const url = source.url.toLowerCase();
      if (url.endsWith('.json')) {
        dataType = 'json';
      } else if (url.endsWith('.csv')) {
        dataType = 'csv';
      } else if (url.endsWith('.parquet')) {
        dataType = 'parquet';
      } else {
        // Default to JSON
        dataType = 'json';
      }
    }
  }
  
  // Parse the data
  let data: any;
  
  switch (dataType) {
    case 'json':
      data = await response.json();
      break;
      
    case 'csv':
      const csvText = await response.text();
      data = parseCSV(csvText);
      break;
      
    case 'parquet':
      throw new UnsupportedOperationError(
        'external-fetcher',
        'fetch',
        'Parquet format is not yet available (requires duckdb-wasm).',
        'JSON or CSV format',
      );
      
    default:
      throw new Error(`Unsupported data type: ${dataType}`);
  }
  
  // Update source metadata
  const updatedSource: ExternalSource = {
    ...source,
    type: dataType,
    lastFetched: fetchedAt,
    etag: newEtag,
    lastModified: newLastModified,
  };
  
  return {
    data,
    fromCache: false,
    source: updatedSource,
    fetchedAt,
  };
}

/**
 * Simple CSV parser
 * 
 * Converts CSV text to array of objects.
 * Assumes first row is header.
 * 
 * @param csvText - CSV text content
 * @returns Array of objects
 */
export function parseCSV(csvText: string): any[] {
  const lines = csvText.split('\n').filter(line => line.trim());
  
  if (lines.length === 0) {
    return [];
  }
  
  // Parse header
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  // Parse rows
  const result: any[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: any = {};
    
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j] || '';
    }
    
    result.push(row);
  }
  
  return result;
}

/**
 * Auto-detect data type from URL or content
 * 
 * @param url - URL to check
 * @param contentType - Content-Type header
 * @returns Detected type
 */
export function detectDataType(
  url: string,
  contentType?: string
): 'json' | 'csv' | 'parquet' | 'auto' {
  // Check content-type first
  if (contentType) {
    if (contentType.includes('application/json')) return 'json';
    if (contentType.includes('text/csv')) return 'csv';
    if (contentType.includes('parquet')) return 'parquet';
  }
  
  // Check URL extension
  const urlLower = url.toLowerCase();
  if (urlLower.endsWith('.json')) return 'json';
  if (urlLower.endsWith('.csv')) return 'csv';
  if (urlLower.endsWith('.parquet')) return 'parquet';
  
  // Default
  return 'auto';
}

