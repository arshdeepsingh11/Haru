import "server-only";
import type { Q } from "./db";

export type Actor = "user" | "ai" | "system";

/** Append-only audit trail; also the structured event history used for personalisation. */
export async function logActivity(
  q: Q,
  userId: string,
  e: { entity: string; entityId?: string | null; action: string; actor: Actor; summary: string; before?: unknown; after?: unknown },
) {
  await q`
    insert into activity_log (user_id, entity, entity_id, action, actor, summary, before, after)
    values (${userId}, ${e.entity}, ${e.entityId ?? null}, ${e.action}, ${e.actor}, ${e.summary},
            ${e.before == null ? null : q.json(e.before as never)}, ${e.after == null ? null : q.json(e.after as never)})`;
}
