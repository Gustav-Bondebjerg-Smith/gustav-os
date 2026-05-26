-- Gustav OS - Fase 7 led 2: Telegram webhook idempotens.
-- Kør denne fil i Supabase SQL Editor før /api/telegram bruges i produktion.
--
-- Telegram kan gensende samme update, hvis webhook-kaldet timer ud eller fejler.
-- Denne tabel gør webhook'en idempotent på update_id, så samme besked ikke bliver
-- gemt flere gange som raw_capture.

create table if not exists telegram_updates (
  update_id    bigint primary key,
  status       text not null default 'processing', -- processing | processed | ignored | failed
  chat_id      bigint,
  message_id   bigint,
  reason       text,
  error        text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_telegram_updates_status_received
  on telegram_updates (status, received_at desc);

-- RLS: kun service_role-adgang, samme mønster som resten af systemet.
alter table telegram_updates enable row level security;
