// Time-zone aware date helpers built only on the platform Intl API.
// Calendar dates are ISO strings ("YYYY-MM-DD") with no time zone attached;
// instants are JS Dates (UTC). All conversions go through an IANA zone, which
// makes daylight-saving transitions correct by construction.

export const DEFAULT_TZ = "America/Edmonton";

export type ISODate = string; // YYYY-MM-DD

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isISODate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function parseTime(hhmm: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid time "${hhmm}", expected HH:MM`);
  return { hour: +m[1], minute: +m[2] };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

export function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    hour: +out.hour === 24 ? 0 : +out.hour,
    minute: +out.minute,
    second: +out.second,
    weekday: WEEKDAYS[out.weekday],
  };
}

/** Offset of the zone from UTC at an instant, in milliseconds (Edmonton MDT = -6h). */
export function tzOffsetMs(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads `date time`.
 * Non-existent times (spring-forward gap) resolve to the instant just after the gap;
 * ambiguous times (fall-back) resolve to the first occurrence.
 */
export function zonedToUtc(date: ISODate, time: string, tz: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date "${date}"`);
  const { hour, minute } = parseTime(time);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], hour, minute);
  // Try both candidate offsets around the wall time; prefer the earliest match.
  const o1 = tzOffsetMs(new Date(wall - 12 * 3600e3), tz);
  const o2 = tzOffsetMs(new Date(wall + 12 * 3600e3), tz);
  const candidates = [wall - o1, wall - o2].sort((a, b) => a - b);
  for (const c of candidates) {
    const p = localParts(new Date(c), tz);
    if (p.hour === hour && p.minute === minute && toISODate(p) === date) return new Date(c);
  }
  // Gap: the wall time does not exist. Use the later offset (clock jumped forward).
  return new Date(wall - Math.min(o1, o2));
}

function toISODate(p: { year: number; month: number; day: number }): ISODate {
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function localDate(instant: Date, tz: string): ISODate {
  return toISODate(localParts(instant, tz));
}

export function localTime(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function todayIn(tz: string, now: Date = new Date()): ISODate {
  return localDate(now, tz);
}

// ---- pure calendar arithmetic on ISO dates (no time zone involved) ----

function toUtcMs(d: ISODate): number {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`Invalid date "${d}"`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
function fromUtcMs(ms: number): ISODate {
  const d = new Date(ms);
  return toISODate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUtcMs(toUtcMs(d) + n * 86400e3);
}

/** b - a in whole days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86400e3);
}

export function weekdayOf(d: ISODate): number {
  return new Date(toUtcMs(d)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function splitDate(d: ISODate): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`Invalid date "${d}"`);
  return { year: +m[1], month: +m[2], day: +m[3] };
}

export function makeDate(year: number, month: number, day: number): ISODate {
  // normalises month overflow, clamps day to month length
  const y = year + Math.floor((month - 1) / 12);
  const mo = ((((month - 1) % 12) + 12) % 12) + 1;
  return toISODate({ year: y, month: mo, day: Math.min(day, daysInMonth(y, mo)) });
}

export function startOfMonth(d: ISODate): ISODate {
  const { year, month } = splitDate(d);
  return makeDate(year, month, 1);
}

export function endOfMonth(d: ISODate): ISODate {
  const { year, month } = splitDate(d);
  return makeDate(year, month, daysInMonth(year, month));
}

/** Add months, keeping `anchorDay` (default: the date's own day) and clamping to month length. */
export function addMonths(d: ISODate, n: number, anchorDay?: number): ISODate {
  const { year, month, day } = splitDate(d);
  return makeDate(year, month + n, anchorDay ?? day);
}

export function startOfWeek(d: ISODate, weekStartsOn = 1): ISODate {
  const wd = weekdayOf(d);
  return addDays(d, -((wd - weekStartsOn + 7) % 7));
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}
export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayName(d: ISODate): string {
  return WEEKDAY_NAMES[weekdayOf(d)];
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 31" (or "Oct 31, 2027" outside the reference year). */
export function friendlyDate(d: ISODate, referenceYear?: number): string {
  const { year, month, day } = splitDate(d);
  return `${MONTHS_SHORT[month - 1]} ${day}${referenceYear && referenceYear !== year ? `, ${year}` : ""}`;
}
