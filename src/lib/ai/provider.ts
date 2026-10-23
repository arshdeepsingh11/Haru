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
/** Flash-lite is left out: it is fast but drops details when saving many things at once. */
export const DEFAULT_GEMINI_FALLBACKS = ["gemini-3.6-flash", "gemini-2.5-flash"];

export class ProviderUnavailable extends Error {}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** HARU_AI_MODEL is honoured only when it names a model of the provider in use (so switching providers can't send a Gemini name to Claude). */
function modelFor(provider: "anthropic" | "gemini"): string {
  const own = provider === "anthropic" ? process.env.HARU_CLAUDE_MODEL : process.env.HARU_GEMINI_MODEL;
  if (own?.trim()) return own.trim();
  const legacy = process.env.HARU_AI_MODEL?.trim();
  if (legacy && (provider === "anthropic" ? /^claude/i : /^gemini/i).test(legacy)) return legacy;
  return provider === "anthropic" ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL;
}

/** Which provider answers first. Claude when its key is set (best at careful tool use), else Gemini. HARU_AI_PROVIDER forces one. */
function primary(): "anthropic" | "gemini" | null {
  const forced = process.env.HARU_AI_PROVIDER?.trim().toLowerCase();
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  if (forced === "gemini" && hasGemini) return "gemini";
  if (forced === "anthropic" && hasClaude) return "anthropic";
  return hasClaude ? "anthropic" : hasGemini ? "gemini" : null;
}

/** The model HARU will ask first, for display ("claude-opus-5-5"). */
export function configuredModel(): string | null {
  const p = primary();
  return p ? modelFor(p) : null;
}

export function aiConfigured(): boolean {
  return primary() !== null;
}

async function make(p: "anthropic" | "gemini", asBackup = false): Promise<ChatProvider> {
  if (p === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, modelFor("anthropic"));
  }
  const { GeminiProvider } = await import("./gemini");
  const fallbacks = process.env.HARU_AI_FALLBACK_MODELS != null ? process.env.HARU_AI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_GEMINI_FALLBACKS;
  return new GeminiProvider(process.env.GEMINI_API_KEY!, modelFor("gemini"), fetch, { fallbacks, foreignHistory: asBackup });
}

/**
 * Picks the provider from the environment: Claude first when ANTHROPIC_API_KEY is set, Gemini otherwise.
 * With both keys, Gemini stands by: if Claude is down or overloaded, the same turn continues on Gemini.
 */
export async function getProvider(): Promise<ChatProvider> {
  const p = primary();
  if (!p) throw new ProviderUnavailable("No AI provider is configured. Add ANTHROPIC_API_KEY (Claude) or GEMINI_API_KEY to the server environment.");
  const main = await make(p);
  const other = p === "anthropic" ? "gemini" : "anthropic";
  const hasOther = other === "gemini" ? Boolean(process.env.GEMINI_API_KEY) : Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasOther || process.env.HARU_AI_CROSS_FALLBACK === "off") return main;
  return new FallbackProvider(main, () => make(other, true));
}

/**
 * Tries the main provider; when it is unavailable (outage, overload, quota), switches to the backup
 * and stays there for the rest of this turn so one conversation never bounces between models.
 * Key errors are not hidden: a rejected key is a setup problem the person should see.
 */
export class FallbackProvider implements ChatProvider {
  readonly name: string;
  private backup: ChatProvider | null = null;
  private usingBackup = false;

  constructor(
    private main: ChatProvider,
    private loadBackup: () => Promise<ChatProvider>,
  ) {
    this.name = main.name;
  }

  get modelInUse(): string {
    const p = this.usingBackup && this.backup ? this.backup : this.main;
    return (p as { modelInUse?: string }).modelInUse ?? p.name;
  }

  private async run<T>(fn: (p: ChatProvider) => Promise<T>): Promise<T> {
    if (!this.usingBackup) {
      try {
        return await fn(this.main);
      } catch (e) {
        if (!(e instanceof ProviderUnavailable) || /rejected HARU's API key/.test(e.message)) throw e;
        console.error(`[haru:ai] ${this.main.name} unavailable (${e.message}); switching to backup`);
        this.backup ??= await this.loadBackup();
        this.usingBackup = true;
      }
    }
    return fn(this.backup!);
  }

  chat(req: Parameters<ChatProvider["chat"]>[0]): Promise<ChatResponse> {
    return this.run((p) => p.chat(req));
  }

  async vision(req: { system: string; prompt: string; image: { mime: string; base64: string } }): Promise<string> {
    return this.run((p) => {
      if (!p.vision) throw new ProviderUnavailable("This AI provider can't read photos.");
      return p.vision(req);
    });
  }
}
