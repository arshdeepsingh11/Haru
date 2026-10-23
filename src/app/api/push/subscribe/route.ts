import { z } from "zod";
import { sql } from "@/lib/server/db";
import { body, route } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

const Sub = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "Push endpoints must be https"),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

/** Store this browser's push subscription. Enabling also turns on notify_enabled. */
export const POST = route(async (ctx, req) => {
  const b = await body(req, z.object({ subscription: Sub }));
  const ua = req.headers.get("user-agent")?.slice(0, 200) ?? null;
  // An endpoint belongs to exactly one user; re-subscribing on a shared browser moves it.
  await sql`
    insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (${ctx.userId}, ${b.subscription.endpoint}, ${b.subscription.keys.p256dh}, ${b.subscription.keys.auth}, ${ua})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      user_agent = excluded.user_agent, failure_count = 0`;
  await sql`update user_preferences set notify_enabled = true, updated_at = now() where user_id = ${ctx.userId}`;
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where user_id = ${ctx.userId}`;
  return { subscribed: true, devices: n.n };
});

export const DELETE = route(async (ctx, req) => {
  const b = await body(req, z.object({ endpoint: z.string().url().optional(), disableAll: z.boolean().optional() }));
  if (!b.endpoint && !b.disableAll) throw new AppError("Nothing to unsubscribe.");
  if (b.endpoint) await sql`delete from push_subscriptions where user_id = ${ctx.userId} and endpoint = ${b.endpoint}`;
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from push_subscriptions where user_id = ${ctx.userId}`;
  if (b.disableAll || n.n === 0) await sql`update user_preferences set notify_enabled = false, updated_at = now() where user_id = ${ctx.userId}`;
  return { subscribed: false, devices: n.n };
});
