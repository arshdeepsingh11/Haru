import { route } from "@/lib/server/http";
import { overview, zCountry } from "@/lib/server/invest/service";

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET ?country=IN|CA|WORLD — everything the Invest tab shows for one country. */
export const GET = route(async (ctx, req) => {
  const c = zCountry.safeParse(new URL(req.url).searchParams.get("country") ?? "IN");
  return overview(ctx, c.success ? c.data : "IN");
});
