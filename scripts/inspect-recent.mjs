// Read-only diagnose: viser routing-udfaldet (telegram_updates.reason) + teksten
// (raw_captures.content) for de sidste N beskeder, tids-sorteret. Bruges til at se
// hvad hver testbesked faktisk blev routet til efter router-aktivering.
//
// Kør:  node scripts/inspect-recent.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const N = 15
const cph = (iso) =>
  new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))

const { data: ups, error: e1 } = await sb
  .from('telegram_updates')
  .select('update_id, status, reason, error, message_id, received_at')
  .order('received_at', { ascending: false })
  .limit(N)
if (e1) { console.error('telegram_updates fejl:', e1.message); process.exit(1) }

const { data: caps, error: e2 } = await sb
  .from('raw_captures')
  .select('id, source, content, classification, created_at')
  .order('created_at', { ascending: false })
  .limit(N)
if (e2) { console.error('raw_captures fejl:', e2.message); process.exit(1) }

console.log(`\n=== TELEGRAM_UPDATES (sidste ${ups.length}, nyeste øverst) ===`)
console.log('tid              | status     | reason                          | err')
for (const u of ups) {
  const err = u.error ? String(u.error).slice(0, 40) : ''
  console.log(
    `${cph(u.received_at)} | ${String(u.status).padEnd(10)} | ${String(u.reason || '(null)').padEnd(31)} | ${err}`
  )
}

console.log(`\n=== RAW_CAPTURES (sidste ${caps.length}, nyeste øverst) ===`)
console.log('(kun beskeder der endte i note/capture/insert/delete-grenen)')
for (const c of caps) {
  const cls = c.classification || {}
  const txt = (c.content || '').replace(/\n/g, ' ').slice(0, 70)
  console.log(`${cph(c.created_at)} | ${String(cls.type || '?').padEnd(8)} | "${txt}"`)
}

console.log('')
