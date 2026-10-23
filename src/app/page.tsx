import { redirect } from "next/navigation";
import { getCtx } from "@/lib/server/context";
import { getDashboard } from "@/lib/server/services/dashboard";
import { materializeSchedules } from "@/lib/server/services/shifts";
import { refreshObservations } from "@/lib/server/services/observations";
import { logError, publicMessage } from "@/lib/server/errors";
import { AppShell } from "@/components/AppShell";
import { aiConfigured } from "@/lib/ai/provider";
import { Wordmark } from "@/components/Wordmark";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  let ctx;
  try {
    ctx = await getCtx();
  } catch (e) {
    logError("home.ctx", e);
    return <Unavailable message={publicMessage(e)} />;
  }
  if (!ctx) redirect("/login");

  try {
    // Keep generated schedule shifts and observations current; failures here are non-fatal.
    await materializeSchedules(ctx, 14).catch((e) => logError("home.schedule", e));
    await refreshObservations(ctx).catch((e) => logError("home.observations", e));
    const data = await getDashboard(ctx);
    return (
      <AppShell
        data={data}
        email={ctx.email}
        initialAsk={sp.ask ?? null}
        initialSheet={sp.settings ? "settings" : sp.schedule ? "schedule" : null}
        initialCheckout={sp.checkout ?? null}
        vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
        aiConfigured={aiConfigured()}
      />
    );
  } catch (e) {
    logError("home", e);
    return <Unavailable message={publicMessage(e)} />;
  }
}

function Unavailable({ message }: { message: string }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center gap-4 px-6">
      <Wordmark />
      <h1 className="text-xl font-semibold">HARU can't load your dashboard</h1>
      <p className="text-ink-2">{message}</p>
      <a className="btn btn-primary w-fit" href="/">
        Try again
      </a>
    </main>
  );
}
