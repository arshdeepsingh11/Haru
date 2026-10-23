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

const DUMMY_SIGNATURE = "skip_thought_signature_validator";

/**
 * Keep thinking short: HARU's tools do the maths, so deep reasoning only adds seconds.
 * Gemini 3.x takes a thinking level; 2.5 takes a token budget. Override with HARU_AI_THINKING.
 */
export function thinkingFor(model: string): Record<string, unknown> {
  const forced = process.env.HARU_AI_THINKING?.trim();
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: /lite/.test(model) ? 0 : 512 };
  if (forced) return { thinkingLevel: forced };
  // "minimal" made 3.5/3.6 skip details in long messages (missed schedules); "low" is still fast.
  return { thinkingLevel: "low" };
}
const RETRYABLE = new Set([500, 502, 503, 504]);

/** When a turn moves to a fallback model, signatures from the first model can't be validated by it. */
export function resignContents(contents: GeminiContent[]): GeminiContent[] {
  return contents.map((c) => ({
    role: c.role,
    parts: c.parts.map((p) => {
      if ("functionCall" in p) return { functionCall: p.functionCall, ...(c.role === "model" ? { thoughtSignature: DUMMY_SIGNATURE } : {}) };
      if ("text" in p) return { text: p.text };
      return p;
    }),
  }));
}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export interface GeminiOptions {
  /** Models to try, in order, when the main one is overloaded or out of quota. */
  fallbacks?: string[];
  /** Waits between retries of the same model on 5xx. */
  retryDelaysMs?: number[];
  /** Longest a single request may take before moving to the next model. */
  callTimeoutMs?: number;
  /** Total time one request may spend across retries and fallbacks. */
  budgetMs?: number;
}

export class GeminiProvider implements ChatProvider {
  readonly name = "gemini";
  private active: string;
  private fallbacks: string[];
  private delays: number[];
  private callTimeoutMs: number;
  private budgetMs: number;

  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
    opts: GeminiOptions = {},
  ) {
    this.active = model;
    this.fallbacks = (opts.fallbacks ?? []).filter((m) => m && m !== model);
    this.delays = opts.retryDelaysMs ?? [600];
    this.callTimeoutMs = opts.callTimeoutMs ?? 20_000;
    this.budgetMs = opts.budgetMs ?? 40_000;
  }

  /** The model that answered last (sticky for the rest of this turn). */
  get modelInUse() {
    return this.active;
  }

  private async post(model: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response;
    const started = Date.now();
    try {
      res = await this.fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error(`[haru:gemini] network error (${model}): ${(e as Error).message}`);
      throw new GeminiHttpError(0, (e as Error).name === "TimeoutError" ? "timed out" : "network error");
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let reason = "";
      try {
        reason = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        reason = detail.slice(0, 200);
      }
      console.error(`[haru:gemini] HTTP ${res.status} for model ${model}: ${reason.slice(0, 300)}`);
      throw new GeminiHttpError(res.status, reason);
    }
    const json = await res.json();
    console.info(`[haru:gemini] ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return json;
  }

  /**
   * Try the active model (retrying brief overloads), then each fallback model.
   * Quota (429) and overload (5xx) move on to the next model; key and request errors stop at once.
   */
  private async generate(build: (model: string, switched: boolean, thinking: boolean) => unknown): Promise<unknown> {
    const chain = [this.active, ...[this.model, ...this.fallbacks].filter((m) => m !== this.active)];
    const deadline = Date.now() + this.budgetMs;
    let last: GeminiHttpError | null = null;
    for (const model of chain) {
      const switched = model !== this.active;
      let thinking = true;
      for (let attempt = 0; attempt <= this.delays.length; attempt++) {
        const left = deadline - Date.now();
        if (left < 4_000) break;
        try {
          const json = await this.post(model, build(model, switched, thinking), Math.min(this.callTimeoutMs, left));
          this.active = model;
          return json;
        } catch (e) {
          const err = e as GeminiHttpError;
          last = err;
          if (/API key|API_KEY|credential|unauthenticated/i.test(err.reason) || err.status === 401 || err.status === 403)
            throw new ProviderUnavailable(`Gemini rejected HARU's API key (${err.status}): ${err.reason.slice(0, 160)}`);
          // A model that doesn't accept the thinking setting: ask again without it.
          if (err.status === 400 && thinking && /thinking/i.test(err.reason)) {
            thinking = false;
            attempt--;
            continue;
          }
          // A slow model (timeout) goes straight to the next one; brief overloads are retried.
          const retrySame = RETRYABLE.has(err.status) && attempt < this.delays.length;
          if (retrySame) {
            await new Promise((r) => setTimeout(r, this.delays[attempt]));
            continue;
          }
          break; // next model
        }
      }
      if (last && !(RETRYABLE.has(last.status) || last.status === 0 || last.status === 429 || last.status === 404)) break;
      if (deadline - Date.now() < 4_000) break;
    }
    const tried = chain.length > 1 ? ` (tried ${chain.join(", ")})` : "";
    const e = last ?? new GeminiHttpError(0, "timed out");
    if (e.status === 429)
      throw new ProviderUnavailable(`Gemini's usage limit was reached${tried}. The free tier allows a limited number of requests; try again in a minute or use a paid key.`);
    if (e.status === 404) throw new ProviderUnavailable(`Gemini model "${this.model}" isn't available to this key. Set HARU_AI_MODEL (e.g. gemini-3.6-flash) and restart.`);
    if (RETRYABLE.has(e.status)) throw new ProviderUnavailable(`Gemini is overloaded right now${tried}. Give it a minute and tap Retry.`);
    if (e.status === 0) throw new ProviderUnavailable(e.reason === "timed out" ? `Gemini is answering too slowly right now${tried}. Tap Retry, or set HARU_AI_MODEL to a faster model.` : `HARU couldn't reach Gemini (${e.reason}).`);
    throw new ProviderUnavailable(`Gemini error ${e.status}: ${e.reason.slice(0, 160) || "no details"}`);
  }

  async chat(req: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<ChatResponse> {
    const contents = toGeminiContents(req.messages);
    const json = await this.generate((model, switched, thinking) => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: switched ? resignContents(contents) : contents,
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      // Thought tokens count toward the output limit, so leave room for the actual reply.
      generationConfig: { maxOutputTokens: req.maxTokens ?? 8192, ...(thinking ? { thinkingConfig: thinkingFor(model) } : {}) },
    }));
    return fromGeminiResponse(json);
  }

  /** Read an image (a photographed schedule) and answer with JSON text. */
  async vision(req: { system: string; prompt: string; image: { mime: string; base64: string } }): Promise<string> {
    const json = await this.generate((model, _switched, thinking) => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: req.image.mime, data: req.image.base64 } }, { text: req.prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, ...(thinking ? { thinkingConfig: thinkingFor(model) } : {}) },
    }));
    const parts = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("");
  }
}
