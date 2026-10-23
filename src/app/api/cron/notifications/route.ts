import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runScheduler } from "@/lib/server/notifications/scheduler";
import { logError } from "@/lib/server/errors";
import { refreshNewsIfStale } from "@/lib/server/invest/news";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET". Supabase pg_cron
// (via pg_net) or any external scheduler can POST the same header every minute.
async function handle(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const result = await runScheduler();
    // Headlines for the Invest tab refresh every 15 minutes on the same heartbeat.
    await refreshNewsIfStale(8000).catch((e) => logError("cron.news", e));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logError("cron", e);
    return NextResponse.json({ ok: false, error: "Scheduler run failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
