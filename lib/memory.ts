// Server-side helpers til embeddings + memory_chunks.
// Bruges af dashboard-ask og webhook capture-flowet.
import 'server-only'
import { getSupabase } from './supabase'

export const EMBED_MODEL = 'text-embedding-3-small'

export async function embedText(text: string): Promise<number[]> {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText: text skal være en ikke-tom string')
  }

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
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error('embedText: uventet svar fra OpenAI')
  }
  return vec
}

export async function storeChunk({
  content,
  source_type,
  source_id,
  area = null,
  metadata = {},
}: {
  content: string
  source_type: string
  source_id: string
  area?: string | null
  metadata?: Record<string, unknown>
}): Promise<{ id: string; skipped: boolean }> {
  if (!content) throw new Error('storeChunk: content er påkrævet')
  if (!source_type || !source_id) {
    throw new Error('storeChunk: source_type og source_id er påkrævet')
  }

  const sb = getSupabase()
  const { data: existing, error: selErr } = await sb
    .from('memory_chunks')
    .select('id')
    .eq('source_type', source_type)
    .eq('source_id', source_id)
    .limit(1)

  if (selErr) throw new Error(`storeChunk select-fejl: ${selErr.message}`)
  if (existing?.[0]) return { id: String(existing[0].id), skipped: true }

  const embedding = await embedText(content)
  const { data, error } = await sb
    .from('memory_chunks')
    .insert({ content, embedding, source_type, source_id, area, metadata })
    .select('id')
    .single()

  if (error) throw new Error(`storeChunk insert-fejl: ${error.message}`)
  return { id: String(data.id), skipped: false }
}
