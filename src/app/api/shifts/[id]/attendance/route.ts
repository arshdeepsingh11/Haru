import { z } from "zod";
import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/server/context";
import { body, errorResponse } from "@/lib/server/http";
import { setAttendance } from "@/lib/server/services/shiftloop";
import { zId } from "@/lib/validation";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

// "Are you going to this shift?" — answered in the app or from the notification buttons.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCtx();
    const { id } = await params;
    if (!zId.safeParse(id).success) throw new AppError("Invalid shift id.");
    const b = await body(req, z.object({ going: z.boolean() }));
    const r = await setAttendance(ctx, id, b.going, "user");
    return NextResponse.json({ ok: true, summary: r.summary, data: r.data });
  } catch (e) {
    return errorResponse(e);
  }
}
