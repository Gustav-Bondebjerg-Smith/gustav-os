-- Gustav OS - mål (Modul 3).
-- Uge- og måneds-mål der bliver stående (auto-nulstiller aldrig; Gustav fjerner
-- dem selv). Bevidst simpelt: ét mål = én boolean (klar/ikke klar). Den rigere
-- "aktivt fokus + delmål"-hero fra Claude Design er udskudt (kræver eget datamodel).
-- Kør HELE filen i Supabase SQL Editor (projekt dxowfjyigfrhyaixyonj).

create table if not exists goals (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('week', 'month')),
  title       text not null,
  done        boolean not null default false,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_goals_scope on goals (scope, sort, created_at);

-- Samme RLS-mønster som resten: aktiveret UDEN policies (deny-all). Appen tilgår
-- kun via service_role (getSupabase()), som bypasser RLS.
alter table goals enable row level security;

-- PostgREST skal kende den nye tabel med det samme.
notify pgrst, 'reload schema';
