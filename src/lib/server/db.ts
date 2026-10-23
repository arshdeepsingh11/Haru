import "server-only";
import postgres from "postgres";

// One pooled client per server instance. Connections open lazily, so importing
// this during `next build` without DATABASE_URL is harmless.
const g = globalThis as unknown as { __haruSql?: ReturnType<typeof make> };

function make() {
  return postgres(process.env.DATABASE_URL ?? "postgres://unconfigured@localhost:1/haru", {
    prepare: false, // required by Supabase's transaction pooler
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: {
      // int8 → number (cents fit comfortably within 2^53)
      int8num: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      // numeric → number (percentages)
      numericnum: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      // date → "YYYY-MM-DD" string; calendar dates never become Date objects
      isodate: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
}

export const sql = g.__haruSql ?? make();
if (process.env.NODE_ENV !== "production") g.__haruSql = sql;

export type Db = typeof sql;
export type Tx = Parameters<Parameters<Db["begin"]>[1]>[0];
/** A query runner: the pool or an open transaction. */
export type Q = Db | Tx;

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}
