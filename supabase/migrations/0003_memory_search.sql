-- Gustav OS - Fase 5: semantisk søgning i memory_chunks.
-- Kør denne fil i Supabase SQL Editor.
-- Forklaring:
--   - search_memory() er en RPC-funktion (Remote Procedure Call). Den kaldes via supabase.rpc('search_memory', {...}).
--   - <=> er pgvector's cosine-distance-operator (0 = identisk, 1 = uafhængig, 2 = modsat).
--   - similarity = 1 - distance, så højere = mere relevant. Nemmere at læse end distance.
--   - language sql stable: ren SQL, ingen side effects, kan caches inden for samme transaktion.

create or replace function search_memory(
  query_embedding vector(1536),
  match_count     int   default 5,
  filter_area     text  default null
)
returns table (
  id          uuid,
  content     text,
  source_type text,
  source_id   uuid,
  area        text,
  metadata    jsonb,
  created_at  timestamptz,
  similarity  float
)
language sql stable as $$
  select
    id,
    content,
    source_type,
    source_id,
    area,
    metadata,
    created_at,
    1 - (embedding <=> query_embedding) as similarity
  from memory_chunks
  where embedding is not null
    and (filter_area is null or area = filter_area)
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Similarity-index. ivfflat er hurtigere ved >1k rækker, men kræver "lists"-parameter.
-- 100 lister er fint indtil ~100k rækker. Bruger cosine, som matcher operatoren i search_memory.
-- Hvis tabellen er tom, kan index oprettes nu, men det er først reelt nyttigt når der er data.
create index if not exists idx_memory_chunks_embedding
  on memory_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
