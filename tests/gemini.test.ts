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
  const other = new GeminiProvider("k", "m", fakeFetch([{ status: 500, body: JSON.stringify({ error: { message: "Internal error" } }) }], []));
  await assert.rejects(other.chat({ system: "", messages: [], tools }), /Gemini error 500: Internal error/);
});
