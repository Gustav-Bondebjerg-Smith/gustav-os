-- Gustav OS - mad/opskrifter (helbreds-modul, fase 1).
-- ÉN tabel: recipes. Et voksende katalog. Det starter tomt og fyldes af
-- assistenten selv: hver gang suggest_meal genererer en god opskrift, gemmes den
-- her (source 'generated'). Manuelt tilfoejede er 'manual'.
--
-- MAKRO-KRAV (Gustavs valg 2026-06-27): hver ret er proteintung. Maal-ratio ca.
-- 15 kcal pr. gram protein - svarer til 3000 kcal og 200 g protein hvis hele
-- retten var dagens eneste mad. Behoever ikke ramme praecist, men ratioen skal
-- holde. Derfor gemmes kcal + protein_g pr. ret.
--
-- BEVIDST SIMPELT (jf. anti-over-engineering i AGENTS.md):
--   * INGEN meal_log-tabel. Variation styres af last_suggested_at, som saettes ved
--     hvert forslag. En meal_log ville kraeve manuel logning Gustav dropper.
--   * INGEN embedding-kolonne / semantisk soegning endnu. Kataloget er lille, et
--     almindeligt SQL-filter raekker. Tilfoejes hvis kataloget bliver stort.
--   * Diaet-praeferencer/allergier/maal lagres IKKE her, men i memory_facts
--     (scope='global' via save_memory) og laeses af suggest_meal som haarde krav.
-- Kør HELE filen i Supabase SQL Editor (projekt dxowfjyigfrhyaixyonj).

create table if not exists recipes (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  meal              text not null default 'aftensmad'
    check (meal in ('morgenmad', 'frokost', 'aftensmad', 'snack')),
  source            text not null default 'generated'
    check (source in ('generated', 'manual')),
  kcal              int,                          -- anslaaet kcal for HELE retten
  protein_g         int,                          -- anslaaet protein (g) for HELE retten
  total_minutes     int,                          -- samlet tilberedningstid
  servings          int,                          -- antal portioner/maaltider retten giver
  ingredients       text[] not null default '{}', -- én streng pr. ingrediens (m. maengde)
  steps             text[] not null default '{}', -- én streng pr. trin
  tags              text[] not null default '{}', -- fx 'kylling', 'meal-prep', 'billig'
  notes             text,                         -- tips, variationer, rester
  times_cooked      int not null default 0,
  last_suggested_at timestamptz,                  -- driver variation (foreslaa ikke det samme igen-igen)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Forslag filtrerer paa maaltid og sorterer paa variation (mindst nyligt foreslaaet).
create index if not exists idx_recipes_meal on recipes (meal, last_suggested_at);

-- Samme RLS-moenster som resten: aktiveret UDEN policies (deny-all). Appen tilgaar
-- kun via service_role (getSupabase()), som bypasser RLS.
alter table recipes enable row level security;

-- PostgREST skal kende den nye tabel med det samme (ellers PGRST204/PGRST202).
notify pgrst, 'reload schema';
