"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

export function LoginForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const sb = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    try {
      if (mode === "in") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = "/";
      } else {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
        if (error) throw error;
        if (data.session) window.location.href = "/onboarding";
        else setMsg({ tone: "info", text: "Account created. Your Supabase project requires confirming the address before signing in." });
      }
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message || "Sign-in failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <label className="field">
        Email
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        Password
        <input className="input" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {msg && (
        <p role="alert" className={`text-sm ${msg.tone === "error" ? "text-brick" : "text-ink-2"}`}>
          {msg.text}
        </p>
      )}
      <button className="btn btn-primary h-11" disabled={busy}>
        {busy ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}
      </button>
      <button type="button" className="btn btn-quiet" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
