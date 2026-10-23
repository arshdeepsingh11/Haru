"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Download, Loader2, LogOut, RotateCcw, X } from "lucide-react";
import { forgetMemory, freshStart, loadMemory, loadSettings, readNotifications, signOut, type SettingsData } from "@/app/actions";
import { NotificationSettings } from "./Notifications";
import { Empty, Sheet, useAct, useToast } from "./ui";

const ZONES = ["America/Edmonton", "America/Vancouver", "America/Regina", "America/Winnipeg", "America/Toronto", "America/Halifax", "America/St_Johns", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "UTC"];

function useSettings(open: boolean) {
  const [s, setS] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setError(null);
      setS(await loadSettings());
    } catch {
      setError("Couldn't load settings. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);
  return { s, error, reload };
}

export function SettingsSheet({ open, onClose, vapidPublicKey }: { open: boolean; onClose: () => void; vapidPublicKey: string | null }) {
  const { s, error, reload } = useSettings(open);
  const { run, pending } = useAct();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState("");

  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !s ? (
        <p className="flex items-center gap-2 text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</p>
      ) : (
        <div className="grid gap-8">
          <section className="grid gap-3">
            <h3 className="section-title">Notifications</h3>
            <NotificationSettings s={s} vapidPublicKey={vapidPublicKey} onChanged={reload} />
          </section>

          <section className="grid gap-3 border-t border-line pt-6">
            <h3 className="section-title">You</h3>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                run("updatePrefs", {
                  display_name: String(fd.get("display_name") ?? ""),
                  currency: String(fd.get("currency")),
                  timezone: String(fd.get("timezone")),
                  week_starts_on: Number(fd.get("week_starts_on")),
                  reserve_percent: Number(fd.get("reserve_percent")),
                }, (r) => r.ok && reload());
              }}
            >
              <label className="field">Name<input className="input" name="display_name" defaultValue={s.prefs.display_name ?? ""} /></label>
              <label className="field">
                Currency
                <select className="input" name="currency" defaultValue={s.prefs.currency}>
                  {["CAD", "USD", "EUR", "GBP", "INR", "AUD", "JPY"].map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="field">
                Time zone
                <select className="input" name="timezone" defaultValue={s.prefs.timezone}>
                  {[...new Set([s.prefs.timezone, ...ZONES])].map((z) => <option key={z}>{z}</option>)}
                </select>
              </label>
              <label className="field">
                Weeks start on
                <select className="input" name="week_starts_on" defaultValue={s.prefs.week_starts_on}>
                  <option value={1}>Monday</option>
                  <option value={0}>Sunday</option>
                </select>
              </label>
              <label className="field sm:col-span-2">
                Reserve estimate (% of income, for planning)
                <input className="input" type="number" min={0} max={100} step="0.5" name="reserve_percent" defaultValue={s.prefs.reserve_percent} />
                <span className="text-xs text-ink-3">A planning cushion only. It isn't a tax calculation and HARU doesn't move any money.</span>
              </label>
              <button className="btn btn-primary w-fit" disabled={pending}>Save</button>
            </form>
          </section>

          <HaruMemory />

          <section className="grid gap-3 border-t border-line pt-6">
            <h3 className="section-title">Your data</h3>
            <div className="flex flex-wrap gap-2">
              <a className="btn btn-line" href="/api/export?type=all" download>
                <Download size={14} /> Export everything (JSON)
              </a>
              <a className="btn btn-line" href="/api/export?period=this_month" download>
                <Download size={14} /> This month's report (CSV)
              </a>
              <button className="btn btn-quiet" onClick={async () => { await signOut(); window.location.href = "/login"; }}>
                <LogOut size={14} /> Sign out
              </button>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-brick">Delete my account and data</summary>
              <div className="mt-3 grid gap-2">
                <p className="text-sm text-ink-2">This permanently deletes every job, shift, transaction, conversation and setting. Export first if you want a copy. Type DELETE to confirm.</p>
                <input className="input max-w-48" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} aria-label="Type DELETE to confirm" />
                <button
                  className="btn btn-danger w-fit"
                  disabled={confirmDelete !== "DELETE"}
                  onClick={async () => {
                    const res = await fetch("/api/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "DELETE" }) });
                    if (res.ok) window.location.href = "/login";
                    else toast((await res.json()).error ?? "Deletion failed. Nothing was deleted.", "error");
                  }}
                >
                  Delete everything
                </button>
              </div>
            </details>
            <p className="text-xs text-ink-3">Signed in as {s.email}</p>
          </section>
        </div>
      )}
    </Sheet>
  );
}

type Fact = Awaited<ReturnType<typeof loadMemory>>[number];

/** What Haru remembers, with a way to remove anything wrong, and a fresh start that keeps your money records. */
function HaruMemory() {
  const toast = useToast();
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [wipeMemory, setWipeMemory] = useState(true);
  const [wipeChats, setWipeChats] = useState(true);
  const reload = useCallback(() => {
    loadMemory().then(setFacts).catch(() => setFacts([]));
  }, []);
  useEffect(reload, [reload]);

  return (
    <section className="grid gap-3 border-t border-line pt-6">
      <h3 className="section-title flex items-center gap-2">
        <Brain size={16} /> What Haru remembers
      </h3>
      <p className="text-sm text-ink-2">Haru reads these on every message. Remove anything that's wrong or out of date.</p>
      {!facts ? (
        <p className="flex items-center gap-2 text-sm text-ink-3"><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : facts.length === 0 ? (
        <p className="text-sm text-ink-3">Nothing yet. Haru saves corrections and preferences as you talk.</p>
      ) : (
        <ul className="grid gap-1.5">
          {facts.map((f) => (
            <li key={f.id} className="glass flex items-start gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{f.fact}</span>
              <button
                className="btn btn-quiet h-7 w-7 min-h-0 shrink-0 p-0"
                aria-label={`Forget: ${f.fact}`}
                onClick={async () => {
                  const r = await forgetMemory(f.id);
                  if (r.ok) setFacts((xs) => xs?.filter((x) => x.id !== f.id) ?? null);
                  else toast(r.error, "error");
                }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-sm font-semibold">Fresh start for Haru</summary>
        <div className="mt-3 grid gap-2.5">
          <p className="text-sm text-ink-2">Clears what Haru learned and your old chats, so earlier mistakes can't come back. Your jobs, shifts, bills and balances are kept.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wipeMemory} onChange={(e) => setWipeMemory(e.target.checked)} /> Forget everything Haru remembers
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wipeChats} onChange={(e) => setWipeChats(e.target.checked)} /> Delete chat history
          </label>
          <button
            className="btn btn-line w-fit"
            disabled={busy || (!wipeMemory && !wipeChats)}
            onClick={async () => {
              setBusy(true);
              const r = await freshStart({ memory: wipeMemory, chats: wipeChats });
              setBusy(false);
              toast(r.ok ? r.summary : r.error, r.ok ? "ok" : "error");
              if (r.ok) {
                reload();
                if (wipeChats) window.location.reload();
              }
            }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Start fresh
          </button>
        </div>
      </details>
    </section>
  );
}

export function InboxSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { s, error, reload } = useSettings(open);
  useEffect(() => {
    if (open && s && s.notifications.some((n) => !n.read)) readNotifications().then(() => {});
  }, [open, s]);
  return (
    <Sheet open={open} onClose={onClose} title="Notifications">
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !s ? (
        <p className="flex items-center gap-2 text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</p>
      ) : s.notifications.length === 0 ? (
        <Empty>Nothing yet. Reminders HARU sends will be listed here too.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {s.notifications.map((n) => (
            <li key={n.id} className="py-3">
              <p className={n.read ? "" : "font-semibold"}>{n.title}</p>
              {n.body && <p className="text-sm text-ink-2">{n.body}</p>}
              <p className="mt-0.5 text-xs text-ink-3">
                {new Date(n.at).toLocaleString("en-CA", { timeZone: s.prefs.timezone, dateStyle: "medium", timeStyle: "short" })}
                {n.status === "failed" ? " — push delivery failed" : n.note ? ` — ${n.note}` : " — sent as a push notification"}
              </p>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-quiet mt-3 text-xs" onClick={reload}>Refresh</button>
    </Sheet>
  );
}
