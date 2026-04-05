#!/usr/bin/env -S deno run --allow-all
/**
 * md-paste server — Markdown Pastebin with Web UI
 *
 * Uses Google Sheets (via Sheetlog) as the database.
 * Requires SHEET_URL or SM_SHEET_URL env var.
 * Needs two sheet tabs: "md-docs" and "md-checkpoints" (create manually first).
 *
 * Run:
 *   deno run --allow-all examples/md-paste/serve.ts
 *   MD_PORT=3333 deno run --allow-all examples/md-paste/serve.ts
 */

import { Hono } from 'hono';
import { Sheetlog } from '../../src/clients/sheetlog/client.ts';
import { createMdPaste } from './core.ts';
import type { MdDoc, Checkpoint } from './core.ts';

// ============================================================================
// Setup
// ============================================================================

const PORT = parseInt(Deno.env.get('MD_PORT') || '4444');

const sheetUrl = Deno.env.get('SHEET_URL') || Deno.env.get('SM_SHEET_URL');
if (!sheetUrl) {
  console.error('Error: SHEET_URL or SM_SHEET_URL env var required.');
  console.error('Set it to your Sheetlog Apps Script URL.');
  Deno.exit(1);
}

const docsClient = new Sheetlog({ sheetUrl, sheet: 'md-docs' });
const checkpointsClient = new Sheetlog({ sheetUrl, sheet: 'md-checkpoints' });
const paste = createMdPaste(docsClient, checkpointsClient);

// ============================================================================
// HTML helpers
// ============================================================================

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, sans-serif; background: #fafafa; color: #1a1a1a; max-width: 720px; margin: 0 auto; padding: 20px; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e0e0e0; margin-bottom: 20px; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header h1 a { color: inherit; }
  .btn { display: inline-block; padding: 6px 14px; border-radius: 6px; border: 1px solid #d0d0d0; background: white; color: #333; font-size: 13px; cursor: pointer; text-decoration: none; }
  .btn:hover { background: #f0f0f0; text-decoration: none; }
  .btn-primary { background: #0066cc; color: white; border-color: #0066cc; }
  .btn-primary:hover { background: #0055aa; }
  .btn-danger { color: #cc3333; border-color: #cc3333; }
  .btn-danger:hover { background: #fff5f5; }
  .btn-sm { padding: 3px 8px; font-size: 12px; }
  textarea, input[type="text"] { width: 100%; padding: 10px; border: 1px solid #d0d0d0; border-radius: 6px; font-family: inherit; font-size: 14px; }
  textarea { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; min-height: 400px; resize: vertical; line-height: 1.6; tab-size: 2; }
  input[type="text"] { margin-bottom: 10px; }
  .doc-list { list-style: none; }
  .doc-list li { padding: 12px 0; border-bottom: 1px solid #eee; }
  .doc-list .title { font-weight: 500; font-size: 15px; }
  .doc-list .meta { font-size: 12px; color: #888; margin-top: 3px; }
  .doc-meta { font-size: 13px; color: #666; margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  .doc-content { background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 24px; line-height: 1.7; font-size: 15px; }
  .doc-content h1 { font-size: 24px; margin: 0 0 12px; }
  .doc-content h2 { font-size: 19px; margin: 20px 0 8px; }
  .doc-content h3 { font-size: 16px; margin: 16px 0 6px; }
  .doc-content p { margin: 8px 0; }
  .doc-content ul, .doc-content ol { margin: 8px 0 8px 24px; }
  .doc-content li { margin: 4px 0; }
  .doc-content pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; margin: 10px 0; }
  .doc-content code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 13px; }
  .doc-content pre code { background: none; padding: 0; }
  .doc-content blockquote { border-left: 3px solid #ddd; padding-left: 14px; color: #666; margin: 10px 0; }
  .doc-content strong { font-weight: 600; }
  .doc-content hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
  .actions { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
  .checkpoint-list { list-style: none; }
  .checkpoint-list li { padding: 8px 12px; border-left: 3px solid #ddd; margin-bottom: 6px; font-size: 13px; }
  .checkpoint-list li.current { border-left-color: #0066cc; background: #f0f7ff; }
  .checkpoint-list .ver { font-weight: 600; }
  .diff-view { background: #fefefe; border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; line-height: 1.6; overflow-x: auto; }
  .diff-add { color: #22863a; background: #f0fff4; }
  .diff-del { color: #cb2431; background: #ffeef0; }
  .diff-ctx { color: #888; }
  .empty { color: #999; font-style: italic; padding: 40px 0; text-align: center; }
  .raw { white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; background: white; border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px; }
  form .form-actions { margin-top: 12px; display: flex; gap: 8px; }
`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — md-paste</title>
<style>${CSS}</style>
</head><body>
<div class="header">
  <h1><a href="/">md-paste</a></h1>
  <a href="/new" class="btn btn-primary">+ New</a>
</div>
${body}
</body></html>`;
}

/** Very basic markdown → HTML (good enough for a toy) */
function renderMd(md: string): string {
  if (!md) return '';
  let html = escHtml(md);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Checkboxes
  html = html.replace(/^- \[x\] (.+)$/gm, '<li style="list-style:none">&#9745; $1</li>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<li style="list-style:none">&#9744; $1</li>');

  // Unordered list items
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Paragraphs (lines not already wrapped in tags)
  html = html.replace(/^(?!<[huplob]|<\/|$)(.+)$/gm, '<p>$1</p>');

  // Clean up blank lines
  html = html.replace(/\n{2,}/g, '\n');

  return html;
}

// ============================================================================
// Routes
// ============================================================================

const app = new Hono();

// ── Index: list all docs ─────────────────────────────────────────────────
app.get('/', async (c) => {
  const docs = await paste.getAllDocs();
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (docs.length === 0) {
    return c.html(layout('Home', `
      <div class="empty">
        No documents yet. <a href="/new">Create one</a>.
      </div>
    `));
  }

  const items = docs.map(d => `
    <li>
      <div class="title"><a href="/${escHtml(d.slug)}">${escHtml(d.title)}</a></div>
      <div class="meta">v${d.version} &middot; ${d.checkpointCount} checkpoint${d.checkpointCount !== 1 ? 's' : ''} &middot; updated ${timeAgo(d.updatedAt)}</div>
    </li>
  `).join('');

  return c.html(layout('Home', `
    <ul class="doc-list">${items}</ul>
  `));
});

// ── New doc form ─────────────────────────────────────────────────────────
app.get('/new', (c) => {
  return c.html(layout('New Document', `
    <form method="POST" action="/new" id="create-form">
      <input type="text" name="title" placeholder="Title" required autofocus>
      <textarea name="content" placeholder="Write your markdown here..."></textarea>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" id="create-btn">Create</button>
        <a href="/" class="btn">Cancel</a>
      </div>
    </form>
    <script>
      document.getElementById('create-form').addEventListener('submit', function() {
        var btn = document.getElementById('create-btn');
        btn.disabled = true;
        btn.textContent = 'Creating…';
        btn.style.opacity = '0.6';
      });
    </script>
  `));
});

app.post('/new', async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title || 'Untitled');
  const content = String(body.content || '');
  const doc = await paste.createDoc(title, content);
  return c.redirect(`/${doc.slug}`);
});

// ── View doc ─────────────────────────────────────────────────────────────
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const doc = await paste.getDoc(slug);
  if (!doc) return c.html(layout('Not Found', '<div class="empty">Document not found.</div>'), 404);

  return c.html(layout(doc.title, `
    <div class="doc-meta">
      <span>v${doc.version}</span>
      <span>${doc.checkpointCount} checkpoint${doc.checkpointCount !== 1 ? 's' : ''}</span>
      <span>updated ${timeAgo(doc.updatedAt)}</span>
      <span>created ${timeAgo(doc.createdAt)}</span>
    </div>
    <div class="actions">
      <a href="/${escHtml(slug)}/edit" class="btn">Edit</a>
      <a href="/${escHtml(slug)}/history" class="btn">History</a>
      <a href="/${escHtml(slug)}/raw" class="btn">Raw</a>
      <form method="POST" action="/${escHtml(slug)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
        <button type="submit" class="btn btn-danger">Delete</button>
      </form>
    </div>
    <div class="doc-content">${renderMd(doc.content)}</div>
  `));
});

// ── Raw markdown ─────────────────────────────────────────────────────────
app.get('/:slug/raw', async (c) => {
  const doc = await paste.getDoc(c.req.param('slug'));
  if (!doc) return c.text('Not found', 404);
  return c.text(doc.content, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

// ── Edit form ────────────────────────────────────────────────────────────
app.get('/:slug/edit', async (c) => {
  const slug = c.req.param('slug');
  const doc = await paste.getDoc(slug);
  if (!doc) return c.html(layout('Not Found', '<div class="empty">Document not found.</div>'), 404);

  return c.html(layout(`Edit: ${doc.title}`, `
    <form method="POST" action="/${escHtml(slug)}/edit" id="edit-form">
      <input type="text" name="title" value="${escHtml(doc.title)}" required>
      <textarea name="content" autofocus>${escHtml(doc.content)}</textarea>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" id="save-btn">Save checkpoint</button>
        <a href="/${escHtml(slug)}" class="btn">Cancel</a>
      </div>
    </form>
    <div style="margin-top: 10px; font-size: 12px; color: #888;">
      Currently v${doc.version} &middot; saving will create v${doc.version + 1}
    </div>
    <script>
      document.getElementById('edit-form').addEventListener('submit', function() {
        var btn = document.getElementById('save-btn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        btn.style.opacity = '0.6';
      });
    </script>
  `));
});

app.post('/:slug/edit', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.parseBody();
  const content = String(body.content || '');
  const title = String(body.title || '');
  await paste.saveCheckpoint(slug, content, title || undefined);
  return c.redirect(`/${slug}`);
});

// ── Checkpoint history ───────────────────────────────────────────────────
app.get('/:slug/history', async (c) => {
  const slug = c.req.param('slug');
  const doc = await paste.getDoc(slug);
  if (!doc) return c.html(layout('Not Found', '<div class="empty">Document not found.</div>'), 404);

  const checkpoints = await paste.getCheckpoints(slug);

  const items = checkpoints.map((cp, i) => {
    const isCurrent = cp.version === doc.version;
    const delta = cp.bytesDelta >= 0 ? `+${cp.bytesDelta}` : `${cp.bytesDelta}`;
    const diffLink = i > 0
      ? ` &middot; <a href="/${escHtml(slug)}/diff/${checkpoints[i - 1].version}/${cp.version}">diff from v${checkpoints[i - 1].version}</a>`
      : '';
    return `
      <li class="${isCurrent ? 'current' : ''}">
        <span class="ver">v${cp.version}</span> &middot;
        ${escHtml(cp.title)} &middot;
        ${delta} bytes &middot;
        ${timeAgo(cp.savedAt)}
        ${isCurrent ? ' (current)' : ''}
        ${diffLink}
        &middot; <a href="/${escHtml(slug)}/version/${cp.version}">view</a>
      </li>`;
  }).reverse().join('');

  return c.html(layout(`History: ${doc.title}`, `
    <div class="actions">
      <a href="/${escHtml(slug)}" class="btn">&larr; Back</a>
    </div>
    <h2 style="margin: 12px 0 8px; font-size: 16px;">${checkpoints.length} checkpoints</h2>
    <ul class="checkpoint-list">${items}</ul>
  `));
});

// ── View specific version ────────────────────────────────────────────────
app.get('/:slug/version/:v', async (c) => {
  const slug = c.req.param('slug');
  const v = parseInt(c.req.param('v'));
  const checkpoints = await paste.getCheckpoints(slug);
  const cp = checkpoints.find(cp => cp.version === v);
  if (!cp) return c.html(layout('Not Found', '<div class="empty">Version not found.</div>'), 404);

  return c.html(layout(`v${v}: ${cp.title}`, `
    <div class="doc-meta">
      <span>v${cp.version}</span>
      <span>saved ${timeAgo(cp.savedAt)}</span>
    </div>
    <div class="actions">
      <a href="/${escHtml(slug)}/history" class="btn">&larr; History</a>
      <a href="/${escHtml(slug)}" class="btn">Current</a>
    </div>
    <div class="doc-content">${renderMd(cp.content)}</div>
  `));
});

// ── Diff view ────────────────────────────────────────────────────────────
app.get('/:slug/diff/:v1/:v2', async (c) => {
  const slug = c.req.param('slug');
  const v1 = parseInt(c.req.param('v1'));
  const v2 = parseInt(c.req.param('v2'));

  try {
    const diffLines = await paste.diffVersions(slug, v1, v2);
    const doc = await paste.getDoc(slug);

    const diffHtml = diffLines.length === 0
      ? '<div class="diff-ctx">No changes.</div>'
      : diffLines.map(line => {
          if (line.startsWith('+ ')) return `<div class="diff-add">${escHtml(line)}</div>`;
          if (line.startsWith('- ')) return `<div class="diff-del">${escHtml(line)}</div>`;
          return `<div class="diff-ctx">${escHtml(line)}</div>`;
        }).join('');

    return c.html(layout(`Diff v${v1} → v${v2}: ${doc?.title || slug}`, `
      <div class="actions">
        <a href="/${escHtml(slug)}/history" class="btn">&larr; History</a>
        <a href="/${escHtml(slug)}/version/${v1}" class="btn">v${v1}</a>
        <a href="/${escHtml(slug)}/version/${v2}" class="btn">v${v2}</a>
      </div>
      <h2 style="margin: 12px 0 8px; font-size: 16px;">v${v1} &rarr; v${v2} &middot; ${diffLines.length} changed lines</h2>
      <div class="diff-view">${diffHtml}</div>
    `));
  } catch (e) {
    return c.html(layout('Diff Error', `<div class="empty">${escHtml((e as Error).message)}</div>`), 400);
  }
});

// ── Delete ───────────────────────────────────────────────────────────────
app.post('/:slug/delete', async (c) => {
  await paste.deleteDoc(c.req.param('slug'));
  return c.redirect('/');
});

// ── JSON API (bonus) ─────────────────────────────────────────────────────
app.get('/api/docs', async (c) => {
  const docs = await paste.getAllDocs();
  return c.json(docs);
});

app.get('/api/docs/:slug', async (c) => {
  const doc = await paste.getDoc(c.req.param('slug'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json(doc);
});

app.get('/api/docs/:slug/checkpoints', async (c) => {
  const cps = await paste.getCheckpoints(c.req.param('slug'));
  return c.json(cps);
});

// ============================================================================
// Start
// ============================================================================

console.log(`
  md-paste server
  http://localhost:${PORT}

  Routes:
    GET  /                    Document list
    GET  /new                 Create form
    GET  /:slug               View document
    GET  /:slug/edit          Edit form
    GET  /:slug/history       Checkpoint history
    GET  /:slug/diff/:v1/:v2  Diff between versions
    GET  /:slug/raw           Raw markdown
    GET  /api/docs            JSON API
`);

Deno.serve({ port: PORT }, app.fetch);
