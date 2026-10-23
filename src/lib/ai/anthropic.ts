import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderUnavailable, type Block, type ChatMessage, type ChatProvider, type ChatResponse, type ToolSpec } from "./provider";

export class AnthropicProvider implements ChatProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 45_000 });
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
        max_tokens: req.maxTokens ?? 1500,
        system: [{ type: "text", text: req.system }],
        ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })) } : {}),
        messages,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new ProviderUnavailable(
        status === 401 ? "The AI provider rejected HARU's API key." : status === 429 ? "The AI provider is rate-limiting requests. Try again in a moment." : "The AI service is unavailable right now.",
      );
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
      throw new ProviderUnavailable(status === 401 ? "The AI provider rejected HARU's API key." : "The AI service couldn't read the photo right now.");
    }
  }
}
