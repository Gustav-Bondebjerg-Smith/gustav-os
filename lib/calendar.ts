import 'server-only'
import { JWT } from 'google-auth-library'

const READ_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
const WRITE_SCOPES = ['https://www.googleapis.com/auth/calendar.events']

export type GoogleCalendarEvent = {
  id?: string
  htmlLink?: string
  summary?: string
  location?: string
  start?: {
    date?: string
    dateTime?: string
  }
  end?: {
    date?: string
    dateTime?: string
  }
}

export type CalendarInsertPayload = {
  summary: string
  start: string | Date
  end: string | Date
  location?: string
  description?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function getClient(scopes: string[]): JWT {
  const email = requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const key = requireEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n')
  return new JWT({ email, key, scopes })
}

function getCalendarId(): string {
  return requireEnv('GOOGLE_CALENDAR_ID')
}

async function getAccessToken(scopes: string[]): Promise<string> {
  const client = getClient(scopes)
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('Kunne ikke hente access token fra Google')
  return token
}

function toGoogleDateTime(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export async function getEvents(
  from: Date,
  to: Date,
  calendarId = getCalendarId()
): Promise<GoogleCalendarEvent[]> {
  const token = await getAccessToken(READ_SCOPES)
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  })
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`Calendar API HTTP ${r.status}: ${await r.text()}`)
  const json = await r.json()
  return (json.items || []) as GoogleCalendarEvent[]
}

export function eventHours(event: GoogleCalendarEvent): number {
  const start = event.start?.dateTime
  const end = event.end?.dateTime
  if (!start || !end) return 0
  return (new Date(end).getTime() - new Date(start).getTime()) / 3.6e6
}

// Sletter et event. 410 Gone tæller som "allerede væk" og returneres som success.
export async function deleteEvent(eventId: string): Promise<void> {
  if (!eventId) throw new Error('eventId er påkrævet')
  const token = await getAccessToken(WRITE_SCOPES)
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalendarId())}/events/${encodeURIComponent(eventId)}`
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok && r.status !== 410) {
    throw new Error(`Calendar delete HTTP ${r.status}: ${await r.text()}`)
  }
}

export async function insertEvent(payload: CalendarInsertPayload): Promise<GoogleCalendarEvent> {
  if (!payload.summary) throw new Error('summary er påkrævet')
  if (!payload.start || !payload.end) throw new Error('start og end er påkrævet')

  const token = await getAccessToken(WRITE_SCOPES)
  const body: Record<string, unknown> = {
    summary: payload.summary,
    start: { dateTime: toGoogleDateTime(payload.start), timeZone: 'Europe/Copenhagen' },
    end: { dateTime: toGoogleDateTime(payload.end), timeZone: 'Europe/Copenhagen' },
  }
  if (payload.location) body.location = payload.location
  if (payload.description) body.description = payload.description

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(getCalendarId())}/events`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Calendar insert HTTP ${r.status}: ${await r.text()}`)
  return (await r.json()) as GoogleCalendarEvent
}
