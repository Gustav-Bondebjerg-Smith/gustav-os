-- Modul 5: ugentlig review. Én række pr. ISO-uge (mandag = week_start, unik),
-- så cron + manuel kørsel idempotent opdaterer SAMME uge i stedet for at lave
-- dubletter. report = Sonnet-markdown (wins / hvad smuttede / åbne sløjfer /
-- top 3 næste uge). data = snapshot af input (tid/opgaver/mål/finans) til
-- visning + debug. RLS deny-all (kun service_role), som alle øvrige tabeller.
create extension if not exists pgcrypto;

create table if not exists public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  week_end date not null,
  report text not null,
  data jsonb not null default '{}'::jsonb,
  delivered_telegram boolean not null default false,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists weekly_reviews_week_start_idx
  on public.weekly_reviews (week_start desc);

alter table public.weekly_reviews enable row level security;

-- Ingen policies = deny-all for anon/auth. service_role (lib/supabase.ts) går
-- uden om RLS, som i resten af systemet.

notify pgrst, 'reload schema';
