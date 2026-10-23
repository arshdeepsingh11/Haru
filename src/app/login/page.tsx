import { LoginForm } from "./LoginForm";
import { Wordmark } from "@/components/Wordmark";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return (
    <main className="mx-auto grid min-h-dvh max-w-[26rem] content-center gap-10 px-6 py-12">
      <div>
        <Wordmark size="lg" tagline />
        <p className="mt-6 max-w-[30ch] text-ink-2">Know where you work, what you've earned, when you're paid, and what's safe to spend.</p>
      </div>
      {configured ? (
        <LoginForm />
      ) : (
        <p className="panel p-5 text-sm text-ink-2">
          Sign-in isn't configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (see the README).
        </p>
      )}
    </main>
  );
}
