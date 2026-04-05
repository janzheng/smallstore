/**
 * Smallstore Express Integration (Stub)
 *
 * Adapter for using Smallstore HTTP handlers with Express framework.
 *
 * NOTE: This is a stub implementation. Full implementation can be added
 * when Express support is needed.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createSmallstore } from '@smallstore/mod.ts';
 * import { createExpressRouter } from '@smallstore/http/integrations/express.ts';
 *
 * const app = express();
 * const smallstore = createSmallstore({ ... });
 *
 * app.use('/api/smallstore', createExpressRouter(smallstore));
 * ```
 */

import type { SmallstoreRequest, SmallstoreResponse, SmallstoreInstance } from '../types.ts';
import * as handlers from '../handlers.ts';

// Type definitions for Express (to avoid hard dependency)
interface ExpressRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(data: any): void;
  set(key: string, value: string): ExpressResponse;
}

type ExpressNextFunction = () => void;

interface ExpressRouter {
  get(path: string, handler: any): ExpressRouter;
  post(path: string, handler: any): ExpressRouter;
  put(path: string, handler: any): ExpressRouter;
  patch(path: string, handler: any): ExpressRouter;
  delete(path: string, handler: any): ExpressRouter;
}

// ============================================================================
// Request Conversion
// ============================================================================

/**
 * Convert Express Request to SmallstoreRequest
 */
function expressToRequest(req: ExpressRequest): SmallstoreRequest {
  // Convert headers to lowercase
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key.toLowerCase()] = value;
    }
  }

  // Convert query params to strings
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') {
      query[key] = value;
    }
  }

  return {
    method: req.method,
    path: req.path,
    params: req.params || {},
    query,
    body: req.body,
    headers,
  };
}

/**
 * Send SmallstoreResponse via Express Response
 */
function sendResponse(res: ExpressResponse, response: SmallstoreResponse): void {
  // Set custom headers if provided
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      res.set(key, value);
    }
  }

  res.status(response.status).json(response.body);
}

// ============================================================================
// Router Factory
// ============================================================================

/**
 * Create Express router for Smallstore
 *
 * NOTE: This is a stub. Full implementation requires express as a dependency.
 *
 * @param smallstore - Smallstore instance
 * @returns Express router with all Smallstore routes
 */
export function createExpressRouter(smallstore: SmallstoreInstance): ExpressRouter {
  // This is a stub - actual implementation would use express.Router()
  throw new Error(
    'Express integration is not yet fully implemented. ' +
    'Please use the Hono integration or implement the Express adapter.'
  );
}

/**
 * Express middleware factory for Smallstore
 *
 * Creates middleware that adds smallstore to request.
 */
export function smallstoreMiddleware(smallstore: SmallstoreInstance) {
  return (req: any, _res: ExpressResponse, next: ExpressNextFunction) => {
    req.smallstore = smallstore;
    next();
  };
}

// ============================================================================
// Handler Wrappers (for custom Express integration)
// ============================================================================

/**
 * Wrap a Smallstore handler for Express
 *
 * Use this to create Express route handlers manually.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { wrapHandler, handleGet } from '@smallstore/http';
 *
 * const router = express.Router();
 * const smallstore = createSmallstore({ ... });
 *
 * router.get('/:collection', wrapHandler(handleGet, smallstore));
 * ```
 */
export function wrapHandler(
  handler: (req: SmallstoreRequest, ss: SmallstoreInstance) => Promise<SmallstoreResponse>,
  smallstore: SmallstoreInstance
) {
  return async (req: ExpressRequest, res: ExpressResponse) => {
    const request = expressToRequest(req);
    const response = await handler(request, smallstore);
    sendResponse(res, response);
  };
}

// Export handlers for manual route setup
export { handlers };
