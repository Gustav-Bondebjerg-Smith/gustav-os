// Henter events fra Google Calendar via service account (kun læsning).
// Service account'en har fået din kalender delt med "See all event details".
// Delt modul: bruges af balance.mjs. Kan også køres direkte for at teste forbindelsen.
import './load-env.mjs'
import { fileURLToPath } from 'node:url'
import { JWT } from 'google-auth-library'

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']

function getClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  // Nøglen ligger på én linje i .env.local med tekst-\n. Fold ud til rigtige linjeskift.
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (!email || !key) throw new Error('Mangler GOOGLE_SERVICE_ACCOUNT_EMAIL eller _PRIVATE_KEY i .env.local')
  return new JWT({ email, key, scopes: SCOPES })
}

// from/to: Date-objekter. Returnerer rå event-objekter fra Google (gentagne foldet ud, sorteret).
export async function getEvents(from, to, calendarId = process.env.GOOGLE_CALENDAR_ID) {
  if (!calendarId) throw new Error('Mangler GOOGLE_CALENDAR_ID i .env.local')
  const client = getClient()
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('Kunne ikke hente access token fra Google')
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true', // folder gentagne events ud til enkelt-forekomster
    orderBy: 'startTime',
    maxResults: '2500',
  })
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`Calendar API HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return j.items || []
}

// Varighed i timer for et event. Heldags-events (kun .date, intet klokkeslæt) giver 0.
export function eventHours(e) {
  const s = e.start?.dateTime, t = e.end?.dateTime
  if (!s || !t) return 0
  return (new Date(t) - new Date(s)) / 3.6e6
}

// CLI: node scripts/calendar.mjs  -> lister sidste 14 dage (test af forbindelsen)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const to = new Date()
  const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const events = await getEvents(from, to)
  console.log(`Fandt ${events.length} events de sidste 14 dage:\n`)
  for (const e of events) {
    const start = (e.start?.dateTime || e.start?.date || '?').slice(0, 16).replace('T', ' ')
    const h = eventHours(e)
    console.log(`${start}  ${h ? h.toFixed(1).padStart(4) + 't' : 'heldag'}  ${e.summary || '(uden titel)'}`)
  }
}
