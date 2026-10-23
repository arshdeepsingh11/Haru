"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, CalendarDays, FolderOpen, MessageSquareText, Settings } from "lucide-react";
import type { DashboardData } from "@/lib/server/services/dashboard";
import { Wordmark } from "./Wordmark";
import { Dashboard } from "./dashboard/Dashboard";
import { CommandCenter } from "./CommandCenter";
import { RecordsSheet } from "./RecordsSheet";
import { InboxSheet, SettingsSheet } from "./SettingsSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { CheckoutCard } from "./home/ShiftHome";
import { CurrencyProvider, Sheet, ToastProvider } from "./ui";

const ASK_PREFILL: Record<string, string> = {
  log: "I worked ",
  paycheck: "My paycheck arrived: ",
};

export function AppShell({
  data,
  initialAsk,
  initialSheet,
  initialCheckout,
  vapidPublicKey,
  aiConfigured,
}: {
  data: DashboardData;
  email: string | null;
  initialAsk: string | null;
  initialSheet: "settings" | "schedule" | null;
  initialCheckout?: string | null;
  vapidPublicKey: string | null;
  aiConfigured: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(Boolean(initialAsk));
  const [prefill, setPrefill] = useState<string | null>(initialAsk ? (ASK_PREFILL[initialAsk] ?? null) : null);
  const [sheet, setSheet] = useState<"records" | "settings" | "inbox" | "schedule" | null>(initialSheet);
  const checkout = initialCheckout ? data.coach.checkouts.find((c) => c.id === initialCheckout) ?? null : null;
  const [checkoutOpen, setCheckoutOpen] = useState(Boolean(checkout));
  const [recordsTab, setRecordsTab] = useState<string | null>(null);

  const ask = useCallback((text: string) => {
    setPrefill(text);
    setChatOpen(true);
  }, []);
  const openRecords = useCallback((tab?: string) => {
    setRecordsTab(tab ?? null);
    setSheet("records");
  }, []);

  // Keyboard: "/" focuses the command center.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        setChatOpen(true);
        setTimeout(() => document.getElementById("haru-input")?.focus(), 30);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CurrencyProvider value={data.currency}>
      <ToastProvider>
        <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
          <div className="min-w-0">
            <header className="glass sticky top-0 z-30 border-b border-line">
              <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-4">
                <a href="/" className="mr-auto" aria-label="HARU home">
                  <Wordmark />
                </a>
                <button className="btn btn-quiet px-2.5" onClick={() => setSheet("schedule")} aria-label="Schedule">
                  <CalendarDays size={18} /> <span className="hidden sm:inline">Schedule</span>
                </button>
                <button className="btn btn-quiet px-2.5" onClick={() => openRecords()} aria-label="Records">
                  <FolderOpen size={18} /> <span className="hidden sm:inline">Records</span>
                </button>
                <button className="btn btn-quiet relative px-2.5" onClick={() => setSheet("inbox")} aria-label={`Notifications${data.unreadNotifications ? `, ${data.unreadNotifications} unread` : ""}`}>
                  <Bell size={18} />
                  {data.unreadNotifications > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brick" aria-hidden />}
                </button>
                <button className="btn btn-quiet px-2.5" onClick={() => setSheet("settings")} aria-label="Settings">
                  <Settings size={18} />
                </button>
              </div>
            </header>
            <main className="mx-auto max-w-3xl px-4 pb-32 pt-6 lg:pb-16">
              <Dashboard data={data} onAsk={ask} onOpenRecords={openRecords} onOpenSchedule={() => setSheet("schedule")} />
              <footer className="mt-12 text-xs text-ink-3">HARU, Work for Haru.</footer>
            </main>
          </div>

          {/* One command center: a side panel on large screens, a full sheet on small ones. */}
          <aside
            aria-label="HARU command center"
            className={`${chatOpen ? "fixed inset-0 z-50 flex" : "hidden"} glass flex-col lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:border-l lg:border-line`}
          >
            <CommandCenter prefill={prefill} onPrefillUsed={() => setPrefill(null)} onClose={() => setChatOpen(false)} aiConfigured={aiConfigured} />
          </aside>
        </div>

        {!chatOpen && (
          <button
            onClick={() => setChatOpen(true)}
            className="glass fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex h-13 items-center gap-3 rounded-full border border-line px-5 py-3.5 text-left text-ink-2 shadow-lg lg:hidden"
          >
            <MessageSquareText size={18} className="text-ink" aria-hidden />
            Ask HARU or log something…
          </button>
        )}

        <RecordsSheet open={sheet === "records"} onClose={() => setSheet(null)} initialTab={recordsTab} />
        <SettingsSheet open={sheet === "settings"} onClose={() => setSheet(null)} vapidPublicKey={vapidPublicKey} />
        <InboxSheet open={sheet === "inbox"} onClose={() => setSheet(null)} />
        <ScheduleSheet open={sheet === "schedule"} onClose={() => setSheet(null)} />
        {checkout && (
          <Sheet open={checkoutOpen} onClose={() => setCheckoutOpen(false)} title="Check out of your shift">
            <CheckoutCard s={checkout} today={data.today} taxPercent={data.coach.taxPercent} autoFocus />
          </Sheet>
        )}
      </ToastProvider>
    </CurrencyProvider>
  );
}
