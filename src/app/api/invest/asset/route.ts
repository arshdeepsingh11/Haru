import { route } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { RANGES, type Range } from "@/lib/invest/analytics";
import { assetDetail } from "@/lib/server/invest/service";

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET ?key=&range= — price, chart, computed stats and related news for one asset. */
export const GET = route(async (ctx, req) => {
  const u = new URL(req.url);
  const key = u.searchParams.get("key") ?? "";
  if (key.length < 2 || key.length > 120) throw new AppError("Missing asset.");
  const r = u.searchParams.get("range") as Range;
  return assetDetail(ctx, key, RANGES.includes(r) ? r : "1Y");
});
