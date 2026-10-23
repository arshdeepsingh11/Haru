import { z } from "zod";
import { NextResponse } from "next/server";
import { body, errorResponse, route } from "@/lib/server/http";
import { requireCtx } from "@/lib/server/context";
import { AppError, logError, publicMessage } from "@/lib/server/errors";
import { getConversation, listConversations, runTurn } from "@/lib/ai/agent";
import { zId } from "@/lib/validation";
import { configuredModel } from "@/lib/ai/provider";

export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = route(async (ctx, req) => {
  const id = new URL(req.url).searchParams.get("conversationId");
  const [conversation, conversations] = await Promise.all([getConversation(ctx, id && zId.safeParse(id).success ? id : null), listConversations(ctx)]);
  return { conversation, conversations: conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at.toISOString() })), model: configuredModel() };
});

/** DELETE {conversationId} → clear that chat. Messages go; jobs, shifts and money records stay. */
export const DELETE = route(async (ctx, req) => {
  const b = await body(req, z.object({ conversationId: zId }));
  const { sql } = await import("@/lib/server/db");
  const r = await sql`delete from ai_conversations where id = ${b.conversationId} and user_id = ${ctx.userId}`;
  if (!r.count) throw new AppError("That chat is already gone.", 404);
  return { ok: true };
});

const Turn = z.object({ text: z.string().min(1).max(4000), conversationId: zId.nullable().optional(), stream: z.boolean().optional() });

/**
 * One chat turn. With `stream: true` the reply is Server-Sent Events: progress events while Haru works
 * ({type:"thinking"} / {type:"tool"}), then {type:"done", result} or {type:"error", error}.
 */
export async function POST(req: Request) {
  let ctx;
  let b: z.infer<typeof Turn>;
  try {
    ctx = await requireCtx();
    b = await body(req, Turn);
  } catch (e) {
    return errorResponse(e);
  }
  if (!b.stream) {
    try {
      return NextResponse.json(await runTurn(ctx, b));
    } catch (e) {
      return errorResponse(e);
    }
  }
  const enc = new TextEncoder();
  const turnCtx = ctx;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const result = await runTurn(turnCtx, b, { onEvent: send });
        send({ type: "done", result });
      } catch (e) {
        if (!(e instanceof AppError)) logError("chat.stream", e);
        send({ type: "error", error: publicMessage(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
