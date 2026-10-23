import "server-only";

// Provider-neutral chat types. Swap the model vendor by adding an adapter.

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
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
}

export class ProviderUnavailable extends Error {}

export async function getProvider(): Promise<ChatProvider> {
  if (process.env.ANTHROPIC_API_KEY) {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.HARU_AI_MODEL || "claude-sonnet-5-5");
  }
  throw new ProviderUnavailable("No AI provider is configured (ANTHROPIC_API_KEY is missing).");
}
