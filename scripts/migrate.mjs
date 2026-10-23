// Applies db/migrations/*.sql in order, once each, inside a transaction.
// Usage: DATABASE_URL=... npm run db:migrate   (uses DATABASE_URL_MIGRATIONS if set)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL_MIGRATIONS || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_URL_MIGRATIONS) first.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const dir = join(process.cwd(), "db", "migrations");

try {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select version from schema_migrations`).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (version) values (${f})`;
    });
    console.log(`applied ${f}`);
    applied++;
  }
  console.log(applied ? `Done: ${applied} migration(s) applied.` : "Database is up to date.");
} catch (e) {
  console.error(`Migration failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
