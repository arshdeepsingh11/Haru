import "server-only";
import { sql } from "../db";
import type { Ctx } from "../context";
import { CARDS, CARDS_FOR, normalizeCards, placeCards, type CardKey, type CardsState } from "../../dashboard-registry";

// The user's dashboard is a list of cards that HARU (or the user) adds and removes.

async function readRaw(ctx: Ctx): Promise<CardsState | null> {
  const [row] = await sql<{ cards: unknown }[]>`select cards from dashboard_preferences where user_id = ${ctx.userId}`;
  return normalizeCards(row?.cards ?? null);
}

/** Cards for someone whose dashboard was never built (existing data, pre-AI dashboard). */
async function derive(ctx: Ctx): Promise<CardKey[]> {
  const [r] = await sql<{ jobs: number; debts: number; goals: number; bills: number; accounts: number; opps: number }[]>`
    select (select count(*) from jobs where user_id = ${ctx.userId} and status = 'active')::int as jobs,
           (select count(*) from debts where user_id = ${ctx.userId} and status = 'active')::int as debts,
           (select count(*) from savings_goals where user_id = ${ctx.userId} and status = 'active')::int as goals,
           (select count(*) from bills where user_id = ${ctx.userId} and status = 'active')::int as bills,
           (select count(*) from accounts where user_id = ${ctx.userId} and archived_at is null)::int as accounts,
           (select count(*) from work_opportunities where user_id = ${ctx.userId} and status in ('considering','accepted','scheduled'))::int as opps`;
  const add: CardKey[] = [];
  if (r.jobs) add.push("next_shift", "paychecks", "week", "stats");
  if (r.debts || r.goals) add.push("payoff");
  if (r.accounts) add.push("money");
  if (r.bills) add.push("bills");
  if (r.goals) add.push("goals");
  if (r.debts) add.push("debts");
  if (r.opps) add.push("opportunities");
  return placeCards([], add);
}

export async function getCards(ctx: Ctx): Promise<CardsState> {
  const raw = await readRaw(ctx);
  if (raw) return raw;
  // People who finished setup before the AI-built dashboard existed get cards from their data.
  // Someone new starts empty: Haru adds cards as they talk.
  return { show: ctx.prefs.onboarded_at ? await derive(ctx) : [], removed: [] };
}

async function save(ctx: Ctx, next: CardsState, prev: CardsState) {
  await sql`
    insert into dashboard_preferences (user_id, cards, previous_cards) values (${ctx.userId}, ${sql.json(next as never)}, ${sql.json(prev as never)})
    on conflict (user_id) do update set cards = excluded.cards, previous_cards = excluded.previous_cards, updated_at = now()`;
}

export interface CardChange {
  summary: string;
  added: CardKey[];
  removed: CardKey[];
  prev: CardsState;
}

/** Explicit change from the AI or the user. Removing a card remembers it, so it isn't auto-added back. */
export async function changeCards(ctx: Ctx, a: { add?: CardKey[]; remove?: CardKey[]; order?: CardKey[] }): Promise<CardChange> {
  const prev = await getCards(ctx);
  const remove = new Set(a.remove ?? []);
  let show = prev.show.filter((k) => !remove.has(k));
  const added = (a.add ?? []).filter((k) => !show.includes(k) && !remove.has(k));
  show = placeCards(show, added);
  if (a.order?.length) {
    const first = a.order.filter((k) => show.includes(k));
    show = [...first, ...show.filter((k) => !first.includes(k))];
  }
  const removedNow = prev.show.filter((k) => remove.has(k));
  const next: CardsState = { show, removed: [...prev.removed.filter((k) => !added.includes(k)), ...removedNow.filter((k) => !prev.removed.includes(k))] };
  await save(ctx, next, prev);
  const t = (ks: CardKey[]) => ks.map((k) => CARDS[k].title).join(", ");
  const parts = [added.length ? `added ${t(added)}` : "", removedNow.length ? `removed ${t(removedNow)}` : "", a.order?.length ? "reordered" : ""].filter(Boolean);
  return { summary: parts.length ? `Dashboard: ${parts.join("; ")}.` : "Dashboard unchanged.", added, removed: removedNow, prev };
}

/** After a change to the records, put the cards that now have something to show. */
export async function autoPlace(ctx: Ctx, change: string): Promise<CardKey[]> {
  const want = CARDS_FOR[change];
  if (!want?.length) return [];
  const prev = await getCards(ctx);
  const add = want.filter((k) => !prev.show.includes(k) && !prev.removed.includes(k));
  if (!add.length) return [];
  await save(ctx, { show: placeCards(prev.show, add), removed: prev.removed }, prev);
  return add;
}

export async function restoreCards(ctx: Ctx, state: CardsState) {
  const prev = await getCards(ctx);
  await save(ctx, state, prev);
}
