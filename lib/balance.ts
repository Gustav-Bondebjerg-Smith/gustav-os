// TS-port af scripts/balance.mjs til brug i dashboardet (server component).
// CLI'en lever videre uændret. Når vi vil eliminere drift kan scripts/balance.mjs
// senere refactoreres til at importere herfra via dynamic import.
//
// Kontrakt: getBalance(days) henter events, lader Claude Sonnet kategorisere
// hvert event + skrive en kort rapport. Timer pr. kategori regnes i kode.
// Resultatet caches 1 time via unstable_cache (per days-værdi) så hver
// /balance-visit ikke koster et nyt Sonnet-kald.
import 'server-only'
import { unstable_cache } from 'next/cache'
import { getEvents, eventHours, type GoogleCalendarEvent } from './calendar'

const ANALYST_MODEL = 'claude-sonnet-4-6'
export const CATEGORIES = [
  'søvn', 'studie', 'arbejde', 'projekt', 'transport', 'socialt', 'krop', 'fritid', 'andet',
] as const
export type BalanceCategory = (typeof CATEGORIES)[number]

const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']

export type BalanceEvent = {
  summary: string
  startIso: string | null
  endIso: string | null
  isAllDay: boolean
  hours: number
  category: string
}

export type BalanceReport = {
  days: number
  fromIso: string
  toIso: string
  eventCount: number
  trackedHours: number
  totalHours: number
  totals: Array<{ category: string; hours: number; pct: number }>
  report: string
  events: BalanceEvent[]
  generatedAt: string
}

// Linje pr. event til Claude: indeks | ugedag dato tid (varighed) | titel
function fmtEvent(e: GoogleCalendarEvent, i: number): string {
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

async function analyze(
  eventLines: string[],
  fromStr: string,
  toStr: string,
  days: number,
): Promise<{ categories: string[]; report: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('Mangler ANTHROPIC_API_KEY')

  const system = [
    'Du er Gustav OS, en personlig assistent der laver en ærlig balance-rapport til Gustav.',
    'Stemme: dansk, direkte og udfordrende, men konstruktiv. Ingen moralisering over hans sociale liv. Han er 23.',
    'Ankr mod realistiske benchmarks for en travl studerende, ikke outliers. Hvis han nedgør sig selv som "doven", afvis det og reframe til "reaktiv, arbejder på proaktiv".',
    '',
    'Om Gustav: medicinstuderende SDU (4. semester), sygeplejevikar (SPV) + forskningsassistent, bor i Odense.',
    'Hans balance-mål: nok studie, ægte hvile (ikke skærm-zombie), mindre spildtid. Blindspot: perfektionisme + reaktivt engagement.',
    'PersonalOS = det AI-projekt han selv bygger (kategori "projekt"). SPV = sygeplejevikar-vagt (arbejde). League = gaming (fritid).',
    '',
    `Data: ${days} dages kalender (${fromStr} til ${toStr}), groft retro-udfyldt, så tallene er omtrentlige.`,
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
      'x-api-key': apiKey,
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
  const text: string = (j.content?.[0]?.text || '').trim()

  // Robust parse: kategorier (JSON-array) før første ---, rapport efter.
  const sep = text.indexOf('---')
  const head = (sep >= 0 ? text.slice(0, sep) : text.split('\n')[0])
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const report = sep >= 0 ? text.slice(sep + 3).trim() : '(kunne ikke læse rapport-delen)'
  let categories: string[] = []
  try {
    const parsed = JSON.parse(head)
    if (Array.isArray(parsed)) categories = parsed.map(String)
  } catch {
    categories = []
  }
  return { categories, report }
}

async function computeBalance(days: number): Promise<BalanceReport> {
  const to = new Date()
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const fromStr = from.toISOString().slice(0, 10)
  const toStr = to.toISOString().slice(0, 10)
  const generatedAt = new Date().toISOString()

  const events = await getEvents(from, to)
  if (!events.length) {
    return {
      days,
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      eventCount: 0,
      trackedHours: 0,
      totalHours: days * 24,
      totals: [],
      report: 'Ingen events i perioden. Fyld kalenderen, og kom igen.',
      events: [],
      generatedAt,
    }
  }

  const lines = events.map(fmtEvent)
  const { categories, report } = await analyze(lines, fromStr, toStr, days)

  // Præcise timer pr. kategori (regnet i kode, ikke af Claude).
  const totalsMap = new Map<string, number>()
  let tracked = 0
  const enriched: BalanceEvent[] = events.map((ev, i) => {
    const cat = categories[i] || 'andet'
    const h = eventHours(ev)
    totalsMap.set(cat, (totalsMap.get(cat) || 0) + h)
    tracked += h
    return {
      summary: ev.summary || '(uden titel)',
      startIso: ev.start?.dateTime || ev.start?.date || null,
      endIso: ev.end?.dateTime || ev.end?.date || null,
      isAllDay: !!ev.start?.date && !ev.start?.dateTime,
      hours: h,
      category: cat,
    }
  })

  const totalHours = days * 24
  const totals = Array.from(totalsMap.entries())
    .map(([category, hours]) => ({ category, hours, pct: (hours / totalHours) * 100 }))
    .sort((a, b) => b.hours - a.hours)

  return {
    days,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    eventCount: events.length,
    trackedHours: tracked,
    totalHours,
    totals,
    report,
    events: enriched,
    generatedAt,
  }
}

// Cache: per days-værdi, revalidates hver time. Sonnet-kald koster penge,
// så vi vil ikke regne ny rapport ved hver navigation.
// Auto-invalidates når der lægges nye events i Google Calendar? Nej. Brugeren
// må vente op til en time. Det er fint for v2.2; vi tilføjer en "genberegn"-
// knap hvis det viser sig irriterende.
export const getBalance = unstable_cache(
  async (days: number) => computeBalance(days),
  ['balance-v1'],
  { revalidate: 3600, tags: ['balance'] },
)
