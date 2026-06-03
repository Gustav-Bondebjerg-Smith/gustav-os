-- Gustav OS - Kort-tids samtale-hukommelse for tool-calling routeren.
-- Når routeren stiller et afklarende spørgsmål (kind:'ask') i stedet for at
-- handle, gemmes samtalen-indtil-nu her (messages = Anthropic message-array:
-- [{role, content}, ...]). Gustavs NÆSTE besked fra samme chat sendes så med som
-- kontekst, så et svar fuldfører den oprindelige handling i stedet for at blive
-- vurderet kontekstløst (= loop i nye spørgsmål). Ryddes så snart en handling
-- udføres, og udløber efter et kort vindue (se CLARIFY_WINDOW_MINUTES) så en gammel
-- halv-samtale ikke hænger på en helt ny, urelateret besked.
--
-- chat_id er UNIQUE: én åben afklaring per chat. Upsert på conflict.

create table if not exists pending_clarification (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null unique,
  messages    jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Samme RLS-mønster som pending_activity: aktiveret UDEN policies med vilje.
-- Appen tilgår kun tabellen via service_role-klienten (getSupabase()), som
-- bypasser RLS. Med RLS aktiveret og nul policies nægtes al adgang for
-- anon/authenticated = sikker deny-by-default. Bygger du senere UI mod tabellen
-- med en anon/authenticated nøgle, så TILFØJ policies her.
alter table pending_clarification enable row level security;
