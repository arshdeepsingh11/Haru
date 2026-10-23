import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { addWatch, removeWatch, WatchInput } from "@/lib/server/invest/service";

export const runtime = "nodejs";

/** POST asset → save to watchlist; DELETE {key} → remove. */
export const POST = route(async (ctx, req) => {
  await addWatch(ctx, await body(req, WatchInput));
  return { ok: true };
});
export const DELETE = route(async (ctx, req) => {
  const b = await body(req, z.object({ key: z.string().min(2).max(120) }));
  await removeWatch(ctx, b.key);
  return { ok: true };
});
