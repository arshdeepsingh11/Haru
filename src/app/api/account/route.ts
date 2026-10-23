import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { sql } from "@/lib/server/db";
import { body, route } from "@/lib/server/http";
import { supabaseServer } from "@/lib/server/context";
import { AppError, logError } from "@/lib/server/errors";

export const runtime = "nodejs";

/**
 * Permanently delete all of the user's HARU data (every table cascades from app_users).
 * If SUPABASE_SERVICE_ROLE_KEY is set, the login identity is deleted too; otherwise the
 * user is signed out and the identity can be removed in the Supabase dashboard.
 */
export const DELETE = route(async (ctx, req) => {
  const b = await body(req, z.object({ confirm: z.literal("DELETE") }));
  if (b.confirm !== "DELETE") throw new AppError("Type DELETE to confirm.");
  await sql`delete from app_users where id = ${ctx.userId}`;
  let identityDeleted = false;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (service && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, service, { auth: { persistSession: false } });
      const { error } = await admin.auth.admin.deleteUser(ctx.userId);
      identityDeleted = !error;
    } catch (e) {
      logError("account.delete", e);
    }
  }
  const sb = await supabaseServer();
  await sb.auth.signOut();
  return { deleted: true, identityDeleted };
});
