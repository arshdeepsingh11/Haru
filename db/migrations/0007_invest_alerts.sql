-- HARU 0007: price alerts ("tell me when gold goes above ₹1,30,000"), delivered as normal reminders.

create table if not exists invest_alerts (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  asset_key text not null check (length(asset_key) between 2 and 120),
  name text not null check (length(name) between 1 and 160),
  currency text not null,
  unit text,
  -- how to price it without the person's session (catalog or saved search result)
  asset jsonb not null default '{}'::jsonb,
  direction text not null check (direction in ('above', 'below')),
  target numeric(20, 6) not null check (target > 0),
  price_at_create numeric(20, 6),
  active boolean not null default true,
  triggered_at timestamptz,
  triggered_price numeric(20, 6),
  last_checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invest_alerts_user_idx on invest_alerts(user_id, created_at desc);
create index if not exists invest_alerts_active_idx on invest_alerts(asset_key) where active;

-- Alerts arrive through the reminder queue (push + in-app inbox, with retries).
alter table reminders drop constraint if exists reminders_category_check;
alter table reminders add constraint reminders_category_check
  check (category in ('shift', 'checkout', 'log_hours', 'payday', 'bill', 'goal', 'opportunity', 'custom', 'market'));

alter table invest_alerts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on invest_alerts from anon, authenticated';
    execute 'revoke all on sequence invest_alerts_id_seq from anon, authenticated';
  end if;
end $$;
