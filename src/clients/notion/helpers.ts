/**
 * Notion API Key Resolution Helpers
 *
 * Centralized functions for resolving Notion API keys from multiple sources:
 * 1. Direct params (settings)
 * 2. keyResolver (headers/config)
 * 3. Environment variables
 */

import { getEnv } from '../../utils/env.ts';
import { resolveNotionEnv } from '../../../config.ts';

/**
 * Resolve Notion API key (secret/token) from multiple sources
 *
 * Supports multiple key names for backward compatibility:
 * - NOTION_SECRET (official SDK name)
 * - NOTION_API_KEY
 * - NOTION_TOKEN
 *
 * Priority: params > keyResolver > environment
 *
 * @param params - Input parameters that may contain notionSecret, apiKey, or token
 * @param keyResolver - KeyResolver instance from execution context
 * @returns Resolved API key
 * @throws Error if key not found in any source
 */
export function resolveNotionApiKey(
  params: {
    notionSecret?: string;
    apiKey?: string;
    token?: string;
  },
  keyResolver?: any
): string {
  // Try direct params first (highest priority)
  let apiKey = params.notionSecret || params.apiKey || params.token;

  // Try keyResolver (headers/config)
  if (!apiKey && keyResolver) {
    apiKey = keyResolver.getKey?.('NOTION_SECRET') ||
             keyResolver.getKey?.('NOTION_API_KEY') ||
             keyResolver.getKey?.('NOTION_TOKEN');
  }

  // Try environment variables via shared resolver
  if (!apiKey) {
    apiKey = resolveNotionEnv().secret;
  }

  // Validate
  if (!apiKey) {
    throw new Error(
      'Notion API key is required. Set NOTION_SECRET (or NOTION_API_KEY) env var, ' +
      'pass in X-API-Keys header, or provide notionSecret in settings'
    );
  }

  return apiKey;
}

/**
 * Resolve Notion version (optional parameter)
 *
 * @param params - Input parameters that may contain notionVersion
 * @param keyResolver - KeyResolver instance from execution context
 * @returns Resolved API version or default
 */
export function resolveNotionVersion(
  params: { notionVersion?: string },
  keyResolver?: any
): string | undefined {
  let version = params.notionVersion;

  // Try keyResolver
  if (!version && keyResolver) {
    version = keyResolver.getKey?.('NOTION_VERSION');
  }

  // Try environment
  if (!version) {
    version = getEnv('NOTION_VERSION');
  }

  return version; // Can be undefined, will use client default
}

/**
 * Resolve all Notion configuration options at once
 *
 * @param params - Input parameters
 * @param keyResolver - KeyResolver instance from execution context
 * @returns Configuration object with resolved values
 */
export function resolveNotionConfig(
  params: {
    notionSecret?: string;
    apiKey?: string;
    token?: string;
    notionVersion?: string;
  },
  keyResolver?: any
): {
  notionSecret: string;
  notionVersion?: string;
} {
  return {
    notionSecret: resolveNotionApiKey(params, keyResolver),
    notionVersion: resolveNotionVersion(params, keyResolver),
  };
}

/**
 * Clean and extract Notion UUID from various formats
 *
 * Handles:
 * 1. URLs: https://www.notion.so/myworkspace/test-page-2a56478089c6801087aacee3a60a9a9f
 * 2. URLs with query params: https://notion.site/test-page-2a56478089c6801087aacee3a60a9a9f?source=copy_link
 * 3. Prefixed IDs: test-page-2a56478089c6801087aacee3a60a9a9f
 * 4. Old-style UUIDs: 2a564780-89c6-8010-87aa-cee3a60a9a9f
 * 5. New-style UUIDs (32 chars no dashes): 2a56478089c6801087aacee3a60a9a9f
 * 6. Already clean UUIDs: returns as-is
 *
 * @param idOrUrl - Notion ID or URL in any format
 * @returns Clean UUID string (32 chars, no dashes)
 * @throws Error if no valid UUID found or if template string detected
 */
export function cleanNotionId(idOrUrl: string | undefined | null): string {
  if (!idOrUrl) {
    throw new Error('Notion ID is required');
  }

  // Remove whitespace
  const input = idOrUrl.trim();

  // If it's a template string, provide helpful error
  if (input.startsWith('{') && input.endsWith('}')) {
    throw new Error(
      `Template string detected: "${input}". ` +
      `This should have been resolved by the pipeline runner before reaching the Notion client. ` +
      `Check that variables are being substituted correctly. ` +
      `For step references, use {config.pipeline.N.output.id} format (0-based index).`
    );
  }

  // Extract UUID patterns:
  // 1. New-style: 32 hex chars (no dashes)
  // 2. Old-style: UUID format with dashes (8-4-4-4-12)
  // 3. In URLs or with prefixes

  // Try to extract from URL first (if it looks like a URL)
  if (input.includes('notion.so') || input.includes('notion.site') || input.startsWith('http')) {
    // Extract the path part (remove query params)
    const urlPart = input.split('?')[0];

    // Get the last segment of the path
    const segments = urlPart.split('/');
    const lastSegment = segments[segments.length - 1];

    // The ID is typically at the end, after the last dash
    // Format: page-name-2a56478089c6801087aacee3a60a9a9f
    const match = lastSegment.match(/([a-f0-9]{32})$/i);
    if (match) {
      return match[1].toLowerCase().replace(/-/g, '');
    }
  }

  // Try to find old-style UUID with dashes (8-4-4-4-12)
  const uuidMatch = input.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (uuidMatch) {
    // Remove dashes and return lowercase
    return uuidMatch[1].toLowerCase().replace(/-/g, '');
  }

  // Try to find new-style UUID (32 hex chars, possibly with prefix)
  const newStyleMatch = input.match(/([a-f0-9]{32})/i);
  if (newStyleMatch) {
    return newStyleMatch[1].toLowerCase().replace(/-/g, '');
  }

  // If we get here, no valid UUID was found
  throw new Error(`Could not extract valid Notion UUID from: ${input}`);
}

/**
 * Format Notion UUID to old-style format with dashes (8-4-4-4-12)
 * Some older APIs may require this format
 *
 * @param id - Notion ID in any format
 * @returns UUID with dashes in format: 8-4-4-4-12
 * @throws Error if cleanNotionId throws (including template string detection)
 */
export function formatNotionIdWithDashes(idOrUrl: string | undefined | null): string {
  const cleanId = cleanNotionId(idOrUrl);

  // Insert dashes: 8-4-4-4-12
  return `${cleanId.slice(0, 8)}-${cleanId.slice(8, 12)}-${cleanId.slice(12, 16)}-${cleanId.slice(16, 20)}-${cleanId.slice(20, 32)}`;
}

/**
 * Validate if a string contains a valid Notion UUID
 *
 * @param idOrUrl - String to validate
 * @returns True if valid Notion UUID can be extracted
 */
export function isValidNotionId(idOrUrl: string | undefined | null): boolean {
  try {
    cleanNotionId(idOrUrl);
    return true;
  } catch {
    return false;
  }
}
