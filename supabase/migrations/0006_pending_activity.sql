-- Gustav OS - Tids-tracking via Telegram.
-- Én aktiv "pending activity" per chat. Når Gustav skriver "starter på X",
-- gemmes start-tidspunktet her. Når han skifter til "Y", indsættes X som
-- kalenderbegivenhed (med pending-rækkens started_at som start og nu som
-- slut), og pending-rækken overskrives med {Y, nu}.
--
-- chat_id er UNIQUE: én aktiv aktivitet per chat. Upsert på conflict.

create table if not exists pending_activity (
  id            uuid primary key default gen_random_uuid(),
  chat_id       bigint not null unique,
  activity_name text not null,
  started_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_pending_activity_chat on pending_activity (chat_id);

alter table pending_activity enable row level security;
