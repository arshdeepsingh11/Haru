"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { formatMoney } from "@/lib/domain/money";
import { act, type ActionKind, type ActionResult } from "@/app/actions";

// ---------------------------------------------------------------- currency
const CurrencyCtx = createContext("CAD");
export const CurrencyProvider = CurrencyCtx.Provider;
export function useMoney() {
  const currency = useContext(CurrencyCtx);
  return useCallback((cents: number | null | undefined, opts?: { signed?: boolean; compact?: boolean }) => (cents == null ? "—" : formatMoney(cents, currency, opts)), [currency]);
}

// ---------------------------------------------------------------- toast
type Toast = { id: number; text: string; tone: "ok" | "error" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-28 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`sheet-enter pointer-events-auto max-w-md rounded-2xl px-4 py-2.5 text-sm shadow-lg ${t.tone === "error" ? "bg-brick text-white" : "bg-charcoal text-stone"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- server action hook
/** Run a validated server action; toast the honest result and refresh the dashboard on success. */
export function useAct() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const run = useCallback(
    (kind: ActionKind, input: unknown, onDone?: (r: ActionResult) => void) =>
      new Promise<ActionResult>((resolve) => {
        start(async () => {
          const r = await act(kind, input).catch((): ActionResult => ({ ok: false, error: "HARU couldn't reach the server. Nothing was saved." }));
          toast(r.ok ? r.summary : r.error, r.ok ? "ok" : "error");
          if (r.ok) router.refresh();
          onDone?.(r);
          resolve(r);
        });
      }),
    [router, toast],
  );
  return { run, pending };
}

// ---------------------------------------------------------------- sheet (native dialog)
export function Sheet({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
      className={`m-0 mt-auto max-h-[94dvh] w-full max-w-none dark-scope rounded-t-[30px] border-0 bg-[#323638] p-0 text-ink shadow-2xl backdrop:bg-[rgb(20_22_23/0.35)] backdrop:backdrop-blur-sm sm:m-auto sm:rounded-[30px] ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}
    >
      {open && (
        <div className="sheet-enter flex max-h-[94dvh] flex-col">
          <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
          <header className="flex items-center justify-between px-5 pb-2 pt-3">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <button className="btn btn-quiet -mr-2 px-2" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </header>
          <div className="scroll-thin min-w-0 overflow-y-auto overflow-x-hidden px-5 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- small pieces
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-3">{children}</p>;
}

export function Progress({ value, tone = "moss", label }: { value: number; tone?: "moss" | "goal" | "slate"; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="h-2 w-full overflow-hidden rounded-full bg-paper-2">
      <div className="bar-grow h-full rounded-full" style={{ width: `${pct}%`, background: tone === "slate" ? "var(--ink)" : "var(--aurora)" }} />
    </div>
  );
}

/** Lower-case only the relative words, for mid-sentence use: "due tomorrow", "due Sat, Oct 31". */
export function dayLabelInline(date: string, today: string) {
  const l = dayLabel(date, today);
  return ["Today", "Tomorrow", "Yesterday"].includes(l) ? l.toLowerCase() : l;
}

export function dayLabel(date: string, today: string) {
  const d = Math.round((Date.parse(date) - Date.parse(today)) / 86400e3);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  const wd = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return wd;
}

export function hours(min: number) {
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, "")} h`;
}
