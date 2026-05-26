// Watcher der udfører foreslåede actions hvis veto-vinduet er udløbet uden veto.
// Spørger actions-tabellen for status='proposed' AND veto_deadline < now(), udfører via calendar-write,
// opdaterer status til 'executed' eller 'failed', logger i audit_log og sender Telegram-bekræftelse.
//
// Kør én gang:   node scripts/watch-actions.mjs --once
// Kør løbende:   node scripts/watch-actions.mjs   (tjekker hvert 30. sek, Ctrl+C stopper)
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { insertEvent } from './calendar-write.mjs'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT = process.env.TELEGRAM_CHAT_ID
const ONCE = process.argv.includes('--once')
const POLL_INTERVAL_MS = 30 * 1000

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

async function tgSend(text) {
  if (!TOKEN || !CHAT) {
    console.warn('  (intet Telegram-token eller chat-id; springer notifikation over)')
    return
  }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text }),
  })
  const j = await r.json()
  if (!j.ok) console.error('  Telegram-fejl:', JSON.stringify(j))
}

async function runOnce() {
  const nowIso = new Date().toISOString()
  const { data: due, error } = await supabase
    .from('actions')
    .select('id, type, payload, source_capture_id')
    .eq('status', 'proposed')
    .lt('veto_deadline', nowIso)
    .order('created_at', { ascending: true })
  if (error) throw error
  if (!due.length) return 0

  console.log(`Fandt ${due.length} action(s) klar til udførelse.`)
  for (const a of due) {
    console.log(`- ${a.id}: ${a.type} "${a.payload?.summary}"`)
    try {
      if (a.type !== 'calendar_insert') throw new Error(`Ukendt action-type: ${a.type}`)
      const ev = await insertEvent(a.payload)
      const result = { event_id: ev.id, html_link: ev.htmlLink }
      await supabase.from('actions').update({
        status: 'executed', executed_at: new Date().toISOString(), result,
      }).eq('id', a.id)
      await supabase.from('audit_log').insert({
        action: 'calendar_insert',
        payload: { ...a.payload, ...result },
        status: 'applied',
        reason: `udført efter veto-vindue (action ${a.id})`,
      })
      await tgSend(`Skrevet i kalender: "${a.payload.summary}"`)
      console.log('  -> executed')
    } catch (e) {
      const errMsg = String(e.message || e)
      console.error('  -> failed:', errMsg)
      await supabase.from('actions').update({
        status: 'failed', result: { error: errMsg },
      }).eq('id', a.id)
      await supabase.from('audit_log').insert({
        action: 'calendar_insert',
        payload: a.payload,
        status: 'failed',
        reason: errMsg,
      })
      await tgSend(`Kunne ikke skrive "${a.payload.summary}" i kalender: ${errMsg}`)
    }
  }
  return due.length
}

if (ONCE) {
  const n = await runOnce()
  console.log(`Færdig. Udførte ${n} action(s).`)
} else {
  console.log(`Watcher kører. Tjekker hvert ${POLL_INTERVAL_MS / 1000}. sek. Ctrl+C stopper.`)
  while (true) {
    try { await runOnce() } catch (e) { console.error('runOnce fejl:', e.message) }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}
