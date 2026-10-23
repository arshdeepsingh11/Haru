import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredModel, FallbackProvider, ProviderUnavailable, type ChatProvider, type ChatResponse } from "../src/lib/ai/provider";

const KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "HARU_AI_PROVIDER", "HARU_AI_MODEL", "HARU_CLAUDE_MODEL", "HARU_GEMINI_MODEL"];
function withEnv(env: Record<string, string>, fn: () => void) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

test("provider: Claude answers first when its key is set", () => {
  withEnv({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" }, () => assert.equal(configuredModel(), "claude-opus-5-5"));
  withEnv({ GEMINI_API_KEY: "y" }, () => assert.equal(configuredModel(), "gemini-3.8-flash"));
  withEnv({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y", HARU_AI_PROVIDER: "gemini" }, () => assert.equal(configuredModel(), "gemini-3.8-flash"));
  withEnv({}, () => assert.equal(configuredModel(), null));
});

test("provider: an old Gemini model name is never sent to Claude", () => {
  withEnv({ ANTHROPIC_API_KEY: "x", HARU_AI_MODEL: "gemini-3.8-flash" }, () => assert.equal(configuredModel(), "claude-opus-5-5"));
  withEnv({ ANTHROPIC_API_KEY: "x", HARU_CLAUDE_MODEL: "claude-sonnet-5-5" }, () => assert.equal(configuredModel(), "claude-sonnet-5-5"));
});

const reply: ChatResponse = { stopReason: "end", blocks: [{ type: "text", text: "hi" }] } as unknown as ChatResponse;
function fake(name: string, behave: () => Promise<ChatResponse>, calls: string[]): ChatProvider {
  return { name, chat: async () => (calls.push(name), behave()) } as unknown as ChatProvider;
}

test("provider: an outage switches to the backup and stays there for the turn", async () => {
  const calls: string[] = [];
  const p = new FallbackProvider(
    fake("claude", () => Promise.reject(new ProviderUnavailable("Claude is busy right now. Try again in a moment.")), calls),
    async () => fake("gemini", async () => reply, calls),
  );
  const req = { system: "", messages: [], tools: [] } as unknown as Parameters<ChatProvider["chat"]>[0];
  assert.equal(await p.chat(req), reply);
  assert.equal(await p.chat(req), reply);
  assert.deepEqual(calls, ["claude", "gemini", "gemini"]);
});

test("provider: a rejected key is shown, not hidden behind the backup", async () => {
  const calls: string[] = [];
  const p = new FallbackProvider(
    fake("claude", () => Promise.reject(new ProviderUnavailable("The AI provider rejected HARU's API key.")), calls),
    async () => fake("gemini", async () => reply, calls),
  );
  await assert.rejects(() => p.chat({ system: "", messages: [], tools: [] } as never), /rejected/);
  assert.deepEqual(calls, ["claude"]);
});
