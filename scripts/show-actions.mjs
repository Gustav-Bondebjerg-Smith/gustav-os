// Viser de seneste actions med deres status (proposed/executed/vetoed/failed).
// Sidestykke til show-captures, men for kalender-handlinger.
// Kør: node scripts/show-actions.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const LIMIT = 10
const { data, error } = await supabase
  .from('actions')
  .select('id, type, payload, status, veto_deadline, executed_at, vetoed_at, result, created_at')
  .order('created_at', { ascending: false })
  .limit(LIMIT)

if (error) { console.error('DB-fejl:', error.message); process.exit(1) }

if (!data.length) {
  console.log('Ingen actions endnu. Send en aftale-besked til botten.')
  process.exit(0)
}

const WEEKDAYS_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
function fmtPayloadTime(p) {
  if (!p?.start || !p?.end) return ''
  const s = new Date(p.start), e = new Date(p.end)
  const wd = WEEKDAYS_SHORT[s.getDay()]
  const d = `${s.getDate()}/${s.getMonth() + 1}`
  const t1 = `${String(s.getHours()).padStart(2, '0')}.${String(s.getMinutes()).padStart(2, '0')}`
  const t2 = `${String(e.getHours()).padStart(2, '0')}.${String(e.getMinutes()).padStart(2, '0')}`
  return `${wd} ${d} ${t1}-${t2}`
}

console.log(`Seneste ${data.length} action(s):\n`)
for (const a of data) {
  const t = new Date(a.created_at).toLocaleString('da-DK')
  const status = a.status.toUpperCase().padEnd(9)
  console.log(`- ${t}  [${status}]  ${a.type}`)
  const summary = a.payload?.summary || '(uden titel)'
  const when = fmtPayloadTime(a.payload)
  console.log(`    "${summary}"${when ? ' - ' + when : ''}`)
  if (a.status === 'proposed') {
    const deadline = new Date(a.veto_deadline).toLocaleString('da-DK')
    const passed = new Date(a.veto_deadline) < new Date()
    console.log(`    veto-deadline: ${deadline}${passed ? ' (passeret, venter på watcher)' : ''}`)
  } else if (a.status === 'executed' && a.result?.html_link) {
    console.log(`    ${a.result.html_link}`)
  } else if (a.status === 'failed' && a.result?.error) {
    console.log(`    fejl: ${a.result.error}`)
  }
}
