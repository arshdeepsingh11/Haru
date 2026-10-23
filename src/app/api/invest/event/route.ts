import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { track } from "@/lib/server/invest/service";

export const runtime = "nodejs";

/** POST {kind, ref, tags} — what they open, so the feed learns their interests. */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ kind: z.enum(["open_news", "view_asset", "ask"]), ref: z.string().max(300).nullable(), tags: z.array(z.string().max(120)).max(12).default([]) }));
  await track(ctx, b.kind, b.ref, b.tags);
  return { ok: true };
});
