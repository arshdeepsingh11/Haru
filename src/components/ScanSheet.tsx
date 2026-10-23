"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImagePlus, Plus, Trash2 } from "lucide-react";
import { act, loadSchedule } from "@/app/actions";
import { AuroraOrb } from "./AuroraOrb";
import { Sheet, useToast } from "./ui";

// Photo of a schedule → shifts Haru read → the user edits → saved. Nothing is saved until "Save".

interface Row {
  key: number;
  include: boolean;
  date: string;
  start: string;
  end: string;
  break_minutes: number;
  job_id: string;
}
interface ScanResponse {
  shifts: { date: string; start: string; end: string; break_minutes: number; job_id: string | null; job_name: string | null }[];
  employer: string | null;
  notes: string[];
  jobs: { id: string; name: string }[];
}

/** Shrink big phone photos before upload: faster, and well under server limits. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.85));
  } catch {
    return file; // e.g. HEIC on a browser that can't decode it: let the server/model try
  }
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function ScanSheet({ open, onClose, today, onSaved }: { open: boolean; onClose: () => void; today: string; onSaved?: (summary: string) => void }) {
  const router = useRouter();
  const toast = useToast();
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"pick" | "reading" | "review" | "saving">("pick");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [newJob, setNewJob] = useState({ employer: "", rate: "" });

  function reset() {
    setStep("pick");
    setError(null);
    setRows([]);
    setNotes([]);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  }

  async function read(file: File) {
    setError(null);
    setPreview(URL.createObjectURL(file));
    setStep("reading");
    try {
      const fd = new FormData();
      fd.append("photo", await shrink(file), "schedule.jpg");
      const res = await fetch("/api/schedule/scan", { method: "POST", body: fd });
      const j = (await res.json()) as ScanResponse & { error?: string };
      if (!res.ok) throw new Error(j.error ?? "Haru couldn't read that photo.");
      setJobs(j.jobs);
      setNotes(j.notes);
      setNewJob({ employer: j.employer ?? "", rate: "" });
      const fallbackJob = j.jobs.length === 1 ? j.jobs[0].id : "";
      setRows(j.shifts.map((s, i) => ({ key: i, include: s.date >= today, date: s.date, start: s.start, end: s.end, break_minutes: s.break_minutes, job_id: s.job_id ?? fallbackJob })));
      if (!j.shifts.length) setError("Haru didn't find any shifts in that photo. Try a sharper photo, straight on, with the dates visible.");
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
      setStep("pick");
    }
  }

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.include);
  const needsJob = jobs.length === 0;

  async function save() {
    setStep("saving");
    setError(null);
    try {
      let jobId: string | null = null;
      if (needsJob) {
        if (!newJob.employer.trim() || !(Number(newJob.rate) > 0)) throw new Error("Add the job name and hourly rate first.");
        const r = await act("createJob", { employer: newJob.employer.trim(), hourly_rate: Number(newJob.rate) });
        if (!r.ok) throw new Error(r.error);
        const sched = await loadSchedule();
        jobId = sched.jobs.find((j) => j.employer === newJob.employer.trim())?.id ?? sched.jobs[0]?.id ?? null;
        if (!jobId) throw new Error("Couldn't find the new job. Try again.");
      }
      let saved = 0;
      const failed: string[] = [];
      for (const r of chosen) {
        const res = await act("createShift", { job_id: jobId ?? r.job_id, date: r.date, start: r.start, end: r.end, break_minutes: r.break_minutes || undefined, status: "scheduled" });
        if (res.ok) saved++;
        else failed.push(`${fmtDay(r.date)}: ${res.error}`);
      }
      router.refresh();
      const summary = `Added ${saved} shift${saved === 1 ? "" : "s"} from your schedule photo.`;
      if (failed.length) {
        setError(`${summary} Not saved: ${failed.join("; ")}`);
        setStep("review");
        return;
      }
      toast(summary);
      onSaved?.(summary);
      reset();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setStep("review");
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Scan your schedule"
    >
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      <input ref={libRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />

      {step === "pick" && (
        <div className="grid gap-4">
          <p className="text-ink-2">Take a photo of your printed schedule, a whiteboard or a screenshot from your work app. Haru reads the shifts and you check them before anything is saved.</p>
          <div className="grid grid-cols-2 gap-3">
            <button className="glass grid justify-items-center gap-2 px-4 py-6 text-sm font-semibold" onClick={() => camRef.current?.click()}>
              <Camera size={26} className="text-iris" /> Take photo
            </button>
            <button className="glass grid justify-items-center gap-2 px-4 py-6 text-sm font-semibold" onClick={() => libRef.current?.click()}>
              <ImagePlus size={26} className="text-lagoon" /> Choose photo
            </button>
          </div>
          {error && <p className="text-sm text-brick">{error}</p>}
        </div>
      )}

      {(step === "reading" || step === "saving") && (
        <div className="grid justify-items-center gap-4 py-8 text-center">
          {preview && step === "reading" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your schedule photo" className="max-h-40 rounded-2xl object-contain opacity-70" />
          )}
          <AuroraOrb size={84} state="thinking" />
          <p className="font-semibold">{step === "reading" ? "Reading your schedule…" : "Saving your shifts…"}</p>
        </div>
      )}

      {step === "review" && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
          {notes.length > 0 && (
            <ul className="rounded-2xl bg-amber-soft px-4 py-3 text-sm text-ink">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {needsJob && (
            <div className="glass grid gap-3 p-4">
              <p className="text-sm font-semibold">Which job is this schedule for?</p>
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <label className="field">
                  Job
                  <input className="input" value={newJob.employer} onChange={(e) => setNewJob({ ...newJob, employer: e.target.value })} placeholder="Employer" />
                </label>
                <label className="field">
                  $ per hour
                  <input className="input" inputMode="decimal" value={newJob.rate} onChange={(e) => setNewJob({ ...newJob, rate: e.target.value })} placeholder="20" />
                </label>
              </div>
            </div>
          )}
          <p className="text-sm text-ink-2">
            Haru found {rows.length} shift{rows.length === 1 ? "" : "s"}. Fix anything that's off, untick what you don't work.
          </p>
          <ul className="grid gap-2">
            {rows.map((r) => (
              <li key={r.key} className={`glass grid min-w-0 gap-2 p-3 ${r.include ? "" : "opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" className="h-5 w-5 accent-[var(--iris)]" checked={r.include} onChange={(e) => set(r.key, { include: e.target.checked })} aria-label={`Include ${fmtDay(r.date)}`} />
                  <input type="date" className="input min-h-10 min-w-0 flex-1 py-1.5" value={r.date} onChange={(e) => set(r.key, { date: e.target.value })} aria-label="Date" />
                  <button className="btn btn-quiet h-10 w-10 p-0" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label="Delete row">
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.4rem] gap-2">
                  <input type="time" className="input min-h-10 min-w-0 px-2.5 py-1.5" value={r.start} onChange={(e) => set(r.key, { start: e.target.value })} aria-label="Start" />
                  <input type="time" className="input min-h-10 min-w-0 px-2.5 py-1.5" value={r.end} onChange={(e) => set(r.key, { end: e.target.value })} aria-label="End" />
                  <input className="input min-h-10 min-w-0 px-2.5 py-1.5" inputMode="numeric" value={r.break_minutes || ""} placeholder="Brk" onChange={(e) => set(r.key, { break_minutes: Number(e.target.value) || 0 })} aria-label="Unpaid break minutes" />
                </div>
                {!needsJob && jobs.length > 1 && (
                  <select className="input min-h-10 py-1.5" value={r.job_id} onChange={(e) => set(r.key, { job_id: e.target.value })} aria-label="Job">
                    <option value="">Pick a job</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
          <button
            className="btn btn-line w-fit"
            onClick={() => setRows((rs) => [...rs, { key: Date.now(), include: true, date: today, start: "09:00", end: "17:00", break_minutes: 0, job_id: jobs.length === 1 ? jobs[0].id : "" }])}
          >
            <Plus size={15} /> Add a shift
          </button>
          {error && <p className="text-sm text-brick">{error}</p>}
          {!needsJob && chosen.some((r) => !r.job_id) && <p className="text-sm text-amber">Pick the job for every shift you're keeping.</p>}
          <div className="sticky -bottom-5 -mx-5 flex gap-2 bg-[color:var(--mist)] px-5 pb-1 pt-3">
            <button className="btn btn-quiet" onClick={reset}>
              Retake
            </button>
            <button className="btn btn-primary flex-1" disabled={!chosen.length || (!needsJob && chosen.some((r) => !r.job_id))} onClick={save}>
              Save {chosen.length} shift{chosen.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
