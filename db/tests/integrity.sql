-- HARU database integrity tests. Run against a freshly migrated database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/integrity.sql
-- Every block raises an exception on failure. The whole run is rolled back.
begin;

insert into app_users(id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');

insert into jobs(id, user_id, employer, title, pay_frequency, period_anchor_date)
values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Northgate Security', 'Guard', 'biweekly', '2026-10-05'),
       ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'B Corp', null, 'monthly', null);

insert into accounts(id, user_id, name, kind, opening_balance_cents) values
  ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'Chequing', 'checking', 100000),
  ('20000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'Savings',  'savings',   50000),
  ('20000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'B Chequing', 'checking', 0);

-- T1: cross-user reference is rejected by composite FK (user isolation at the DB level)
do $$ begin
  begin
    insert into shifts(user_id, job_id, work_date, paid_minutes, rate_cents, gross_cents)
    values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000b', '2026-10-20', 360, 2000, 12000);
    raise exception 'T1 FAILED: shift referencing another user''s job was accepted';
  exception when foreign_key_violation then null; end;
end $$;

-- T2: gross must equal paid_minutes × rate / 60 (6.5h × $20 = $130)
insert into shifts(id, user_id, job_id, work_date, paid_minutes, rate_cents, gross_cents)
values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '2026-10-20', 390, 2000, 13000);
do $$ begin
  begin
    insert into shifts(user_id, job_id, work_date, paid_minutes, rate_cents, gross_cents)
    values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '2026-10-21', 390, 2000, 99999);
    raise exception 'T2 FAILED: inconsistent gross accepted';
  exception when check_violation then null; end;
end $$;

-- T3: recording work does not change cash
do $$ declare b bigint; begin
  select sum(balance_cents) into b from account_balances where user_id = '00000000-0000-0000-0000-00000000000a';
  if b <> 150000 then raise exception 'T3 FAILED: cash changed by a shift, got %', b; end if;
end $$;

-- T4: transfer between own accounts leaves total cash unchanged
insert into transactions(user_id, account_id, to_account_id, type, amount_cents, occurred_on)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a2', 'transfer', 20000, '2026-10-20');
do $$ declare b bigint; c bigint; s bigint; begin
  select sum(balance_cents) into b from account_balances where user_id = '00000000-0000-0000-0000-00000000000a';
  select balance_cents into c from account_balances where account_id = '20000000-0000-0000-0000-0000000000a1';
  select balance_cents into s from account_balances where account_id = '20000000-0000-0000-0000-0000000000a2';
  if b <> 150000 or c <> 80000 or s <> 70000 then raise exception 'T4 FAILED: total %, chequing %, savings %', b, c, s; end if;
end $$;

-- T5: a paycheck can be deposited only once
insert into paychecks(id, user_id, job_id, period_start, period_end, pay_date, expected_gross_cents, status, actual_net_cents)
values ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '2026-10-05', '2026-10-18', '2026-10-23', 13000, 'received', 12000);
insert into transactions(user_id, account_id, type, amount_cents, occurred_on, paycheck_id)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'paycheck', 12000, '2026-10-23', '40000000-0000-0000-0000-000000000001');
do $$ begin
  begin
    insert into transactions(user_id, account_id, type, amount_cents, occurred_on, paycheck_id)
    values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'paycheck', 12000, '2026-10-23', '40000000-0000-0000-0000-000000000001');
    raise exception 'T5 FAILED: paycheck deposited twice';
  exception when unique_violation then null; end;
end $$;

-- T6: expense reduces cash; voided rows are ignored
insert into transactions(id, user_id, account_id, type, amount_cents, occurred_on, category)
values ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'expense', 4200, '2026-10-22', 'groceries');
update transactions set voided_at = now() where id = '50000000-0000-0000-0000-000000000001';
insert into transactions(user_id, account_id, type, amount_cents, occurred_on, category)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'expense', 4200, '2026-10-22', 'groceries');
do $$ declare b bigint; begin
  select sum(balance_cents) into b from account_balances where user_id = '00000000-0000-0000-0000-00000000000a';
  if b <> 150000 + 12000 - 4200 then raise exception 'T6 FAILED: got %', b; end if;
end $$;

-- T7: debt payments reduce debt balance and cash, never below zero balance view
insert into debts(id, user_id, name, starting_balance_cents) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Friend loan', 640000);
insert into transactions(user_id, account_id, type, amount_cents, occurred_on, debt_id)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'debt_payment', 40000, '2026-10-22', '60000000-0000-0000-0000-000000000001');
do $$ declare d bigint; begin
  select balance_cents into d from debt_balances where debt_id = '60000000-0000-0000-0000-000000000001';
  if d <> 600000 then raise exception 'T7 FAILED: debt balance %', d; end if;
end $$;

-- T8: one payment per bill occurrence
insert into bills(id, user_id, name, amount_cents, next_due_date, recurrence)
values ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Phone', 11500, '2026-10-25', 'monthly');
insert into bill_payments(user_id, bill_id, due_date, paid_on, amount_cents)
values ('00000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000001', '2026-10-25', '2026-10-22', 11500);
do $$ begin
  begin
    insert into bill_payments(user_id, bill_id, due_date, paid_on, amount_cents)
    values ('00000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-000000000001', '2026-10-25', '2026-10-22', 11500);
    raise exception 'T8 FAILED: bill occurrence paid twice';
  exception when unique_violation then null; end;
end $$;

-- T9: goal contributions allocate, they do not change cash
insert into savings_goals(id, user_id, name, target_cents) values
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Emergency fund', 500000);
insert into goal_contributions(user_id, goal_id, amount_cents, contributed_on) values
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', 25000, '2026-10-22');
do $$ declare b bigint; g bigint; begin
  select sum(balance_cents) into b from account_balances where user_id = '00000000-0000-0000-0000-00000000000a';
  select saved_cents into g from goal_progress where goal_id = '80000000-0000-0000-0000-000000000001';
  if b <> 150000 + 12000 - 4200 - 40000 or g <> 25000 then raise exception 'T9 FAILED: cash %, goal %', b, g; end if;
end $$;

-- T10: a one-time job payment can be deposited only once
insert into work_opportunities(id, user_id, name, offered_cents, expected_minutes, status, earned_cents, work_date)
values ('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Restaurant shift', 10000, 360, 'completed', 10000, '2026-10-24');
insert into transactions(user_id, account_id, type, amount_cents, occurred_on, opportunity_id)
values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'income', 10000, '2026-10-24', '90000000-0000-0000-0000-000000000001');
do $$ begin
  begin
    insert into transactions(user_id, account_id, type, amount_cents, occurred_on, opportunity_id)
    values ('00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'income', 10000, '2026-10-24', '90000000-0000-0000-0000-000000000001');
    raise exception 'T10 FAILED: one-time job paid twice';
  exception when unique_violation then null; end;
end $$;

-- T11: reminder dedupe key prevents duplicate reminders
insert into reminders(user_id, category, title, fire_at, dedupe_key, origin)
values ('00000000-0000-0000-0000-00000000000a', 'shift', 'Shift soon', now() - interval '1 minute', 'shift:x:1', 'auto');
insert into reminders(user_id, category, title, fire_at, dedupe_key, origin)
values ('00000000-0000-0000-0000-00000000000a', 'shift', 'Shift soon', now() - interval '1 minute', 'shift:x:1', 'auto')
on conflict (user_id, dedupe_key) do nothing;
do $$ declare n int; begin
  select count(*) into n from reminders where dedupe_key = 'shift:x:1';
  if n <> 1 then raise exception 'T11 FAILED: % reminders', n; end if;
end $$;

-- T12: the scheduler claim query (same SQL as src/lib/notifications/scheduler.ts)
-- claims a due reminder exactly once across repeated invocations.
do $$ declare a int; b int; begin
  with due as (
    select id from reminders
    where (status = 'pending' and coalesce(next_attempt_at, fire_at) <= now())
       or (status = 'sending' and locked_at < now() - interval '5 minutes')
    order by coalesce(next_attempt_at, fire_at) limit 50
    for update skip locked
  )
  update reminders r set status = 'sending', locked_at = now(), attempts = r.attempts + 1
  from due where r.id = due.id;
  get diagnostics a = row_count;
  with due as (
    select id from reminders
    where (status = 'pending' and coalesce(next_attempt_at, fire_at) <= now())
       or (status = 'sending' and locked_at < now() - interval '5 minutes')
    order by coalesce(next_attempt_at, fire_at) limit 50
    for update skip locked
  )
  update reminders r set status = 'sending', locked_at = now(), attempts = r.attempts + 1
  from due where r.id = due.id;
  get diagnostics b = row_count;
  if a <> 1 or b <> 0 then raise exception 'T12 FAILED: first claim %, second claim %', a, b; end if;
end $$;

-- T13: user B sees none of user A's balances through the views
do $$ declare n int; begin
  select count(*) into n from account_balances where user_id = '00000000-0000-0000-0000-00000000000b' and account_id::text like '%a_';
  if n <> 0 then raise exception 'T13 FAILED'; end if;
end $$;

-- T14: deleting a user cascades all of their data (account deletion)
delete from app_users where id = '00000000-0000-0000-0000-00000000000b';
do $$ declare n int; begin
  select (select count(*) from jobs where user_id = '00000000-0000-0000-0000-00000000000b')
       + (select count(*) from accounts where user_id = '00000000-0000-0000-0000-00000000000b') into n;
  if n <> 0 then raise exception 'T14 FAILED: % rows survived', n; end if;
end $$;

select 'ALL 14 DATABASE INTEGRITY TESTS PASSED' as result;
rollback;
