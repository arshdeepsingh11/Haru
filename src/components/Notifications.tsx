"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Check, Loader2, Send } from "lucide-react";
import type { SettingsData } from "@/app/actions";
import { useAct, useToast } from "./ui";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type Support = { ok: true } | { ok: false; reason: string };

function detectSupport(): Support {
  if (typeof window === "undefined") return { ok: false, reason: "" };
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return { ok: false, reason: "On iPhone and iPad, notifications work only after you add HARU to your Home Screen: tap Share, then “Add to Home Screen”, and open HARU from there." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return { ok: false, reason: "This browser doesn't support push notifications. Reminders still appear inside HARU." };
  return { ok: true };
}

type TestState =
  | { stage: "idle" }
  | { stage: "sending" }
  | { stage: "accepted"; deliveryId: string }
  | { stage: "displayed" }
  | { stage: "unconfirmed" }
  | { stage: "failed"; error: string };

export function NotificationSettings({ s, vapidPublicKey, onChanged }: { s: SettingsData; vapidPublicKey: string | null; onChanged: () => void }) {
  const toast = useToast();
  const { run, pending } = useAct();
  const [support, setSupport] = useState<Support>({ ok: false, reason: "" });
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ stage: "idle" });

  const inspect = useCallback(async () => {
    const sup = detectSupport();
    setSupport(sup);
    if (!sup.ok) return setPermission("unsupported");
    setPermission(Notification.permission);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    setEndpoint(sub?.endpoint ?? null);
  }, []);

  useEffect(() => {
    inspect();
  }, [inspect]);

  const serverKnowsThisDevice = endpoint != null && s.devices.some((d) => d.endpoint === endpoint);

  async function enable() {
    if (!vapidPublicKey || !s.pushConfigured) return toast("Push isn't configured on the server yet. See the README (VAPID keys).", "error");
    setBusy(true);
    try {
      const p = await Notification.requestPermission(); // only ever called from this button
      setPermission(p);
      if (p !== "granted") throw new Error(p === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." : "Permission wasn't granted.");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
      const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Couldn't save the subscription.");
      setEndpoint(sub.endpoint);
      toast("This device is subscribed. Send a test to confirm delivery.");
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub?.endpoint, disableAll: !sub }) });
      setEndpoint(null);
      toast("Notifications are off on this device.");
      onChanged();
    } catch {
      toast("Couldn't turn notifications off. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTest({ stage: "sending" });
    try {
      const res = await fetch("/api/push/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Test failed.");
      const r = j.results[0];
      if (!r.accepted) throw new Error(r.gone ? "The push service says this subscription has expired. Turn notifications off and on again." : `The push service rejected it (${r.status ?? "network error"}).`);
      setTest({ stage: "accepted", deliveryId: r.deliveryId });
      for (let i = 0; i < 14; i++) {
        await new Promise((ok) => setTimeout(ok, 1500));
        const st = await fetch(`/api/push/test?deliveryId=${r.deliveryId}`).then((x) => x.json());
        if (st.displayed) return setTest({ stage: "displayed" });
      }
      setTest({ stage: "unconfirmed" });
    } catch (e) {
      setTest({ stage: "failed", error: (e as Error).message });
    }
  }

  const p = s.prefs;
  const cats: [string, string][] = [
    ["shift", "Before shifts"],
    ["log_hours", "Log my hours"],
    ["payday", "Paydays"],
    ["bill", "Bills due"],
    ["opportunity", "One-time work"],
    ["goal", "Goal reminders"],
    ["custom", "Reminders I ask for"],
  ];

  return (
    <div className="grid gap-5">
      <section className="grid gap-3">
        {!support.ok ? (
          <p className="rounded-xl bg-amber-soft px-3 py-2 text-sm">{support.reason || "Checking this browser…"}</p>
        ) : !s.pushConfigured ? (
          <p className="rounded-xl bg-amber-soft px-3 py-2 text-sm">The server doesn't have push keys configured yet, so devices can't subscribe. Reminders still appear in HARU's inbox.</p>
        ) : serverKnowsThisDevice && permission === "granted" ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="chip chip-moss">
              <Bell size={12} /> On for this device
            </span>
            <button className="btn btn-line" onClick={sendTest} disabled={test.stage === "sending" || test.stage === "accepted"}>
              <Send size={14} /> Send a test
            </button>
            <button className="btn btn-quiet" onClick={disable} disabled={busy}>
              <BellOff size={14} /> Turn off here
            </button>
          </div>
        ) : (
          <div className="grid gap-2">
            <p className="text-sm text-ink-2">Get reminders on this device even when HARU isn't open: before shifts, to log hours, on paydays and before bills are due.</p>
            {permission === "denied" ? (
              <p className="text-sm text-brick">Notifications are blocked for this site. Open your browser's site settings (the icon left of the address bar), allow notifications, then reload.</p>
            ) : (
              <button className="btn btn-primary w-fit" onClick={enable} disabled={busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />} Turn on notifications
              </button>
            )}
          </div>
        )}

        {test.stage !== "idle" && (
          <ol className="grid gap-1 rounded-xl bg-surface px-3 py-2 text-sm ring-1 ring-line" aria-live="polite">
            <Step done label="Device subscribed" />
            <Step done={["accepted", "displayed", "unconfirmed"].includes(test.stage)} active={test.stage === "sending"} label="Accepted by your browser's push service" />
            <Step done={test.stage === "displayed"} active={test.stage === "accepted"} label="Shown on this device" />
            {test.stage === "unconfirmed" && <li className="text-xs text-ink-3">The push service accepted it, but this device hasn't confirmed showing it. Check your system's Do Not Disturb or focus settings and the browser's notification permission.</li>}
            {test.stage === "failed" && <li className="text-xs text-brick">{test.error}</li>}
          </ol>
        )}

        <p className="text-xs text-ink-3">
          {s.devices.length} device{s.devices.length === 1 ? "" : "s"} subscribed.{" "}
          {s.scheduler?.lastRunAt
            ? `Reminder scheduler last ran ${new Date(s.scheduler.lastRunAt).toLocaleString("en-CA", { timeZone: p.timezone, dateStyle: "medium", timeStyle: "short" })}.`
            : "The reminder scheduler hasn't run yet — see the README to connect it."}
        </p>
      </section>

      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const categories = Object.fromEntries(cats.map(([k]) => [k, fd.get(`cat_${k}`) === "on"]));
          run("updatePrefs", {
            notify_categories: categories,
            shift_lead_minutes: Number(fd.get("shift_lead_minutes")),
            log_hours_time: String(fd.get("log_hours_time")),
            bill_lead_days: Number(fd.get("bill_lead_days")),
            bill_notify_time: String(fd.get("bill_notify_time")),
            payday_notify_time: String(fd.get("payday_notify_time")),
          }, (r) => r.ok && onChanged());
        }}
      >
        <fieldset className="grid grid-cols-2 gap-2 text-sm">
          <legend className="mb-2 text-sm font-semibold">Remind me about</legend>
          {cats.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" name={`cat_${k}`} defaultChecked={p.notify_categories?.[k] !== false} className="h-4 w-4 accent-[var(--ink)]" /> {label}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field">
            Minutes before a shift
            <input className="input" type="number" min={0} max={1440} name="shift_lead_minutes" defaultValue={p.shift_lead_minutes} />
          </label>
          <label className="field">
            Remind me to log hours at
            <input className="input" type="time" name="log_hours_time" defaultValue={p.log_hours_time} />
          </label>
          <label className="field">
            Days before a bill is due
            <input className="input" type="number" min={0} max={14} name="bill_lead_days" defaultValue={p.bill_lead_days} />
          </label>
          <label className="field">
            Bill reminders at
            <input className="input" type="time" name="bill_notify_time" defaultValue={p.bill_notify_time} />
          </label>
          <label className="field">
            Payday reminders at
            <input className="input" type="time" name="payday_notify_time" defaultValue={p.payday_notify_time} />
          </label>
        </div>
        <button className="btn btn-primary w-fit" disabled={pending}>
          Save reminder settings
        </button>
      </form>
    </div>
  );
}

function Step({ done, active, label }: { done?: boolean; active?: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 ${done ? "text-ink" : "text-ink-3"}`}>
      {done ? <Check size={14} className="text-moss" /> : active ? <Loader2 size={14} className="animate-spin" /> : <span className="inline-block h-3.5 w-3.5 rounded-full border border-line" />}
      {label}
    </li>
  );
}
