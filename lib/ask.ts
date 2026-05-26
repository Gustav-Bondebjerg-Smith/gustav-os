// TS-port af scripts/ask.mjs til brug i dashboardet (server action).
// CLI'en lever videre uændret. Når vi vil eliminere drift kan scripts/ask.mjs
// senere refactoreres til at importere herfra via dynamic import.
import { getSupabase } from './supabase'

const ASK_MODEL = 'claude-sonnet-4-6'
const EMBED_MODEL = 'text-embedding-3-small'
const MATCH_COUNT = 8

export type Chunk = {
  id: string
  content: string
  source_type: string
  source_id: string
  area: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  similarity: number
}

export type AskResult = {
  answer: string
  sources: Chunk[]
}

const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`
}

// Embedder en tekst via OpenAI. Returnerer 1536-dim float-array.
async function embedText(text: string): Promise<number[]> {
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

async function searchMemory(query: string, matchCount = MATCH_COUNT): Promise<Chunk[]> {
  const embedding = await embedText(query)
  const sb = getSupabase()
  const { data, error } = await sb.rpc('search_memory', {
    query_embedding: embedding,
    match_count: matchCount,
    filter_area: null,
  })
  if (error) throw new Error(`search_memory RPC-fejl: ${error.message}`)
  return (data || []) as Chunk[]
}

function buildContext(chunks: Chunk[]): string {
  if (!chunks.length) return '(ingen relevante kilder fundet)'
  return chunks
    .map((c, i) => {
      const when = fmtDate(c.created_at)
      const area = c.area ? `[${c.area}]` : '[ukategoriseret]'
      const sim = `sim=${c.similarity.toFixed(2)}`
      return `[${i + 1}] ${when} ${area} (${sim})\n${c.content}`
    })
    .join('\n\n')
}

async function askClaude(question: string, chunks: Chunk[]): Promise<string> {
  const system = [
    'Du er Gustav OS, en personlig assistent der svarer Gustav ud fra hans egen second brain.',
    'Stemme: dansk, direkte, konstruktivt udfordrende. Ikke refleksiv enighed. Ingen em-dashes.',
    'Medicinske fagtermer på latin når relevant. Han er medicinstuderende SDU (4. semester), sygeplejevikar og forskningsassistent.',
    '',
    'Du får kontekst-uddrag fra hans captures (Telegram-tekst og voicenotes). Hver kilde har et nummer [1], [2], ...',
    'Svar KORT og konkret. Citer kilderne ved deres nummer (fx "[2]") når du bruger dem.',
    'Hvis intet svar findes i kilderne, sig det rent ud i ÉN sætning. Lad være med at fabrikere.',
    'Hvis spørgsmålet er vagt, foreslå en omformulering. Ikke en lang afdækning.',
  ].join('\n')

  const userBlock = [
    `Spørgsmål: ${question}`,
    '',
    'Kilder fra second brain:',
    buildContext(chunks),
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ASK_MODEL,
      max_tokens: 800,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: userBlock }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return (j.content?.[0]?.text || '').trim()
}

// Public: ask(question) -> { answer, sources }. Samme kontrakt som CLI-versionen.
export async function ask(question: string): Promise<AskResult> {
  if (!question?.trim()) throw new Error('ask: tomt spørgsmål')
  const sources = await searchMemory(question)
  if (!sources.length) {
    return {
      answer: 'Din second brain er tom (eller endnu ikke embeddet). Kør "node scripts/embed-captures.mjs" først.',
      sources: [],
    }
  }
  const answer = await askClaude(question, sources)
  return { answer, sources }
}
