import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

// Refreshes the Supabase session cookie on every request and keeps signed-out
// visitors on the public pages. Authorisation is still enforced server-side in
// every route and action — this is only routing.
const PUBLIC = ["/login", "/auth", "/api/cron", "/api/push/ack", "/manifest.webmanifest", "/sw.js", "/icons", "/favicon"];

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  if (!data.user && !PUBLIC.some((p) => path.startsWith(p))) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.search = "";
    return NextResponse.redirect(to);
  }
  if (data.user && path === "/login") {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:png|svg|ico|webp|jpg)$).*)"],
};
