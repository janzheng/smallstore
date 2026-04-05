// Lossless Context Management (LCM) backed by smallstore
//
// Ports the core LCM paper implementation to use smallstore for persistence.
// Each session stores its message log + summary DAG as a single collection entry.

import type {
  StoreMessage,
  SummaryNode,
  LCMStoreData,
  LCMConfig,
  ChatMessage,
} from "./types.ts";
import { DEFAULT_LCM_CONFIG } from "./types.ts";

// ============================================================================
// Token estimation
// ============================================================================

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}

// ============================================================================
// BM25 Search
// ============================================================================

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function bm25Rank(
  query: string,
  documents: string[],
): Array<{ index: number; score: number }> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const N = documents.length;
  const docTokens = documents.map(tokenize);
  const avgdl = docTokens.reduce((sum, d) => sum + d.length, 0) / N;

  const df = new Map<string, number>();
  for (const term of queryTerms) {
    if (df.has(term)) continue;
    let count = 0;
    for (const doc of docTokens) {
      if (doc.includes(term)) count++;
    }
    df.set(term, count);
  }

  const scores: Array<{ index: number; score: number }> = [];

  for (let i = 0; i < N; i++) {
    const dl = docTokens[i].length;
    if (dl === 0) continue;

    const tf = new Map<string, number>();
    for (const token of docTokens[i]) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const n = df.get(term) || 0;
      const f = tf.get(term) || 0;
      if (f === 0) continue;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl)));
    }

    if (score > 0) scores.push({ index: i, score });
  }

  return scores.sort((a, b) => b.score - a.score);
}

// ============================================================================
// LCMStore — in-memory with smallstore persistence
// ============================================================================

function generateId(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

export class LCMStore {
  private data: LCMStoreData;
  private nextMsgSeq = 1;
  private nextSumSeq = 1;

  constructor(initial?: LCMStoreData) {
    this.data = initial || LCMStore.emptyData();
    this._restoreCounters();
  }

  static emptyData(): LCMStoreData {
    return {
      immutable_store: [],
      summary_dag: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }

  private _restoreCounters(): void {
    if (this.data.immutable_store.length > 0) {
      this.nextMsgSeq = Math.max(...this.data.immutable_store.map((m) => m.seq)) + 1;
    }
    if (this.data.summary_dag.length > 0) {
      const maxSumSeq = Math.max(
        ...this.data.summary_dag.map((s) => parseInt(s.id.split("-")[1]) || 0),
      );
      this.nextSumSeq = maxSumSeq + 1;
    }
  }

  /** Export data for persistence to smallstore */
  toJSON(): LCMStoreData {
    this.data.updated = new Date().toISOString();
    return this.data;
  }

  /** Load from smallstore data */
  static fromJSON(data: LCMStoreData): LCMStore {
    return new LCMStore(data);
  }

  // ---------- Immutable Store ----------

  appendMessage(role: StoreMessage["role"], content: string): StoreMessage {
    const msg: StoreMessage = {
      id: generateId("msg", this.nextMsgSeq),
      seq: this.nextMsgSeq,
      role,
      content,
      tokenEstimate: estimateTokens(content),
      ts: Date.now(),
      archivedBy: null,
    };
    this.nextMsgSeq++;
    this.data.immutable_store.push(msg);
    return msg;
  }

  getActiveMessages(): StoreMessage[] {
    return this.data.immutable_store.filter((m) => m.archivedBy === null);
  }

  /** Get all messages (active + archived) sorted by sequence */
  getAllMessages(): StoreMessage[] {
    return [...this.data.immutable_store].sort((a, b) => a.seq - b.seq);
  }

  archiveMessages(msgIds: string[], summaryId: string): void {
    for (const msg of this.data.immutable_store) {
      if (msgIds.includes(msg.id) && msg.archivedBy === null) {
        msg.archivedBy = summaryId;
      }
    }
  }

  // ---------- Summary DAG ----------

  addSummary(
    level: number,
    coversMsgIds: string[],
    summaryText: string,
    parentSummaryId: string | null = null,
  ): SummaryNode {
    const seqs = coversMsgIds
      .map((id) => this.data.immutable_store.find((m) => m.id === id)?.seq)
      .filter((s): s is number => s !== undefined);

    const node: SummaryNode = {
      id: generateId("sum", this.nextSumSeq),
      level,
      coversMsgIds,
      coversSeqRange: seqs.length > 0
        ? [Math.min(...seqs), Math.max(...seqs)]
        : [0, 0],
      summaryText,
      tokenEstimate: estimateTokens(summaryText),
      parentSummaryId,
      createdAt: Date.now(),
    };

    this.nextSumSeq++;
    this.data.summary_dag.push(node);
    return node;
  }

  getActiveSummaries(): SummaryNode[] {
    return this.data.summary_dag.filter((s) => s.parentSummaryId === null);
  }

  consumeSummaries(summaryIds: string[], parentId: string): void {
    for (const node of this.data.summary_dag) {
      if (summaryIds.includes(node.id)) {
        node.parentSummaryId = parentId;
      }
    }
  }

  // ---------- Search ----------

  grep(
    query: string,
    options?: { mode?: "regex" | "bm25"; limit?: number },
  ): Array<{ message: StoreMessage; matchContext: string; score?: number }> {
    const mode = options?.mode || "bm25";
    const limit = options?.limit || 10;

    if (!query || query.trim().length === 0) return [];

    if (mode === "bm25") {
      const messages = this.data.immutable_store;
      const documents = messages.map((m) => m.content);
      const ranked = bm25Rank(query, documents);

      return ranked.slice(0, limit).map(({ index, score }) => {
        const msg = messages[index];
        const queryTerms = query.toLowerCase().split(/\s+/);
        let bestIdx = 0;
        for (const term of queryTerms) {
          const idx = msg.content.toLowerCase().indexOf(term);
          if (idx !== -1) { bestIdx = idx; break; }
        }
        const start = Math.max(0, bestIdx - 100);
        const end = Math.min(msg.content.length, bestIdx + 100);
        return { message: msg, matchContext: msg.content.slice(start, end), score };
      });
    }

    // Regex/substring mode
    const lowerQuery = query.toLowerCase();
    const results: Array<{ message: StoreMessage; matchContext: string }> = [];

    for (const msg of this.data.immutable_store) {
      const idx = msg.content.toLowerCase().indexOf(lowerQuery);
      if (idx !== -1) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(msg.content.length, idx + query.length + 100);
        results.push({ message: msg, matchContext: msg.content.slice(start, end) });
      }
    }
    return results;
  }

  // ---------- Stats ----------

  getStats() {
    const allMsgs = this.data.immutable_store;
    const active = allMsgs.filter((m) => m.archivedBy === null);
    const activeSums = this.data.summary_dag.filter((s) => s.parentSummaryId === null);

    return {
      totalMessages: allMsgs.length,
      activeMessages: active.length,
      archivedMessages: allMsgs.length - active.length,
      summaryNodes: this.data.summary_dag.length,
      activeSummaries: activeSums.length,
      activeTokens:
        active.reduce((sum, m) => sum + m.tokenEstimate, 0) +
        activeSums.reduce((sum, s) => sum + s.tokenEstimate, 0),
    };
  }
}

// ============================================================================
// Context Assembly
// ============================================================================

/** Strip LCM scaffolding markers from text */
export function stripScaffolding(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<function=\w+>[\s\S]*?<\/function>/g, "")
    .replace(/\[sum-\d+[^\]]*\][^\n]*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip <think> tokens from model output */
export function stripThinkTokens(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Assemble context window from store state */
export function assembleContext(
  store: LCMStore,
  systemPrompt: string,
  maxSummaries = 5,
): { messages: ChatMessage[]; totalTokens: number } {
  const activeSummaries = store.getActiveSummaries();
  const activeMessages = store.getActiveMessages();

  let systemContent = systemPrompt;

  if (activeSummaries.length > 0) {
    const sorted = [...activeSummaries].sort(
      (a, b) => a.coversSeqRange[0] - b.coversSeqRange[0],
    );

    const limit = maxSummaries > 0 ? maxSummaries : sorted.length;
    const visible = sorted.slice(-limit);
    const hidden = sorted.length - visible.length;

    systemContent += "\n\n## Earlier Conversation (Summaries)\n";

    if (hidden > 0) {
      systemContent += `(${hidden} older summaries available via lcm_grep search)\n`;
    }

    for (const sum of visible) {
      systemContent += `[${sum.id}, msgs ${sum.coversSeqRange[0]}-${sum.coversSeqRange[1]}]: ${sum.summaryText}\n`;
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
  ];

  for (const msg of activeMessages) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role !== "system" && prev.role === msg.role) {
      prev.content += `\n\n${msg.content}`;
    } else {
      messages.push({ role: msg.role as ChatMessage["role"], content: msg.content });
    }
  }

  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : ""),
    0,
  );

  return { messages, totalTokens };
}

// ============================================================================
// Summarization
// ============================================================================

/** AI completion function type — injected to avoid coupling to a specific provider */
export type CompleteFn = (
  messages: ChatMessage[],
  options?: { model?: string; temperature?: number; maxTokens?: number },
) => Promise<{ content: string | null }>;

/** Run incremental summarization if active messages exceed threshold */
export async function runIncrementalSummarization(
  store: LCMStore,
  complete: CompleteFn,
  config: LCMConfig = DEFAULT_LCM_CONFIG,
): Promise<{ summarized: boolean; summaryId?: string }> {
  const active = store.getActiveMessages();

  if (active.length <= config.keepLastN + config.chunkSize) {
    return { summarized: false };
  }

  const chunk = active.slice(0, config.chunkSize);
  const msgText = chunk.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  const prompt = config.summarizationPrompt || DEFAULT_LCM_CONFIG.summarizationPrompt!;

  try {
    const response = await complete(
      [
        { role: "system", content: prompt },
        { role: "user", content: msgText },
      ],
      { temperature: 0.1, maxTokens: config.summaryMaxTokens },
    );

    if (response.content) {
      const msgIds = chunk.map((m) => m.id);
      const sanitized = stripScaffolding(response.content);
      const summaryNode = store.addSummary(1, msgIds, sanitized);
      store.archiveMessages(msgIds, summaryNode.id);

      // Proactive compaction: compact 3+ L1 summaries into L2
      const activeSummaries = store.getActiveSummaries();
      const level1Nodes = activeSummaries
        .filter((s) => s.level === 1)
        .sort((a, b) => a.coversSeqRange[0] - b.coversSeqRange[0]);

      if (level1Nodes.length >= 3) {
        const toCompact = level1Nodes.slice(0, -1);
        const sumText = toCompact.map((s) => s.summaryText).join("\n---\n");

        try {
          const compactResponse = await complete(
            [
              { role: "system", content: prompt },
              { role: "user", content: sumText },
            ],
            { temperature: 0.1, maxTokens: config.summaryMaxTokens },
          );

          if (compactResponse.content) {
            const allCoveredMsgIds = toCompact.flatMap((s) => s.coversMsgIds);
            const sanitizedCompact = stripScaffolding(compactResponse.content);
            const level2Node = store.addSummary(2, allCoveredMsgIds, sanitizedCompact);
            store.consumeSummaries(toCompact.map((s) => s.id), level2Node.id);
          }
        } catch {
          // Not fatal — escalation is the safety net
        }
      }

      return { summarized: true, summaryId: summaryNode.id };
    }
  } catch (error) {
    console.error("[LCM] Incremental summarization failed:", (error as Error).message);
  }

  return { summarized: false };
}

/** Escalation protocol — safety net when incremental isn't enough */
export async function runEscalationProtocol(
  store: LCMStore,
  complete: CompleteFn,
  systemPrompt: string,
  config: LCMConfig = DEFAULT_LCM_CONFIG,
): Promise<{ escalationLevel: number }> {
  const { totalTokens } = assembleContext(store, systemPrompt, 0);

  if (totalTokens < config.softThreshold) {
    return { escalationLevel: 0 };
  }

  const prompt = config.summarizationPrompt || DEFAULT_LCM_CONFIG.summarizationPrompt!;

  // Level 1: LLM compaction
  try {
    const active = store.getActiveMessages();
    const toSummarize = active.slice(0, -config.keepLastN);

    if (toSummarize.length >= 2) {
      const msgText = toSummarize.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
      const response = await complete(
        [
          { role: "system", content: prompt },
          { role: "user", content: msgText },
        ],
        { temperature: 0.1, maxTokens: config.summaryMaxTokens },
      );

      if (response.content) {
        const msgIds = toSummarize.map((m) => m.id);
        const sanitized = stripScaffolding(response.content);
        const summaryNode = store.addSummary(1, msgIds, sanitized);
        store.archiveMessages(msgIds, summaryNode.id);
      }
    }

    const { totalTokens: newTotal } = assembleContext(store, systemPrompt, 0);
    if (newTotal < config.hardThreshold) {
      return { escalationLevel: 1 };
    }
  } catch (error) {
    console.error("[LCM] Level 1 escalation failed:", (error as Error).message);
  }

  // Level 2: Deterministic fallback
  const active = store.getActiveMessages();
  if (active.length > config.keepLastN) {
    const toArchive = active.slice(0, -config.keepLastN);
    const msgIds = toArchive.map((m) => m.id);
    const deterministicSummary = toArchive
      .map((m) => `${m.role}: ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`)
      .join(" | ");

    const summaryNode = store.addSummary(1, msgIds, `(Deterministic fallback) ${deterministicSummary}`);
    store.archiveMessages(msgIds, summaryNode.id);
  }

  return { escalationLevel: 2 };
}
