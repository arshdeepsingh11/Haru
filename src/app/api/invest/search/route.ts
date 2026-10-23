import { route } from "@/lib/server/http";
import { search, zCountry } from "@/lib/server/invest/service";

export const runtime = "nodejs";
export const maxDuration = 20;

/** GET ?q=&country= — stocks, ETFs and (India) mutual funds by name or symbol. */
export const GET = route(async (ctx, req) => {
  const u = new URL(req.url);
  const c = zCountry.safeParse(u.searchParams.get("country") ?? "WORLD");
  return { results: await search(ctx, u.searchParams.get("q") ?? "", c.success ? c.data : "WORLD") };
});
