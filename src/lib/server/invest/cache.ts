import "server-only";
import { sql } from "../db";

// Two-level cache for market data: memory (per server instance) in front of Postgres (shared).
// Stale entries are kept so a busy provider never leaves the screen empty.

interface Entry<T> {
  data: T;
  fetchedAt: number;
  expiresAt: number;
}
const mem = new Map<string, Entry<unknown>>();
const MAX_MEM = 800;

export async function cacheGet<T>(key: string): Promise<Entry<T> | null> {
  const m = mem.get(key) as Entry<T> | undefined;
  if (m && m.expiresAt > Date.now()) return m;
  const [row] = await sql<{ data: T; fetched_at: Date; expires_at: Date }[]>`select data, fetched_at, expires_at from market_cache where key = ${key}`;
  if (!row) return m ?? null;
  const e = { data: row.data, fetchedAt: row.fetched_at.getTime(), expiresAt: row.expires_at.getTime() };
  remember(key, e);
  return e;
}

export async function cacheSet<T>(key: string, data: T, ttlMs: number): Promise<void> {
  const e = { data, fetchedAt: Date.now(), expiresAt: Date.now() + ttlMs };
  remember(key, e);
  await sql`
    insert into market_cache (key, data, fetched_at, expires_at) values (${key}, ${sql.json(data as never)}, now(), ${new Date(e.expiresAt)})
    on conflict (key) do update set data = excluded.data, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`;
}

function remember(key: string, e: Entry<unknown>) {
  if (mem.size >= MAX_MEM) mem.delete(mem.keys().next().value as string);
  mem.set(key, e);
}

/**
 * Fresh value from cache, or load it. If loading fails, the last value (even expired) is returned
 * with `stale: true`; only when nothing was ever cached does the error surface.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<{ data: T; fetchedAt: number; stale: boolean }> {
  const hit = await cacheGet<T>(key);
  if (hit && hit.expiresAt > Date.now()) return { data: hit.data, fetchedAt: hit.fetchedAt, stale: false };
  try {
    const data = await load();
    await cacheSet(key, data, ttlMs);
    return { data, fetchedAt: Date.now(), stale: false };
  } catch (e) {
    if (hit) return { data: hit.data, fetchedAt: hit.fetchedAt, stale: true };
    throw e;
  }
}

/** Only read the cache (any age). Used to paint the page instantly before refreshing. */
export async function peek<T>(key: string): Promise<{ data: T; fetchedAt: number; fresh: boolean } | null> {
  const hit = await cacheGet<T>(key);
  return hit ? { data: hit.data, fetchedAt: hit.fetchedAt, fresh: hit.expiresAt > Date.now() } : null;
}

/** Simple per-instance budget so free plans' per-minute limits aren't hit. */
const windows = new Map<string, number[]>();
export function takeBudget(provider: string, perMinute: number): boolean {
  const now = Date.now();
  const w = (windows.get(provider) ?? []).filter((t) => now - t < 60_000);
  if (w.length >= perMinute) {
    windows.set(provider, w);
    return false;
  }
  w.push(now);
  windows.set(provider, w);
  return true;
}
