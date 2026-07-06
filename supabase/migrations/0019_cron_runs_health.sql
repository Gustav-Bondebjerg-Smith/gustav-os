-- 0019_cron_runs_health.sql
-- Vagthund (health-cron): (1) puls-tabel som withCronLock skriver "sidste
-- vellykkede koersel" i, (2) vaern mod Storebox-dobbeltmatch, (3) dagligt
-- pg_cron-kald af /api/cron/health (samme Vault-moenster som 0007/0014).
--
-- KOERSEL: hele filen kan koeres i Supabase SQL Editor (eller via MCP).
-- BLOK 3 kraever at extensions + Vault-secret fra 0007 allerede findes.

-- =====================================================================
-- BLOK 1: cron_runs - puls pr. cron-job.
-- withCronLock upserter (name, last_success) efter hver vellykket koersel.
-- Vagthunden flager jobs hvis puls er aeldre end jobbets forventning.
-- Seedes med now() som baseline, saa et job foerst flages naar det har
-- OVERSKREDET sin taerskel efter denne migration - ikke fra dag ét.
-- =====================================================================
create table if not exists cron_runs (
  name text primary key,
  last_success timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cron_runs enable row level security;

insert into cron_runs (name) values
  ('actions'),
  ('patterns'),
  ('finance-classify'),
  ('productivity'),
  ('weekly-review'),
  ('health')
on conflict (name) do nothing;

-- =====================================================================
-- BLOK 2: Storebox-dobbeltmatch-vaern.
-- To kvitteringer maa ikke pege paa samme bank-transaktion (1:1-reglen i
-- lib/finance-reconcile.ts haandhaeves nu ogsaa af databasen). Partial
-- index, saa de mange umatchede (null) rækker ikke rammes.
-- =====================================================================
create unique index if not exists uq_storebox_matched_tx
  on storebox_receipts (matched_transaction_id)
  where matched_transaction_id is not null;

-- =====================================================================
-- BLOK 3: dagligt pg_cron-kald af vagthunden (05:30 UTC = 06:30/07:30 CPH).
-- Genbruger CRON_SECRET fra Vault ('gustav_os_cron_secret', oprettet i 0007).
-- Idempotent: samme jobnavn opdaterer bare jobbet.
-- =====================================================================
select cron.schedule(
  'gustav-os-health',
  '30 5 * * *',
  $$
  select net.http_get(
    url := 'https://gustav-os.vercel.app/api/cron/health',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gustav_os_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);

-- =====================================================================
-- VERIFIKATION (koer efter naeste morgen)
-- =====================================================================
-- select jobid, jobname, schedule, active from cron.job where jobname = 'gustav-os-health';
-- select name, last_success from cron_runs order by last_success desc;
--
-- AFINSTALLATION:
-- select cron.unschedule('gustav-os-health');
