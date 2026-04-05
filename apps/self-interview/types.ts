// Self-Interview App Types
// Shared types for the interview system backed by smallstore

// ============================================================================
// Messages & LCM Types
// ============================================================================

export interface StoreMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tokenEstimate: number;
  ts: number;
  /** FK to summary ID that archived this message. null = active. */
  archivedBy: string | null;
}

export interface SummaryNode {
  id: string;
  /** 1 = summary of messages, 2 = summary of summaries, etc. */
  level: number;
  coversMsgIds: string[];
  coversSeqRange: [number, number];
  summaryText: string;
  tokenEstimate: number;
  /** FK to parent summary. null = active (visible in context). */
  parentSummaryId: string | null;
  createdAt: number;
}

export interface LCMStoreData {
  immutable_store: StoreMessage[];
  summary_dag: SummaryNode[];
  created: string;
  updated: string;
}

export interface LCMConfig {
  softThreshold: number;
  hardThreshold: number;
  keepLastN: number;
  chunkSize: number;
  summaryMaxTokens: number;
  maxSummariesInContext: number;
  summarizationPrompt?: string;
}

export const DEFAULT_LCM_CONFIG: LCMConfig = {
  softThreshold: 8000,
  hardThreshold: 16000,
  keepLastN: 8,
  chunkSize: 8,
  summaryMaxTokens: 1024,
  maxSummariesInContext: 5,
  summarizationPrompt:
    "Summarize this interview conversation, preserving ALL key facts, stories, names, dates, " +
    "emotions, quotes, and insights shared by the interviewee. Be faithful to their voice.",
};

// ============================================================================
// Notes Types
// ============================================================================

export interface Note {
  id: number;
  category: string;
  text: string;
  timestamp: string;
  quote?: string;
}

export interface NotesData {
  notes: Note[];
  nextId: number;
  intervieweeName?: string;
  missionSlug: string;
  customMissionContext?: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Session Types
// ============================================================================

export interface SessionMeta {
  name: string;
  missionSlug: string;
  missionName: string;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
  messageCount: number;
  directive?: string;
}

// ============================================================================
// AI Message Types (simplified from agentscape)
// ============================================================================

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ============================================================================
// API Types
// ============================================================================

export interface TurnResponse {
  response: string;
  noteCount: number;
  messageCount: number;
  activeTokens: number;
}
