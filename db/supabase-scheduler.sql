-- HARU reminder scheduler on Supabase (works on the free plan).
-- Calls HARU's protected endpoint every minute using pg_cron + pg_net.
-- Run once in Supabase → SQL Editor, after replacing the two placeholders.
-- It does NOT need the HARU website to be open.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the secret in Supabase Vault instead of in the job text.
select vault.create_secret('REPLACE_WITH_YOUR_CRON_SECRET', 'haru_cron_secret');

select cron.schedule(
  'haru-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://REPLACE_WITH_YOUR_DOMAIN/api/cron/notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'haru_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it's running:
--   select jobname, schedule, active from cron.job;
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select id, status_code, content from net._http_response order by id desc limit 5;
-- Stop it:
--   select cron.unschedule('haru-notifications');
