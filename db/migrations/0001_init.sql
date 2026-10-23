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
