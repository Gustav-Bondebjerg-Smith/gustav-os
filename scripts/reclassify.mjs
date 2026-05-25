// Backfill: klassificerer captures der endnu ikke er behandlet (processed=false).
// Nyttigt til at indhente gamle captures eller efter forbedring af klassifikatoren.
// Kør: node scripts/reclassify.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { classify, VALID_AREAS } from './classify.mjs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data, error } = await supabase
  .from('raw_captures')
  .select('id, content')
  .eq('processed', false)
  .order('created_at', { ascending: true })

if (error) { console.error('DB-fejl:', error.message); process.exit(1) }
if (!data.length) { console.log('Ingen ubehandlede captures.'); process.exit(0) }

console.log(`Klassificerer ${data.length} capture(s)...\n`)
for (const row of data) {
  try {
    const c = await classify(row.content)
    const area = VALID_AREAS.includes(c.area) ? c.area : null
    await supabase.from('raw_captures').update({ area, classification: c, processed: true }).eq('id', row.id)
    console.log(`OK   ${(area || 'ukategoriseret').padEnd(13)} ${String(c.type).padEnd(8)} ${c.summary}`)
  } catch (e) {
    console.error(`FEJL ${row.id}: ${e.message}`)
  }
}
console.log('\nFærdig.')
