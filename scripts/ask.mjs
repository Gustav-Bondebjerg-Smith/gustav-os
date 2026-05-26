// Ask-funktion: spørg din second brain på dansk.
// Flow: embed spørgsmålet -> cosine similarity-søgning i memory_chunks -> Claude svarer med kilder.
// CLI:           node scripts/ask.mjs "spørgsmål her"
// Telegram:      genbruges via askWithSources() i telegram-poll.mjs (/ask <spørgsmål>).
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import { embedText } from './embed.mjs'

const ASK_MODEL = 'claude-sonnet-4-6' // højere stakes end klassificering. Værd at bruge Sonnet.
const MATCH_COUNT = 8 // top-N kilder. Nok kontekst uden at overvælde Claude.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`
}

// Henter top-N relevante chunks via pgvector cosine similarity.
async function searchMemory(query, { matchCount = MATCH_COUNT, filterArea = null } = {}) {
  const embedding = await embedText(query)
  const { data, error } = await supabase.rpc('search_memory', {
    query_embedding: embedding,
    match_count: matchCount,
    filter_area: filterArea,
  })
  if (error) throw new Error(`search_memory RPC-fejl: ${error.message}`)
  return data || []
}

// Bygger system-prompt + kontekst-blok til Claude.
// Hver kilde får et nummer [1], [2], ... så Claude kan citere dem i svaret.
function buildContext(chunks) {
  if (!chunks.length) return '(ingen relevante kilder fundet)'
  return chunks.map((c, i) => {
    const when = fmtDate(c.created_at)
    const area = c.area ? `[${c.area}]` : '[ukategoriseret]'
    const sim = `sim=${c.similarity.toFixed(2)}`
    return `[${i + 1}] ${when} ${area} (${sim})\n${c.content}`
  }).join('\n\n')
}

// Kalder Claude Sonnet med Gustav OS-personaen + kontekst + spørgsmål.
// Returnerer ren tekst-svar. Kaster ved API-fejl.
async function askClaude(question, chunks) {
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
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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

// Public API: ask(question) -> { answer, sources }. Bruges af CLI og telegram-poll.
// sources er chunks-rækken som blev brugt, så caller kan vise dem som kilde-liste.
export async function ask(question, opts = {}) {
  if (!question?.trim()) throw new Error('ask: tomt spørgsmål')
  const sources = await searchMemory(question, opts)
  if (!sources.length) {
    return { answer: 'Din second brain er tom (eller endnu ikke embeddet). Kør "node scripts/embed-captures.mjs" først.', sources: [] }
  }
  const answer = await askClaude(question, sources)
  return { answer, sources }
}

// Formaterer kilde-liste til output. Bruges af både CLI og Telegram (plain text, ingen markdown).
export function formatSources(sources) {
  if (!sources.length) return ''
  const lines = sources.map((c, i) => {
    const when = fmtDate(c.created_at)
    const sim = c.similarity.toFixed(2)
    const preview = c.content.length > 80 ? c.content.slice(0, 80) + '...' : c.content
    return `[${i + 1}] ${when} (sim=${sim}): ${preview}`
  })
  return 'Kilder:\n' + lines.join('\n')
}

// CLI: argumenterne efter scriptnavnet bliver spørgsmålet.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    console.log('Brug: node scripts/ask.mjs "spørgsmål"')
    console.log('Fx:   node scripts/ask.mjs "hvad var jeg ved at glemme i går?"')
    process.exit(0)
  }
  const { answer, sources } = await ask(question)
  console.log('\n' + answer + '\n')
  if (sources.length) {
    console.log('---')
    console.log(formatSources(sources))
  }
}
