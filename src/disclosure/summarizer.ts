/**
 * Summarizer
 *
 * Generates summaries at different disclosure levels.
 * Handles multi-level summarization from brief to detailed.
 */

import type {
  DisclosureLevel,
  DisclosedData,
  DisclosedOverview,
  SummarizationOptions,
} from './types.ts';

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: Required<SummarizationOptions> = {
  maxLength: 200,
  priorityFields: ['name', 'title', 'description', 'summary', 'type', 'id'],
  includeMetadata: false,
  template: '',
};

// ============================================================================
// Summarizer Class
// ============================================================================

/**
 * Summarizer generates summaries at different disclosure levels
 */
export class Summarizer {
  private options: Required<SummarizationOptions>;

  constructor(options?: SummarizationOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generate summary text for data
   *
   * @param data - Data to summarize
   * @param path - Data path (for context)
   * @returns Brief summary text
   */
  generateSummary(data: any, path: string): string {
    if (data === null || data === undefined) {
      return `Empty data at ${path}`;
    }

    // Handle primitives
    if (typeof data === 'string') {
      return this.truncate(data, this.options.maxLength);
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return `${typeof data}: ${data}`;
    }

    // Handle arrays
    if (Array.isArray(data)) {
      const itemType = this.inferArrayItemType(data);
      const sample = data.length > 0 ? this.summarizeItem(data[0]) : 'empty';
      return this.truncate(
        `Array of ${data.length} ${itemType}s. First: ${sample}`,
        this.options.maxLength
      );
    }

    // Handle objects
    if (typeof data === 'object') {
      return this.summarizeObject(data, path);
    }

    return `Unknown data type at ${path}`;
  }

  /**
   * Generate overview for data
   *
   * @param data - Data to analyze
   * @returns Overview structure
   */
  generateOverview(data: any): DisclosedOverview {
    if (data === null || data === undefined) {
      return { structure: 'empty' };
    }

    if (typeof data !== 'object') {
      return {
        structure: typeof data,
        sample: { value: data },
      };
    }

    if (Array.isArray(data)) {
      return this.generateArrayOverview(data);
    }

    return this.generateObjectOverview(data);
  }

  /**
   * Generate details (most fields with context)
   *
   * @param data - Data to detail
   * @param path - Data path
   * @returns Detailed representation
   */
  generateDetails(data: any, _path: string): any {
    if (data === null || data === undefined) {
      return null;
    }

    if (typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      // Return first 10 items with full details
      return {
        type: 'array',
        totalItems: data.length,
        items: data.slice(0, 10).map((item, i) => ({
          index: i,
          data: this.trimLargeValues(item),
        })),
        hasMore: data.length > 10,
      };
    }

    // For objects, include most fields but trim very large values
    return this.trimLargeValues(data);
  }

  /**
   * Disclose data at a specific level
   *
   * @param data - Raw data
   * @param path - Data path
   * @param level - Disclosure level
   * @param relevanceScore - Relevance score
   * @param matchedSkill - Skill that matched
   * @returns Disclosed data at requested level
   */
  disclose(
    data: any,
    path: string,
    level: DisclosureLevel,
    relevanceScore: number,
    matchedSkill?: string
  ): DisclosedData {
    const result: DisclosedData = {
      path,
      level,
      summary: this.generateSummary(data, path),
      relevanceScore,
      matchedSkill,
      canExpandTo: this.getExpandableLevels(level),
      dataType: this.getDataType(data),
      size: this.calculateSize(data),
    };

    // Add overview for levels >= overview
    if (level !== 'summary') {
      result.overview = this.generateOverview(data);
    }

    // Add details for levels >= detailed
    if (level === 'detailed' || level === 'full') {
      result.details = this.generateDetails(data, path);
    }

    // Add full data for full level
    if (level === 'full') {
      result.full = data;
    }

    return result;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Summarize an object
   */
  private summarizeObject(obj: Record<string, any>, path: string): string {
    const keys = Object.keys(obj);

    // Look for priority fields
    for (const field of this.options.priorityFields) {
      if (obj[field] !== undefined) {
        const value = obj[field];
        if (typeof value === 'string') {
          return this.truncate(value, this.options.maxLength);
        }
      }
    }

    // Fallback: describe structure
    const fieldList = keys.slice(0, 5).join(', ');
    const more = keys.length > 5 ? ` and ${keys.length - 5} more` : '';
    return this.truncate(
      `Object at ${path} with fields: ${fieldList}${more}`,
      this.options.maxLength
    );
  }

  /**
   * Summarize a single item (for array previews)
   */
  private summarizeItem(item: any): string {
    if (item === null || item === undefined) return 'null';
    if (typeof item === 'string') return this.truncate(item, 50);
    if (typeof item === 'number' || typeof item === 'boolean') {
      return String(item);
    }
    if (Array.isArray(item)) {
      return `[${item.length} items]`;
    }
    if (typeof item === 'object') {
      // Look for name/title
      if (item.name) return this.truncate(String(item.name), 50);
      if (item.title) return this.truncate(String(item.title), 50);
      if (item.id) return `id: ${item.id}`;
      return `{${Object.keys(item).length} fields}`;
    }
    return 'unknown';
  }

  /**
   * Infer array item type
   */
  private inferArrayItemType(arr: any[]): string {
    if (arr.length === 0) return 'item';

    const types = new Set<string>();
    for (const item of arr.slice(0, 10)) {
      if (item === null) types.add('null');
      else if (Array.isArray(item)) types.add('array');
      else types.add(typeof item);
    }

    if (types.size === 1) {
      return types.values().next().value || 'item';
    }
    return 'mixed';
  }

  /**
   * Generate overview for an array
   */
  private generateArrayOverview(arr: any[]): DisclosedOverview {
    if (arr.length === 0) {
      return {
        structure: 'array',
        itemCount: 0,
      };
    }

    const itemType = this.inferArrayItemType(arr);
    const sample: Record<string, any> = {};

    // Get sample items
    for (let i = 0; i < Math.min(3, arr.length); i++) {
      sample[`item_${i}`] = this.summarizeItem(arr[i]);
    }

    // Get fields if items are objects
    let fields: string[] | undefined;
    if (itemType === 'object' && arr[0] && typeof arr[0] === 'object') {
      fields = Object.keys(arr[0]).slice(0, 10);
    }

    return {
      structure: 'array',
      itemCount: arr.length,
      fields,
      sample,
      nested:
        itemType !== 'object' && itemType !== 'array'
          ? undefined
          : { itemType },
    };
  }

  /**
   * Generate overview for an object
   */
  private generateObjectOverview(obj: Record<string, any>): DisclosedOverview {
    const fields = Object.keys(obj);
    const sample: Record<string, any> = {};
    const nested: Record<string, string> = {};

    // Extract priority fields first
    for (const field of this.options.priorityFields) {
      if (obj[field] !== undefined) {
        sample[field] = this.summarizeItem(obj[field]);
      }
    }

    // Fill in remaining fields up to 10
    for (const field of fields) {
      if (Object.keys(sample).length >= 10) break;
      if (sample[field] === undefined) {
        sample[field] = this.summarizeItem(obj[field]);
      }

      // Track nested structures
      if (Array.isArray(obj[field])) {
        nested[field] = `array[${obj[field].length}]`;
      } else if (typeof obj[field] === 'object' && obj[field] !== null) {
        nested[field] = `object{${Object.keys(obj[field]).length}}`;
      }
    }

    return {
      structure: 'object',
      fields: fields.slice(0, 20),
      sample,
      nested: Object.keys(nested).length > 0 ? nested : undefined,
    };
  }

  /**
   * Trim large values in an object (for details level)
   */
  private trimLargeValues(obj: any, depth = 0): any {
    if (depth > 5) return '[max depth]';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') {
      if (typeof obj === 'string' && obj.length > 1000) {
        return obj.slice(0, 1000) + '... [truncated]';
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      if (obj.length > 100) {
        return [
          ...obj.slice(0, 100).map((item) => this.trimLargeValues(item, depth + 1)),
          `... and ${obj.length - 100} more items`,
        ];
      }
      return obj.map((item) => this.trimLargeValues(item, depth + 1));
    }

    const result: Record<string, any> = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, 50)) {
      result[key] = this.trimLargeValues(obj[key], depth + 1);
    }
    if (keys.length > 50) {
      result['...'] = `${keys.length - 50} more fields`;
    }
    return result;
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Get levels this data can be expanded to
   */
  private getExpandableLevels(currentLevel: DisclosureLevel): DisclosureLevel[] {
    const allLevels: DisclosureLevel[] = ['summary', 'overview', 'detailed', 'full'];
    const currentIndex = allLevels.indexOf(currentLevel);
    return allLevels.slice(currentIndex + 1);
  }

  /**
   * Get data type string
   */
  private getDataType(data: any): string {
    if (data === null) return 'null';
    if (data === undefined) return 'undefined';
    if (Array.isArray(data)) return 'array';
    return typeof data;
  }

  /**
   * Calculate size information
   */
  private calculateSize(data: any): { bytes: number; formatted: string; itemCount?: number } {
    let bytes: number;

    try {
      const json = JSON.stringify(data);
      bytes = new TextEncoder().encode(json).length;
    } catch {
      bytes = 0;
    }

    const itemCount = Array.isArray(data) ? data.length : undefined;

    return {
      bytes,
      formatted: this.formatBytes(bytes),
      itemCount,
    };
  }

  /**
   * Format bytes as human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Update options
   */
  updateOptions(options: Partial<SummarizationOptions>): void {
    this.options = { ...this.options, ...options };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a summarizer with default or custom options
 */
export function createSummarizer(options?: SummarizationOptions): Summarizer {
  return new Summarizer(options);
}
