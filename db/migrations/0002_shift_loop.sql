-- HARU 0002 — the shift loop.
--  * shifts can be confirmed ("going") before they start, or marked missed
--  * twice-a-month pay with custom period start days and pay days
--    (e.g. periods start on the 10th and 25th, paid on the 15th and 30th)
--  * after-shift check-in reminders and one-tap notification actions
--  * reminders one hour before a shift by default

-- Attendance on shifts
alter table shifts add column if not exists attendance text not null default 'pending'
  check (attendance in ('pending', 'going', 'not_going'));
alter table shifts drop constraint if exists shifts_status_check;
alter table shifts add constraint shifts_status_check
  check (status in ('scheduled', 'completed', 'cancelled', 'missed'));
create index if not exists shifts_user_status_idx on shifts(user_id, status, work_date);

-- Custom pay calendars
alter table jobs add column if not exists period_start_days smallint[]; -- semimonthly/monthly period starts, e.g. {10,25}
alter table jobs add column if not exists pay_days smallint[];          -- calendar pay days, e.g. {15,30}; 31 = last day
alter table jobs drop constraint if exists jobs_period_start_days_check;
alter table jobs add constraint jobs_period_start_days_check
  check (period_start_days is null or (cardinality(period_start_days) between 1 and 2
         and 1 <= all(period_start_days) and 28 >= all(period_start_days)));
alter table jobs drop constraint if exists jobs_pay_days_check;
alter table jobs add constraint jobs_pay_days_check
  check (pay_days is null or (cardinality(pay_days) between 1 and 2 and 1 <= all(pay_days) and 31 >= all(pay_days)));

-- Reminder categories and notification payloads (actions, shift id)
alter table reminders drop constraint if exists reminders_category_check;
alter table reminders add constraint reminders_category_check
  check (category in ('shift', 'checkout', 'log_hours', 'payday', 'bill', 'goal', 'opportunity', 'custom'));
alter table reminders add column if not exists payload jsonb not null default '{}'::jsonb;

-- Tax estimate and reminder timing defaults
alter table user_preferences alter column shift_lead_minutes set default 60;
update user_preferences set shift_lead_minutes = 60 where shift_lead_minutes = 30;
update user_preferences set notify_categories = notify_categories || '{"checkout": true}'::jsonb
  where not notify_categories ? 'checkout';
alter table user_preferences alter column notify_categories set default
  '{"shift":true,"checkout":true,"log_hours":false,"payday":true,"bill":true,"goal":true,"opportunity":true,"custom":true}'::jsonb;

-- Debt kind for payoff planning
alter table debts add column if not exists kind text not null default 'other'
  check (kind in ('credit_card', 'loan', 'personal', 'line_of_credit', 'other'));

-- Behavioural memory for the AI: what the user did when asked "are you going?"
create table if not exists shift_events (
  id bigserial primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  shift_id uuid references shifts(id) on delete set null,
  event text not null check (event in ('going', 'not_going', 'completed_full', 'completed_partial', 'missed')),
  weekday smallint not null check (weekday between 0 and 6),
  local_hour smallint check (local_hour between 0 and 23),
  hours_planned numeric(5,2),
  hours_worked numeric(5,2),
  created_at timestamptz not null default now()
);
create index if not exists shift_events_user_idx on shift_events(user_id, created_at desc);
alter table shift_events enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on shift_events from anon, authenticated';
    execute 'revoke all on sequence shift_events_id_seq from anon, authenticated';
  end if;
end $$;
