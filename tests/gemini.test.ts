import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider, fromGeminiResponse, toGeminiContents } from "../src/lib/ai/gemini";
import { ProviderUnavailable, type ChatMessage } from "../src/lib/ai/provider";

const tools = [{ name: "create_expense", description: "Record money spent.", inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] } }];

function fakeFetch(responses: { status: number; body: unknown }[], seen: { url: string; body: any; headers: any }[]) {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

test("gemini: request carries system prompt, tools as JSON Schema, key in header", async () => {
  const seen: { url: string; body: any; headers: any }[] = [];
  const p = new GeminiProvider("test-key", "gemini-3.8-flash", fakeFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] } }], seen));
  const r = await p.chat({ system: "You are HARU", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools });
  assert.equal(r.stopReason, "end");
  assert.deepEqual(r.content, [{ type: "text", text: "Hi", signature: undefined }]);
  assert.match(seen[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(seen[0].headers["x-goog-api-key"], "test-key");
  assert.equal(seen[0].body.systemInstruction.parts[0].text, "You are HARU");
  assert.deepEqual(seen[0].body.tools[0].functionDeclarations[0].parametersJsonSchema, tools[0].inputSchema);
  assert.equal(seen[0].url.includes("test-key"), false, "key never in URL");
});

test("gemini: tool call → tool result round trip keeps thought signature and tool name", () => {
  const resp = fromGeminiResponse({
    candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "create_expense", args: { amount: 42 } }, thoughtSignature: "SIG123" }] }, finishReason: "STOP" }],
  });
  assert.equal(resp.stopReason, "tool_use");
  const call = resp.content[0];
  assert.equal(call.type, "tool_call");
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "I spent $42" }] },
    { role: "assistant", content: resp.content },
    { role: "user", content: [{ type: "tool_result", id: "c1", content: JSON.stringify({ ok: true, summary: "Recorded" }) }] },
  ];
  const contents = toGeminiContents(messages);
  assert.deepEqual(contents[1], { role: "model", parts: [{ functionCall: { id: "c1", name: "create_expense", args: { amount: 42 } }, thoughtSignature: "SIG123" }] });
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { id: "c1", name: "create_expense", response: { ok: true, summary: "Recorded" } } }] });
});

test("gemini: calls without ids get unique ids", () => {
  const r = fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: {} } }] } }] });
  const ids = r.content.map((b) => (b.type === "tool_call" ? b.id : ""));
  assert.notEqual(ids[0], ids[1]);
});

test("gemini: free-tier limit and bad key fail honestly", async () => {
  const limited = new GeminiProvider("k", "m", fakeFetch([{ status: 429, body: "quota" }], []));
  await assert.rejects(limited.chat({ system: "", messages: [], tools }), (e: unknown) => e instanceof ProviderUnavailable && /usage limit/.test((e as Error).message));
  const badKey = new GeminiProvider("k", "m", fakeFetch([{ status: 400, body: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }) }], []));
  await assert.rejects(badKey.chat({ system: "", messages: [], tools }), /rejected HARU's API key/);
});

test("gemini: unknown model and other errors show Google's reason", async () => {
  const missing = new GeminiProvider("k", "gemini-9", fakeFetch([{ status: 404, body: JSON.stringify({ error: { message: "models/gemini-9 is not found" } }) }], []));
  await assert.rejects(missing.chat({ system: "", messages: [], tools }), /isn't available to this key/);
  const other = new GeminiProvider("k", "m", fakeFetch([{ status: 400, body: JSON.stringify({ error: { message: "Bad request thing" } }) }], []));
  await assert.rejects(other.chat({ system: "", messages: [], tools }), /Gemini error 400: Bad request thing/);
});

const ok = { status: 200, body: { candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }] } };
const busy = { status: 503, body: JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }) };

test("gemini: a brief 503 is retried on the same model", async () => {
  const seen: { url: string; body: any; headers: any }[] = [];
  const p = new GeminiProvider("k", "main", fakeFetch([busy, ok], seen), { retryDelaysMs: [0, 0] });
  const r = await p.chat({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }], tools });
  assert.equal(r.content[0].type, "text");
  assert.equal(seen.length, 2);
  assert.ok(seen.every((x) => x.url.includes("/main:")));
});

test("gemini: overloaded model falls back to the next, which stays in use, with signatures re-signed", async () => {
  const seen: { url: string; body: any; headers: any }[] = [];
  const p = new GeminiProvider("k", "main", fakeFetch([busy, busy, busy, ok, ok], seen), { fallbacks: ["backup"], retryDelaysMs: [0, 0] });
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "I spent $42" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "create_expense", input: { amount: 42 }, signature: "REAL" }] },
    { role: "user", content: [{ type: "tool_result", id: "c1", content: "{}" }] },
  ];
  await p.chat({ system: "", messages, tools });
  assert.deepEqual(seen.map((x) => x.url.split("/models/")[1].split(":")[0]), ["main", "main", "main", "backup"]);
  assert.equal(seen[3].body.contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(p.modelInUse, "backup");
  await p.chat({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "again" }] }], tools });
  assert.match(seen[4].url, /\/backup:/);
});

test("gemini: quota on one model moves on; all busy says so plainly", async () => {
  const seen: { url: string; body: any; headers: any }[] = [];
  const p = new GeminiProvider("k", "main", fakeFetch([{ status: 429, body: "quota" }, ok], seen), { fallbacks: ["backup"], retryDelaysMs: [] });
  await p.chat({ system: "", messages: [], tools });
  assert.match(seen[1].url, /\/backup:/);
  const all = new GeminiProvider("k", "main", fakeFetch([busy], []), { fallbacks: ["b2"], retryDelaysMs: [0] });
  await assert.rejects(all.chat({ system: "", messages: [], tools }), (e: unknown) => e instanceof ProviderUnavailable && /overloaded right now \(tried main, b2\)/.test((e as Error).message));
});

test("gemini: thinking is kept short per model, and dropped if a model rejects it", async () => {
  const { thinkingFor } = await import("../src/lib/ai/gemini");
  assert.deepEqual(thinkingFor("gemini-3.8-flash"), { thinkingLevel: "low" });
  assert.deepEqual(thinkingFor("gemini-3.5-flash-lite"), { thinkingLevel: "minimal" });
  assert.deepEqual(thinkingFor("gemini-2.5-flash"), { thinkingBudget: 512 });
  const seen: { url: string; body: any; headers: any }[] = [];
  const p = new GeminiProvider("k", "gemini-3.8-flash", fakeFetch([{ status: 400, body: JSON.stringify({ error: { message: "Unknown name thinkingLevel" } }) }, ok], seen), { retryDelaysMs: [0] });
  await p.chat({ system: "", messages: [], tools });
  assert.equal(seen[0].body.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 8192);
  assert.equal(seen[1].body.generationConfig.thinkingConfig, undefined);
});

test("gemini: a model that hangs is abandoned for the next one", async () => {
  let n = 0;
  const hang = (async (url: string, init: RequestInit) => {
    n++;
    if (String(url).includes("/slow:")) {
      return new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new GeminiProvider("k", "slow", hang, { fallbacks: ["fast"], retryDelaysMs: [0], callTimeoutMs: 50, budgetMs: 10_000 });
  const keepAlive = setInterval(() => {}, 20); // AbortSignal.timeout doesn't hold the event loop open
  const r = await p.chat({ system: "", messages: [], tools }).finally(() => clearInterval(keepAlive));
  assert.equal(r.content[0].type, "text");
  assert.equal(p.modelInUse, "fast");
  assert.equal(n, 2, "no retry of the hanging model");
});
