import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { setProfile, zCountry } from "@/lib/server/invest/service";

export const runtime = "nodejs";

/** POST {countries?} or {country, interests} — what this person follows. */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ countries: z.array(zCountry).min(1).max(3).optional(), country: zCountry.optional(), interests: z.array(z.string().min(2).max(40)).max(20).optional() }));
  return setProfile(ctx, b);
});
