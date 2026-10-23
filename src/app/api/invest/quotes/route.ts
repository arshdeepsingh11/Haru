import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { quotesFor } from "@/lib/server/invest/service";

export const runtime = "nodejs";
export const maxDuration = 30;

/** POST {keys: string[]} — fresh quotes for assets on screen (refresh and fill-in). */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ keys: z.array(z.string().min(2).max(120)).min(1).max(30) }));
  return { quotes: await quotesFor(ctx, b.keys) };
});
