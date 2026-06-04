-- 0014_finance_classify_cron.sql
-- Formål: dræn finans-klassificeringskøen hvert kvarter fra Supabase selv
-- (pg_cron + pg_net), så månedlige uploads på /finans bliver kategoriseret i
-- baggrunden uden at ramme serverless-timeout. Samme mønster som 0007.
--
-- Genbruger den eksisterende Vault-secret 'gustav_os_cron_secret' (oprettet i
-- 0007) og de allerede installerede extensions pg_cron + pg_net. cron.schedule
-- er idempotent: samme jobnavn opdaterer bare jobbet.

select cron.schedule(
  'gustav-os-finance-classify',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://gustav-os.vercel.app/api/cron/finance-classify',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gustav_os_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

-- VERIFIKATION (kør manuelt efter ~15 min):
-- select jobid, jobname, schedule, active from cron.job where jobname = 'gustav-os-finance-classify';
-- select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'gustav-os-finance-classify')
--   order by start_time desc limit 5;
-- AFINSTALLATION: select cron.unschedule('gustav-os-finance-classify');
