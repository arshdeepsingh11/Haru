import { z } from "zod";
import { body, route } from "@/lib/server/http";
import { addAlert, AlertInput, listAlerts, removeAlert } from "@/lib/server/invest/planning";

export const runtime = "nodejs";

/** GET ?key= → alerts (for one asset or all); POST {key, direction, target}; DELETE {id}. */
export const GET = route(async (ctx, req) => ({ alerts: await listAlerts(ctx, new URL(req.url).searchParams.get("key") ?? undefined) }));
export const POST = route(async (ctx, req) => ({ alert: await addAlert(ctx, await body(req, AlertInput)) }));
export const DELETE = route(async (ctx, req) => {
  const b = await body(req, z.object({ id: z.number().int().positive() }));
  await removeAlert(ctx, b.id);
  return { ok: true };
});
