import { z } from "zod";
import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/server/context";
import { body, errorResponse } from "@/lib/server/http";
import { checkoutShift } from "@/lib/server/services/shiftloop";
import { zId } from "@/lib/validation";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

// "Did you finish your shift?" — full shift, fewer hours, or missed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCtx();
    const { id } = await params;
    if (!zId.safeParse(id).success) throw new AppError("Invalid shift id.");
    const b = await body(req, z.object({ full: z.boolean().optional(), hours: z.number().gt(0).max(24).optional(), missed: z.boolean().optional() }));
    if (!b.full && b.hours == null && !b.missed) throw new AppError("Say whether you worked the full shift, how many hours, or missed it.");
    const r = await checkoutShift(ctx, id, b, "user");
    return NextResponse.json({ ok: true, summary: r.summary, data: r.data });
  } catch (e) {
    return errorResponse(e);
  }
}
