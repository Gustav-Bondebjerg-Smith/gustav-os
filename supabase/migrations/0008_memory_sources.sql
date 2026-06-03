-- Gustav OS - canonical Supabase memory + agent/MCP access.
-- Kør hele filen i Supabase SQL Editor.
--
-- Formål:
--   - Supabase bliver primær kilde til agent-memory.
--   - Lokale filer, reference-docs, raw captures og manuelle agent-noter får
--     en source-række med metadata.
--   - memory_chunks bevarer bagudkompatibilitet med search_memory(), men får
--     source-link, brain_id, chunk_index og soft-delete metadata.

create table if not exists memory_sources (
  id           uuid primary key default gen_random_uuid(),
  brain_id     text not null default 'personal',
  source_type  text not null,
  source_key   text not null,
  title        text not null,
  uri          text,
  content      text,
  content_hash text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create unique index if not exists idx_memory_sources_unique
  on memory_sources (brain_id, source_type, source_key);

create index if not exists idx_memory_sources_active
  on memory_sources (brain_id, source_type, deleted_at);

alter table memory_sources enable row level security;

alter table memory_chunks
  add column if not exists memory_source_id uuid references memory_sources(id) on delete cascade,
  add column if not exists brain_id text not null default 'personal',
  add column if not exists chunk_index int,
  add column if not exists content_hash text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

create index if not exists idx_memory_chunks_source
  on memory_chunks (memory_source_id, chunk_index);

create index if not exists idx_memory_chunks_brain_active
  on memory_chunks (brain_id, deleted_at, created_at desc);

create unique index if not exists idx_memory_chunks_source_chunk_active
  on memory_chunks (memory_source_id, chunk_index)
  where deleted_at is null and memory_source_id is not null and chunk_index is not null;

create table if not exists memory_audit_log (
  id               uuid primary key default gen_random_uuid(),
  actor            text not null default 'agent',
  tool_name         text,
  action            text not null,
  memory_source_id  uuid references memory_sources(id) on delete set null,
  payload           jsonb not null default '{}',
  status            text not null default 'ok',
  created_at        timestamptz not null default now()
);

create index if not exists idx_memory_audit_log_created_at
  on memory_audit_log (created_at desc);

alter table memory_audit_log enable row level security;

create or replace function set_memory_updated_at()
returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_memory_sources_updated_at on memory_sources;
create trigger trg_memory_sources_updated_at
before update on memory_sources
for each row execute function set_memory_updated_at();

drop trigger if exists trg_memory_chunks_updated_at on memory_chunks;
create trigger trg_memory_chunks_updated_at
before update on memory_chunks
for each row execute function set_memory_updated_at();

-- Backfill raw captures som memory_sources, så eksisterende chunks kan linkes
-- uden at ændre den gamle raw_capture-baserede søgning.
insert into memory_sources (
  brain_id,
  source_type,
  source_key,
  title,
  uri,
  content,
  content_hash,
  metadata,
  created_at,
  updated_at
)
select
  'personal',
  'raw_capture',
  rc.id::text,
  coalesce(nullif(rc.classification->>'summary', ''), 'raw capture'),
  'supabase://raw_captures/' || rc.id::text,
  rc.content,
  md5(rc.content),
  jsonb_build_object(
    'source', rc.source,
    'area', rc.area,
    'classification', rc.classification,
    'processed', rc.processed,
    'legacy_table', 'raw_captures'
  ),
  rc.created_at,
  now()
from raw_captures rc
on conflict (brain_id, source_type, source_key) do update
set
  title = excluded.title,
  uri = excluded.uri,
  content = excluded.content,
  content_hash = excluded.content_hash,
  metadata = excluded.metadata,
  deleted_at = null;

update memory_chunks mc
set
  memory_source_id = ms.id,
  brain_id = coalesce(mc.brain_id, ms.brain_id, 'personal'),
  content_hash = coalesce(mc.content_hash, md5(mc.content)),
  updated_at = now()
from memory_sources ms
where mc.source_type = 'raw_capture'
  and mc.source_id::text = ms.source_key
  and ms.source_type = 'raw_capture'
  and mc.memory_source_id is null;

-- V2-search til MCP/agent-memory. Den gamle search_memory() bevares urørt.
create or replace function search_memory_v2(
  query_embedding    vector(1536),
  match_count        int   default 8,
  filter_brain_id    text  default null,
  filter_source_type text  default null
)
returns table (
  id                uuid,
  content           text,
  source_type       text,
  source_id         uuid,
  memory_source_id  uuid,
  brain_id          text,
  chunk_index       int,
  area              text,
  metadata          jsonb,
  source_title      text,
  source_uri        text,
  source_key        text,
  source_metadata   jsonb,
  created_at        timestamptz,
  updated_at        timestamptz,
  similarity        float
)
language sql stable as $$
  select
    mc.id,
    mc.content,
    coalesce(ms.source_type, mc.source_type) as source_type,
    mc.source_id,
    mc.memory_source_id,
    coalesce(mc.brain_id, ms.brain_id, 'personal') as brain_id,
    mc.chunk_index,
    mc.area,
    mc.metadata,
    ms.title as source_title,
    ms.uri as source_uri,
    ms.source_key,
    ms.metadata as source_metadata,
    mc.created_at,
    mc.updated_at,
    1 - (mc.embedding <=> query_embedding) as similarity
  from memory_chunks mc
  left join memory_sources ms on ms.id = mc.memory_source_id
  where mc.embedding is not null
    and mc.deleted_at is null
    and (ms.id is null or ms.deleted_at is null)
    and (filter_brain_id is null or coalesce(mc.brain_id, ms.brain_id, 'personal') = filter_brain_id)
    and (filter_source_type is null or coalesce(ms.source_type, mc.source_type) = filter_source_type)
  order by mc.embedding <=> query_embedding
  limit match_count;
$$;

notify pgrst, 'reload schema';
