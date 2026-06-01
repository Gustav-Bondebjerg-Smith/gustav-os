-- 0007_pg_cron_actions.sql
-- Formaal: kald /api/cron/actions hvert 10. minut fra Supabase selv (pg_cron + pg_net),
-- saa kalender-actions ikke venter paa den daglige Vercel-cron (op til 17 timers lag).
-- Secreten bliver i DIN egen Supabase (Vault), aldrig hos en tredjepart.
--
-- KOERSEL: i Supabase Dashboard -> SQL Editor. Koer BLOK 1 (du indsaetter din secret),
-- derefter BLOK 2. BLOK 3 og 4 er til verifikation og afinstallation.

-- =====================================================================
-- BLOK 1: udvidelser + gem CRON_SECRET i Vault (koer EN gang)
-- Indsaet din 43-tegns CRON_SECRET mellem de foerste anførselstegn nedenfor.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(
  'PASTE_DIN_CRON_SECRET_HER',
  'gustav_os_cron_secret',
  'Bearer-token til /api/cron/actions'
);

-- =====================================================================
-- BLOK 2: schedulér kaldet hvert 10. minut (idempotent - samme navn opdaterer jobbet)
-- Henter nøglen fra Vault ved kørsel, saa secreten staar ikke i cron-definitionen.
-- =====================================================================
select cron.schedule(
  'gustav-os-actions',
  '*/10 * * * *',
  $$
  select net.http_get(
    url := 'https://gustav-os.vercel.app/api/cron/actions',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gustav_os_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $$
);

-- =====================================================================
-- BLOK 3: VERIFIKATION (koer efter ~10 min)
-- =====================================================================
-- Er jobbet registreret og aktivt?
-- select jobid, jobname, schedule, active from cron.job where jobname = 'gustav-os-actions';

-- Koerte pg_cron-jobbet? (status skal vaere 'succeeded')
-- select status, return_message, start_time
-- from cron.job_run_details
-- where jobid = (select jobid from cron.job where jobname = 'gustav-os-actions')
-- order by start_time desc limit 5;

-- Hvad svarede endpointet? (status_code 200, content {"ok":true,...})
-- select status_code, content, created
-- from net._http_response order by created desc limit 5;

-- =====================================================================
-- BLOK 4: AFINSTALLATION (hvis du vil stoppe igen)
-- =====================================================================
-- select cron.unschedule('gustav-os-actions');
