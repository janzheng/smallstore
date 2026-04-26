/**
 * valtown cron val — generic RSS → smallstore inbox poller
 *
 * Path A poller (per `.brief/rss-as-mailbox.md`). Default config polls
 * bioRxiv neuroscience into the `biorxiv` inbox; override via env to point
 * at any feed.
 *
 * IMPORTANT — bioRxiv specifically is gated by Cloudflare's bot challenge.
 * External pollers (valtown, this script run from your laptop) get 403'd
 * with a CF JS challenge. Path B (the in-Worker pull-runner already running
 * on smallstore.labspace.ai) reaches bioRxiv successfully because Worker →
 * Worker bypasses the bot gate. This val is the right shape for permissive
 * feeds (arXiv, Hacker News, Substack export-as-RSS, podcast feeds, blogs);
 * for bioRxiv specifically, prefer Path B by re-enabling the bioRxiv peers
 * in the registry.
 *
 * Both paths use identical content-addressed IDs, so running both against
 * the same feed dedups cleanly.
 *
 * Deploy on val.town:
 *   1. New cron val
 *   2. Paste this file
 *   3. Env: SMALLSTORE_TOKEN  (smallstore master token, same as deploy/.env)
 *   4. Optional env overrides: FEED_URL, TARGET_INBOX, DEFAULT_LABELS (JSON array)
 *   5. Cron: every 30 min (e.g. "0,30 * * * *")
 *   6. First run: set DRY_RUN=1 to verify parsing without ingesting
 *
 * Smoke-test locally against a permissive feed (won't trip CF challenges):
 *   FEED_URL="https://hnrss.org/frontpage" \
 *   TARGET_INBOX="biorxiv" DRY_RUN=1 \
 *   deno run --allow-net --allow-env examples/valtown-biorxiv-poller.ts
 */

import Parser from "npm:rss-parser";

const FEED_URL = Deno.env.get("FEED_URL") ??
  "https://www.biorxiv.org/rss/subject/neuroscience.xml";
const TARGET_INBOX = Deno.env.get("TARGET_INBOX") ?? "biorxiv";
const DEFAULT_LABELS: string[] = (() => {
  const raw = Deno.env.get("DEFAULT_LABELS");
  if (!raw) return ["neuroscience"];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
})();
const SMALLSTORE_URL = Deno.env.get("SMALLSTORE_URL") ??
  "https://smallstore.labspace.ai";

const parser: any = new Parser({
  timeout: 20_000,
  headers: {
    "User-Agent": "smallstore-rss-poller/1.0 (+https://smallstore.labspace.ai)",
    "Accept": "application/rss+xml, application/xml, text/xml; q=0.9, */*; q=0.8",
  },
});

interface PollSummary {
  feed_url: string;
  target_inbox: string;
  ingested: number;
  skipped: number;
  failed: number;
  errors: string[];
  dry_run: boolean;
  fetch_blocked?: string;
}

async function poll(): Promise<PollSummary> {
  const token = Deno.env.get("SMALLSTORE_TOKEN");
  const dryRun = (Deno.env.get("DRY_RUN") ?? "").length > 0;
  if (!token && !dryRun) {
    throw new Error("SMALLSTORE_TOKEN env var required (or set DRY_RUN=1)");
  }

  const summary: PollSummary = {
    feed_url: FEED_URL,
    target_inbox: TARGET_INBOX,
    ingested: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dry_run: dryRun,
  };

  let feed;
  try {
    feed = await parser.parseURL(FEED_URL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Status code 403|Status code 5\d\d|Non-whitespace before first tag/.test(msg)) {
      summary.fetch_blocked = msg;
      console.log(JSON.stringify(summary));
      return summary;
    }
    throw err;
  }

  const now = new Date().toISOString();
  const threadId = `feed:${(await sha256Hex(FEED_URL)).slice(0, 16)}`;

  for (const entry of feed.items ?? []) {
    const guid = entry.guid ?? entry.link;
    if (!guid) {
      summary.skipped++;
      continue;
    }

    const id = (await sha256Hex(`${FEED_URL}:${guid}`)).slice(0, 32);
    const item = {
      id,
      source: "rss/v1",
      source_version: "rss/v1",
      received_at: now,
      sent_at: entry.pubDate ? new Date(entry.pubDate).toISOString() : undefined,
      summary: entry.title ?? "(no title)",
      body: entry.contentSnippet ?? entry.content ?? null,
      thread_id: threadId,
      labels: DEFAULT_LABELS,
      fields: {
        feed_url: FEED_URL,
        feed_title: feed.title ?? null,
        entry_url: entry.link,
        entry_guid: guid,
        authors: entry.creator ? [entry.creator] : [],
        categories: entry.categories ?? [],
        pub_date: entry.pubDate,
        doi: entry.link?.match(/10\.1101\/[\d.]+/)?.[0],
        preprint_server: FEED_URL.includes("biorxiv.org")
          ? "biorxiv"
          : FEED_URL.includes("arxiv.org")
          ? "arxiv"
          : undefined,
      },
    };

    if (dryRun) {
      console.log(`[dry] ${id}  ${(item.summary as string).slice(0, 80)}`);
      summary.ingested++;
      continue;
    }

    const res = await fetch(`${SMALLSTORE_URL}/inbox/${TARGET_INBOX}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(item),
    });

    if (res.ok) {
      summary.ingested++;
    } else {
      summary.failed++;
      const errBody = await res.text().catch(() => "<no body>");
      summary.errors.push(`${id}: ${res.status} ${errBody.slice(0, 200)}`);
    }
  }

  console.log(JSON.stringify(summary));
  return summary;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default poll;

if (import.meta.main) await poll();
