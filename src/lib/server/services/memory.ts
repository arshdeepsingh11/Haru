import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { AppError } from "../errors";

// What Haru has learned about this person: corrections, preferences, plans. One short fact per row.

export interface MemoryFact {
  id: number;
  fact: string;
  updatedAt: string;
}

const MAX_FACTS = 60;

export async function listMemory(ctx: Ctx, limit = 40): Promise<MemoryFact[]> {
  const rows = await sql<{ id: number; fact: string; updated_at: Date }[]>`
    select id, fact, updated_at from user_memory where user_id = ${ctx.userId} order by updated_at desc limit ${limit}`;
  return rows.map((r) => ({ id: Number(r.id), fact: r.fact, updatedAt: r.updated_at.toISOString() }));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Save facts; a near-duplicate refreshes the existing one instead of piling up. */
export async function remember(ctx: Ctx, facts: string[], source: "ai" | "user" = "ai"): Promise<{ saved: number; ids: number[] }> {
  const clean = facts.map((f) => f.trim().replace(/\s+/g, " ").slice(0, 300)).filter((f) => f.length >= 3);
  if (!clean.length) throw new AppError("Nothing to remember.");
  const existing = await listMemory(ctx, MAX_FACTS);
  const ids: number[] = [];
  for (const f of clean) {
    const dup = existing.find((e) => norm(e.fact) === norm(f));
    if (dup) {
      await sql`update user_memory set fact = ${f}, updated_at = now() where id = ${dup.id} and user_id = ${ctx.userId}`;
      ids.push(dup.id);
    } else {
      const [r] = await sql<{ id: number }[]>`insert into user_memory (user_id, fact, source) values (${ctx.userId}, ${f}, ${source}) returning id`;
      ids.push(Number(r.id));
    }
  }
  // Keep the list focused: drop the oldest beyond the cap.
  await sql`delete from user_memory where user_id = ${ctx.userId} and id not in (
    select id from user_memory where user_id = ${ctx.userId} order by updated_at desc limit ${MAX_FACTS})`;
  return { saved: clean.length, ids };
}

export async function forget(ctx: Ctx, id: number): Promise<string> {
  const [r] = await sql<{ fact: string }[]>`delete from user_memory where id = ${id} and user_id = ${ctx.userId} returning fact`;
  if (!r) throw new AppError("That memory no longer exists.", 404);
  return r.fact;
}

export async function forgetAll(ctx: Ctx): Promise<number> {
  const r = await sql`delete from user_memory where user_id = ${ctx.userId}`;
  return r.count;
}
