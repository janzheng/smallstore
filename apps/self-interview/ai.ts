// Shared AI completion function factory
//
// OpenAI-compatible API client used by mod.ts, cli.ts, and test files.
// Supports multiple providers via env vars: DEFAULT_PROVIDER, DEFAULT_MODEL,
// or provider-specific keys (GROQ_API_KEY, OPENAI_API_KEY, NVIDIA_INFERENCE_KEY, etc.)

import type { CompleteFn } from "./lcm.ts";
import type { ChatMessage } from "./types.ts";

// Provider config: name → { envKey, baseUrl, defaultModel }
const PROVIDERS: Record<string, { envKey: string; baseUrl: string; defaultModel: string }> = {
  groq:     { envKey: "GROQ_API_KEY",        baseUrl: "https://api.groq.com/openai/v1",    defaultModel: "moonshotai/kimi-k2-instruct" },
  openai:   { envKey: "OPENAI_API_KEY",       baseUrl: "https://api.openai.com/v1",          defaultModel: "gpt-4o-mini" },
  nvidia:   { envKey: "NVIDIA_INFERENCE_KEY",  baseUrl: "https://inference-api.nvidia.com/v1", defaultModel: "aws/anthropic/bedrock-claude-opus-4-6" },
  anthropic:{ envKey: "ANTHROPIC_API_KEY",     baseUrl: "https://api.anthropic.com/v1",        defaultModel: "claude-sonnet-4-20250514" },
};

/** Resolve which provider to use from env vars + optional config overrides. */
export function resolveProvider(config?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
}): { name: string; apiKey: string; baseUrl: string; model: string } {
  const defaultProviderName = config?.provider || Deno.env.get("DEFAULT_PROVIDER") || "";
  const interviewKey = Deno.env.get("INTERVIEW_API_KEY");

  // 1. Explicit provider name (from config or DEFAULT_PROVIDER)
  if (defaultProviderName && PROVIDERS[defaultProviderName]) {
    const p = PROVIDERS[defaultProviderName];
    return {
      name: defaultProviderName,
      apiKey: config?.apiKey || Deno.env.get(p.envKey) || interviewKey || "",
      baseUrl: (config?.baseUrl || Deno.env.get("INTERVIEW_API_URL") || p.baseUrl).replace(/\/+$/, ""),
      model: config?.model || Deno.env.get("DEFAULT_MODEL") || Deno.env.get("INTERVIEW_MODEL") || p.defaultModel,
    };
  }

  // 2. INTERVIEW_API_KEY + INTERVIEW_API_URL (fully custom endpoint)
  if (config?.apiKey || interviewKey) {
    const key = config?.apiKey || interviewKey || "";
    // Detect groq key by prefix
    const isGroq = key.startsWith("gsk_");
    return {
      name: isGroq ? "groq" : "custom",
      apiKey: key,
      baseUrl: (config?.baseUrl || Deno.env.get("INTERVIEW_API_URL") || (isGroq ? PROVIDERS.groq.baseUrl : PROVIDERS.openai.baseUrl)).replace(/\/+$/, ""),
      model: config?.model || Deno.env.get("DEFAULT_MODEL") || Deno.env.get("INTERVIEW_MODEL") || (isGroq ? PROVIDERS.groq.defaultModel : PROVIDERS.openai.defaultModel),
    };
  }

  // 3. Auto-detect from available API keys (priority order)
  for (const name of ["groq", "nvidia", "openai"]) {
    const p = PROVIDERS[name];
    const key = Deno.env.get(p.envKey);
    if (key) {
      return {
        name,
        apiKey: key,
        baseUrl: (config?.baseUrl || Deno.env.get("INTERVIEW_API_URL") || p.baseUrl).replace(/\/+$/, ""),
        model: config?.model || Deno.env.get("DEFAULT_MODEL") || Deno.env.get("INTERVIEW_MODEL") || p.defaultModel,
      };
    }
  }

  // 4. Nothing configured
  return {
    name: "none",
    apiKey: "",
    baseUrl: (config?.baseUrl || Deno.env.get("INTERVIEW_API_URL") || PROVIDERS.openai.baseUrl).replace(/\/+$/, ""),
    model: config?.model || Deno.env.get("DEFAULT_MODEL") || Deno.env.get("INTERVIEW_MODEL") || "gpt-4o-mini",
  };
}

/**
 * Create a CompleteFn that calls an OpenAI-compatible API directly.
 * Works with Groq, OpenAI, NVIDIA Inference, and any compatible endpoint.
 */
export function createOpenAICompleteFn(config?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
}): CompleteFn {
  const resolved = resolveProvider(config);
  const apiKey = resolved.apiKey;
  const baseUrl = resolved.baseUrl;
  const defaultModel = resolved.model;

  return async (messages, options) => {
    const body: Record<string, unknown> = {
      model: (options as any)?.model || defaultModel,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      temperature: options?.temperature ?? 0.5,
    };

    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    if ((options as any)?.tools) {
      body.tools = (options as any).tools.map((t: any) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = (options as any)?.tool_choice || "auto";
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || null,
      tool_calls: choice?.message?.tool_calls,
    };
  };
}

/**
 * Create the best available CompleteFn.
 * Always uses direct OpenAI-compatible API because the interview engine
 * passes plain JSON Schema tool definitions, which ModelProvider doesn't
 * support (it expects Zod schemas).
 */
export async function createCompleteFn(config?: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<CompleteFn> {
  return createOpenAICompleteFn(config);
}
