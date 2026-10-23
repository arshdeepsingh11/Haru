import { NextResponse } from "next/server";
import { sql } from "@/lib/server/db";
import { zId } from "@/lib/validation";

export const runtime = "nodejs";

// Called by the service worker right after it shows a notification. The delivery id
// is an unguessable UUID that only this device received; it can only set displayed_at
// once, within a day, and reveals nothing.
export async function POST(req: Request) {
  try {
    const { deliveryId } = (await req.json()) as { deliveryId?: string };
    if (!deliveryId || !zId.safeParse(deliveryId).success) return NextResponse.json({ ok: false }, { status: 400 });
    await sql`update notification_deliveries set displayed_at = now()
              where id = ${deliveryId} and displayed_at is null and created_at > now() - interval '1 day'`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
