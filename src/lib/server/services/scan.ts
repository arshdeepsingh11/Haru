import "server-only";
import { getProvider, ProviderUnavailable } from "../../ai/provider";
import { addDays, isISODate, weekdayName } from "../../domain/time";
import { AppError } from "../errors";
import type { Ctx } from "../context";
import { jobLabel, listJobs } from "./jobs";

// Read a photo of a work schedule into shifts the user can check and edit before saving.
// Nothing is saved here.

export interface ScannedShift {
  date: string;
  start: string;
  end: string;
  break_minutes: number;
  job_id: string | null;
  job_name: string | null;
}

export interface ScanResult {
  shifts: ScannedShift[];
  employer: string | null;
  notes: string[];
  jobs: { id: string; name: string }[];
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MAX_BYTES = 6 * 1024 * 1024;
export const SCAN_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

function pad(t: string) {
  const m = TIME.exec(t.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** Loose JSON from the model → strict shifts. Exported for tests. */
export function parseScan(text: string, jobs: { id: string; name: string; employer: string }[], today: string): Omit<ScanResult, "jobs"> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new AppError("HARU couldn't read a schedule in that photo. Try a sharper, straight-on photo.");
  }
  const r = (raw ?? {}) as { shifts?: unknown[]; employer?: unknown; notes?: unknown[] };
  const employer = typeof r.employer === "string" && r.employer.trim() ? r.employer.trim().slice(0, 120) : null;
  const match = (name: string | null) => {
    const n = (name ?? employer ?? "").toLowerCase().trim();
    if (jobs.length === 1 && !n) return jobs[0];
    if (!n) return null;
    return jobs.find((j) => j.employer.toLowerCase().includes(n) || n.includes(j.employer.toLowerCase()) || j.name.toLowerCase().includes(n)) ?? (jobs.length === 1 ? jobs[0] : null);
  };
  const lo = addDays(today, -31);
  const hi = addDays(today, 120);
  const shifts: ScannedShift[] = [];
  for (const s of Array.isArray(r.shifts) ? r.shifts : []) {
    const x = (s ?? {}) as Record<string, unknown>;
    const date = typeof x.date === "string" && isISODate(x.date) ? x.date : null;
    const start = typeof x.start === "string" ? pad(x.start) : null;
    const end = typeof x.end === "string" ? pad(x.end) : null;
    if (!date || !start || !end || date < lo || date > hi) continue;
    const name = typeof x.job === "string" && x.job.trim() ? x.job.trim().slice(0, 120) : null;
    const j = match(name);
    const brk = Number(x.break_minutes);
    shifts.push({ date, start, end, break_minutes: Number.isFinite(brk) && brk >= 0 && brk <= 240 ? Math.round(brk) : 0, job_id: j?.id ?? null, job_name: j ? j.name : name ?? employer });
  }
  shifts.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 200)).slice(0, 5);
  return { shifts: shifts.slice(0, 60), employer, notes };
}

export async function scanSchedule(ctx: Ctx, file: File): Promise<ScanResult> {
  if (!SCAN_MIME.has(file.type)) throw new AppError("Send a photo (JPG, PNG, WebP or HEIC).");
  if (file.size > MAX_BYTES) throw new AppError("That photo is too large. Try one under 6 MB.");
  const jobs = (await listJobs(ctx)).filter((j) => j.status === "active");
  const named = jobs.map((j) => ({ id: j.id, name: jobLabel(j), employer: j.employer }));
  const provider = await getProvider().catch((e) => {
    throw new AppError(e instanceof ProviderUnavailable ? e.message : "The AI isn't configured.", 503);
  });
  if (!provider.vision) throw new AppError("This AI provider can't read photos.", 503);

  const calendar = Array.from({ length: 42 }, (_, i) => addDays(ctx.today, i - 14))
    .map((d) => `${weekdayName(d).slice(0, 3)} ${d}`)
    .join(", ");
  const system = `You read photos of work schedules (printed rosters, app screenshots, whiteboards, handwritten notes) and return the shifts as JSON. Today is ${weekdayName(ctx.today)} ${ctx.today}. Calendar: ${calendar}.`;
  const prompt = `Extract every shift for ONE person from this schedule photo.
${named.length ? `Their jobs: ${named.map((j) => j.name).join("; ")}.` : ""}
If the schedule lists several people, use the row/column that is highlighted or most likely theirs and say which in notes.
If dates show only weekdays or day numbers, resolve them to real dates using the calendar (the nearest matching week, usually this or next week).
Use 24-hour times. Overnight shifts keep the real end time (e.g. 22:00 to 06:00). Skip days marked OFF, RDO or blank.
Return JSON exactly like: {"employer": string|null, "shifts": [{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","break_minutes":number|0,"job":string|null}], "notes": [string]}
Put anything unclear (unreadable dates, guessed year, whose row) in notes. Never invent shifts that aren't in the photo.`;

  let text: string;
  try {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    text = await provider.vision({ system, prompt, image: { mime: file.type, base64 } });
  } catch (e) {
    if (e instanceof ProviderUnavailable) throw new AppError(e.message, 503);
    throw e;
  }
  return { ...parseScan(text, named, ctx.today), jobs: named.map(({ id, name }) => ({ id, name })) };
}
