// Golden-set eksport: trækker dine sidste rigtige Telegram-beskeder ud af
// Supabase og bygger et label-klart datasæt, så du kan måle den nuværende
// router FØR du bygger tool-calling-loopet (og bagefter, som regressionstest).
//
// Kør:  node scripts/export-golden-set.mjs
//
// Output (skrives i repo-roden, begge er gitignore-kandidater):
//   golden-set-labeling.csv  <- den du udfylder (kolonnen "intended" er tom)
//   golden-set-raw.json      <- rådata + reason-fordeling, hvis du vil i dybden
//
// Hvorfor to kilder:
//   raw_captures   = beskedTEKST, men kun for beskeder der endte i note/capture/
//                    insert/delete-grenen. Det er præcis her fejl-routede
//                    kommandoer lander, så det er guld til at finde misroutes.
//   telegram_updates = ENHVER beskeds routing-udfald (reason), men uden tekst.
//                      Bruges til at vise hvor ofte hver sti faktisk fyrede.
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const CAP_LIMIT = 100
const UPD_LIMIT = 250

// Samme trigger-mønstre som lib/telegram-webhook.ts. Vi bruger dem til at gætte
// om en capture EGENTLIG var en kommando der faldt tavst igennem til note.
const TRIGGERS = {
  start_aktivitet: /(?<![\p{L}\p{N}])(starter på|starter med|går i gang med|begynder(?: på| med)?|skifter til|påbegynder|tager fat på|i gang med|nu kaster jeg mig over)(?![\p{L}\p{N}])/iu,
  stop_aktivitet: /(?<![\p{L}\p{N}])(slutter(?: på| med)?|stopper(?: med)?|afslutter|holder pause|tager (?:en )?pause|færdig(?: med)?|done|det var det for i dag)(?![\p{L}\p{N}])/iu,
  ret_aftale: /(?<![\p{L}\p{N}])(ret(?:te|ter|tede)?|ændr(?:e|er|ede)?|flyt(?:te|ter|tede)?|rykke(?:de|r|t)?|skubbe(?:de|r|t)?|gik til|går til|trak ud|går i seng|står op|sover (?:til|først))(?![\p{L}\p{N}])/iu,
  slet_aftale: /(?<![\p{L}\p{N}])(slet|fjern|aflys|aflyse|aflyst|cancel|drop(?:per)?|ryger ud)(?![\p{L}\p{N}])/iu,
  opslag_recall: /(hvad skulle jeg|hvad havde jeg|hvornår skulle jeg|hvad sagde jeg|hvad lavede jeg|hvad er der på|husker du)/iu,
}

function guessIntent(text) {
  if (!text) return ''
  const hits = []
  for (const [label, re] of Object.entries(TRIGGERS)) if (re.test(text)) hits.push(label)
  if (hits.length === 0) return ''
  if (hits.length === 1) return hits[0]
  return 'FLERE? (' + hits.join(', ') + ')'
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const { data: caps, error: e1 } = await sb
  .from('raw_captures')
  .select('id, source, content, area, classification, created_at')
  .order('created_at', { ascending: false })
  .limit(CAP_LIMIT)
if (e1) { console.error('raw_captures fejl:', e1.message); process.exit(1) }

const { data: ups, error: e2 } = await sb
  .from('telegram_updates')
  .select('update_id, status, reason, message_id, received_at')
  .order('received_at', { ascending: false })
  .limit(UPD_LIMIT)
if (e2) { console.error('telegram_updates fejl:', e2.message); process.exit(1) }

// Routing-fordeling: hvor ofte fyrede hver sti? (Contrarianerens "mål det først".)
const reasonCounts = {}
for (const u of ups) {
  const k = u.reason || '(null)'
  reasonCounts[k] = (reasonCounts[k] || 0) + 1
}
const sortedReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])

// Byg CSV. "intended" + "misrouted" er TOMME - dem udfylder du.
// system_did = hvad routeren gjorde (type fra klassificeringen, note-grenen).
// auto_guess = mit heuristiske gæt på hvad du nok MENTE (kun et hint).
const header = [
  'id', 'timestamp', 'source', 'message',
  'system_did', 'auto_guess', 'intended', 'misrouted', 'notes',
]
const rows = caps.map((c) => {
  const cls = c.classification || {}
  const systemDid = `note/${c.area || 'ukat'}/${cls.type || '?'}`
  return [
    c.id,
    new Date(c.created_at).toISOString(),
    c.source,
    c.content,
    systemDid,
    guessIntent(c.content),
    '', // intended  <- UDFYLD
    '', // misrouted <- UDFYLD (y hvis system_did != det du mente)
    '', // notes
  ]
})

const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
writeFileSync('golden-set-labeling.csv', csv, 'utf8')
writeFileSync('golden-set-raw.json', JSON.stringify({ caps, ups, reasonCounts }, null, 2), 'utf8')

// Konsol-resume.
const flagged = rows.filter((r) => r[5] !== '').length
console.log(`\n=== GOLDEN SET EKSPORTERET ===`)
console.log(`raw_captures hentet : ${caps.length}`)
console.log(`telegram_updates    : ${ups.length}`)
console.log(`auto-flagget som muligt fejl-routet kommando: ${flagged} / ${caps.length}`)
console.log(`\nFiler skrevet:`)
console.log(`  golden-set-labeling.csv  (udfyld kolonnen "intended")`)
console.log(`  golden-set-raw.json`)
console.log(`\n=== ROUTING-FORDELING (sidste ${ups.length} beskeder) ===`)
console.log(`(dette er Contrarianerens "mål hvad der faktisk fejler" - se hvilke`)
console.log(` reasons der dominerer; *_failed / *_no_match / capture_saved på en`)
console.log(` kommando er smerten)\n`)
for (const [k, v] of sortedReasons) console.log(String(v).padStart(4), k)

console.log(`\n=== LABELS at vælge mellem i "intended" ===`)
console.log(`  opret_aftale   - ny kalenderbegivenhed`)
console.log(`  ret_aftale     - ret tid på eksisterende (inkl. søvn)`)
console.log(`  slet_aftale    - fjern/aflys`)
console.log(`  start_aktivitet- start tidstagning nu`)
console.log(`  stop_aktivitet - stop/pause nu`)
console.log(`  opslag         - spørg din second brain (recall)`)
console.log(`  note           - reelt bare en note (korrekt)`)
console.log(`  flere          - beskeden vil flere ting (multi-intent)`)
console.log(`\nNår "intended" != "system_did", sæt misrouted = y. Det er din fejlrate.`)
