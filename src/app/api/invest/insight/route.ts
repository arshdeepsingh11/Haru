import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { insight, zCountry } from "@/lib/server/invest/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST {country, key?|interest?} — Haru's AI read, built only from computed facts and matched headlines. */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ country: zCountry, key: z.string().min(2).max(120).optional(), interest: z.string().min(2).max(40).optional() }).refine((x) => x.key || x.interest, "key or interest"));
  return insight(ctx, b);
});
