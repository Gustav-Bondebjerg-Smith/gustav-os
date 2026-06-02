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

-- Intet separat index på chat_id: UNIQUE-constraint ovenfor giver allerede et
-- index på kolonnen, så et ekstra create index ville være redundant.

-- RLS slås til UDEN policies med vilje: appen tilgår kun denne tabel via
-- service_role-klienten (getSupabase()), som bypasser RLS. Med RLS aktiveret og
-- nul policies nægtes al adgang for anon/authenticated = sikker deny-by-default.
-- Bygger du senere UI mod tabellen med en anon/authenticated nøgle, så TILFØJ
-- policies her.
alter table pending_activity enable row level security;
