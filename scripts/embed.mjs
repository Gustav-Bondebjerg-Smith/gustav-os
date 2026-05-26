// Delt modul: embedding + storage til memory_chunks.
// Bruges af telegram-poll (live), embed-captures (backfill) og ask (query-embedding).
// OpenAI text-embedding-3-small giver vector(1536), som matcher schema fra Fase 1.
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

export const EMBED_MODEL = 'text-embedding-3-small'

// Lazy supabase-klient. Vi laver den her i stedet for at få hver caller til at lave deres egen.
let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  _supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  )
  return _supabase
}

// Embedder en tekst. Returnerer 1536-dim float-array.
// Kaster fejl ved netværks- eller API-fejl - caller beslutter om det er kritisk.
export async function embedText(text) {
  if (!text || typeof text !== 'string') throw new Error('embedText: text skal være en ikke-tom string')
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!r.ok) throw new Error(`OpenAI embeddings HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const vec = j.data?.[0]?.embedding
  if (!Array.isArray(vec) || vec.length !== 1536) throw new Error('embedText: uventet svar fra OpenAI')
  return vec
}

// Gemmer en chunk i memory_chunks. Idempotent på (source_type, source_id):
// findes der allerede en chunk for denne kilde, returneres dens id uden at embedde igen.
// Det sparer både API-kald og duplikater når backfill kører flere gange.
export async function storeChunk({ content, source_type, source_id, area = null, metadata = {} }) {
  if (!content) throw new Error('storeChunk: content er påkrævet')
  if (!source_type || !source_id) throw new Error('storeChunk: source_type og source_id er påkrævet')
  const sb = getSupabase()

  const { data: existing, error: selErr } = await sb
    .from('memory_chunks')
    .select('id')
    .eq('source_type', source_type)
    .eq('source_id', source_id)
    .limit(1)
  if (selErr) throw new Error(`storeChunk select-fejl: ${selErr.message}`)
  if (existing?.[0]) return { id: existing[0].id, skipped: true }

  const embedding = await embedText(content)
  const { data, error } = await sb
    .from('memory_chunks')
    .insert({ content, embedding, source_type, source_id, area, metadata })
    .select('id')
    .single()
  if (error) throw new Error(`storeChunk insert-fejl: ${error.message}`)
  return { id: data.id, skipped: false }
}
