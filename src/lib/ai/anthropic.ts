import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderUnavailable, type Block, type ChatMessage, type ChatProvider, type ChatResponse, type ToolSpec } from "./provider";

export class AnthropicProvider implements ChatProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  get modelInUse() {
    return this.model;
  }

  async chat(req: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<ChatResponse> {
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) => {
        if (b.type === "text") return { type: "text" as const, text: b.text };
        if (b.type === "tool_call") return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input as Record<string, unknown> };
        return { type: "tool_result" as const, tool_use_id: b.id, content: b.content, is_error: b.isError ?? false };
      }),
    })) as Anthropic.MessageParam[];

    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        // The system prompt and ~50 tool definitions are the same every turn: cache them
        // (faster first token, much cheaper input). The cache breakpoint on the last tool covers all tools.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        ...(req.tools.length
          ? {
              tools: req.tools.map((t, i) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
              })),
            }
          : {}),
        messages,
      });
    } catch (e) {
      throw new ProviderUnavailable(failure(e, this.model));
    }

    return this.toResponse(res);
  }

  private toResponse(res: Anthropic.Message): ChatResponse {
    const content: Block[] = [];
    for (const b of res.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    }
    const stopReason = res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "end_turn" ? "end" : res.stop_reason === "max_tokens" ? "max_tokens" : "other";
    return { content, stopReason };
  }

  async vision(req: { system: string; prompt: string; image: { mime: string; base64: string } }): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: req.system,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: req.image.mime as "image/jpeg", data: req.image.base64 } },
              { type: "text", text: `${req.prompt}\nReply with the JSON only.` },
            ],
          },
        ],
      });
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new ProviderUnavailable(status === 401 ? "The AI provider rejected HARU's API key." : failure(e, this.model));
    }
  }
}

function failure(e: unknown, model: string): string {
  const status = (e as { status?: number }).status;
  const detail = ((e as { message?: string }).message ?? "").slice(0, 300);
  console.error(`[haru:claude] ${model} failed (${status ?? "network"}): ${detail}`);
  if (status === 401 || status === 403) return "The AI provider rejected HARU's API key.";
  if (status === 404) return `Claude doesn't recognise the model "${model}". Check HARU_CLAUDE_MODEL.`;
  if (status === 429) return "Claude is rate-limiting requests. Try again in a moment.";
  if (status === 529 || status === 503) return "Claude is busy right now. Try again in a moment.";
  if (status === 400 && /credit|billing/i.test(detail)) return "Your Anthropic account is out of credit. Add credit at console.anthropic.com.";
  return "The AI service is unavailable right now.";
}
