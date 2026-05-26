-- Gustav OS - Fase 4: actions-tabel til auto-handlinger med Telegram-veto.
-- Kør hele filen i Supabase SQL Editor.
-- Bemærk: audit_log-tabellen findes allerede fra 0001_init.sql og genbruges som immutable log.
--
-- State machine for actions:
--   proposed   - forslag sendt til Telegram, venter på veto eller veto-vindue udløb
--   executing  - worker/cron har claimet handlingen og er ved at udføre den
--   executed   - handlingen udført (timeout uden veto, eller eksplicit 'ja')
--   vetoed     - Gustav skrev 'nej' inden veto-vinduet udløb
--   failed     - forsøgte at udføre, men fejlede (fx Google API-fejl)

create table if not exists actions (
  id                  uuid primary key default gen_random_uuid(),
  type                text not null,                    -- 'calendar_insert' (senere flere typer)
  payload             jsonb not null default '{}',      -- hvad skal udføres (summary, start, end, ...)
  status              text not null default 'proposed', -- proposed | executed | vetoed | failed
  source_capture_id   uuid references raw_captures(id) on delete set null,
  telegram_message_id bigint,                           -- Telegram-besked med forslaget (til reply-detektion)
  veto_deadline       timestamptz not null,             -- efter denne tid må watcheren udføre
  result              jsonb,                            -- udførelsens output (event_id, fejlbesked, ...)
  executed_at         timestamptz,
  vetoed_at           timestamptz,
  created_at          timestamptz not null default now()
);

-- Indeks: watcheren spørger ofte "alt der er proposed og hvis deadline er passeret"
create index if not exists idx_actions_status_deadline on actions (status, veto_deadline);

-- RLS: kun service_role-adgang, samme mønster som resten af tabellerne
alter table actions enable row level security;
