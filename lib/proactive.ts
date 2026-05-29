import 'server-only'
import { getSupabase } from './supabase'
import { getEvents, eventHours, type GoogleCalendarEvent } from './calendar'
import { sendTelegramMessage } from './telegram'
import { startOfTodayCph, endOfTodayCph, fmtTime } from './format'

const BRIEFING_MODEL = 'claude-haiku-4-5-20251001'

type BriefingKind = 'morning' | 'evening' | 'patterns'

type CaptureRow = {
  id: string
  content: string
  area: string | null
  classification: { type?: string; summary?: string } | null
  created_at: string
}

type ActionRow = {
  id: string
  type: string
  status: string
  payload: { summary?: string; start?: string; end?: string } | null
  veto_deadline: string | null
  created_at: string
}

export type ProactiveResult = {
  kind: BriefingKind
  sent: boolean
  reason?: string
  message?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function nowLabel(): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
}

function fmtEvent(event: GoogleCalendarEvent): string {
  const start = event.start?.dateTime || event.start?.date || '?'
  const end = event.end?.dateTime || event.end?.date || '?'
  const hours = eventHours(event)
  const duration = hours ? ` (${hours.toFixed(1)}t)` : ''
  return `${start.slice(0, 16).replace('T', ' ')}-${end.slice(11, 16) || '?'}${duration}: ${event.summary || '(uden titel)'}`
}

function fmtCapture(capture: CaptureRow): string {
  const type = capture.classification?.type || 'ukendt'
  const summary = capture.classification?.summary || capture.content.slice(0, 80)
  return `${capture.created_at.slice(0, 16).replace('T', ' ')} [${capture.area || 'ukendt'}, ${type}]: ${summary}`
}

function fmtAction(action: ActionRow): string {
  const summary = action.payload?.summary || '(uden titel)'
  const start = action.payload?.start ? action.payload.start.slice(0, 16).replace('T', ' ') : '?'
  return `${action.status}: ${summary} (${start})`
}

function section(title: string, lines: string[]): string {
  return `${title}\n${lines.length ? lines.join('\n') : '(ingen)'}`
}

async function anthropic(system: string, user: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: BRIEFING_MODEL,
      max_tokens: 800,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const json = await r.json()
  return String(json.content?.[0]?.text || '').trim()
}

async function getRecentCaptures(hours: number, limit: number): Promise<CaptureRow[]> {
  const sb = getSupabase()
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('raw_captures')
    .select('id, content, area, classification, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`raw_captures query-fejl: ${error.message}`)
  return (data || []) as CaptureRow[]
}

async function getRecentActions(hours: number, limit: number): Promise<ActionRow[]> {
  const sb = getSupabase()
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('actions')
    .select('id, type, status, payload, veto_deadline, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`actions query-fejl: ${error.message}`)
  return (data || []) as ActionRow[]
}

async function logBriefing(kind: BriefingKind, result: ProactiveResult): Promise<void> {
  const sb = getSupabase()
  await sb.from('audit_log').insert({
    action: `proactive_${kind}`,
    payload: { sent: result.sent, message: result.message || null },
    status: result.sent ? 'applied' : 'skipped',
    reason: result.reason || null,
  })
}

async function alreadySent(kind: BriefingKind, hours: number): Promise<boolean> {
  const sb = getSupabase()
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('audit_log')
    .select('id')
    .eq('action', `proactive_${kind}`)
    .eq('status', 'applied')
    .gte('created_at', since)
    .limit(1)
  if (error) throw new Error(`audit_log query-fejl: ${error.message}`)
  return Boolean(data?.length)
}

// Klassificér dagen ud fra første event. Vercel Hobby tillader kun
// daglige crons, så vi kan ikke styre HVORNÅR briefen sendes; men vi
// kan tilpasse INDHOLDET til dagens form.
type DayShape =
  | { kind: 'early'; firstStart: string; label: string } // første event før 08:00 CPH
  | { kind: 'normal'; firstStart: string; label: string } // første event 08:00-12:00
  | { kind: 'late'; firstStart: string; label: string } // første event efter 12:00
  | { kind: 'empty'; label: string } // ingen events i kalenderen i dag

function classifyDay(todaysEvents: GoogleCalendarEvent[]): DayShape {
  const withStart = todaysEvents
    .map((ev) => ev.start?.dateTime)
    .filter((s): s is string => !!s)
    .sort()
  const firstStart = withStart[0]
  if (!firstStart) return { kind: 'empty', label: 'Ingen events i kalenderen i dag.' }

  const hourCph = Number(fmtTime(firstStart).slice(0, 2)) // "06.45" -> 6
  const tidStr = fmtTime(firstStart)
  if (hourCph < 8) return { kind: 'early', firstStart, label: `Tidlig dag - første event kl ${tidStr}.` }
  if (hourCph < 12) return { kind: 'normal', firstStart, label: `Normal dag - første event kl ${tidStr}.` }
  return { kind: 'late', firstStart, label: `Sen start - første event kl ${tidStr}.` }
}

async function buildMorningBriefing(): Promise<string> {
  const now = new Date()
  const later = new Date(now.getTime() + 36 * 60 * 60 * 1000)
  const [events, todayEvents, captures, actions] = await Promise.all([
    getEvents(now, later),
    getEvents(startOfTodayCph(), endOfTodayCph()),
    getRecentCaptures(24, 10),
    getRecentActions(48, 10),
  ])
  const shape = classifyDay(todayEvents)

  const adaptHint = (() => {
    switch (shape.kind) {
      case 'early':
        return 'Han skal ud af døren snart. Hold briefen ekstra kort. Spring kontekst over og kør lige til prioritet.'
      case 'normal':
        return 'Standard-format: 3-5 bullets + én prioritet.'
      case 'late':
        return 'Han har formiddagen fri. Foreslå konkret, hvad den skal bruges til. Studie eller projekt-build, ikke spildtid.'
      case 'empty':
        return 'Ingen kalender-aftaler. Briefen skal udfordre ham til at sætte to konkrete blokke for dagen (studie/projekt) i stedet for at drive.'
    }
  })()

  const system = [
    'Du er Gustav OS og skriver en kort morgenbrief til Gustav på dansk.',
    'Stil: direkte, varm, konkret. Ingen lange forklaringer. Ingen em-dash.',
    `Dagens form: ${shape.label}`,
    `Tilpasning: ${adaptHint}`,
    'Giv max 5 korte bullets. Slut med præcis én anbefalet prioritet for dagen.',
    'Kontekst: Gustav læser medicin, arbejder som SPV/forskningsassistent og bygger dette system som hobby.',
  ].join('\n')

  const user = [
    `Nu i København: ${nowLabel()}`,
    `Dagstype: ${shape.kind} (${shape.label})`,
    section('I dag (kalender):', todayEvents.map(fmtEvent)),
    section('Næste 36 timer (inkl. i morgen tidligt):', events.map(fmtEvent)),
    section('Seneste captures:', captures.map(fmtCapture)),
    section('Seneste actions:', actions.map(fmtAction)),
  ].join('\n\n')

  return anthropic(system, user)
}

async function buildEveningReflection(): Promise<string> {
  const now = new Date()
  const earlier = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const [events, captures, actions] = await Promise.all([
    getEvents(earlier, now),
    getRecentCaptures(24, 12),
    getRecentActions(24, 10),
  ])

  const system = [
    'Du er Gustav OS og skriver en kort aften-refleksion til Gustav på dansk.',
    'Stil: direkte, rolig, ikke terapeutisk. Ingen em-dash.',
    'Skriv max 160 ord. Brug 3 korte bullets og slut med ét spørgsmål han kan svare på i Telegram.',
    'Fokus: hvad dagen faktisk viser, ikke moralsk evaluering.',
  ].join('\n')

  const user = [
    `Nu i København: ${nowLabel()}`,
    section('Kalender sidste 24 timer:', events.map(fmtEvent)),
    section('Captures sidste 24 timer:', captures.map(fmtCapture)),
    section('Actions sidste 24 timer:', actions.map(fmtAction)),
  ].join('\n\n')

  return anthropic(system, user)
}

async function buildPatternFlag(): Promise<{ send: boolean; message?: string; reason?: string }> {
  const now = new Date()
  const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const [events, captures, actions] = await Promise.all([
    getEvents(since, now),
    getRecentCaptures(14 * 24, 80),
    getRecentActions(14 * 24, 40),
  ])

  const system = [
    'Du er Gustav OS og vurderer om Gustav skal have et proaktivt mønster-flag.',
    'Svar KUN med JSON på formen {"send":true/false,"reason":"...","message":"..."}',
    'Send kun hvis der er et konkret mønster, han kan handle på nu. Ingen generisk motivation.',
    'Hvis send=true: message skal være dansk, max 120 ord, direkte og hjælpsomt. Ingen em-dash.',
  ].join('\n')

  const user = [
    `Nu i København: ${nowLabel()}`,
    section('Kalender sidste 14 dage:', events.map(fmtEvent).slice(-120)),
    section('Captures sidste 14 dage:', captures.map(fmtCapture)),
    section('Actions sidste 14 dage:', actions.map(fmtAction)),
  ].join('\n\n')

  const raw = await anthropic(system, user)
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as { send?: boolean; message?: string; reason?: string }
    return {
      send: Boolean(parsed.send && parsed.message),
      message: parsed.message,
      reason: parsed.reason,
    }
  } catch {
    return { send: false, reason: 'pattern_json_parse_failed' }
  }
}

export async function runProactiveBriefing(kind: BriefingKind): Promise<ProactiveResult> {
  if (kind !== 'patterns' && await alreadySent(kind, 18)) {
    return { kind, sent: false, reason: 'already_sent_recently' }
  }
  if (kind === 'patterns' && await alreadySent(kind, 72)) {
    return { kind, sent: false, reason: 'already_sent_recently' }
  }

  let result: ProactiveResult
  if (kind === 'morning') {
    const message = await buildMorningBriefing()
    await sendTelegramMessage(`Morgenbrief\n\n${message}`)
    result = { kind, sent: true, message }
  } else if (kind === 'evening') {
    const message = await buildEveningReflection()
    await sendTelegramMessage(`Aften-refleksion\n\n${message}`)
    result = { kind, sent: true, message }
  } else {
    const flag = await buildPatternFlag()
    if (!flag.send || !flag.message) {
      result = { kind, sent: false, reason: flag.reason || 'no_signal' }
    } else {
      await sendTelegramMessage(`Mønster-flag\n\n${flag.message}`)
      result = { kind, sent: true, reason: flag.reason, message: flag.message }
    }
  }

  await logBriefing(kind, result)
  return result
}
