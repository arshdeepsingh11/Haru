import "server-only";
import { ProviderUnavailable, type Block, type ChatMessage, type ChatProvider, type ChatResponse, type ToolSpec } from "./provider";

// Google Gemini adapter over the REST API (no extra dependency).
// Gemini 3 models attach a `thoughtSignature` to tool calls that must be sent
// back unchanged on the next turn; it is carried on the block's `signature`.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type Part =
  | { text: string; thoughtSignature?: string }
  | { functionCall: { id?: string; name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: Part[];
}

export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const names = new Map<string, string>(); // tool call id → tool name (functionResponse needs the name)
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const parts: Part[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) parts.push(b.signature ? { text: b.text, thoughtSignature: b.signature } : { text: b.text });
      } else if (b.type === "tool_call") {
        names.set(b.id, b.name);
        parts.push({
          functionCall: { id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> },
          ...(b.signature ? { thoughtSignature: b.signature } : {}),
        });
      } else {
        let response: Record<string, unknown>;
        try {
          const parsed = JSON.parse(b.content);
          response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
        } catch {
          response = { result: b.content };
        }
        parts.push({ functionResponse: { id: b.id, name: names.get(b.id) ?? "unknown_tool", response } });
      }
    }
    if (parts.length) out.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return out;
}

export function fromGeminiResponse(json: unknown): ChatResponse {
  const cand = (json as { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[] }).candidates?.[0];
  const content: Block[] = [];
  let n = 0;
  for (const p of cand?.content?.parts ?? []) {
    if ("functionCall" in p) {
      content.push({ type: "tool_call", id: p.functionCall.id ?? `call_${Date.now()}_${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, signature: p.thoughtSignature });
    } else if ("text" in p && p.text) {
      content.push({ type: "text", text: p.text, signature: p.thoughtSignature });
    }
  }
  const hasCalls = content.some((b) => b.type === "tool_call");
  const reason = cand?.finishReason;
  return { content, stopReason: hasCalls ? "tool_use" : reason === "MAX_TOKENS" ? "max_tokens" : reason === "STOP" || !reason ? "end" : "other" };
}

export class GeminiProvider implements ChatProvider {
  readonly name = "gemini";

  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(req: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<ChatResponse> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: req.maxTokens ?? 2048 },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      console.error(`[haru:gemini] network error: ${(e as Error).message}`);
      throw new ProviderUnavailable(`HARU couldn't reach Gemini (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}).`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let reason = "";
      try {
        reason = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        reason = detail.slice(0, 200);
      }
      console.error(`[haru:gemini] HTTP ${res.status} for model ${this.model}: ${reason.slice(0, 300)}`);
      if (res.status === 429)
        throw new ProviderUnavailable("Gemini's usage limit was reached (the free tier allows only a limited number of requests per day). Try again later or use a paid key.");
      if (/API key|API_KEY|credential|unauthenticated/i.test(reason) || res.status === 401)
        throw new ProviderUnavailable(`Gemini rejected HARU's API key (${res.status}): ${reason.slice(0, 160)}`);
      if (res.status === 404)
        throw new ProviderUnavailable(`Gemini model "${this.model}" isn't available to this key. Set HARU_AI_MODEL (e.g. gemini-3.6-flash) and restart.`);
      throw new ProviderUnavailable(`Gemini error ${res.status}: ${reason.slice(0, 160) || "no details"}`);
    }
    return fromGeminiResponse(await res.json());
  }
}
