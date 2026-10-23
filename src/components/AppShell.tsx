"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, CalendarDays, FolderOpen, Home, Settings } from "lucide-react";
import type { DashboardData } from "@/lib/server/services/dashboard";
import type { CardKey } from "@/lib/dashboard-registry";
import { Wordmark } from "./Wordmark";
import { AuroraOrb } from "./AuroraOrb";
import { Dashboard } from "./dashboard/Dashboard";
import { CommandCenter } from "./CommandCenter";
import { RecordsSheet } from "./RecordsSheet";
import { InboxSheet, SettingsSheet } from "./SettingsSheet";
import { ScheduleSheet } from "./ScheduleSheet";
import { ScanSheet } from "./ScanSheet";
import { JobsSheet } from "./JobsSheet";
import { CheckoutCard } from "./home/ShiftHome";
import { CurrencyProvider, Sheet, ToastProvider } from "./ui";

const ASK_PREFILL: Record<string, string> = {
  log: "I worked ",
  paycheck: "My paycheck arrived: ",
};

type SheetName = "records" | "settings" | "inbox" | "schedule" | "jobs" | null;

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
  // First run: no cards and setup not finished → the whole app is the conversation.
  const genesis = !data.onboarded && data.cards.length === 0;
  const [chatOpen, setChatOpen] = useState(Boolean(initialAsk) || !data.onboarded);
  const [prefill, setPrefill] = useState<string | null>(initialAsk ? (ASK_PREFILL[initialAsk] ?? null) : null);
  const [autoSend, setAutoSend] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName>(initialSheet);
  const [scanOpen, setScanOpen] = useState(false);
  const [fresh, setFresh] = useState<CardKey[]>([]);
  const checkout = initialCheckout ? (data.coach.checkouts.find((c) => c.id === initialCheckout) ?? null) : null;
  const [checkoutOpen, setCheckoutOpen] = useState(Boolean(checkout));
  const [recordsTab, setRecordsTab] = useState<string | null>(null);
  const [jobFocus, setJobFocus] = useState<string | null>(null);
  const openJobs = useCallback((jobId?: string) => {
    setJobFocus(jobId ?? null);
    setSheet("jobs");
  }, []);

  const ask = useCallback((text: string) => {
    setPrefill(text);
    setChatOpen(true);
  }, []);
  const openRecords = useCallback((tab?: string) => {
    setRecordsTab(tab ?? null);
    setSheet("records");
  }, []);
  const onCardsAdded = useCallback((keys: CardKey[]) => {
    setFresh((f) => [...f, ...keys]);
    setTimeout(() => setFresh((f) => f.filter((k) => !keys.includes(k))), 4000);
  }, []);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const clearAutoSend = useCallback(() => setAutoSend(null), []);

  // Setup just finished: show the dashboard Haru built.
  const [wasOnboarded, setWasOnboarded] = useState(data.onboarded);
  useEffect(() => {
    if (data.onboarded && !wasOnboarded) {
      setWasOnboarded(true);
      setTimeout(() => setChatOpen(false), 1800);
    }
  }, [data.onboarded, wasOnboarded]);

  // Lock page scroll under the full-screen chat on phones.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    document.documentElement.style.overflow = chatOpen && mq.matches ? "hidden" : "";
    return () => {
      document.documentElement.style.overflow = "";
    };
  }, [chatOpen]);

  // Keyboard: "/" opens the conversation.
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

  const chat = (
    <CommandCenter
      prefill={prefill}
      onPrefillUsed={clearPrefill}
      onClose={genesis ? undefined : () => setChatOpen(false)}
      aiConfigured={aiConfigured}
      genesis={genesis}
      setup={!data.onboarded}
      cardCount={data.cards.length}
      vapidPublicKey={vapidPublicKey}
      onCardsAdded={onCardsAdded}
      onViewDashboard={genesis ? undefined : () => setChatOpen(false)}
      onScan={() => setScanOpen(true)}
      autoSend={autoSend}
      onAutoSent={clearAutoSend}
    />
  );

  const sheets = (
    <>
      <RecordsSheet open={sheet === "records"} onClose={() => setSheet(null)} initialTab={recordsTab} />
      <SettingsSheet open={sheet === "settings"} onClose={() => setSheet(null)} vapidPublicKey={vapidPublicKey} />
      <InboxSheet open={sheet === "inbox"} onClose={() => setSheet(null)} />
      <ScheduleSheet open={sheet === "schedule"} onClose={() => setSheet(null)} onScan={() => setScanOpen(true)} onOpenJobs={() => openJobs()} />
      <JobsSheet open={sheet === "jobs"} onClose={() => setSheet(null)} focusJobId={jobFocus} />
      <ScanSheet
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        today={data.today}
        onSaved={(summary) => {
          if (chatOpen || !data.onboarded) setAutoSend(summary);
        }}
      />
      {checkout && (
        <Sheet open={checkoutOpen} onClose={() => setCheckoutOpen(false)} title="Check out of your shift">
          <CheckoutCard s={checkout} today={data.today} taxPercent={data.coach.taxPercent} autoFocus />
        </Sheet>
      )}
    </>
  );

  return (
    <CurrencyProvider value={data.currency}>
      <ToastProvider>
        {genesis ? (
          <div className="mx-auto flex h-dvh max-w-2xl flex-col">
            <div className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
              <Wordmark size={26} />
              <button className="btn btn-quiet h-10 w-10 p-0" onClick={() => setSheet("settings")} aria-label="Settings">
                <Settings size={19} />
              </button>
            </div>
            <div className="min-h-0 flex-1">{chat}</div>
          </div>
        ) : (
          <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]">
            <div className="min-w-0">
              <header className="sticky top-0 z-30 bg-[color:var(--mist)]/75 backdrop-blur-xl">
                <div className="mx-auto flex max-w-2xl items-center gap-1 px-4 pb-2 pt-[max(0.6rem,env(safe-area-inset-top))]">
                  <a href="/" className="mr-auto py-1" aria-label="HARU home">
                    <Wordmark size={26} />
                  </a>
                  <button className="btn btn-quiet relative h-10 w-10 p-0" onClick={() => setSheet("inbox")} aria-label={`Notifications${data.unreadNotifications ? `, ${data.unreadNotifications} unread` : ""}`}>
                    <Bell size={19} />
                    {data.unreadNotifications > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-bloom" aria-hidden />}
                  </button>
                  <div className="hidden items-center gap-1 lg:flex">
                    <button className="btn btn-quiet" onClick={() => setSheet("schedule")}>
                      <CalendarDays size={17} /> Schedule
                    </button>
                    <button className="btn btn-quiet" onClick={() => openRecords()}>
                      <FolderOpen size={17} /> Records
                    </button>
                    <button className="btn btn-quiet h-10 w-10 p-0" onClick={() => setSheet("settings")} aria-label="Settings">
                      <Settings size={18} />
                    </button>
                  </div>
                </div>
              </header>
              <main className="mx-auto max-w-2xl px-4 pb-36 pt-3 lg:pb-16">
                <Dashboard data={data} onAsk={ask} onOpenRecords={openRecords} onOpenSchedule={() => setSheet("schedule")} onOpenJobs={openJobs} fresh={fresh} />
              </main>
            </div>

            {/* The conversation: full screen on phones, a side panel on large screens. */}
            <aside
              aria-label="Talk to Haru"
              className={`${chatOpen ? "fixed inset-0 z-50 flex sheet-enter" : "hidden"} flex-col bg-[color:var(--mist)] lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:animate-none lg:border-l lg:border-line lg:bg-white/40 lg:backdrop-blur-xl`}
            >
              {chat}
            </aside>
          </div>
        )}

        {/* Phone dock: Haru sits in the middle. */}
        {!genesis && !chatOpen && (
          <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
            <div className="mx-auto flex max-w-md items-end justify-between rounded-[28px] border border-white bg-white/95 px-3 py-2 shadow-[0_20px_40px_-20px_rgb(40_44_110/0.45)] ring-1 ring-ink/5 backdrop-blur-2xl">
              <DockButton label="Home" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} active>
                <Home size={21} />
              </DockButton>
              <DockButton label="Schedule" onClick={() => setSheet("schedule")}>
                <CalendarDays size={21} />
              </DockButton>
              <button className="-mt-8 grid justify-items-center gap-1 text-[0.68rem] font-semibold text-ink" onClick={() => setChatOpen(true)} aria-label="Talk to Haru">
                <span className="rounded-full bg-white p-1.5 shadow-[0_14px_30px_-12px_rgb(80_60_230/0.7)]">
                  <AuroraOrb size={54} />
                </span>
                Haru
              </button>
              <DockButton label="Records" onClick={() => openRecords()}>
                <FolderOpen size={21} />
              </DockButton>
              <DockButton label="Settings" onClick={() => setSheet("settings")}>
                <Settings size={21} />
              </DockButton>
            </div>
          </nav>
        )}

        {sheets}
      </ToastProvider>
    </CurrencyProvider>
  );
}

function DockButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`grid w-14 justify-items-center gap-0.5 py-1 text-[0.68rem] font-medium ${active ? "text-ink" : "text-ink-3"}`}>
      {children}
      {label}
    </button>
  );
}
