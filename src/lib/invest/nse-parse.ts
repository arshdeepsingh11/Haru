import { inflateRawSync } from "node:zlib";

// Parsers for NSE's official daily files (free, no key):
//  - Capital-market bhavcopy: every listed stock and ETF's open/high/low/close for one trading day.
//  - Index closing values: Nifty 50, Nifty Bank and the rest.
// Pure functions so they can be tested without the network.

export interface DayBar {
  o: number;
  h: number;
  l: number;
  c: number;
  prev: number | null;
  /** trading date, YYYY-MM-DD */
  date: string;
}

/** Split one CSV line, honouring quotes. */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") out.push(cur.trim()), (cur = "");
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "2026-10-23", "23-OCT-2026", "23-10-2026", "23-Oct-2026" → "2026-10-23" (null if unreadable). */
export function isoDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})$/.exec(t);
  if (!m) return null;
  const mo = /\d/.test(m[2]) ? m[2].padStart(2, "0") : MON[m[2].toUpperCase()];
  return mo ? `${m[3]}-${mo}-${m[1].padStart(2, "0")}` : null;
}

const n = (v: string | undefined) => {
  const x = parseFloat((v ?? "").replace(/,/g, ""));
  return Number.isFinite(x) ? x : NaN;
};

function headerIndex(header: string[], names: string[]): number {
  const low = header.map((h) => h.replace(/^﻿/, "").trim().toLowerCase());
  for (const name of names) {
    const i = low.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a bhavcopy CSV (the 2024+ UDiFF layout or the older one) into SYMBOL → bar.
 * Keeps ordinary equity series (EQ, BE, BZ) so ETFs and stocks are both included.
 */
export function parseBhav(csv: string): Record<string, DayBar> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const h = csvLine(lines[0]);
  const col = {
    sym: headerIndex(h, ["TckrSymb", "SYMBOL"]),
    series: headerIndex(h, ["SctySrs", "SERIES"]),
    seg: headerIndex(h, ["Sgmt"]),
    o: headerIndex(h, ["OpnPric", "OPEN"]),
    hi: headerIndex(h, ["HghPric", "HIGH"]),
    lo: headerIndex(h, ["LwPric", "LOW"]),
    c: headerIndex(h, ["ClsPric", "CLOSE"]),
    prev: headerIndex(h, ["PrvsClsgPric", "PREVCLOSE"]),
    date: headerIndex(h, ["TradDt", "TIMESTAMP", "BizDt"]),
  };
  if (col.sym < 0 || col.c < 0) return {};
  const out: Record<string, DayBar> = {};
  for (const line of lines.slice(1)) {
    const r = csvLine(line);
    const series = col.series >= 0 ? r[col.series] : "EQ";
    if (!["EQ", "BE", "BZ"].includes(series)) continue;
    if (col.seg >= 0 && r[col.seg] && r[col.seg] !== "CM") continue;
    const c = n(r[col.c]);
    const date = col.date >= 0 ? isoDate(r[col.date] ?? "") : null;
    if (!(c > 0) || !date) continue;
    const sym = r[col.sym].toUpperCase();
    const bar: DayBar = { o: n(r[col.o]) || c, h: n(r[col.hi]) || c, l: n(r[col.lo]) || c, c, prev: n(r[col.prev]) > 0 ? n(r[col.prev]) : null, date };
    // EQ wins over other series for the same symbol.
    if (!out[sym] || series === "EQ") out[sym] = bar;
  }
  return out;
}

/** Parse NSE's daily index closing file into lower-cased index name → bar ("nifty 50", "nifty bank"). */
export function parseIndexCloses(csv: string): Record<string, DayBar> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const h = csvLine(lines[0]);
  const col = {
    name: headerIndex(h, ["Index Name"]),
    date: headerIndex(h, ["Index Date"]),
    o: headerIndex(h, ["Open Index Value"]),
    hi: headerIndex(h, ["High Index Value"]),
    lo: headerIndex(h, ["Low Index Value"]),
    c: headerIndex(h, ["Closing Index Value"]),
    pts: headerIndex(h, ["Points Change"]),
  };
  if (col.name < 0 || col.c < 0) return {};
  const out: Record<string, DayBar> = {};
  for (const line of lines.slice(1)) {
    const r = csvLine(line);
    const c = n(r[col.c]);
    const date = isoDate(r[col.date] ?? "");
    if (!(c > 0) || !date) continue;
    const pts = n(r[col.pts]);
    out[r[col.name].trim().toLowerCase()] = { o: n(r[col.o]) || c, h: n(r[col.hi]) || c, l: n(r[col.lo]) || c, c, prev: Number.isFinite(pts) ? c - pts : null, date };
  }
  return out;
}

/** Extract the first file of a ZIP archive (NSE ships one CSV per zip). Handles stored and deflated entries. */
export function unzipFirst(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back from the end for its signature.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const cd = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip central directory missing");
  const method = b.readUInt16LE(cd + 10);
  const size = b.readUInt32LE(cd + 20);
  const local = b.readUInt32LE(cd + 42);
  if (b.readUInt32LE(local) !== 0x04034b50) throw new Error("zip entry missing");
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  const data = b.subarray(start, start + size);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`unsupported zip method ${method}`);
}

/** Trading days to try, newest first: today and the previous `days` calendar days, in India time. */
export function recentIstDates(now: number, days = 7): string[] {
  const ist = now + 5.5 * 3600e3;
  return Array.from({ length: days + 1 }, (_, i) => new Date(ist - i * 86400e3).toISOString().slice(0, 10)).filter((d) => {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  });
}
