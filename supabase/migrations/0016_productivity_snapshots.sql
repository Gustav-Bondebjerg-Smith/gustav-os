-- Modul: Produktivitet. Dagligt snapshot af et 30-dages rullende produktivitets-
-- mål, beregnet i et nattecron fra balance-modulets kategoriserede kalender-events.
-- To tal gemmes, så forsiden kun læser et tal (ingen tung Sonnet-kald pr. besøg):
--   productivity_pct = produktiv tid / logget ikke-søvn tid (kvaliteten af det loggede)
--   coverage_pct     = logget ikke-søvn tid / vågne timer (30*24 - søvn) (hvor meget logget)
-- Produktiv = studie, arbejde, projekt, socialt, krop. Søvn holdes helt udenfor.
create table if not exists productivity_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  window_days int not null default 30,
  productive_hours numeric,
  logged_hours numeric,
  sleep_hours numeric,
  waking_hours numeric,
  productivity_pct numeric,
  coverage_pct numeric,
  event_count int not null default 0,
  generated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_productivity_date on productivity_snapshots (snapshot_date desc);
alter table productivity_snapshots enable row level security;

notify pgrst, 'reload schema';
