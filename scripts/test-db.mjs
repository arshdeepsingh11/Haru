// Runs the SQL integrity suite against a THROWAWAY database: creates a temp
// database, applies migrations, runs db/tests/integrity.sql, drops it.
// Usage: TEST_DATABASE_ADMIN_URL=postgres://user:pass@localhost:5432/postgres npm run test:db
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
if (!admin) {
  console.error("Set TEST_DATABASE_ADMIN_URL to a Postgres server you can create databases on (never production).");
  process.exit(1);
}
const name = `haru_test_${Date.now()}`;
const root = postgres(admin, { max: 1, onnotice: () => {} });
await root.unsafe(`create database ${name}`);
const u = new URL(admin);
u.pathname = `/${name}`;
const db = postgres(u.toString(), { max: 1, onnotice: () => {} });
try {
  for (const f of readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort()) await db.unsafe(readFileSync(join("db/migrations", f), "utf8"));
  const out = await db.unsafe(readFileSync("db/tests/integrity.sql", "utf8"));
  const last = [out].flat().filter(Boolean).pop();
  console.log(Array.isArray(last) ? last[0]?.result ?? "ok" : "ok");
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
  await root.unsafe(`drop database if exists ${name}`);
  await root.end();
}
