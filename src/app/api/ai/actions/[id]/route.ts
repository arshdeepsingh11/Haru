import { z } from "zod";
import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/server/context";
import { body, errorResponse } from "@/lib/server/http";
import { resolveAction } from "@/lib/ai/agent";
import { zId } from "@/lib/validation";
import { AppError } from "@/lib/server/errors";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCtx();
    const { id } = await params;
    if (!zId.safeParse(id).success) throw new AppError("Invalid action id.");
    const b = await body(req, z.object({ decision: z.enum(["confirm", "cancel", "undo"]) }));
    return NextResponse.json(await resolveAction(ctx, id, b.decision));
  } catch (e) {
    return errorResponse(e);
  }
}
