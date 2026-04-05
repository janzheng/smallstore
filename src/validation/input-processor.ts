/**
 * Input Validation & Filtering for Smallstore
 * 
 * Validates and transforms data BEFORE storage.
 * Complements Phase 2's output filtering (views/retrievers).
 * 
 * Phase 2.6: Input Validation & Filtering
 */

import type { SetOptions, FieldFilter } from '../types.ts';

// ============================================================================
// Validation Logic (borrowed from validate.ts)
// ============================================================================

/**
 * Convert JSON Schema to validation function
 */
function createValidator(schema: any): (item: any) => { success: boolean; error?: any } {
  return (item: any) => {
    try {
      validateJsonSchema(item, schema);
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  };
}

/**
 * Simple JSON Schema validator
 * 
 * Validates basic types and structures.
 * For complex validation, users can provide zodSchema.
 */
function validateJsonSchema(data: any, schema: any): void {
  const type = schema.type;
  
  if (!type) {
    if (schema.properties) {
      validateJsonSchema(data, { ...schema, type: 'object' });
      return;
    }
    if (schema.items) {
      validateJsonSchema(data, { ...schema, type: 'array' });
      return;
    }
    return; // No type, assume valid
  }
  
  switch (type) {
    case 'string':
      if (typeof data !== 'string') {
        throw new Error(`Expected string, got ${typeof data}`);
      }
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        throw new Error(`String length ${data.length} < minLength ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        throw new Error(`String length ${data.length} > maxLength ${schema.maxLength}`);
      }
      if (schema.pattern) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(String(data))) {
            throw new Error(`String does not match pattern ${schema.pattern}`);
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            throw new Error(`Invalid regex pattern: ${schema.pattern}`);
          }
          throw e;
        }
      }
      if (schema.format === 'email' && !isEmail(data)) {
        throw new Error(`Invalid email format: ${data}`);
      }
      if (schema.format === 'url' && !isUrl(data)) {
        throw new Error(`Invalid URL format: ${data}`);
      }
      break;
      
    case 'number':
    case 'integer':
      if (typeof data !== 'number') {
        throw new Error(`Expected number, got ${typeof data}`);
      }
      if (type === 'integer' && !Number.isInteger(data)) {
        throw new Error(`Expected integer, got ${data}`);
      }
      if (schema.minimum !== undefined && data < schema.minimum) {
        throw new Error(`Number ${data} < minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        throw new Error(`Number ${data} > maximum ${schema.maximum}`);
      }
      break;
      
    case 'boolean':
      if (typeof data !== 'boolean') {
        throw new Error(`Expected boolean, got ${typeof data}`);
      }
      break;
      
    case 'null':
      if (data !== null) {
        throw new Error(`Expected null, got ${typeof data}`);
      }
      break;
      
    case 'array':
      if (!Array.isArray(data)) {
        throw new Error(`Expected array, got ${typeof data}`);
      }
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        throw new Error(`Array length ${data.length} < minItems ${schema.minItems}`);
      }
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        throw new Error(`Array length ${data.length} > maxItems ${schema.maxItems}`);
      }
      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          try {
            validateJsonSchema(data[i], schema.items);
          } catch (error) {
            throw new Error(`Array item ${i}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      break;
      
    case 'object':
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error(`Expected object, got ${typeof data}`);
      }
      if (schema.properties) {
        const required = schema.required || [];
        
        // Check required fields
        for (const key of required) {
          if (!(key in data)) {
            throw new Error(`Missing required field: ${key}`);
          }
        }
        
        // Validate each property
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in data) {
            try {
              validateJsonSchema(data[key], propSchema);
            } catch (error) {
              throw new Error(`Property '${key}': ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        
        // Check for additional properties
        if (schema.additionalProperties === false) {
          const allowedKeys = Object.keys(schema.properties);
          for (const key of Object.keys(data)) {
            if (!allowedKeys.includes(key)) {
              throw new Error(`Additional property not allowed: ${key}`);
            }
          }
        }
      }
      break;
      
    default:
      // Unknown type, assume valid
      break;
  }
}

/**
 * Simple email validation
 */
function isEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

/**
 * Simple URL validation
 */
function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validate input data before storage
 * 
 * @param data - Data to validate
 * @param options - Validation options
 * @returns Validated data (may be filtered in sieve mode)
 */
export async function validateInput(data: any, options: NonNullable<SetOptions['inputValidation']>): Promise<any> {
  const { schema, zodSchema, mode, onInvalid } = options;
  
  if (!schema && !zodSchema) {
    throw new Error('inputValidation requires either schema or zodSchema');
  }
  
  // Create validator
  let validator: (item: any) => { success: boolean; error?: any };
  
  if (zodSchema) {
    // Use Zod schema if provided
    validator = (item: any) => {
      try {
        zodSchema.parse(item);
        return { success: true };
      } catch (error) {
        return { success: false, error };
      }
    };
  } else {
    // Use JSON Schema
    validator = createValidator(schema);
  }
  
  // Validate based on mode
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];
  
  if (mode === 'strict') {
    // Strict mode: Throw on first invalid item
    for (let i = 0; i < items.length; i++) {
      const result = validator(items[i]);
      if (!result.success) {
        throw new Error(`Validation failed for item ${i}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
      }
    }
    return data;
  } else {
    // Sieve mode: Filter out invalid items
    const validItems: any[] = [];
    
    for (const item of items) {
      const result = validator(item);
      if (result.success) {
        validItems.push(item);
      } else if (onInvalid) {
        onInvalid(item, result.error);
      }
    }
    
    return isArray ? validItems : (validItems.length > 0 ? validItems[0] : null);
  }
}

// ============================================================================
// Input Transformation
// ============================================================================

/**
 * Apply pick transformation (only keep specified fields)
 */
function applyPick(data: any, fields: string[]): any {
  if (Array.isArray(data)) {
    return data.map(item => applyPick(item, fields));
  }
  
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  
  const result: any = {};
  for (const field of fields) {
    if (field in data) {
      result[field] = data[field];
    }
  }
  return result;
}

/**
 * Apply omit transformation (remove specified fields)
 */
function applyOmit(data: any, fields: string[]): any {
  if (Array.isArray(data)) {
    return data.map(item => applyOmit(item, fields));
  }
  
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  
  const result: any = { ...data };
  for (const field of fields) {
    delete result[field];
  }
  return result;
}

/**
 * Apply where filter (using field-based filter syntax)
 */
function applyWhere(data: any, filter: FieldFilter): any {
  if (!Array.isArray(data)) {
    // Single item: check if it matches filter
    return matchesFilter(data, filter) ? data : null;
  }
  
  // Array: filter items
  return data.filter(item => matchesFilter(item, filter));
}

/**
 * Check if item matches filter
 * 
 * Matches the FilterRetriever logic from Phase 2 for consistency!
 */
function matchesFilter(item: any, filter: FieldFilter): boolean {
  if (typeof item !== 'object' || item === null) {
    return false;
  }
  
  for (const [key, condition] of Object.entries(filter)) {
    const value = getNestedValue(item, key);  // Support dot notation like views!
    
    if (typeof condition === 'object' && condition !== null) {
      // Operator-based condition
      for (const [op, expected] of Object.entries(condition)) {
        switch (op) {
          case '$eq':
            if (value !== expected) return false;
            break;
          case '$ne':
            if (value === expected) return false;
            break;
          case '$gt':
            if (!(value > (expected as number))) return false;
            break;
          case '$gte':
            if (!(value >= (expected as number))) return false;
            break;
          case '$lt':
            if (!(value < (expected as number))) return false;
            break;
          case '$lte':
            if (!(value <= (expected as number))) return false;
            break;
          case '$contains':
            // Support both string and array contains (like FilterRetriever!)
            if (Array.isArray(value)) {
              if (!value.includes(expected as string)) return false;
            } else if (typeof value === 'string') {
              if (!value.includes(expected as string)) return false;
            } else {
              return false;
            }
            break;
          case '$startsWith':
            if (typeof value !== 'string' || !value.startsWith(expected as string)) return false;
            break;
          case '$endsWith':
            if (typeof value !== 'string' || !value.endsWith(expected as string)) return false;
            break;
          case '$in':
            if (!Array.isArray(expected) || !expected.includes(value)) return false;
            break;
          case '$nin':
            if (!Array.isArray(expected) || expected.includes(value)) return false;
            break;
          default:
            // Unknown operator, skip
            break;
        }
      }
    } else {
      // Simple equality check
      if (value !== condition) return false;
    }
  }
  
  return true;
}

/**
 * Get nested value from object using dot notation
 * Example: "user.address.city" → obj.user?.address?.city
 * 
 * Matches FilterRetriever logic for consistency!
 */
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((curr, key) => curr?.[key], obj);
}

/**
 * Apply custom transform function
 */
function applyTransform(data: any, transform: (item: any) => any): any {
  if (Array.isArray(data)) {
    return data.map(item => transform(item));
  }
  
  return transform(data);
}

/**
 * Transform input data before storage
 * 
 * @param data - Data to transform
 * @param options - Transform options
 * @returns Transformed data
 */
export function transformInput(data: any, options: NonNullable<SetOptions['inputTransform']>): any {
  let result = data;
  
  // Apply transformations in order
  if (options.where) {
    result = applyWhere(result, options.where);
  }
  
  if (options.pick) {
    result = applyPick(result, options.pick);
  }
  
  if (options.omit) {
    result = applyOmit(result, options.omit);
  }
  
  if (options.transform) {
    result = applyTransform(result, options.transform);
  }
  
  return result;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Process input data (validate + transform)
 * 
 * This is the main entry point called by router.set()
 * 
 * @param data - Data to process
 * @param options - SetOptions with inputValidation/inputTransform
 * @returns Processed data
 */
export async function processInput(data: any, options: SetOptions): Promise<any> {
  let processed = data;
  
  // 1. Apply validation first (may filter in sieve mode)
  if (options.inputValidation) {
    processed = await validateInput(processed, options.inputValidation);
  }
  
  // 2. Apply transformation
  if (options.inputTransform) {
    processed = transformInput(processed, options.inputTransform);
  }
  
  return processed;
}

