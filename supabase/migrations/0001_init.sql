-- Gustav OS - initial schema (Fase 1)
-- Kør hele filen i Supabase SQL Editor.
-- Sikkerhed: alle tabeller får RLS (row-level security) slået til UDEN offentlige policies.
-- Det betyder: kun server-side adgang via service_role-nøglen kan læse/skrive.
-- Din anon-nøgle (browseren) kan altså ikke røre dataene endnu. Det er bevidst og sikkert.

-- 1) pgvector: gør semantisk søgning mulig (embeddings i memory_chunks).
create extension if not exists vector;

-- 2) entities: ting systemet kender til - personer, projekter, fag, steder.
create table if not exists entities (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,                 -- 'person' | 'projekt' | 'fag' | 'sted' ...
  name        text not null,
  notes       text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 3) raw_captures: alt råt input fra Telegram (voice/tekst) eller dashboard.
create table if not exists raw_captures (
  id             uuid primary key default gen_random_uuid(),
  source         text not null,              -- 'telegram_voice' | 'telegram_text' | 'dashboard'
  content        text not null,              -- transskriberet eller skrevet tekst
  area           text,                       -- 'personlig' | 'studie' | 'arbejde' (til senere opdeling)
  classification jsonb,                      -- Claudes klassificering (type, tags, ...)
  processed      boolean not null default false,
  created_at     timestamptz not null default now()
);

-- 4) tasks: opgaver og deadlines udtrukket fra captures.
create table if not exists tasks (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  details           text,
  due_date          timestamptz,
  status            text not null default 'open',  -- 'open' | 'done' | 'cancelled'
  area              text,
  source_capture_id uuid references raw_captures(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- 5) daily_logs: daglige check-ins (energi, humør, søvn) som mønstre læres fra.
create table if not exists daily_logs (
  id          uuid primary key default gen_random_uuid(),
  log_date    date not null,
  energy      int,            -- 1-5
  mood        int,            -- 1-5
  sleep_hours numeric,
  notes       text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- 6) memory_chunks: embeddede tekststumper = kernen i din "second brain".
-- vector(1536) matcher OpenAI's model text-embedding-3-small.
create table if not exists memory_chunks (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  embedding   vector(1536),
  source_type text,           -- 'raw_capture' | 'task' | 'daily_log' | 'calendar_event' ...
  source_id   uuid,
  area        text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
-- NB: similarity-index (ivfflat/hnsw) tilføjes i Fase 5, når der er data at søge i.

-- 7) audit_log: log over auto-handlinger (kalender) til veto/rollback-modellen.
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,   -- 'calendar_insert' | 'calendar_move' | 'calendar_delete' ...
  payload    jsonb not null default '{}',     -- hvad blev gjort, før/efter
  status     text not null default 'applied', -- 'applied' | 'rolled_back' | 'vetoed'
  reason     text,            -- assistentens begrundelse
  created_at timestamptz not null default now()
);

-- 8) Slå RLS til på alt. Uden policies = ingen offentlig adgang (kun service_role).
alter table entities      enable row level security;
alter table raw_captures  enable row level security;
alter table tasks         enable row level security;
alter table daily_logs    enable row level security;
alter table memory_chunks enable row level security;
alter table audit_log     enable row level security;
