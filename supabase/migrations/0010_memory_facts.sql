-- Gustav OS - lærende fakta-lag for tool-calling routeren.
-- Kør hele filen i Supabase SQL Editor (projekt dxowfjyigfrhyaixyonj), som de øvrige.
--
-- Formål:
--   Et lille, kurateret lag af ATOMARE fakta/præferencer som routeren selv kan
--   skrive i runtime (save_memory) når Gustav retter den. Det globale lag lægges
--   ind i routerens system-prompt, så korrektioner ændrer adfærd UDEN kode-edit.
--
-- Skel mod det eksisterende memory_sources/memory_chunks (dokument-RAG):
--   - memory_sources = langt importeret korpus, chunket og vektor-søgt.
--   - memory_facts (her) = én række = ét faktum. Overskrives på (scope, key).
--     Lille nok til at "load alt" globalt; vektor-søges først når en projekt-scope
--     vokser sig stor. Samme embedding-model (text-embedding-3-small / 1536 dim).

create extension if not exists vector;

create table if not exists memory_facts (
  id          uuid primary key default gen_random_uuid(),
  -- type: hvad slags faktum. 'feedback' = en korrektion/instruks (kræver i ånden et why).
  type        text check (type in ('user', 'feedback', 'project', 'reference')),
  -- scope: 'global' = stabile fakta om Gustav (load i fuld hver gang). Ellers et
  -- projekt-slug (vektor-søges når det bliver for stort til at loade i fuld).
  scope       text not null default 'global',
  -- key: kort kebab-case slug. Korrektioner med samme (scope, key) OVERSKRIVER.
  key         text not null,
  content     text not null,
  why         text,
  embedding   vector(1536),
  updated_at  timestamptz not null default now(),
  -- Upsert-nøgle: en korrektion opdaterer samme række, duplikerer aldrig.
  unique (scope, key)
);

-- HNSW + cosine matcher embedding-modellen og giver god recall ved lavt volumen
-- uden lists-tuning (modsat ivfflat på memory_chunks). Bygges inkrementelt; fint
-- på en tom tabel.
create index if not exists idx_memory_facts_embedding
  on memory_facts using hnsw (embedding vector_cosine_ops);

-- Til recallGlobal() (where scope = 'global') og scope/type-opslag uden vektor.
create index if not exists idx_memory_facts_scope_type
  on memory_facts (scope, type);

-- Genbruger set_memory_updated_at() fra migration 0008 (sætter updated_at = now()
-- ved hver UPDATE), så en overskreven fakta får frisk tidsstempel.
drop trigger if exists trg_memory_facts_updated_at on memory_facts;
create trigger trg_memory_facts_updated_at
before update on memory_facts
for each row execute function set_memory_updated_at();

-- Samme RLS-mønster som pending_activity/pending_clarification: aktiveret UDEN
-- policies med vilje. Appen tilgår kun via service_role-klienten (getSupabase()),
-- som bypasser RLS. Nul policies = deny-by-default for anon/authenticated.
alter table memory_facts enable row level security;

-- Semantisk søgning inden for ÉT scope. Bruges af recallProject() når en
-- projekt-scope vokser forbi token-tærsklen. <=> er cosine-distance (0 = identisk);
-- similarity = 1 - distance, så højere = mere relevant. NB: model-låst til
-- text-embedding-3-small/1536. Skift af model kræver re-embed af HELE tabellen +
-- ny kolonne-dimension (dokumenteret, bygges ikke i v1).
create or replace function match_memory_facts(
  query_embedding vector(1536),
  match_scope     text,
  match_count     int   default 8,
  min_similarity  float default 0.5
)
returns table (key text, content text, why text, similarity float)
language sql stable as $$
  select key, content, why,
         1 - (embedding <=> query_embedding) as similarity
  from memory_facts
  where scope = match_scope
    and embedding is not null
    and 1 - (embedding <=> query_embedding) > min_similarity
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- PostgREST skal kende den nye tabel + funktion med det samme (ellers PGRST202).
notify pgrst, 'reload schema';
