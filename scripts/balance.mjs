// Balance-rapport for de sidste 14 dage ud fra din Google Calendar.
// Koden henter events + regner PRÆCISE timer pr. kategori. Claude (Sonnet) kategoriserer
// hvert event og skriver selve vurderingen i Gustav OS-stemmen.
// Kør:             node scripts/balance.mjs
// Send til phone:  node scripts/balance.mjs --telegram
import './load-env.mjs'
import { getEvents, eventHours } from './calendar.mjs'

const ANALYST_MODEL = 'claude-sonnet-4-6' // stærkere end Haiku, til ræsonnement
const DAYS = 14
const CATEGORIES = ['søvn', 'studie', 'arbejde', 'projekt', 'transport', 'socialt', 'krop', 'fritid', 'andet']
const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']

// Én linje pr. event til Claude: indeks | ugedag dato tid (varighed) | titel
function fmtEvent(e, i) {
  const dt = e.start?.dateTime
  if (dt) {
    const date = dt.slice(0, 10), time = dt.slice(11, 16)
    const endTime = (e.end?.dateTime || '').slice(11, 16)
    const wd = WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()]
    const [, m, d] = date.split('-')
    return `${i} | ${wd} ${Number(d)}/${Number(m)} ${time}-${endTime} (${eventHours(e).toFixed(1)}t) | ${e.summary || '(uden titel)'}`
  }
  return `${i} | ${e.start?.date || '?'} heldag | ${e.summary || '(uden titel)'}`
}

async function analyze(eventLines, fromStr, toStr) {
  const system = [
    'Du er Gustav OS, en personlig assistent der laver en ærlig balance-rapport til Gustav.',
    'Stemme: dansk, direkte og udfordrende, men konstruktiv. Ingen moralisering over hans sociale liv. Han er 23.',
    'Ankr mod realistiske benchmarks for en travl studerende, ikke outliers. Hvis han nedgør sig selv som "doven", afvis det og reframe til "reaktiv, arbejder på proaktiv".',
    '',
    'Om Gustav: medicinstuderende SDU (4. semester), sygeplejevikar (SPV) + forskningsassistent, bor i Odense.',
    'Hans balance-mål: nok studie, ægte hvile (ikke skærm-zombie), mindre spildtid. Blindspot: perfektionisme + reaktivt engagement.',
    'PersonalOS = det AI-projekt han selv bygger (kategori "projekt"). SPV = sygeplejevikar-vagt (arbejde). League = gaming (fritid).',
    '',
    `Data: ${DAYS} dages kalender (${fromStr} til ${toStr}), groft retro-udfyldt, så tallene er omtrentlige.`,
    'Hver linje: indeks | ugedag dato tid (varighed) | titel.',
    '',
    'Din opgave, to dele:',
    `1) Kategorisér HVERT event til præcis en af: ${CATEGORIES.join(', ')}.`,
    '2) Skriv en KORT rapport (max ca. 200 ord) i markdown med tre dele: (a) hvad mønstret viser, (b) ærlig vurdering: er der nok studie for en 4.-semester-medicinstuderende, er hvilen ægte, er der tunge dage i træk, hvordan er social/fritid-balancen, (c) præcis EN eller TO konkrete justeringer for de næste 14 dage. Ingen lange lister.',
    'Brug ikke selv kategori-totaler i tal. Dem viser systemet under din rapport. Fokusér på mønstre og vurdering.',
    '',
    'Svarformat, præcis sådan her:',
    'Første linje: et JSON-array med kategorierne i SAMME rækkefølge og længde som event-listen. Fx ["søvn","studie",...]',
    'Anden linje: kun ---',
    'Derefter: rapporten i markdown.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANALYST_MODEL,
      max_tokens: 2000,
      temperature: 0.4,
      system,
      messages: [{ role: 'user', content: `Periode: ${fromStr} til ${toStr}\n\n${eventLines.join('\n')}` }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const text = (j.content?.[0]?.text || '').trim()

  // Robust parse: kategorier (JSON-array) før første ---, rapport efter.
  const sep = text.indexOf('---')
  const head = (sep >= 0 ? text.slice(0, sep) : text.split('\n')[0]).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const report = sep >= 0 ? text.slice(sep + 3).trim() : '(kunne ikke læse rapport-delen)'
  let categories = []
  try { categories = JSON.parse(head) } catch { categories = [] }
  return { categories, report }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) throw new Error('Mangler TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID')
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }), // plain text: robust, ingen markdown-parsefejl
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`Telegram fejl: ${JSON.stringify(j)}`)
}

// --- kør ---
const to = new Date()
const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
const fromStr = from.toISOString().slice(0, 10)
const toStr = to.toISOString().slice(0, 10)

const events = await getEvents(from, to)
if (!events.length) {
  console.log('Ingen events i de sidste 14 dage. Fyld kalenderen, og kør igen.')
  process.exit(0)
}

const lines = events.map(fmtEvent)
const { categories, report } = await analyze(lines, fromStr, toStr)
if (categories.length !== events.length) {
  console.warn(`Bemærk: Claude gav ${categories.length} kategorier til ${events.length} events. Manglende sættes til "andet".`)
}

// Præcise timer pr. kategori (regnet i kode, ikke af Claude)
const totals = {}
let tracked = 0
events.forEach((e, i) => {
  const cat = categories[i] || 'andet'
  const h = eventHours(e)
  totals[cat] = (totals[cat] || 0) + h
  tracked += h
})
const totalHours = DAYS * 24
const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1])

let table = `BALANCE - sidste ${DAYS} dage (${fromStr} til ${toStr}, ${events.length} events)\n`
table += '='.repeat(46) + '\n'
for (const [cat, h] of sorted) {
  const pct = Math.round((h / totalHours) * 100)
  table += `${cat.padEnd(10)} ${h.toFixed(1).padStart(5)}t ${String(pct).padStart(3)}%  ${'#'.repeat(Math.min(40, Math.round(h / 4)))}\n`
}
table += '-'.repeat(46) + '\n'
table += `${'logget'.padEnd(10)} ${tracked.toFixed(1).padStart(5)}t af ${totalHours}t (${Math.round(tracked / totalHours * 100)}%)\n`

const full = `${table}\n${report}`
console.log('\n' + full + '\n')

if (process.argv.includes('--telegram')) {
  await sendTelegram(full)
  console.log('Sendt til Telegram.')
}
