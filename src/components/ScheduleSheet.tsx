"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, Check, ChevronLeft, ChevronRight, Loader2, Plus, Repeat, Sparkles, Trash2, X } from "lucide-react";
import { loadSchedule, type ScheduleData } from "@/app/actions";
import { Sheet, hours, useAct, useMoney } from "./ui";
import { timeRange } from "./home/ShiftHome";

const DOT = ["bg-iris", "bg-lagoon", "bg-bloom", "bg-amber", "bg-ink"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function dayTitle(d: string, today: string) {
  if (d === today) return "Today";
  if (d === addDays(today, 1)) return "Tomorrow";
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

export function ScheduleSheet({ open, onClose, onScan }: { open: boolean; onClose: () => void; onScan: () => void }) {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "shift" | "extra">(null);

  const refresh = useCallback(async (w?: string) => {
    try {
      setError(null);
      setData(await loadSchedule(w));
    } catch {
      setError("Couldn't load your schedule. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    if (open) refresh(week);
  }, [open, week, refresh]);

  return (
    <Sheet open={open} onClose={onClose} title="Schedule" wide>
      {error ? (
        <p className="text-brick">{error}</p>
      ) : !data ? (
        <p className="flex items-center gap-2 text-ink-3">
          <Loader2 size={15} className="animate-spin" /> Loading your week…
        </p>
      ) : (
        <Week data={data} onWeek={setWeek} mode={mode} setMode={setMode} reload={() => refresh(week)} onScan={onScan} />
      )}
    </Sheet>
  );
}

function Week({ data, onWeek, mode, setMode, reload, onScan }: { data: ScheduleData; onWeek: (w: string) => void; mode: null | "shift" | "extra"; setMode: (m: null | "shift" | "extra") => void; reload: () => void; onScan: () => void }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const days = Array.from({ length: 7 }, (_, i) => addDays(data.start, i));
  const color = new Map(data.jobs.map((j) => [j.id, DOT[j.color % DOT.length]]));
  const planned = data.shifts.filter((s) => s.status === "scheduled" && s.attendance !== "not_going").reduce((a, s) => a + s.takeHomeCents, 0);
  const done = data.shifts.filter((s) => s.status === "completed").reduce((a, s) => a + s.takeHomeCents, 0);
  const after = (r: { ok: boolean }) => r.ok && reload();

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button className="btn btn-line h-9 w-9 p-0" aria-label="Previous week" onClick={() => onWeek(addDays(data.start, -7))}>
            <ChevronLeft size={16} />
          </button>
          <button className="btn btn-line h-9 w-9 p-0" aria-label="Next week" onClick={() => onWeek(addDays(data.start, 7))}>
            <ChevronRight size={16} />
          </button>
          <p className="ml-2 font-semibold">
            {new Date(`${data.start}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" })} –{" "}
            {new Date(`${data.end}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" })}
          </p>
        </div>
        <p className="text-sm text-ink-2">
          Earned <strong className="text-ink">{money(done)}</strong>, still to earn <strong className="text-violet">{money(planned)}</strong>
        </p>
      </div>

      <button className="glass flex items-center gap-3 p-3.5 text-left" onClick={onScan}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-white" style={{ background: "var(--aurora)" }}>
          <Camera size={20} />
        </span>
        <span>
          <span className="block font-semibold">Scan a photo of your schedule</span>
          <span className="block text-sm text-ink-2">Haru reads the shifts, you check and edit them</span>
        </span>
      </button>
      {data.jobs.length === 0 ? (
        <p className="text-sm text-ink-2">Or tell Haru about your job first, and add shifts by hand here.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button className="btn btn-primary" onClick={() => setMode(mode === "shift" ? null : "shift")}>
            <Plus size={16} /> Add shift
          </button>
          <button className="btn btn-line" onClick={() => setMode(mode === "extra" ? null : "extra")}>
            <Sparkles size={15} /> Extra shift
          </button>
        </div>
      )}

      {mode === "shift" && <AddShift data={data} onDone={() => { setMode(null); reload(); }} />}
      {mode === "extra" && <AddExtra data={data} onDone={() => { setMode(null); reload(); }} />}

      <ol className="grid gap-2">
        {days.map((d) => {
          const list = data.shifts.filter((s) => s.date === d);
          const extras = data.extras.filter((x) => x.date === d);
          return (
            <li key={d} className={`${list.length || extras.length ? "glass p-4" : "flex items-baseline justify-between rounded-2xl border border-dashed border-line px-4 py-3"} ${d === data.today ? "ring-2 ring-iris/30" : ""}`}>
              <p className="text-sm font-semibold">{dayTitle(d, data.today)}</p>
              {list.length === 0 && extras.length === 0 && <p className="text-sm text-ink-3">Day off</p>}
              <ul className="mt-2 grid gap-2">
                {list.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/60 px-3 py-2.5">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color.get(s.jobId) ?? "bg-violet"}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className={`font-medium ${s.status === "missed" ? "text-ink-3 line-through" : ""}`}>{s.jobName}</p>
                      <p className="text-xs text-ink-2">
                        {timeRange(s) || hours(s.minutes)}
                        {s.start ? `, ${hours(s.minutes)}` : ""}
                      </p>
                    </div>
                    <span className={`figure text-sm ${s.status === "completed" ? "text-ink" : s.status === "missed" ? "text-ink-3" : "text-violet"}`}>
                      {s.status === "missed" ? "missed" : `+${money(s.takeHomeCents)}`}
                    </span>
                    {s.status === "completed" && <span className="chip chip-moss"><Check size={12} /> done</span>}
                    {s.status === "scheduled" && !s.ended && (
                      s.attendance === "going" ? (
                        <span className="chip chip-moss">going</span>
                      ) : (
                        <span className="flex gap-1">
                          <button className="btn btn-line py-1 text-xs" disabled={pending} onClick={() => run("setAttendance", { shift_id: s.id, going: true }, after)}>
                            Going
                          </button>
                          <button className="btn btn-quiet py-1 text-xs" disabled={pending} onClick={() => confirm(`Skip this shift? That's ${money(s.takeHomeCents)} you won't earn.`) && run("setAttendance", { shift_id: s.id, going: false }, after)}>
                            Can't
                          </button>
                        </span>
                      )
                    )}
                    {s.status === "scheduled" && s.ended && (
                      <span className="flex gap-1">
                        <button className="btn btn-primary py-1 text-xs" disabled={pending} onClick={() => run("checkoutShift", { shift_id: s.id, full: true }, after)}>
                          Worked it
                        </button>
                        <button
                          className="btn btn-line py-1 text-xs"
                          disabled={pending}
                          onClick={() => {
                            const h = prompt(`How many hours did you work? (scheduled ${s.minutes / 60})`);
                            if (h && Number(h) > 0) run("checkoutShift", { shift_id: s.id, hours: Number(h) }, after);
                          }}
                        >
                          Fewer hours
                        </button>
                      </span>
                    )}
                    <button className="btn btn-quiet h-8 w-8 p-0" aria-label="Delete shift" disabled={pending} onClick={() => confirm("Delete this shift?") && run("deleteShift", { shift_id: s.id }, after)}>
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
                {extras.map((x) => (
                  <li key={x.id} className="flex items-center gap-3 rounded-2xl bg-white/60 px-3 py-2.5">
                    <Sparkles size={14} className="shrink-0 text-violet" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {x.name} <span className="chip chip-goal ml-1">one-time</span>
                      </p>
                      <p className="text-xs text-ink-2">{x.start ? `${x.start}, ` : ""}{x.minutes ? hours(x.minutes) : ""}</p>
                    </div>
                    <span className="figure font-bold text-violet">+{money(Math.round(x.offeredCents * (1 - data.taxPercent / 100)))}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AddShift({ data, onDone }: { data: ScheduleData; onDone: () => void }) {
  const money = useMoney();
  const { run, pending } = useAct();
  const [jobId, setJobId] = useState(data.jobs[0]?.id ?? "");
  const [date, setDate] = useState(data.today >= data.start && data.today <= data.end ? data.today : data.start);
  const [start, setStart] = useState("16:00");
  const [end, setEnd] = useState("23:00");
  const [brk, setBrk] = useState("30");
  const [repeat, setRepeat] = useState(false);
  const job = data.jobs.find((j) => j.id === jobId);
  const mins = (() => {
    const [a, b] = start.split(":").map(Number);
    const [c, d] = end.split(":").map(Number);
    let m = c * 60 + d - (a * 60 + b);
    if (m <= 0) m += 1440;
    return m - (Number(brk) || 0);
  })();
  const est = job?.rateCents ? Math.round(((mins * job.rateCents) / 60) * (1 - data.taxPercent / 100)) : null;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

  return (
    <form
      className="glass grid gap-3 p-5 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("createShift", { job_id: jobId, date, start, end, break_minutes: Number(brk) || 0, status: date < data.today ? "completed" : "scheduled" });
        if (r.ok && repeat && job) {
          const sched = [...(job.schedule ?? []).filter((x) => x.weekday !== weekday), { weekday, start, end, break_minutes: Number(brk) || 0 }];
          await run("updateJob", { job_id: job.id, regular_schedule: sched });
        }
        if (r.ok) onDone();
      }}
    >
      <label className="field">
        Job
        <select className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {data.jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
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
        Unpaid break (minutes)
        <input className="input" type="number" min={0} value={brk} onChange={(e) => setBrk(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--violet)]" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
        <Repeat size={14} className="text-violet" /> Every {WD[weekday]}
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button className="btn btn-primary" disabled={pending || !jobId}>
          Add shift{est != null ? `, +${money(est)}` : ""}
        </button>
        <span className="text-xs text-ink-3">{hours(mins)} paid, after {data.taxPercent}% tax</span>
      </div>
    </form>
  );
}

function AddExtra({ data, onDone }: { data: ScheduleData; onDone: () => void }) {
  const { run, pending } = useAct();
  const [basis, setBasis] = useState<"flat" | "hourly">("flat");
  return (
    <form
      className="glass grid gap-3 p-5 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const start = String(f.get("start") || "");
        const end = String(f.get("end") || "");
        const hrs = (() => {
          if (!start || !end) return Number(f.get("hours")) || undefined;
          const [a, b] = start.split(":").map(Number);
          const [c, d] = end.split(":").map(Number);
          let m = c * 60 + d - (a * 60 + b);
          if (m <= 0) m += 1440;
          return m / 60;
        })();
        const amount = Number(f.get("amount"));
        const offered = basis === "hourly" && hrs ? Math.round(amount * hrs * 100) / 100 : amount;
        const r = await run("createOpportunity", {
          name: String(f.get("name")),
          offered_amount: offered,
          expected_hours: hrs,
          date: String(f.get("date")),
          start: start || undefined,
          end: end || undefined,
          status: "scheduled",
        });
        if (r.ok) onDone();
      }}
    >
      <p className="text-sm text-ink-2 sm:col-span-2">A one-off shift somewhere else. It counts toward your money but doesn't become a regular job.</p>
      <label className="field">
        Where
        <input className="input" name="name" required placeholder="Restaurant shift" />
      </label>
      <label className="field">
        Date
        <input className="input" type="date" name="date" required defaultValue={data.today} />
      </label>
      <label className="field">
        Start
        <input className="input" type="time" name="start" />
      </label>
      <label className="field">
        End
        <input className="input" type="time" name="end" />
      </label>
      <div className="field">
        Pay
        <div className="flex gap-2">
          <button type="button" className="choice" aria-pressed={basis === "flat"} onClick={() => setBasis("flat")}>
            Flat amount
          </button>
          <button type="button" className="choice" aria-pressed={basis === "hourly"} onClick={() => setBasis("hourly")}>
            Per hour
          </button>
        </div>
      </div>
      <label className="field">
        {basis === "flat" ? "Total pay" : "Hourly rate"}
        <input className="input" name="amount" inputMode="decimal" required />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn btn-primary" disabled={pending}>
          Add extra shift
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          <X size={15} /> Cancel
        </button>
      </div>
    </form>
  );
}
