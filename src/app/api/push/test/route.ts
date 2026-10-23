import { z } from "zod";
import { sql } from "@/lib/server/db";
import { body, route } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { pushConfigured, sendPush } from "@/lib/server/notifications/push";
import { zId } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Send a test push to the user's devices. The response says whether each push
 * service ACCEPTED it; the device confirms DISPLAY separately via /api/push/ack,
 * which the client polls with GET.
 */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ endpoint: z.string().url().optional() }));
  if (!pushConfigured()) throw new AppError("Push isn't configured on the server yet (VAPID keys missing).", 503);
  const subs = await sql<{ id: string; endpoint: string; p256dh: string; auth: string; user_agent: string | null }[]>`
    select id, endpoint, p256dh, auth, user_agent from push_subscriptions where user_id = ${ctx.userId}
    ${b.endpoint ? sql`and endpoint = ${b.endpoint}` : sql``}`;
  if (subs.length === 0) throw new AppError("This device isn't subscribed. Enable notifications first.", 409);
  const out = [];
  for (const s of subs) {
    const [d] = await sql<{ id: string }[]>`
      insert into notification_deliveries (user_id, subscription_id, kind, status) values (${ctx.userId}, ${s.id}, 'test', 'failed') returning id`;
    const r = await sendPush(s, { title: "HARU test notification", body: "If you can see this, notifications work on this device.", url: "/?settings=notifications", tag: `test-${d.id}`, deliveryId: d.id });
    if (r.ok) await sql`update notification_deliveries set status = 'accepted', http_status = ${r.status} where id = ${d.id}`;
    else {
      await sql`update notification_deliveries set status = ${r.gone ? "gone" : "failed"}, http_status = ${r.status}, error = ${r.error} where id = ${d.id}`;
      if (r.gone) await sql`delete from push_subscriptions where id = ${s.id}`;
    }
    out.push({ deliveryId: d.id, accepted: r.ok, status: r.ok ? r.status : r.status, error: r.ok ? null : r.error, gone: !r.ok && r.gone });
  }
  return { results: out };
});

export const GET = route(async (ctx, req) => {
  const id = new URL(req.url).searchParams.get("deliveryId") ?? "";
  if (!zId.safeParse(id).success) throw new AppError("Invalid delivery id.");
  const [d] = await sql<{ status: string; displayed_at: Date | null; error: string | null }[]>`
    select status, displayed_at, error from notification_deliveries where id = ${id} and user_id = ${ctx.userId}`;
  if (!d) throw new AppError("Unknown delivery.", 404);
  return { status: d.status, displayed: Boolean(d.displayed_at), displayedAt: d.displayed_at?.toISOString() ?? null, error: d.error };
});
