// Viser de seneste raw_captures, så du kan se hvad din second brain har fanget.
// Kør: node scripts/show-captures.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const LIMIT = 10
const { data, error } = await supabase
  .from('raw_captures')
  .select('id, source, content, area, processed, created_at')
  .order('created_at', { ascending: false })
  .limit(LIMIT)

if (error) { console.error('DB-fejl:', error.message); process.exit(1) }

if (!data.length) {
  console.log('Ingen captures endnu. Send en besked til botten.')
  process.exit(0)
}

console.log(`Seneste ${data.length} capture(s):\n`)
for (const r of data) {
  const t = new Date(r.created_at).toLocaleString('da-DK')
  const area = r.area ? `[${r.area}]` : '[ukategoriseret]'
  const flag = r.processed ? 'behandlet' : 'ny'
  console.log(`- ${t}  ${area}  (${r.source}, ${flag})`)
  console.log(`    ${r.content}`)
}
