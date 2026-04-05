/**
 * Embedding Function Helpers
 *
 * Factory functions for creating embed callbacks compatible with
 * MemoryVectorSearchProvider, ZvecSearchProvider, and MemoryHybridSearchProvider.
 *
 * These are thin wrappers around embedding APIs — they turn text into number[].
 * Configure via constructor options or environment variables.
 *
 * @example
 * ```typescript
 * // HuggingFace (free, default)
 * const embed = createHuggingFaceEmbed();
 *
 * // OpenAI
 * const embed = createOpenAIEmbed({ apiKey: 'sk-...', model: 'text-embedding-3-small' });
 *
 * // Use with any vector search provider
 * const provider = new MemoryVectorSearchProvider({ embed });
 * const zvec = new ZvecSearchProvider({ embed, dimensions: 384 });
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/** An embed function: text in, vector out */
export type EmbedFunction = (text: string) => number[] | Promise<number[]>;

/** An embed function that supports batching */
export type BatchEmbedFunction = (texts: string[]) => Promise<number[][]>;

/** Common config shared by all embedding providers */
export interface EmbedConfig {
  /** API key (falls back to env var) */
  apiKey?: string;
  /** Model name */
  model?: string;
}

// ============================================================================
// HuggingFace Inference API
// ============================================================================

export interface HuggingFaceEmbedConfig extends EmbedConfig {
  /** API key. Falls back to HUGGINGFACE_API_KEY env var. */
  apiKey?: string;
  /** Model ID on HuggingFace. Default: BAAI/bge-small-en-v1.5 (384 dims, free) */
  model?: string;
  /** Base URL for the inference API. Default: https://router.huggingface.co/hf-inference */
  baseUrl?: string;
}

/**
 * Create an embed function using HuggingFace Inference API.
 *
 * Default model: BAAI/bge-small-en-v1.5 (384 dims, free tier)
 *
 * Env vars:
 * - HUGGINGFACE_API_KEY — API token
 * - EMBED_MODEL — override model (optional)
 */
export function createHuggingFaceEmbed(config?: HuggingFaceEmbedConfig): EmbedFunction & { batch: BatchEmbedFunction; model: string; dimensions?: number } {
  const apiKey = config?.apiKey
    || Deno.env.get('HUGGINGFACE_API_KEY')
    || Deno.env.get('HF_TOKEN');
  const model = config?.model
    || Deno.env.get('EMBED_MODEL')
    || 'BAAI/bge-small-en-v1.5';
  const baseUrl = config?.baseUrl
    || Deno.env.get('HF_INFERENCE_URL')
    || 'https://router.huggingface.co/hf-inference';
  const url = `${baseUrl}/models/${model}/pipeline/feature-extraction`;

  if (!apiKey) {
    throw new Error('HuggingFace API key required. Set HUGGINGFACE_API_KEY env var or pass apiKey in config.');
  }

  async function fetchEmbedding(body: { inputs: string | string[] }): Promise<any> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HuggingFace embed error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  const embed = async (text: string): Promise<number[]> => {
    const data = await fetchEmbedding({ inputs: text });
    // HF returns flat array for single input, or nested for batch
    return Array.isArray(data[0]) ? data[0] : data;
  };

  const batch: BatchEmbedFunction = async (texts: string[]): Promise<number[][]> => {
    return await fetchEmbedding({ inputs: texts });
  };

  // Attach batch and metadata
  embed.batch = batch;
  embed.model = model;
  embed.dimensions = KNOWN_DIMENSIONS[model];

  return embed as EmbedFunction & { batch: BatchEmbedFunction; model: string; dimensions?: number };
}

// ============================================================================
// OpenAI Embeddings API
// ============================================================================

export interface OpenAIEmbedConfig extends EmbedConfig {
  /** API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Model name. Default: text-embedding-3-small (1536 dims) */
  model?: string;
  /** Base URL. Default: https://api.openai.com/v1 */
  baseUrl?: string;
}

/**
 * Create an embed function using OpenAI Embeddings API.
 *
 * Default model: text-embedding-3-small (1536 dims)
 *
 * Env vars:
 * - OPENAI_API_KEY — API key
 * - EMBED_MODEL — override model (optional)
 */
export function createOpenAIEmbed(config?: OpenAIEmbedConfig): EmbedFunction & { batch: BatchEmbedFunction; model: string; dimensions?: number } {
  const apiKey = config?.apiKey || Deno.env.get('OPENAI_API_KEY');
  const model = config?.model
    || Deno.env.get('EMBED_MODEL')
    || 'text-embedding-3-small';
  const baseUrl = config?.baseUrl
    || Deno.env.get('OPENAI_BASE_URL')
    || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey in config.');
  }

  async function fetchEmbedding(input: string | string[]): Promise<any> {
    const resp = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input, model }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI embed error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  const embed = async (text: string): Promise<number[]> => {
    const data = await fetchEmbedding(text);
    return data.data[0].embedding;
  };

  const batch: BatchEmbedFunction = async (texts: string[]): Promise<number[][]> => {
    const data = await fetchEmbedding(texts);
    return data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);
  };

  embed.batch = batch;
  embed.model = model;
  embed.dimensions = KNOWN_DIMENSIONS[model];

  return embed as EmbedFunction & { batch: BatchEmbedFunction; model: string; dimensions?: number };
}

// ============================================================================
// Auto-detect: pick the best available embedding provider
// ============================================================================

/**
 * Create an embed function by auto-detecting available API keys.
 *
 * Priority: HUGGINGFACE_API_KEY > OPENAI_API_KEY
 *
 * Override with EMBED_PROVIDER=huggingface|openai
 */
export function createEmbed(config?: EmbedConfig): EmbedFunction & { batch: BatchEmbedFunction; model: string; dimensions?: number } {
  const provider = Deno.env.get('EMBED_PROVIDER');

  if (provider === 'openai' || (!provider && !Deno.env.get('HUGGINGFACE_API_KEY') && !Deno.env.get('HF_TOKEN') && Deno.env.get('OPENAI_API_KEY'))) {
    return createOpenAIEmbed(config);
  }

  // Default to HuggingFace (free)
  return createHuggingFaceEmbed(config);
}

// ============================================================================
// Known model dimensions (for convenience — not exhaustive)
// ============================================================================

const KNOWN_DIMENSIONS: Record<string, number> = {
  // HuggingFace
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-base-en-v1.5': 768,
  'BAAI/bge-large-en-v1.5': 1024,
  'sentence-transformers/all-MiniLM-L6-v2': 384,
  'sentence-transformers/all-mpnet-base-v2': 768,
  'Qwen/Qwen3-Embedding-0.6B': 1024,
  'Qwen/Qwen3-Embedding-8B': 4096,
  // OpenAI
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};
