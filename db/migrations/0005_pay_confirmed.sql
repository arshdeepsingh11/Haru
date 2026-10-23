-- HARU 0005: remember whether a job's pay calendar was confirmed by the person.
-- Jobs saved before Haru asked for exact paydays stay unconfirmed, so the app asks once
-- ("Is BioARO's next payday Oct 30?") instead of trusting a guess.
alter table jobs add column if not exists pay_confirmed_at timestamptz;
-- Pay days given explicitly (e.g. 15th & 30th) are a confirmed calendar.
update jobs set pay_confirmed_at = coalesce(pay_confirmed_at, updated_at)
  where pay_confirmed_at is null and pay_days is not null and array_length(pay_days, 1) > 0;
