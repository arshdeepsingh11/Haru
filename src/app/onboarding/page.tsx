import { redirect } from "next/navigation";
import { getCtx } from "@/lib/server/context";
import { Onboarding } from "./Onboarding";

export const metadata = { title: "Welcome" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  if (ctx.prefs.onboarded_at) redirect("/");
  return <Onboarding today={ctx.today} defaults={{ name: ctx.prefs.display_name ?? "", currency: ctx.currency, timezone: ctx.tz }} vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} />;
}
