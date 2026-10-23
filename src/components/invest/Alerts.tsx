"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Loader2, X } from "lucide-react";
import type { AlertRow } from "@/lib/server/invest/planning";
import { useToast } from "../ui";
import { fmtPrice } from "./format";

// Price alerts: "tell me when gold goes above ₹1,30,000". Checked every 5 minutes, sent as a notification.

async function call(method: "GET" | "POST" | "DELETE", body?: unknown, query = "") {
  const res = await fetch(`/api/invest/alerts${query}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? "Couldn't update your alerts.");
  return j;
}

function AlertLine({ a, onRemove }: { a: AlertRow; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-2 px-3 py-2.5 text-sm">
      {a.active ? <Bell size={15} className="shrink-0 text-iris" /> : <BellRing size={15} className="shrink-0 text-moss" />}
      <span className="min-w-0 flex-1">
        <span className="font-medium">{a.name}</span> {a.direction} <span className="figure">{fmtPrice(a.target, a.currency)}</span>
        {!a.active && a.triggeredAt && (
          <span className="block text-xs text-ink-3">
            Reached {new Date(a.triggeredAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
            {a.triggeredPrice != null ? ` at ${fmtPrice(a.triggeredPrice, a.currency)}` : ""}
          </span>
        )}
      </span>
      <button className="btn btn-quiet h-8 w-8 min-h-0 shrink-0 p-0" aria-label={`Remove alert for ${a.name}`} onClick={onRemove}>
        <X size={14} />
      </button>
    </li>
  );
}

/** Inside a stock's sheet: set an alert at a price, see this asset's alerts. */
export function AssetAlerts({ assetKey, currency, price }: { assetKey: string; currency: string; price: number | null }) {
  const toast = useToast();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<"above" | "below">("above");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    call("GET", undefined, `?key=${encodeURIComponent(assetKey)}`)
      .then((j) => setAlerts(j.alerts))
      .catch(() => {});
  }, [assetKey]);
  useEffect(reload, [reload]);
  const preset = (d: "above" | "below") => {
    setDir(d);
    if (price) setTarget(String(Number((price * (d === "above" ? 1.05 : 0.95)).toPrecision(5))));
  };

  return (
    <section className="grid gap-2">
      {alerts.length > 0 && (
        <ul className="glass divide-y divide-line p-0">
          {alerts.map((a) => (
            <AlertLine
              key={a.id}
              a={a}
              onRemove={async () => {
                await call("DELETE", { id: a.id }).catch((e) => toast((e as Error).message, "error"));
                reload();
              }}
            />
          ))}
        </ul>
      )}
      {!open ? (
        <button
          className="btn btn-line"
          onClick={() => {
            setOpen(true);
            preset("above");
          }}
        >
          <Bell size={16} /> Price alert
        </button>
      ) : (
        <form
          className="glass grid gap-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await call("POST", { key: assetKey, direction: dir, target: Number(target) });
              toast("Alert set. Haru checks every 5 minutes and sends a notification.");
              setOpen(false);
              reload();
            } catch (err) {
              toast((err as Error).message, "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm font-semibold">Tell me when the price goes</p>
          <div className="flex gap-1.5">
            {(["above", "below"] as const).map((d) => (
              <button key={d} type="button" className="choice px-4 text-sm" aria-pressed={dir === d} onClick={() => preset(d)}>
                {d === "above" ? "Above" : "Below"}
              </button>
            ))}
          </div>
          <label className="field">
            Price ({currency === "%" ? "%" : currency})
            <input className="input" inputMode="decimal" required value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} />
          </label>
          {price != null && <p className="text-xs text-ink-3">Now {fmtPrice(price, currency)}. Indian stocks update once a day after the close; US prices, gold and currencies within minutes.</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={busy || !(Number(target) > 0)}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Bell size={15} />} Set alert
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** On the Invest tab: every alert you have. Hidden when there are none. */
export function AlertsList({ refreshKey }: { refreshKey: unknown }) {
  const toast = useToast();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const reload = useCallback(() => {
    call("GET")
      .then((j) => setAlerts(j.alerts))
      .catch(() => {});
  }, []);
  useEffect(reload, [reload, refreshKey]);
  if (!alerts.length) return null;
  return (
    <section className="grid gap-2.5">
      <h2 className="section-title px-1">Your price alerts</h2>
      <ul className="glass divide-y divide-line p-0">
        {alerts.map((a) => (
          <AlertLine
            key={a.id}
            a={a}
            onRemove={async () => {
              await call("DELETE", { id: a.id }).catch((e) => toast((e as Error).message, "error"));
              reload();
            }}
          />
        ))}
      </ul>
    </section>
  );
}
