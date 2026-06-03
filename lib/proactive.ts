import 'server-only'
import { getSupabase } from './supabase'
import { getEvents, eventHours, type GoogleCalendarEvent } from './calendar'
import { sendTelegramMessage } from './telegram'

const BRIEFING_MODEL = 'claude-haiku-4-5-20251001'

type BriefingKind = 'patterns'

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
  if (await alreadySent(kind, 72)) {
    return { kind, sent: false, reason: 'already_sent_recently' }
  }

  const flag = await buildPatternFlag()
  let result: ProactiveResult
  if (!flag.send || !flag.message) {
    result = { kind, sent: false, reason: flag.reason || 'no_signal' }
  } else {
    await sendTelegramMessage(`Mønster-flag\n\n${flag.message}`)
    result = { kind, sent: true, reason: flag.reason, message: flag.message }
  }

  await logBriefing(kind, result)
  return result
}
