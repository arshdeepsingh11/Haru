import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { getConversation, listConversations, runTurn } from "@/lib/ai/agent";
import { zId } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = route(async (ctx, req) => {
  const id = new URL(req.url).searchParams.get("conversationId");
  const [conversation, conversations] = await Promise.all([getConversation(ctx, id && zId.safeParse(id).success ? id : null), listConversations(ctx)]);
  return { conversation, conversations: conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at.toISOString() })) };
});

export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ text: z.string().min(1).max(4000), conversationId: zId.nullable().optional() }));
  return runTurn(ctx, b);
});
