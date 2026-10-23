import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/server/context";

// Exchanges the one-time code from a Supabase confirmation/OAuth redirect for a session.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }
  return NextResponse.redirect(new URL("/", url.origin));
}
