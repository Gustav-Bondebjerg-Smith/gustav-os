// Givet en kort besked (capture-tekst), udleder Claude Haiku om der er en konkret aftale.
// Returnerer { summary, start, end, location? } i naive København-tid, ELLER null hvis ikke en konkret aftale.
// Kør CLI: node scripts/propose.mjs "Tandlæge fredag 14"
import './load-env.mjs'
import { fileURLToPath } from 'node:url'

const MODEL = 'claude-haiku-4-5-20251001' // billig + hurtig til strukturerede udtræk

// Menneskeligt læseligt "lige nu" i København, så Haiku har et entydigt anker for "fredag", "i morgen" osv.
function nowInCopenhagen() {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date())
}

export async function proposeCalendarEvent(captureContent) {
  if (!captureContent || captureContent.trim().length < 3) return null

  const system = [
    'Du udleder en konkret kalender-aftale fra en kort dansk besked.',
    `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen()}.`,
    '',
    'Svar KUN med JSON, intet andet. To mulige svar:',
    '',
    'Hvis beskeden indeholder en KONKRET aftale med specifik tid:',
    '{"propose": true, "summary": "...", "start": "YYYY-MM-DDTHH:MM:00", "end": "YYYY-MM-DDTHH:MM:00", "location": "..."}',
    '',
    'Hvis IKKE (vag tid, blot en tanke, ingen tid, fortidig hændelse osv.):',
    '{"propose": false, "reason": "kort dansk forklaring"}',
    '',
    'Regler:',
    '- start/end er NAIVE datetime uden timezone-offset (kalenderen sætter Europe/Copenhagen).',
    '- summary: kort dansk titel, max 6 ord, første bogstav stort.',
    '- Hvis kun starttid og ingen sluttid: sæt end = start + 1 time.',
    '- "fredag" uden uge = den FØRSTKOMMENDE fredag fra nu.',
    '- "i morgen" = dagen efter dagens dato i København.',
    '- Hvis tiden er vag ("snart", "engang", "i næste uge" uden dag), eller hvis det er en ren tanke/note → propose: false.',
    '- Hvis tiden allerede er passeret (fortidig) → propose: false.',
    '- location: kun hvis den er nævnt eksplicit i beskeden. Ellers udelad feltet.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: captureContent }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed
  try { parsed = JSON.parse(cleaned) } catch { return null }
  if (!parsed.propose) return null
  if (!parsed.summary || !parsed.start || !parsed.end) return null
  return {
    summary: parsed.summary,
    start: parsed.start,
    end: parsed.end,
    ...(parsed.location ? { location: parsed.location } : {}),
  }
}

// Formaterer et forslag til en menneskeligt læselig Telegram-besked.
const WEEKDAYS_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
export function formatProposal(p, vetoMinutes = 10) {
  // Bemærk: vi parser den naive streng som lokal tid (på en server i DK er det DK-tid).
  // Til pænt visning er det fint; til Google API sender vi strengen som-er + timeZone-felt.
  const s = new Date(p.start)
  const e = new Date(p.end)
  const wd = WEEKDAYS_SHORT[s.getDay()]
  const d = `${s.getDate()}/${s.getMonth() + 1}`
  const t1 = `${String(s.getHours()).padStart(2, '0')}.${String(s.getMinutes()).padStart(2, '0')}`
  const t2 = `${String(e.getHours()).padStart(2, '0')}.${String(e.getMinutes()).padStart(2, '0')}`
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return [
    `Forslag: ${p.summary}`,
    `Tid: ${wd} ${d} kl. ${t1}-${t2}${loc}`,
    '',
    `Skriv "nej" inden ${vetoMinutes} min for at vetoe. Ellers skriver jeg den i kalenderen.`,
  ].join('\n')
}

// CLI-test: node scripts/propose.mjs "Tandlæge fredag 14"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv.slice(2).join(' ')
  if (!input) {
    console.log('Brug: node scripts/propose.mjs "Tandlæge fredag 14"')
    console.log('Returnerer JSON-forslag eller null.')
    process.exit(0)
  }
  const result = await proposeCalendarEvent(input)
  if (!result) {
    console.log('Ingen aftale udledt (input er for vagt eller ikke en aftale).')
  } else {
    console.log('Forslag:')
    console.log(JSON.stringify(result, null, 2))
    console.log('\nSådan ville Telegram-beskeden se ud:\n')
    console.log(formatProposal(result))
  }
}
