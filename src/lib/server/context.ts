import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { sql } from "./db";
import { AppError } from "./errors";
import { DEFAULT_TZ, todayIn } from "../domain/time";
import { loadPrefs, type Ctx } from "./user-context";

export type { Ctx, Prefs } from "./user-context";
export { ctxForUser, loadPrefs } from "./user-context";

export async function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new AppError("Authentication is not configured (Supabase env vars missing).", 503, "auth_unconfigured");
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component — the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** The authenticated user, provisioned on first sight. Null when signed out. Cached per request. */
export const getCtx = cache(async (): Promise<Ctx | null> => {
  const sb = await supabaseServer();
  const { data, error } = await sb.auth.getUser(); // verifies the JWT with Supabase
  if (error || !data.user) return null;
  const userId = data.user.id;
  const email = data.user.email ?? null;
  await sql`insert into app_users (id, email) values (${userId}, ${email}) on conflict (id) do nothing`;
  await sql`insert into user_preferences (user_id) values (${userId}) on conflict (user_id) do nothing`;
  const prefs = await loadPrefs(userId);
  const tz = prefs.timezone || DEFAULT_TZ;
  const now = new Date();
  return { userId, email, prefs, tz, currency: prefs.currency, today: todayIn(tz, now), now };
});

export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) throw new AppError("Please sign in.", 401, "unauthenticated");
  return ctx;
}
