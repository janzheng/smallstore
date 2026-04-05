/**
 * Text Retriever
 * 
 * Convert everything to text strings.
 * Perfect for feeding to LLMs or displaying as plain text.
 */

import type { DataType } from '../types.ts';
import type { RetrievalAdapter, RetrievalResult } from './base.ts';
import { createMetadata } from './base.ts';

/**
 * Text retriever options
 */
export interface TextRetrieverOptions {
  /** Separator between items */
  separator?: string;
  
  /** Format for objects */
  format?: 'json' | 'custom';
  
  /** Custom formatter function */
  formatter?: (item: any) => string;
  
  /** Pretty print JSON? */
  pretty?: boolean;
  
  /** Include item indices in output? */
  includeIndices?: boolean;
}

/**
 * Text Retriever
 * 
 * Convert any data to text strings.
 * Like JSON.stringify() but with custom formatting options.
 */
export class TextRetriever implements RetrievalAdapter {
  readonly name = 'text';
  readonly capabilities = {
    name: 'text',
    type: 'transform' as const,
    supportedTypes: ['object', 'kv'] as DataType[],
  };

  async retrieve(data: any, options?: TextRetrieverOptions): Promise<RetrievalResult> {
    const sep = options?.separator || '\n\n';
    const pretty = options?.pretty ?? true;
    
    const texts = Array.isArray(data)
      ? data.map((item, i) => this.toString(item, i, options))
      : [this.toString(data, 0, options)];
    
    const text = texts.join(sep);
    
    return {
      data: text,
      metadata: createMetadata('text', text, data, {
        format: options?.format || 'json',
        lengthChars: text.length,
        lengthLines: text.split('\n').length
      })
    };
  }

  /**
   * Convert item to string
   */
  private toString(item: any, index: number, options?: any): string {
    let text = '';
    
    // Include index?
    if (options?.includeIndices) {
      text += `[${index}] `;
    }
    
    // Custom formatter?
    if (options?.formatter) {
      text += options.formatter(item);
      return text;
    }
    
    // String? Return as-is
    if (typeof item === 'string') {
      text += item;
      return text;
    }
    
    // Object? Format as JSON
    if (typeof item === 'object' && item !== null) {
      text += options?.pretty
        ? JSON.stringify(item, null, 2)
        : JSON.stringify(item);
      return text;
    }
    
    // Primitive? Convert
    text += String(item);
    return text;
  }
}

