// Root - "I dag"-overblik. Tre sektioner: kalender for resten af dagen,
// proposed actions der venter (uanset om veto-vindue er løbet ud, fordi
// cron på Hobby kun kører dagligt), og seneste captures. Server component
// der henter direkte fra Supabase + Google Calendar.
import Link from 'next/link'
import { getSupabase } from '@/lib/supabase'
import { getEvents, type GoogleCalendarEvent } from '@/lib/calendar'
import {
  fmtDate,
  fmtRange,
  fmtDay,
  startOfTodayCph,
  endOfTodayCph,
} from '@/lib/format'

type Capture = {
  id: string
  source: string
  content: string
  area: string | null
  classification: { type?: string; summary?: string } | null
  created_at: string
}

type ProposedAction = {
  id: string
  type: string
  payload: {
    summary?: string
    start?: string
    end?: string
    location?: string
  } | null
  veto_deadline: string | null
  created_at: string
}

const AREA_STYLES: Record<string, string> = {
  personlig: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  studie: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100',
  arbejde: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
}

function eventEndIso(ev: GoogleCalendarEvent): string | null {
  return ev.end?.dateTime || ev.end?.date || null
}

function labelSource(source: string): string {
  if (source === 'telegram_voice') return 'voice'
  if (source === 'telegram_text') return 'text'
  if (source === 'dashboard') return 'web'
  return source
}

function fmtEventTime(ev: GoogleCalendarEvent): string {
  const s = ev.start?.dateTime
  const e = ev.end?.dateTime
  if (s && e) return fmtRange(s, e)
  if (ev.start?.date) return 'hele dagen'
  return ''
}

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const sb = getSupabase()
  const now = new Date()

  // Kalender-events for resten af dagen (Copenhagen-tid). Wrappet i try/catch
  // så Google API-fejl ikke krasher hele forsiden.
  let events: GoogleCalendarEvent[] = []
  let calendarError: string | null = null
  try {
    events = await getEvents(startOfTodayCph(), endOfTodayCph())
    // Filtrer events der allerede er afsluttet.
    events = events.filter((ev) => {
      const end = eventEndIso(ev)
      if (!end) return true
      return new Date(end) > now
    })
  } catch (e) {
    calendarError = e instanceof Error ? e.message : String(e)
  }

  // ALLE proposed actions - også dem hvor veto-vinduet er løbet ud, fordi
  // cron på Hobby kun kører dagligt og handlingen reelt venter på dig
  // (du kan stadig veto via Telegram indtil cron eksekverer).
  const { data: actionsData } = await sb
    .from('actions')
    .select('id, type, payload, veto_deadline, created_at')
    .eq('status', 'proposed')
    .order('created_at', { ascending: false })
    .limit(10)
  const proposed = (actionsData || []) as ProposedAction[]

  // Seneste 5 captures.
  const { data: capturesData } = await sb
    .from('raw_captures')
    .select('id, source, content, area, classification, created_at')
    .order('created_at', { ascending: false })
    .limit(5)
  const captures = (capturesData || []) as Capture[]

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">{fmtDay(now.toISOString())}</h1>
        <p className="text-sm text-zinc-500">Overblik over hvad der ligger foran dig lige nu.</p>
      </div>

      {/* I dag - resten af dagens kalender */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">I dag</h2>
          <span className="text-xs text-zinc-400">{events.length} tilbage</span>
        </div>
        {calendarError ? (
          <div className="text-sm text-red-600 dark:text-red-400">
            Kalender-fejl: {calendarError}
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-zinc-500">Ingen flere events i dag.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => (
              <li
                key={ev.id}
                className="flex items-start gap-3 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 bg-white dark:bg-zinc-900"
              >
                <span className="text-xs font-mono text-zinc-500 pt-0.5 min-w-[140px]">
                  {fmtEventTime(ev) || '-'}
                </span>
                <span className="text-sm flex-1">{ev.summary || '(uden titel)'}</span>
                {ev.htmlLink && (
                  <a
                    href={ev.htmlLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline pt-0.5"
                  >
                    åbn
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Venter på dig - proposed actions, både inden for og efter veto-vindue */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Venter på dig</h2>
          <Link href="/actions" className="text-xs text-zinc-400 hover:underline">se alle</Link>
        </div>
        {proposed.length === 0 ? (
          <p className="text-sm text-zinc-500">Intet venter. Veto med &quot;nej&quot; på Telegram hvis noget dukker op.</p>
        ) : (
          <ul className="space-y-2">
            {proposed.map((a) => {
              const when = fmtRange(a.payload?.start, a.payload?.end)
              const day = a.payload?.start ? fmtDay(a.payload.start) : ''
              const deadline = a.veto_deadline ? new Date(a.veto_deadline) : null
              const insideWindow = deadline ? deadline > now : false
              const minutesLeft = deadline && insideWindow
                ? Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 60000))
                : null
              return (
                <li
                  key={a.id}
                  className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{a.payload?.summary || '(uden titel)'}</p>
                      {(day || when) && (
                        <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 font-mono">
                          {day}{day && when ? ' · ' : ''}{when}
                        </p>
                      )}
                      {a.payload?.location && (
                        <p className="text-xs text-zinc-500 mt-0.5">{a.payload.location}</p>
                      )}
                    </div>
                    <span className="text-xs text-amber-700 dark:text-amber-200 whitespace-nowrap pt-0.5">
                      {minutesLeft !== null ? `veto ${minutesLeft} min` : 'venter på cron'}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Seneste captures */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Seneste captures</h2>
          <Link href="/captures" className="text-xs text-zinc-400 hover:underline">se alle</Link>
        </div>
        {captures.length === 0 ? (
          <p className="text-sm text-zinc-500">Ingen captures endnu. Send en besked til botten.</p>
        ) : (
          <ul className="space-y-2">
            {captures.map((c) => (
              <li
                key={c.id}
                className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 bg-white dark:bg-zinc-900"
              >
                <div className="flex flex-wrap items-center gap-2 mb-1 text-xs">
                  <span className="text-zinc-500 font-mono">{fmtDate(c.created_at)}</span>
                  <span className="text-zinc-400">·</span>
                  <span className="text-zinc-500">{labelSource(c.source)}</span>
                  {c.area && (
                    <>
                      <span className="text-zinc-400">·</span>
                      <span className={`px-1.5 py-0.5 rounded ${AREA_STYLES[c.area] || 'bg-zinc-100 text-zinc-700'}`}>
                        {c.area}
                      </span>
                    </>
                  )}
                </div>
                <p className="text-sm leading-relaxed line-clamp-2">{c.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
