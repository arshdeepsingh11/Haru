import { LoginForm } from "./LoginForm";
import { AuroraOrb } from "@/components/AuroraOrb";
import { Wordmark } from "@/components/Wordmark";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return (
    <main className="mx-auto grid min-h-dvh max-w-[26rem] content-center gap-8 px-5 py-12">
      <div className="grid justify-items-center text-center">
        <AuroraOrb size={132} />
        <div className="mt-8">
          <Wordmark size={30} />
        </div>
        <h1 className="mt-5 text-[1.65rem] font-semibold leading-tight tracking-tight">Every shift has a number.</h1>
        <p className="mt-2 max-w-[30ch] text-ink-2">Tell Haru your jobs and goals. It builds your money dashboard and keeps you on track.</p>
      </div>
      {configured ? (
        <div className="glass p-5">
          <LoginForm />
        </div>
      ) : (
        <p className="glass p-5 text-sm text-ink-2">
          Sign-in isn't configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (see the README).
        </p>
      )}
    </main>
  );
}
