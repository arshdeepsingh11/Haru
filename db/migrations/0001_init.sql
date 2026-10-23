-- HARU — initial schema
-- Money is stored as integer cents (bigint). Durations as integer minutes.
-- Instants are timestamptz (UTC). Calendar dates are `date` interpreted in the
-- user's configured time zone (user_preferences.timezone).
--
-- Isolation: every row carries user_id. Child tables reference parents through
-- composite foreign keys (parent_id, user_id) so the database itself rejects a
-- record that points at another user's data.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users & preferences
-- ---------------------------------------------------------------------------
create table app_users (
  id uuid primary key,                 -- equals the Supabase auth user id
  email text,
  created_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid primary key references app_users(id) on delete cascade,
  display_name text,
  currency char(3) not null default 'CAD' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'America/Edmonton',
  week_starts_on smallint not null default 1 check (week_starts_on between 0 and 6),
  reserve_percent numeric(5,2) not null default 5 check (reserve_percent >= 0 and reserve_percent <= 100),
  onboarded_at timestamptz,
  -- notifications
  notify_enabled boolean not null default false,
  notify_categories jsonb not null default
    '{"shift":true,"log_hours":true,"payday":true,"bill":true,"goal":true,"opportunity":true,"custom":true}'::jsonb,
  shift_lead_minutes integer not null default 30 check (shift_lead_minutes between 0 and 1440),
  log_hours_time time not null default '21:00',
  bill_lead_days smallint not null default 1 check (bill_lead_days between 0 and 14),
  bill_notify_time time not null default '09:00',
  payday_notify_time time not null default '09:00',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------
create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  employer text not null check (length(employer) between 1 and 120),
  title text,
  currency char(3) not null default 'CAD' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active','paused','ended')),
  start_date date,
  expected_weekly_minutes integer check (expected_weekly_minutes between 0 and 10080),
  pay_frequency text check (pay_frequency in ('weekly','biweekly','semimonthly','monthly')),
  period_anchor_date date,             -- first day of any known pay period (weekly/biweekly)
  semimonthly_split_day smallint not null default 15 check (semimonthly_split_day between 1 and 27),
  payday_offset_days smallint not null default 0 check (payday_offset_days between 0 and 31),
  payday_weekend_rule text not null default 'none'
    check (payday_weekend_rule in ('none','previous_business_day','next_business_day')),
  deduction_percent numeric(5,2) check (deduction_percent >= 0 and deduction_percent < 100),
  deduction_fixed_cents bigint check (deduction_fixed_cents >= 0),
  regular_schedule jsonb not null default '[]'::jsonb,  -- [{weekday:0-6,start:"HH:MM",end:"HH:MM",break_minutes}]
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (pay_frequency not in ('weekly','biweekly') or period_anchor_date is not null)
);
create index jobs_user_idx on jobs(user_id);

create table job_wages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  rate_cents integer not null check (rate_cents > 0 and rate_cents < 100000000),
  effective_from date not null,
  created_at timestamptz not null default now(),
  foreign key (job_id, user_id) references jobs(id, user_id) on delete cascade,
  unique (job_id, effective_from)
);
create index job_wages_job_idx on job_wages(job_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- Money: accounts & ledger
-- ---------------------------------------------------------------------------
create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  kind text not null default 'checking' check (kind in ('checking','savings','cash','other')),
  opening_balance_cents bigint not null default 0,
  opening_date date not null default current_date,
  is_manual boolean not null default true,   -- true until a real bank sync exists (none is built)
  balance_confirmed boolean not null default false, -- false until the user states a real balance
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index accounts_user_idx on accounts(user_id);

create table paychecks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  expected_gross_cents bigint not null default 0 check (expected_gross_cents >= 0),
  expected_net_cents bigint check (expected_net_cents >= 0),
  actual_gross_cents bigint check (actual_gross_cents >= 0),
  actual_net_cents bigint check (actual_net_cents >= 0),
  status text not null default 'expected' check (status in ('expected','received')),
  received_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, user_id) references jobs(id, user_id) on delete cascade,
  unique (id, user_id),
  unique (job_id, period_start),
  check (period_end >= period_start),
  check (status <> 'received' or actual_net_cents is not null)
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  work_date date not null,
  starts_at timestamptz,
  ends_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes between 0 and 1440),
  paid_minutes integer not null check (paid_minutes between 0 and 1440),
  rate_cents integer not null check (rate_cents >= 0),        -- snapshot of the wage used
  gross_cents bigint not null check (gross_cents >= 0),       -- snapshot: round(paid_minutes*rate/60)
  status text not null default 'completed' check (status in ('scheduled','completed','cancelled')),
  source text not null default 'manual' check (source in ('manual','ai','schedule')),
  paycheck_id uuid,
  notes text,
  revised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (job_id, user_id) references jobs(id, user_id) on delete cascade,
  foreign key (paycheck_id, user_id) references paychecks(id, user_id) on delete set null (paycheck_id),
  unique (id, user_id),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (gross_cents = round(paid_minutes::numeric * rate_cents / 60))
);
create index shifts_user_date_idx on shifts(user_id, work_date);
create index shifts_job_date_idx on shifts(job_id, work_date);
-- Shifts generated from a job's regular schedule are materialised idempotently.
create unique index shifts_schedule_once on shifts(job_id, work_date, starts_at) where source = 'schedule';

create table work_opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  offered_cents bigint not null check (offered_cents >= 0),
  pay_basis text not null default 'unknown' check (pay_basis in ('gross','net','unknown')),
  expected_minutes integer check (expected_minutes > 0 and expected_minutes <= 1440),
  work_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'considering'
    check (status in ('considering','accepted','scheduled','completed','declined')),
  actual_minutes integer check (actual_minutes > 0 and actual_minutes <= 1440),
  earned_cents bigint check (earned_cents >= 0),
  decided_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  check (status <> 'completed' or earned_cents is not null),
  check (status <> 'scheduled' or work_date is not null)
);
create index opp_user_idx on work_opportunities(user_id, status);

create table debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null,
  creditor text,
  starting_balance_cents bigint not null check (starting_balance_cents > 0),
  opened_on date not null default current_date,
  interest_rate_percent numeric(6,3) check (interest_rate_percent >= 0),
  minimum_payment_cents bigint check (minimum_payment_cents >= 0),
  status text not null default 'active' check (status in ('active','paid_off','archived')),
  notes text,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
