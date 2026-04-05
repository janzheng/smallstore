/**
 * Adapter Error Framework
 * 
 * Standardized error types for adapter operations.
 * Allows adapters to throw meaningful errors that can be caught and handled
 * by the composition layer or user code.
 */

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base class for all adapter errors
 */
export class AdapterError extends Error {
  constructor(
    public readonly adapterName: string,
    public readonly operation: string,
    message: string,
    public override readonly cause?: Error
  ) {
    super(`[${adapterName}] ${operation}: ${message}`);
    this.name = 'AdapterError';
  }
}

/**
 * Operation not supported by this adapter
 * 
 * @example
 * throw new UnsupportedOperationError('notion', 'merge', 
 *   'Notion stores individual pages, not arrays. Use insert() or upsert() instead.');
 */
export class UnsupportedOperationError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    reason: string,
    public readonly suggestedAlternative?: string
  ) {
    const message = suggestedAlternative
      ? `${reason} Try ${suggestedAlternative} instead.`
      : reason;
    super(adapterName, operation, message);
    this.name = 'UnsupportedOperationError';
  }
}

/**
 * Data type not supported by this adapter
 * 
 * @example
 * throw new UnsupportedDataTypeError('notion', 'set', 'blob', 
 *   'Notion only supports object (structured) data.');
 */
export class UnsupportedDataTypeError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    public readonly dataType: string,
    reason: string
  ) {
    super(adapterName, operation, `Data type '${dataType}' not supported: ${reason}`);
    this.name = 'UnsupportedDataTypeError';
  }
}

/**
 * Adapter configuration error
 * 
 * @example
 * throw new AdapterConfigError('notion', 'init', 
 *   'Missing required schema mappings for database');
 */
export class AdapterConfigError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    message: string
  ) {
    super(adapterName, operation, message);
    this.name = 'AdapterConfigError';
  }
}

/**
 * Adapter rate limit error
 * 
 * @example
 * throw new RateLimitError('notion', 'set', 5, 1000);
 */
export class RateLimitError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    public readonly requestsPerSecond: number,
    public readonly retryAfterMs?: number
  ) {
    const retryMsg = retryAfterMs ? ` Retry after ${retryAfterMs}ms.` : '';
    super(
      adapterName,
      operation,
      `Rate limit exceeded (${requestsPerSecond} req/s).${retryMsg}`
    );
    this.name = 'RateLimitError';
  }
}

/**
 * Data validation error
 * 
 * @example
 * throw new ValidationError('notion', 'set', 
 *   'Missing required field "title"', { field: 'title' });
 */
export class ValidationError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    message: string,
    public readonly details?: Record<string, any>
  ) {
    super(adapterName, operation, message);
    this.name = 'ValidationError';
    if (details) {
      this.message += `\nDetails: ${JSON.stringify(details, null, 2)}`;
    }
  }
}

/**
 * Size limit exceeded error
 * 
 * @example
 * throw new SizeLimitError('upstash', 'set', 2048, 1024);
 */
export class SizeLimitError extends AdapterError {
  constructor(
    adapterName: string,
    operation: string,
    public readonly actualSize: number,
    public readonly maxSize: number
  ) {
    super(
      adapterName,
      operation,
      `Data size ${formatBytes(actualSize)} exceeds limit ${formatBytes(maxSize)}`
    );
    this.name = 'SizeLimitError';
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if error is an adapter error
 */
export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/**
 * Check if error is a specific adapter error type
 */
export function isUnsupportedOperation(error: unknown): error is UnsupportedOperationError {
  return error instanceof UnsupportedOperationError;
}

export function isUnsupportedDataType(error: unknown): error is UnsupportedDataTypeError {
  return error instanceof UnsupportedDataTypeError;
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isSizeLimitError(error: unknown): error is SizeLimitError {
  return error instanceof SizeLimitError;
}

/**
 * Format error for user display
 */
export function formatAdapterError(error: unknown): string {
  if (isAdapterError(error)) {
    let message = error.message;
    
    if (isUnsupportedOperation(error) && error.suggestedAlternative) {
      message += `\n💡 Suggestion: Use ${error.suggestedAlternative}`;
    }
    
    if (isRateLimitError(error) && error.retryAfterMs) {
      message += `\n⏱️  Retry after ${error.retryAfterMs}ms`;
    }
    
    return message;
  }
  
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format bytes for display
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= k && unitIndex < units.length - 1) {
    size /= k;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// ============================================================================
// Convenience Functions for Adapters
// ============================================================================

/**
 * Throw unsupported operation error with helpful message
 */
export function throwUnsupportedOperation(
  adapterName: string,
  operation: string,
  reason: string,
  suggestedAlternative?: string
): never {
  throw new UnsupportedOperationError(adapterName, operation, reason, suggestedAlternative);
}

/**
 * Throw unsupported data type error
 */
export function throwUnsupportedDataType(
  adapterName: string,
  operation: string,
  dataType: string,
  supportedTypes: string[]
): never {
  throw new UnsupportedDataTypeError(
    adapterName,
    operation,
    dataType,
    `Only supports: ${supportedTypes.join(', ')}`
  );
}

/**
 * Throw validation error
 */
export function throwValidationError(
  adapterName: string,
  operation: string,
  message: string,
  details?: Record<string, any>
): never {
  throw new ValidationError(adapterName, operation, message, details);
}

