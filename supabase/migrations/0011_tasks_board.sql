-- Gustav OS - opgave-board (Modul 2).
-- Udvider tasks-tabellen fra 0001 med hastigheds-bunker, vigtig-flag, prioritet
-- og completed_at, så captures af type "opgave" kan auto-oprettes OG prioriteres
-- (Gustavs krav: "når jeg fortæller, at jeg skal nå noget, indsætter den
-- opgaverne og prioriterer dem").
-- Kør HELE filen i Supabase SQL Editor (projekt dxowfjyigfrhyaixyonj).
-- Idempotent: add column if not exists + betinget backfill, så den kan køres igen.

alter table tasks add column if not exists urgency        text;     -- 'today' | 'week' | 'month' | 'someday'
alter table tasks add column if not exists key            boolean not null default false;  -- vigtig/nøgleopgave
alter table tasks add column if not exists priority_score int;      -- 0-100, højere = vigtigere (AI-tildelt)
alter table tasks add column if not exists completed_at   timestamptz;
alter table tasks add column if not exists tags           jsonb not null default '[]';

-- Eksisterende åbne opgaver uden hastighed lægges i "senere", så boardet ikke
-- har huller. Kun rækker hvor urgency stadig er null (idempotent).
update tasks set urgency = 'someday' where urgency is null and status = 'open';

-- Board-forespørgsler filtrerer på status + sorterer på hastighed/prioritet.
create index if not exists idx_tasks_board on tasks (status, urgency, priority_score desc);

-- PostgREST skal kende de nye kolonner med det samme (ellers PGRST204).
notify pgrst, 'reload schema';
