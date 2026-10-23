# HARU implementation checklist

Status as delivered (October 22, 2026). **Verified** means a test exercised the real code against a real PostgreSQL 16 database or real libraries. **Needs your deployment** means it needs credentials or packages that weren't available where this was built.

## How this was built and checked

The build environment had no access to the npm registry, so `npm install` and `next build` could not run there. What was available and used:

- PostgreSQL 16: the migration was applied and every query path was run against it.
- Zod 4, Node types, TypeScript 6: the whole codebase type-checks in strict mode. Packages that couldn't be installed (Next, React types, postgres.js, Supabase, Anthropic SDK) were replaced by hand-written typed stand-ins for that check.
- For integration tests, the postgres.js driver was stood in for by a psql-backed adapter, and web-push by a recording fake (accepts, 410 Gone, and 503 endpoints).
- React 19 + Tailwind 4 + Chromium: the real dashboard was server-rendered with seeded data and screenshotted at desktop and phone widths, in light and dark.

**Run `npm install && npm run typecheck && npm run build && npm test` first.** That is the first time the real Next.js 16 compiler sees the code. Please send any build error back to me.

## Foundations
- [x] Schema: 25 tables, composite FKs for isolation, check constraints, partial unique indexes, balance/debt/goal views — **verified** (14 SQL integrity tests)
- [x] RLS enabled with no policies; anon/authenticated revoked — **verified** (applied on PG16)
- [x] Migration runner with `schema_migrations` — written; same SQL verified
- [x] Supabase email/password auth, session refresh proxy, provisioning on first sign-in — written; **needs your deployment**

## Work and money
- [x] Jobs, wage history, independent pay rules (weekly / biweekly / semimonthly / monthly, offset, weekend rule) — **verified**
- [x] Shifts from times or hours, breaks, overnight, DST-correct, stored wage snapshot — **verified** (incl. Nov 1 2026 fall-back)
- [x] Scheduled shift completed instead of duplicated; duplicate-day guard — **verified**
- [x] Regular schedules materialise idempotently — **verified**
- [x] One-time opportunities: effective rate, reserve/planning estimate, states, paid once — **verified**
- [x] Paycheck forecast per job with uncertainty; paycheck receipt with comparison; deposit once; undo — **verified**
- [x] Expenses, income, transfers, balance adjustments, voids — **verified**
- [x] Bills with recurrence (anchor day), pay once per occurrence, undo — **verified**
- [x] Goals (allocation, not spending), debts (payments separate from spending) — **verified**
- [x] Reports (earned / received / spending / projections), compare periods, CSV — **verified**

## AI
- [x] Provider abstraction + Anthropic adapter — adapter written; **needs your API key**
- [x] 40 tools with Zod-validated args; JSON Schema generated from the same schemas — **verified**
- [x] Agent loop, conversation persistence, action history — **verified** with a scripted model
- [x] Confirmation gating (single-use), undo (7 days, dependency-safe) — **verified**
- [x] Isolation through tools — **verified**
- [x] Honest failure when the provider is down — **verified**
- [ ] Quality of the live model's understanding (e.g. "this Saturday", ambiguous jobs) — **needs your API key**; prompt includes a calendar and record ids

## Notifications
- [x] Manifest, service worker (show, display ack, click-through, subscription rotation) — written
- [x] Subscribe/unsubscribe, test push with 3-stage result — written; server side **verified**
- [x] Planner, atomic claim, relevance re-check, delivery log, retry/backoff, 410 cleanup, expiry, exactly-once — **verified**
- [x] Protected cron endpoint (timing-safe bearer check) — written
- [x] Supabase pg_cron setup script; Vercel Hobby/Pro limits documented — written
- [ ] Real delivery to a real browser — **needs your deployment** (VAPID keys + scheduler + a device). Use Settings → Send a test.

## UI
- [x] Adaptive dashboard (registry, data-driven order, hide-when-empty, user/AI layout + undo) — **verified** by render
- [x] Money bar separating cash / reserved / goals / safe / unpaid / expected / debt — **verified** by render
- [x] Command center (side panel on desktop, sheet on mobile), action cards, report cards — rendered; interactive behaviour **needs your deployment**
- [x] Records sheet (forms for every record), settings, notification inbox, onboarding — written; type-checked
- [x] Light/dark, responsive at 390px and 1360px, keyboard focus, reduced motion — **verified** by render

## Operations
- [x] Export all data (JSON), account deletion (cascade + optional identity deletion) — deletion cascade **verified**
- [x] Env vars and deployment steps — README
