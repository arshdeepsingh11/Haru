import "server-only";
import { sql } from "../server/db";
import type { Ctx } from "../server/context";
import { AppError, logError, publicMessage } from "../server/errors";
import { applyUndo, type UndoOp } from "../server/undo";
import { logActivity } from "../server/activity";
import { getProvider, ProviderUnavailable, type Block, type ChatMessage, type ChatProvider } from "./provider";
import { buildSystemPrompt } from "./prompt";
import { riskOf, TOOL_MAP, toolSpecs, type ToolOutput } from "./tools";
import { autoPlace } from "../server/services/cards";
import type { CardKey } from "../dashboard-registry";

const MAX_STEPS = 8;
const HISTORY = 16;

export interface ActionView {
  id: string;
  tool: string;
  risk: "read" | "write" | "confirm";
  status: "pending_confirmation" | "completed" | "failed" | "cancelled" | "undone";
  summary: string | null;
  error: string | null;
  undoable: boolean;
  display: ToolOutput["display"] | null;
  createdAt: string;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  actions: ActionView[];
  error?: boolean;
}

interface ActionRow {
  id: string;
  message_id: string | null;
  tool: string;
  risk: ActionView["risk"];
  status: ActionView["status"];
  summary: string | null;
  error: string | null;
  undo: UndoOp[] | null;
  result: { display?: ToolOutput["display"] } | null;
  created_at: Date;
}

function toView(a: ActionRow): ActionView {
  return {
    id: a.id,
    tool: a.tool,
    risk: a.risk,
    status: a.status,
    summary: a.summary,
    error: a.error,
    undoable: a.status === "completed" && Array.isArray(a.undo) && a.undo.length > 0 && Date.now() - a.created_at.getTime() < 7 * 86400e3,
    display: a.result?.display ?? null,
    createdAt: a.created_at.toISOString(),
  };
}

async function checkRateLimit(ctx: Ctx) {
  const [r] = await sql<{ minute: number; hour: number }[]>`
    select count(*) filter (where created_at > now() - interval '1 minute')::int as minute,
           count(*) filter (where created_at > now() - interval '1 hour')::int as hour
    from ai_messages where user_id = ${ctx.userId} and role = 'user' and created_at > now() - interval '1 hour'`;
  if (r.minute >= 10 || r.hour >= 120) throw new AppError("You're sending messages faster than HARU can safely process. Give it a minute.", 429, "rate_limited");
}

export async function listConversations(ctx: Ctx) {
  return sql<{ id: string; title: string | null; updated_at: Date }[]>`
    select id, title, updated_at from ai_conversations where user_id = ${ctx.userId} order by updated_at desc limit 20`;
}

export async function getConversation(ctx: Ctx, conversationId?: string | null): Promise<{ id: string | null; messages: MessageView[] }> {
  const [conv] = conversationId
    ? await sql<{ id: string }[]>`select id from ai_conversations where id = ${conversationId} and user_id = ${ctx.userId}`
    : await sql<{ id: string }[]>`select id from ai_conversations where user_id = ${ctx.userId} order by updated_at desc limit 1`;
  if (!conv) return { id: null, messages: [] };
  const [msgs, actions] = await Promise.all([
    sql<{ id: string; role: "user" | "assistant"; content: string; meta: { error?: boolean }; created_at: Date }[]>`
      select id, role, content, meta, created_at from ai_messages where conversation_id = ${conv.id} and user_id = ${ctx.userId}
      order by created_at desc limit 80`,
    sql<ActionRow[]>`select id, message_id, tool, risk, status, summary, error, undo, result, created_at from ai_actions
      where conversation_id = ${conv.id} and user_id = ${ctx.userId} and (risk <> 'read' or (result -> 'display') is not null)
      order by created_at`,
  ]);
  return {
    id: conv.id,
    messages: msgs.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at.toISOString(),
      error: m.meta?.error,
      actions: actions.filter((a) => a.message_id === m.id).map(toView),
    })),
  };
}

async function saveAction(ctx: Ctx, conversationId: string, a: { tool: string; args: unknown; risk: string; status: string; summary?: string | null; result?: unknown; undo?: unknown; error?: string | null }) {
  const [row] = await sql<{ id: string }[]>`
    insert into ai_actions (user_id, conversation_id, tool, args, risk, status, summary, result, undo, error, resolved_at)
    values (${ctx.userId}, ${conversationId}, ${a.tool}, ${sql.json((a.args ?? {}) as never)}, ${a.risk}, ${a.status}, ${a.summary ?? null},
            ${a.result == null ? null : sql.json(a.result as never)}, ${a.undo == null ? null : sql.json(a.undo as never)}, ${a.error ?? null},
            ${a.status === "pending_confirmation" ? null : new Date()})
    returning id`;
  return row.id;
}

export interface TurnResult {
  conversationId: string;
  user: MessageView;
  assistant: MessageView;
  changed: boolean;
  /** Dashboard cards that appeared during this turn. */
  cardsAdded: CardKey[];
  /** The model could not be reached; nothing was stored, so the client can simply retry. */
  retryable?: boolean;
}

/** One user turn: model ↔ tools loop over HARU's authorised services. */
export async function runTurn(ctx: Ctx, input: { conversationId?: string | null; text: string }, opts: { provider?: ChatProvider } = {}): Promise<TurnResult> {
  const text = input.text.trim().slice(0, 4000);
  if (!text) throw new AppError("Say something for HARU to work on.");
  await checkRateLimit(ctx);

  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const [c] = await sql`select 1 from ai_conversations where id = ${conversationId} and user_id = ${ctx.userId}`;
    if (!c) conversationId = null;
  }
  if (!conversationId) {
    const [c] = await sql<{ id: string }[]>`insert into ai_conversations (user_id, title) values (${ctx.userId}, ${text.slice(0, 60)}) returning id`;
    conversationId = c.id;
  }
  const history = await sql<{ role: "user" | "assistant"; content: string }[]>`
    select role, content from (select role, content, created_at from ai_messages where conversation_id = ${conversationId} and user_id = ${ctx.userId}
    order by created_at desc limit ${HISTORY}) h order by created_at`;
  const [userMsg] = await sql<{ id: string; created_at: Date }[]>`
    insert into ai_messages (user_id, conversation_id, role, content) values (${ctx.userId}, ${conversationId}, 'user', ${text}) returning id, created_at`;

  const messages: ChatMessage[] = history.map((h) => ({ role: h.role, content: [{ type: "text", text: h.content }] }));
  // The provider requires alternating roles; merge any leading assistant turn safely.
  while (messages.length && messages[0].role !== "user") messages.shift();
  messages.push({ role: "user", content: [{ type: "text", text }] });

  const actionIds: string[] = [];
  const cardsAdded: CardKey[] = [];
  let changed = false;
  let finalText = "";
  let failed = false;

  try {
    const provider = opts.provider ?? (await getProvider());
    const system = await buildSystemPrompt(ctx);
    const tools = toolSpecs();
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await provider.chat({ system, messages, tools });
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      const textOut = res.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
      if (calls.length === 0) {
        finalText = textOut;
        break;
      }
      const results: Block[] = [];
      for (const call of calls) {
        const t = TOOL_MAP.get(call.name);
        if (!t) {
          results.push({ type: "tool_result", id: call.id, content: JSON.stringify({ error: `Unknown tool ${call.name}` }), isError: true });
          continue;
        }
        const parsed = t.schema.safeParse(call.input ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
          results.push({ type: "tool_result", id: call.id, content: JSON.stringify({ error: `Invalid arguments — ${issues}` }), isError: true });
          continue;
        }
        let risk: "read" | "write" | "confirm" = "write";
        try {
          risk = await riskOf(t, parsed.data, ctx);
          if (risk === "confirm") {
            const preview = t.preview ? await t.preview(ctx, parsed.data) : `Run ${t.name}`;
            actionIds.push(await saveAction(ctx, conversationId, { tool: t.name, args: parsed.data, risk, status: "pending_confirmation", summary: preview }));
            results.push({ type: "tool_result", id: call.id, content: JSON.stringify({ status: "needs_confirmation", will_do: preview, note: "Not done yet. The user must press Confirm." }) });
            continue;
          }
          const out = await t.run(ctx, parsed.data);
          for (const k of out.cardsAdded ?? []) if (!cardsAdded.includes(k)) cardsAdded.push(k);
          if (risk === "write") {
            changed = true;
            for (const k of await autoPlace(ctx, t.name).catch((e) => (logError("cards.autoPlace", e), [] as CardKey[]))) if (!cardsAdded.includes(k)) cardsAdded.push(k);
            actionIds.push(await saveAction(ctx, conversationId, { tool: t.name, args: parsed.data, risk, status: "completed", summary: out.summary, undo: out.undo ?? null, result: out.display ? { display: out.display } : null }));
          } else if (out.display) {
            actionIds.push(await saveAction(ctx, conversationId, { tool: t.name, args: parsed.data, risk, status: "completed", summary: out.summary, result: { display: out.display } }));
          }
          results.push({ type: "tool_result", id: call.id, content: JSON.stringify({ ok: true, summary: out.summary, data: out.data ?? null }) });
        } catch (e) {
          const msg = publicMessage(e);
          if (!(e instanceof AppError)) logError(`tool.${t.name}`, e);
          if (risk !== "read") actionIds.push(await saveAction(ctx, conversationId, { tool: t.name, args: parsed.data, risk, status: "failed", error: msg }));
          results.push({ type: "tool_result", id: call.id, content: JSON.stringify({ error: msg, nothing_changed: true }), isError: true });
        }
      }
      messages.push({ role: "user", content: results });
      if (step === MAX_STEPS - 1) finalText = textOut || "I've done what I could here — tell me if anything still needs changing.";
    }
    if (!finalText) finalText = "Done.";
  } catch (e) {
    failed = true;
    if (!(e instanceof ProviderUnavailable)) logError("agent", e);
    const why = e instanceof ProviderUnavailable ? e.message : publicMessage(e);
    finalText = actionIds.length
      ? `${why} Some steps had already run — see the action cards below for exactly what was saved.`
      : `${why} Nothing was changed.`;
  }

  if (failed && actionIds.length === 0) {
    await sql`delete from ai_messages where id = ${userMsg.id} and user_id = ${ctx.userId}`;
    const now = new Date().toISOString();
    return {
      conversationId,
      changed: false,
      cardsAdded: [],
      retryable: true,
      user: { id: `u-${userMsg.id}`, role: "user", content: text, createdAt: now, actions: [] },
      assistant: { id: `err-${userMsg.id}`, role: "assistant", content: finalText, createdAt: now, actions: [], error: true },
    };
  }

  const [asst] = await sql<{ id: string; created_at: Date }[]>`
    insert into ai_messages (user_id, conversation_id, role, content, meta)
    values (${ctx.userId}, ${conversationId}, 'assistant', ${finalText}, ${sql.json({ error: failed } as never)}) returning id, created_at`;
  if (actionIds.length) await sql`update ai_actions set message_id = ${asst.id} where id in ${sql(actionIds)} and user_id = ${ctx.userId}`;
  await sql`update ai_conversations set updated_at = now() where id = ${conversationId}`;
  const actions = actionIds.length
    ? await sql<ActionRow[]>`select id, message_id, tool, risk, status, summary, error, undo, result, created_at from ai_actions where id in ${sql(actionIds)} order by created_at`
    : [];

  return {
    conversationId,
    changed: changed || cardsAdded.length > 0,
    cardsAdded,
    user: { id: userMsg.id, role: "user", content: text, createdAt: userMsg.created_at.toISOString(), actions: [] },
    assistant: { id: asst.id, role: "assistant", content: finalText, createdAt: asst.created_at.toISOString(), actions: actions.map(toView), error: failed },
  };
}

/** Confirm, cancel or undo an action. Executes only HARU's own stored, validated arguments. */
export async function resolveAction(ctx: Ctx, actionId: string, decision: "confirm" | "cancel" | "undo"): Promise<{ action: ActionView; message: MessageView }> {
  const [a] = await sql<(ActionRow & { args: unknown; conversation_id: string })[]>`
    select id, message_id, tool, risk, status, summary, error, undo, result, created_at, args, conversation_id
    from ai_actions where id = ${actionId} and user_id = ${ctx.userId}`;
  if (!a) throw new AppError("That action no longer exists.", 404);
  let reply: string;

  if (decision === "confirm" || decision === "cancel") {
    if (a.status !== "pending_confirmation") throw new AppError("This action was already handled.", 409);
    if (Date.now() - a.created_at.getTime() > 24 * 3600e3) {
      await sql`update ai_actions set status = 'cancelled', error = 'Expired', resolved_at = now() where id = ${a.id}`;
      throw new AppError("This confirmation expired. Ask HARU again.", 410);
    }
    if (decision === "cancel") {
      await sql`update ai_actions set status = 'cancelled', resolved_at = now() where id = ${a.id}`;
      reply = "Cancelled — nothing was changed.";
    } else {
      const t = TOOL_MAP.get(a.tool);
      if (!t) throw new AppError("Unknown action.");
      const parsed = t.schema.safeParse(a.args);
      if (!parsed.success) throw new AppError("This action's details are no longer valid.");
      // Claim it first so a double-click cannot run it twice.
      const claim = await sql`update ai_actions set status = 'completed', resolved_at = now() where id = ${a.id} and status = 'pending_confirmation'`;
      if (claim.count === 0) throw new AppError("This action was already handled.", 409);
      try {
        const out = await t.run(ctx, parsed.data);
        await autoPlace(ctx, t.name).catch((e) => logError("cards.autoPlace", e));
        await sql`update ai_actions set summary = ${out.summary}, undo = ${out.undo ? sql.json(out.undo as never) : null},
                   result = ${out.display ? sql.json({ display: out.display } as never) : null} where id = ${a.id}`;
        reply = `Done. ${out.summary}`;
      } catch (e) {
        const msg = publicMessage(e);
        await sql`update ai_actions set status = 'failed', error = ${msg} where id = ${a.id}`;
        reply = `That didn't work: ${msg}`;
      }
    }
  } else {
    if (a.status !== "completed" || !a.undo?.length) throw new AppError("This action can't be undone.", 409);
    if (Date.now() - a.created_at.getTime() > 7 * 86400e3) throw new AppError("This is too old to undo automatically.", 409);
    const claim = await sql`update ai_actions set status = 'undone', resolved_at = now() where id = ${a.id} and status = 'completed'`;
    if (claim.count === 0) throw new AppError("Already undone.", 409);
    try {
      await sql.begin(async (tx) => {
        await applyUndo(tx, ctx.userId, a.undo!);
        await logActivity(tx, ctx.userId, { entity: "ai_action", entityId: a.id, action: "undo", actor: "user", summary: `Undid: ${a.summary ?? a.tool}` });
      });
      reply = `Undone: ${a.summary ?? a.tool}.`;
    } catch (e) {
      await sql`update ai_actions set status = 'completed' where id = ${a.id}`;
      throw e;
    }
  }

  const [m] = await sql<{ id: string; created_at: Date }[]>`
    insert into ai_messages (user_id, conversation_id, role, content) values (${ctx.userId}, ${a.conversation_id}, 'assistant', ${reply}) returning id, created_at`;
  await sql`update ai_conversations set updated_at = now() where id = ${a.conversation_id}`;
  const [fresh] = await sql<ActionRow[]>`select id, message_id, tool, risk, status, summary, error, undo, result, created_at from ai_actions where id = ${a.id}`;
  return { action: toView(fresh), message: { id: m.id, role: "assistant", content: reply, createdAt: m.created_at.toISOString(), actions: [] } };
}
