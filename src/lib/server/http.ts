import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireCtx, type Ctx } from "./context";
import { AppError, logError, publicMessage } from "./errors";

/** JSON route wrapper: authenticated context, validated body, honest errors. */
export function route<T>(handler: (ctx: Ctx, req: Request) => Promise<T>) {
  return async (req: Request) => {
    try {
      const ctx = await requireCtx();
      return NextResponse.json(await handler(ctx, req));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown) {
  if (!(e instanceof AppError)) logError("route", e);
  const status = e instanceof AppError ? e.status : 500;
  return NextResponse.json({ error: publicMessage(e), code: e instanceof AppError ? e.code : "internal" }, { status });
}

export async function body<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("Expected a JSON body.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError(r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return r.data;
}
