// Backfill: embedder alle raw_captures der ikke allerede har en memory_chunks-række.
// Idempotent: kan køres så ofte du vil. Kun nye captures embeddes.
// Kør: node scripts/embed-captures.mjs
// Flag: --limit N (default 100) - hvor mange captures der maks behandles pr. kørsel.
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { storeChunk } from './embed.mjs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// Find limit-flag fra CLI ("--limit 50"), default 100.
function parseLimit() {
  const i = process.argv.indexOf('--limit')
  if (i === -1) return 100
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : 100
}
const LIMIT = parseLimit()

// Hent captures + check hvilke der allerede er embeddet.
// To-trins for at undgå at sende massive id-lister i én query (Supabase REST har grænser).
const { data: caps, error } = await supabase
  .from('raw_captures')
  .select('id, source, content, area, classification, created_at')
  .order('created_at', { ascending: true })
  .limit(LIMIT * 5) // tag flere så vi har nok kandidater efter filtrering

if (error) { console.error('DB-fejl (raw_captures):', error.message); process.exit(1) }
if (!caps.length) { console.log('Ingen captures at embedde.'); process.exit(0) }

const ids = caps.map(c => c.id)
const { data: existing, error: e2 } = await supabase
  .from('memory_chunks')
  .select('source_id')
  .eq('source_type', 'raw_capture')
  .in('source_id', ids)
if (e2) { console.error('DB-fejl (memory_chunks):', e2.message); process.exit(1) }
const done = new Set((existing || []).map(r => r.source_id))

const todo = caps.filter(c => !done.has(c.id)).slice(0, LIMIT)
if (!todo.length) {
  console.log(`Alle ${caps.length} captures er allerede embeddet. Intet at gøre.`)
  process.exit(0)
}

console.log(`Embedder ${todo.length} capture(s) (af ${caps.length} hentet, ${done.size} allerede gjort).`)

let ok = 0, fail = 0
for (const c of todo) {
  try {
    const meta = {
      source: c.source,
      summary: c.classification?.summary || null,
      type: c.classification?.type || null,
      created_at: c.created_at,
    }
    const res = await storeChunk({
      content: c.content,
      source_type: 'raw_capture',
      source_id: c.id,
      area: c.area,
      metadata: meta,
    })
    ok++
    const flag = res.skipped ? '(allerede embeddet)' : 'ok'
    console.log(`  ${c.id.slice(0, 8)}... ${flag}: "${c.content.slice(0, 60)}${c.content.length > 60 ? '...' : ''}"`)
  } catch (e) {
    fail++
    console.error(`  ${c.id.slice(0, 8)}... FEJL:`, e.message)
  }
}

console.log(`Færdig. ${ok} ok, ${fail} fejl.`)
