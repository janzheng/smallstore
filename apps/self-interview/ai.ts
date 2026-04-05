// Shared AI completion function factory
//
// OpenAI-compatible API client used by mod.ts, cli.ts, and test files.

import type { CompleteFn } from "./lcm.ts";
import type { ChatMessage } from "./types.ts";

/**
 * Create a CompleteFn that calls an OpenAI-compatible API directly.
 * Works with Groq, OpenAI, and any compatible endpoint.
 */
export function createOpenAICompleteFn(config?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): CompleteFn {
  const groqKey = Deno.env.get("GROQ_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const interviewKey = Deno.env.get("INTERVIEW_API_KEY");
  const useGroq = !!(config?.apiKey?.startsWith("gsk_") || (!config?.apiKey && !interviewKey && groqKey));

  const apiKey = config?.apiKey || interviewKey || groqKey || openaiKey || "";
  const baseUrl = (config?.baseUrl ||
    Deno.env.get("INTERVIEW_API_URL") ||
    (useGroq ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1")
  ).replace(/\/+$/, "");
  const defaultModel = config?.model ||
    Deno.env.get("INTERVIEW_MODEL") ||
    (useGroq ? "llama-3.3-70b-versatile" : "gpt-4o-mini");

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
