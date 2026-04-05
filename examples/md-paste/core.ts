/**
 * md-paste core — document CRUD, checkpoints, and diffs
 *
 * Uses Sheetlog (Google Sheets) as the primary database.
 * Two sheet tabs:
 *   - md-docs: one row per document (upserted by slug)
 *   - md-checkpoints: one row per checkpoint (append-only)
 *
 * Shared between the demo script (mod.ts) and the web server (serve.ts).
 */

import type { Sheetlog } from '../../src/clients/sheetlog/client.ts';

// ============================================================================
// Types
// ============================================================================

export interface MdDoc {
  id: string;
  slug: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  checkpointCount: number;
}

export interface Checkpoint {
  slug: string;
  version: number;
  content: string;
  title: string;
  savedAt: string;
  bytesDelta: number;
}

// ============================================================================
// Helpers
// ============================================================================

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function now(): string {
  return new Date().toISOString();
}

/** Parse a sheetlog find/get result into row(s) */
function extractRows(result: any): any[] {
  if (!result) return [];
  // find() returns { data: row } or { data: [rows] }
  // get() returns { data: [rows] }
  const d = result.data;
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

/** Sheets returns everything as strings — coerce numeric fields */
function parseDoc(row: any): MdDoc | null {
  if (!row || !row.slug) return null;
  return {
    ...row,
    version: Number(row.version) || 1,
    checkpointCount: Number(row.checkpointCount) || 1,
  };
}

function parseCheckpoint(row: any): Checkpoint {
  return {
    ...row,
    version: Number(row.version) || 1,
    bytesDelta: Number(row.bytesDelta) || 0,
  };
}

// ============================================================================
// Core operations
// ============================================================================

export function createMdPaste(docsClient: Sheetlog, checkpointsClient: Sheetlog) {

  async function createDoc(title: string, content: string): Promise<MdDoc> {
    const id = randomId();
    const s = slugify(title) || id;
    const doc: MdDoc = {
      id, slug: s, title, content,
      createdAt: now(), updatedAt: now(),
      version: 1, checkpointCount: 1,
    };

    await docsClient.dynamicPost(doc);

    const cp: Checkpoint = {
      slug: s, version: 1, content, title,
      savedAt: doc.createdAt,
      bytesDelta: new TextEncoder().encode(content).length,
    };
    await checkpointsClient.dynamicPost(cp);

    return doc;
  }

  async function saveCheckpoint(docSlug: string, newContent: string, newTitle?: string): Promise<{ doc: MdDoc; checkpoint: Checkpoint }> {
    const existing = await getDoc(docSlug);
    if (!existing) throw new Error(`Doc not found: ${docSlug}`);

    const doc = existing;
    const prevContent = doc.content;
    const nextVersion = doc.version + 1;

    doc.content = newContent;
    doc.title = newTitle || doc.title;
    doc.updatedAt = now();
    doc.version = nextVersion;
    doc.checkpointCount += 1;

    // Upsert doc row by slug
    await docsClient.upsert('slug', docSlug, doc);

    const cp: Checkpoint = {
      slug: docSlug, version: nextVersion, content: newContent, title: doc.title,
      savedAt: doc.updatedAt,
      bytesDelta: new TextEncoder().encode(newContent).length - new TextEncoder().encode(prevContent).length,
    };
    await checkpointsClient.dynamicPost(cp);

    return { doc, checkpoint: cp };
  }

  async function getDoc(docSlug: string): Promise<MdDoc | null> {
    try {
      const result = await docsClient.find('slug', docSlug);
      const rows = extractRows(result);
      return parseDoc(rows[0]);
    } catch { return null; }
  }

  async function getCheckpoints(docSlug: string): Promise<Checkpoint[]> {
    try {
      const result = await checkpointsClient.find('slug', docSlug, true);
      const rows = extractRows(result);
      return rows.map(parseCheckpoint);
    } catch { return []; }
  }

  async function listDocs(): Promise<string[]> {
    try {
      const result = await docsClient.get();
      const rows = extractRows(result);
      return rows.map((r: any) => r.slug).filter(Boolean);
    } catch { return []; }
  }

  async function getAllDocs(): Promise<MdDoc[]> {
    try {
      const result = await docsClient.get();
      const rows = extractRows(result);
      return rows.map(parseDoc).filter((d): d is MdDoc => d !== null);
    } catch { return []; }
  }

  async function deleteDoc(docSlug: string): Promise<void> {
    // Find and delete doc row
    try {
      const docResult = await docsClient.find('slug', docSlug);
      const docRows = extractRows(docResult);
      if (docRows[0]?._id) await docsClient.delete(docRows[0]._id);
    } catch (e) {
      console.warn(`[delete] doc row: ${(e as Error).message}`);
    }

    // Find and delete all checkpoint rows
    try {
      const cpResult = await checkpointsClient.find('slug', docSlug, true);
      const cpRows = extractRows(cpResult);
      const ids = cpRows.map((r: any) => r._id).filter(Boolean);
      if (ids.length > 0) await checkpointsClient.bulkDelete(ids);
    } catch (e) {
      console.warn(`[delete] checkpoint rows: ${(e as Error).message}`);
    }
  }

  function simpleDiff(oldText: string, newText: string): string[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const diffs: string[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const ol = oldLines[i];
      const nl = newLines[i];
      if (ol === undefined) diffs.push(`+ ${nl}`);
      else if (nl === undefined) diffs.push(`- ${ol}`);
      else if (ol !== nl) { diffs.push(`- ${ol}`); diffs.push(`+ ${nl}`); }
    }
    return diffs;
  }

  async function diffVersions(docSlug: string, v1: number, v2: number): Promise<string[]> {
    const cps = await getCheckpoints(docSlug);
    const cp1 = cps.find(c => c.version === v1);
    const cp2 = cps.find(c => c.version === v2);
    if (!cp1 || !cp2) throw new Error(`Version not found: v${v1} or v${v2}`);
    return simpleDiff(cp1.content, cp2.content);
  }

  return { createDoc, saveCheckpoint, getDoc, getCheckpoints, listDocs, getAllDocs, deleteDoc, simpleDiff, diffVersions };
}
