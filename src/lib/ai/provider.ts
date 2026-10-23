import "server-only";

// Provider-neutral chat types. Swap the model vendor by adding an adapter.

// `signature` is opaque provider data that must be echoed back (Gemini thought signatures).
export type Block =
  | { type: "text"; text: string; signature?: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; signature?: string }
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatResponse {
  content: Block[];
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
}

export interface ChatProvider {
  readonly name: string;
  chat(req: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<ChatResponse>;
  /** Read an image and reply with text (JSON when asked). */
  vision?(req: { system: string; prompt: string; image: { mime: string; base64: string } }): Promise<string>;
}

/** Gemini models tried in order when the main one is busy. Override with HARU_AI_FALLBACK_MODELS (comma-separated). */
export const DEFAULT_GEMINI_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];

export class ProviderUnavailable extends Error {}

export function aiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * Picks the provider from the environment. HARU_AI_PROVIDER ("gemini" | "anthropic")
 * forces one; otherwise Gemini is used when GEMINI_API_KEY is set, then Anthropic.
 */
export async function getProvider(): Promise<ChatProvider> {
  const forced = process.env.HARU_AI_PROVIDER?.toLowerCase();
  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (gemini && forced !== "anthropic") {
    const { GeminiProvider } = await import("./gemini");
    const fallbacks = process.env.HARU_AI_FALLBACK_MODELS != null ? process.env.HARU_AI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_GEMINI_FALLBACKS;
    return new GeminiProvider(gemini, process.env.HARU_AI_MODEL || "gemini-3.8-flash", fetch, { fallbacks });
  }
  if (anthropic && forced !== "gemini") {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider(anthropic, process.env.HARU_AI_MODEL || "claude-sonnet-5-5");
  }
  throw new ProviderUnavailable("No AI provider is configured. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to the server environment.");
}
