"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Check, ChevronLeft, ChevronRight, Loader2, Plus, Repeat, Sparkles, Trash2, X } from "lucide-react";
import { loadMonth, type MonthData } from "@/app/actions";
import { Sheet, hours, useAct, useMoney } from "./ui";
import { timeRange } from "./home/ShiftHome";

// The schedule as a calendar: a month at a glance, tap a day to see and change it.

const JOB_BG = ["bg-iris", "bg-lagoon", "bg-bloom", "bg-amber", "bg-ink"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function shiftMonth(m: string, n: number) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const monthTitle = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
const dayTitle = (d: string, today: string) =>
  d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

export function ScheduleSheet({ open, onClose, onScan }: { open: boolean; onClose: () => void; onScan: () => void }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<MonthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async (m?: string) => {
    try {
      setError(null);
      setData(await loadMonth(m));
    } catch {
      setError("Couldn't load your schedule. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    if (open) refresh(month);
  }, [open, month, refresh]);
  useEffect(() => {
    if (data && !selected) setSelected(data.today.startsWith(data.month) ? data.today : `${data.month}-01`);
  }, [data, selected]);

  return (
    <Sheet open={open} onClose={onClose} title="Schedule" wide>
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-2 py-10 text-ink-3">
          <Loader2 size={15} className="animate-spin" /> Loading your month…
        </p>
      ) : (
        <Calendar
          data={data}
          selected={selected ?? data.today}
          onSelect={setSelected}
          onMonth={(m) => {
            setMonth(m);
            setSelected(null);
          }}
          reload={() => refresh(month)}
          onScan={onScan}
        />
      )}
    </Sheet>
  );
}

function Calendar({ data, selected, onSelect, onMonth, reload, onScan }: { data: MonthData; selected: string; onSelect: (d: string) => void; onMonth: (m: string) => void; reload: () => void; onScan: () => void }) {
  const money = useMoney();
  const [adding, setAdding] = useState<null | "shift" | "extra">(null);
  const color = useMemo(() => new Map(data.jobs.map((j) => [j.id, JOB_BG[j.color % JOB_BG.length]])), [data.jobs]);
  const cells = useMemo(() => {
    const out: string[] = [];
    for (let d = data.gridStart; d <= data.gridEnd; d = addDays(d, 1)) out.push(d);
    return out;
  }, [data.gridStart, data.gridEnd]);
  const headers = Array.from({ length: 7 }, (_, i) => WD[(data.weekStartsOn + i) % 7]);
  const inMonth = (d: string) => d.startsWith(data.month);
  const monthShifts = data.shifts.filter((s) => inMonth(s.date));
  const earned = monthShifts.filter((s) => s.status === "completed").reduce((a, s) => a + s.takeHomeCents, 0);
  const ahead = monthShifts.filter((s) => s.status === "scheduled" && s.attendance !== "not_going").reduce((a, s) => a + s.takeHomeCents, 0);

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <button className="btn btn-line h-10 w-10 p-0" aria-label="Previous month" onClick={() => onMonth(shiftMonth(data.month, -1))}>
          <ChevronLeft size={18} />
        </button>
        <p className="min-w-0 flex-1 text-center text-lg font-semibold">{monthTitle(data.month)}</p>
        <button className="btn btn-line h-10 w-10 p-0" aria-label="Next month" onClick={() => onMonth(shiftMonth(data.month, 1))}>
          <ChevronRight size={18} />
        </button>
      </div>
      <p className="-mt-2 text-center text-sm text-ink-2">
        Earned <span className="figure text-ink">{money(earned)}</span>, still to earn <span className="figure text-iris">{money(ahead)}</span>
      </p>

      {/* The month */}
      <div className="glass p-2.5">
        <div className="grid grid-cols-7 pb-1 text-center text-[0.7rem] font-semibold text-ink-3">
          {headers.map((h) => (
            <span key={h}>{h.slice(0, 1)}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d) => {
            const list = data.shifts.filter((s) => s.date === d);
            const extras = data.extras.filter((x) => x.date === d);
            const pay = data.paydays.filter((p) => p.date === d);
            const isSel = d === selected;
            const isToday = d === data.today;
            return (
              <button
                key={d}
                onClick={() => onSelect(d)}
                aria-label={`${dayTitle(d, data.today)}: ${list.length} shift${list.length === 1 ? "" : "s"}${pay.length ? `, payday ${pay.map((p) => p.jobName).join(", ")}` : ""}`}
                aria-pressed={isSel}
                className={`relative flex min-h-[3.5rem] flex-col rounded-xl px-1 pb-1 pt-1 text-left transition ${isSel ? "bg-ink text-white" : isToday ? "bg-violet-soft" : "hover:bg-paper-2"} ${inMonth(d) ? "" : "opacity-35"}`}
              >
                <span className={`text-xs font-semibold ${isToday && !isSel ? "text-iris" : ""}`}>{Number(d.slice(8))}</span>
                {pay.length > 0 && (
                  <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full text-[0.6rem] font-bold text-white" style={{ background: "var(--aurora)" }} aria-hidden>
                    $
                  </span>
                )}
                <span className="mt-auto grid gap-0.5">
                  {list.slice(0, 3).map((s) => (
                    <span key={s.id} className={`block h-1.5 rounded-full ${s.status === "missed" || s.attendance === "not_going" ? "bg-ink-3/40" : (color.get(s.jobId) ?? "bg-iris")} ${s.status === "scheduled" ? "opacity-70" : ""}`} />
                  ))}
                  {extras.slice(0, 1).map((x) => (
                    <span key={x.id} className="block h-1.5 rounded-full border border-dashed border-bloom" />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      {data.jobs.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-ink-2">
          {data.jobs.map((j) => (
            <span key={j.id} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${color.get(j.id)}`} /> {j.name}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full text-[0.55rem] font-bold text-white" style={{ background: "var(--aurora)" }}>
              $
            </span>
            Payday
          </span>
        </div>
      )}

      <Day data={data} date={selected} color={color} reload={reload} adding={adding} setAdding={setAdding} onScan={onScan} />
    </div>
  );
}

function Day({
  data,
  date,
  color,
  reload,
  adding,
  setAdding,
  onScan,
}: {
  data: MonthData;
  date: string;
  color: Map<string, string>;
  reload: () => void;
  adding: null | "shift" | "extra";
  setAdding: (a: null | "shift" | "extra") => void;
  onScan: () => void;
}) {
  const money = useMoney();
  const { run, pending } = useAct();
  const list = data.shifts.filter((s) => s.date === date).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const extras = data.extras.filter((x) => x.date === date);
  const pay = data.paydays.filter((p) => p.date === date);
  const after = (r: { ok: boolean }) => r.ok && reload();
  const dayTotal = list.filter((s) => s.status !== "missed" && s.attendance !== "not_going").reduce((a, s) => a + s.takeHomeCents, 0);

  return (
    <section className="grid gap-3" aria-label={dayTitle(date, data.today)}>
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h3 className="text-lg font-semibold">{dayTitle(date, data.today)}</h3>
        {dayTotal > 0 && <span className="figure aurora-text text-base">+{money(dayTotal)}</span>}
      </div>

      {pay.map((p) => (
        <p key={p.jobId} className="flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold text-iris" style={{ background: "var(--aurora-soft)" }}>
          <span className="grid h-5 w-5 place-items-center rounded-full text-[0.65rem] text-white" style={{ background: "var(--aurora)" }}>
            $
          </span>
          {p.jobName} payday
        </p>
      ))}

      {list.length === 0 && extras.length === 0 && <p className="px-1 text-sm text-ink-3">No shifts. A day off.</p>}

      <ul className="grid gap-2">
        {list.map((s) => (
          <li key={s.id} className="glass grid gap-2.5 p-3.5">
            <div className="flex items-center gap-3">
              <span className={`h-9 w-1.5 shrink-0 rounded-full ${color.get(s.jobId) ?? "bg-iris"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className={`font-semibold ${s.status === "missed" ? "text-ink-3 line-through" : ""}`}>{s.jobName}</p>
                <p className="text-sm text-ink-2">
                  {timeRange(s) || hours(s.minutes)}
                  {s.start ? `, ${hours(s.minutes)}` : ""}
                </p>
              </div>
              <span className={`figure text-sm ${s.status === "missed" ? "text-ink-3" : s.status === "completed" ? "text-ink" : "text-iris"}`}>{s.status === "missed" ? "missed" : `+${money(s.takeHomeCents)}`}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {s.status === "completed" && (
                <span className="chip chip-moss">
                  <Check size={12} /> Worked
                </span>
              )}
              {s.status === "scheduled" && !s.ended && (s.attendance === "going" ? <span className="chip chip-moss">Going</span> : (
                <>
                  <button className="btn btn-line h-9 min-h-0 px-3 text-xs" disabled={pending} onClick={() => run("setAttendance", { shift_id: s.id, going: true }, after)}>
                    I'm going
                  </button>
                  <button className="btn btn-quiet h-9 min-h-0 px-3 text-xs" disabled={pending} onClick={() => confirm(`Skip this shift? That's ${money(s.takeHomeCents)} you won't earn.`) && run("setAttendance", { shift_id: s.id, going: false }, after)}>
                    Can't make it
                  </button>
                </>
              ))}
              {s.status === "scheduled" && s.ended && (
                <>
                  <button className="btn btn-primary h-9 min-h-0 px-3 text-xs" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, full: true }, after)}>
                    Worked it
                  </button>
                  <button
                    className="btn btn-line h-9 min-h-0 px-3 text-xs"
                    disabled={pending}
                    onClick={() => {
                      const h = prompt(`How many hours did you work? (scheduled ${s.minutes / 60})`);
                      if (h && Number(h) > 0) run("checkoutShift", { shift_id: s.id, hours: Number(h) }, after);
                    }}
                  >
                    Different hours
                  </button>
                </>
              )}
              <button className="btn btn-quiet ml-auto h-9 w-9 p-0" aria-label="Delete shift" disabled={pending} onClick={() => confirm("Delete this shift?") && run("deleteShift", { shift_id: s.id }, after)}>
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        ))}
        {extras.map((x) => (
          <li key={x.id} className="glass flex items-center gap-3 p-3.5">
            <Sparkles size={16} className="shrink-0 text-bloom" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {x.name} <span className="chip chip-goal ml-1">one-time</span>
              </p>
              <p className="text-sm text-ink-2">
                {x.start ? `${x.start}, ` : ""}
                {x.minutes ? hours(x.minutes) : ""}
              </p>
            </div>
            <span className="figure text-sm text-iris">+{money(Math.round(x.offeredCents * (1 - data.taxPercent / 100)))}</span>
          </li>
        ))}
      </ul>

      {adding === "shift" && <AddShift data={data} date={date} onDone={() => { setAdding(null); reload(); }} />}
      {adding === "extra" && <AddExtra data={data} date={date} onDone={() => { setAdding(null); reload(); }} />}

      {adding === null && (
        <div className="grid grid-cols-3 gap-2">
          <button className="btn btn-primary" disabled={!data.jobs.length} onClick={() => setAdding("shift")}>
            <Plus size={16} /> Shift
          </button>
          <button className="btn btn-line" onClick={() => setAdding("extra")}>
            <Sparkles size={15} /> Extra
          </button>
          <button className="btn btn-line" onClick={onScan}>
            <Camera size={16} /> Scan
          </button>
        </div>
      )}
      {!data.jobs.length && <p className="text-sm text-ink-2">Tell Haru about your job first, or scan your schedule.</p>}
    </section>
  );
}

function minutesBetween(start: string, end: string, brk: number) {
  const [a, b] = start.split(":").map(Number);
  const [c, d] = end.split(":").map(Number);
  let m = c * 60 + d - (a * 60 + b);
  if (m <= 0) m += 1440;
  return m - brk;
}

function AddShift({ data, date: initialDate, onDone }: { data: MonthData; date: string; onDone: () => void }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const [jobId, setJobId] = useState(data.jobs[0]?.id ?? "");
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [brk, setBrk] = useState("0");
  const [repeat, setRepeat] = useState(false);
  const job = data.jobs.find((j) => j.id === jobId);
  const mins = minutesBetween(start, end, Number(brk) || 0);
  const est = job?.rateCents ? Math.round(((mins * job.rateCents) / 60) * (1 - data.taxPercent / 100)) : null;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

  return (
    <form
      className="glass grid grid-cols-2 gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("createShift", { job_id: jobId, date, start, end, break_minutes: Number(brk) || 0, status: date < data.today ? "completed" : "scheduled" });
        if (r.ok && repeat && job) {
          const entry = { weekday, start, end, break_minutes: Number(brk) || 0 };
          const existing = job.schedule ?? [];
          // Add to the weekly pattern (a day can hold several shifts); skip if it's already there.
          if (!existing.some((x) => x.weekday === weekday && x.start === start && x.end === end)) await run("updateJob", { job_id: job.id, regular_schedule: [...existing, entry] });
        }
        if (r.ok) onDone();
      }}
    >
      <label className="field col-span-2">
        Job
        <select className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {data.jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field col-span-2">
        Date
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="field">
        Start
        <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label className="field">
        End
        <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <label className="field">
        Unpaid break (min)
        <input className="input" inputMode="numeric" value={brk} onChange={(e) => setBrk(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 self-end pb-3 text-sm">
        <input type="checkbox" className="h-5 w-5 accent-[var(--iris)]" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
        <Repeat size={14} className="text-iris" /> Every {WD[weekday]}
      </label>
      <div className="col-span-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary flex-1" disabled={pending || !jobId}>
          Add shift{est != null ? `, +${money(est)}` : ""}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="col-span-2 text-xs text-ink-3">
        {hours(mins)} paid, after {data.taxPercent}% tax. Overnight shifts (23:30 to 03:30) are fine.
      </p>
    </form>
  );
}

function AddExtra({ data, date, onDone }: { data: MonthData; date: string; onDone: () => void }) {
  const { run, pending } = useAct();
  const [basis, setBasis] = useState<"flat" | "hourly">("hourly");
  return (
    <form
      className="glass grid grid-cols-2 gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const start = String(f.get("start") || "");
        const end = String(f.get("end") || "");
        const hrs = start && end ? minutesBetween(start, end, 0) / 60 : undefined;
        const amount = Number(f.get("amount"));
        const offered = basis === "hourly" && hrs ? Math.round(amount * hrs * 100) / 100 : amount;
        const r = await run("createOpportunity", { name: String(f.get("name")), offered_amount: offered, expected_hours: hrs, date: String(f.get("date")), start: start || undefined, end: end || undefined, status: "scheduled" });
        if (r.ok) onDone();
      }}
    >
      <p className="col-span-2 text-sm text-ink-2">A one-off shift somewhere else. It counts toward your money but doesn't become a regular job.</p>
      <label className="field col-span-2">
        Where
        <input className="input" name="name" required placeholder="Restaurant shift" />
      </label>
      <label className="field col-span-2">
        Date
        <input className="input" type="date" name="date" required defaultValue={date} />
      </label>
      <label className="field">
        Start
        <input className="input" type="time" name="start" />
      </label>
      <label className="field">
        End
        <input className="input" type="time" name="end" />
      </label>
      <div className="col-span-2 flex gap-2">
        <button type="button" className="choice" aria-pressed={basis === "hourly"} onClick={() => setBasis("hourly")}>
          Per hour
        </button>
        <button type="button" className="choice" aria-pressed={basis === "flat"} onClick={() => setBasis("flat")}>
          Flat amount
        </button>
      </div>
      <label className="field col-span-2">
        {basis === "flat" ? "Total pay" : "Hourly rate"}
        <input className="input" name="amount" inputMode="decimal" required />
      </label>
      <div className="col-span-2 flex gap-2">
        <button className="btn btn-primary flex-1" disabled={pending}>
          Add extra shift
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          <X size={15} /> Cancel
        </button>
      </div>
    </form>
  );
}
