// Skriver og sletter events i Google Calendar via service account.
// Kræver at service account'en har "Make changes to events" på din kalender (ikke kun "See").
// Eksporterer: insertEvent({ summary, start, end, location?, description? }) og deleteEvent(eventId).
// CLI-test: node scripts/calendar-write.mjs --test   (opretter dummy-aftale i morgen kl. 12:00 og sletter den)
import './load-env.mjs'
import { fileURLToPath } from 'node:url'
import { JWT } from 'google-auth-library'

// Bredere scope end calendar.mjs: kræves for at skrive events. Read-only og write skal ikke blandes.
const SCOPES = ['https://www.googleapis.com/auth/calendar.events']

function getClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (!email || !key) throw new Error('Mangler GOOGLE_SERVICE_ACCOUNT_EMAIL eller _PRIVATE_KEY i .env.local')
  return new JWT({ email, key, scopes: SCOPES })
}

function getCalId() {
  const id = process.env.GOOGLE_CALENDAR_ID
  if (!id) throw new Error('Mangler GOOGLE_CALENDAR_ID i .env.local')
  return id
}

// Indsætter et event. start/end kan være Date-objekter eller ISO-strenge.
// Date  -> konverteres til UTC ISO (Google fortolker korrekt via timeZone-feltet).
// String -> sendes SOM-ER (så naive strenge som "2026-05-29T14:00:00" fortolkes i timeZone-feltet).
// Returnerer event-objektet fra Google (har .id som bruges til evt. sletning).
function toGoogleDateTime(t) {
  if (t instanceof Date) return t.toISOString()
  return String(t)
}
export async function insertEvent({ summary, start, end, location, description }) {
  if (!summary) throw new Error('summary er påkrævet')
  if (!start || !end) throw new Error('start og end er påkrævet')
  const client = getClient()
  const { token } = await client.getAccessToken()
  const body = {
    summary,
    start: { dateTime: toGoogleDateTime(start), timeZone: 'Europe/Copenhagen' },
    end:   { dateTime: toGoogleDateTime(end),   timeZone: 'Europe/Copenhagen' },
  }
  if (location) body.location = location
  if (description) body.description = description
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalId())}/events`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Calendar insert HTTP ${r.status}: ${await r.text()}`)
  return r.json()
}

// Sletter et event. 410 Gone tæller som "allerede væk" og returneres som success.
export async function deleteEvent(eventId) {
  if (!eventId) throw new Error('eventId er påkrævet')
  const client = getClient()
  const { token } = await client.getAccessToken()
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalId())}/events/${encodeURIComponent(eventId)}`
  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok && r.status !== 410) throw new Error(`Calendar delete HTTP ${r.status}: ${await r.text()}`)
  return true
}

// CLI: opretter dummy-aftale i morgen kl. 12:00-12:30 og sletter den efter 5 sekunder.
// Bruges til at verificere at service account'en har skrive-permission på din kalender.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--test')) {
    console.log('Brug: node scripts/calendar-write.mjs --test')
    console.log('Det opretter en dummy-aftale i morgen kl. 12:00-12:30 og sletter den igen efter 5 sek.')
    process.exit(0)
  }
  const tomorrowNoon = new Date()
  tomorrowNoon.setDate(tomorrowNoon.getDate() + 1)
  tomorrowNoon.setHours(12, 0, 0, 0)
  const tomorrowHalfPast = new Date(tomorrowNoon.getTime() + 30 * 60 * 1000)

  console.log('Opretter dummy-aftale i din kalender...')
  const ev = await insertEvent({
    summary: 'TEST fra Gustav OS - kan slettes',
    start: tomorrowNoon,
    end: tomorrowHalfPast,
    description: 'Auto-genereret test-event. Slettes automatisk om 5 sek.',
  })
  console.log(`  oprettet: id=${ev.id}`)
  console.log(`  link: ${ev.htmlLink}`)
  console.log('  åbn din kalender og se den ligger der. Vent 5 sek, så slettes den.')
  await new Promise(r => setTimeout(r, 5000))

  console.log('Sletter dummy-aftalen...')
  await deleteEvent(ev.id)
  console.log('  slettet. Fase 4 etape 1 (skrive + slette) virker.')
}
