// /actions - liste over auto-handlinger (kalender-forslag og deres status).
// Server component. Sidestykke til show-actions.mjs.
import { getSupabase } from '@/lib/supabase'
import { fmtDate } from '@/lib/format'

type ActionRow = {
  id: string
  type: string
  status: 'proposed' | 'executing' | 'executed' | 'vetoed' | 'failed'
  payload: {
    summary?: string
    start?: string
    end?: string
    location?: string
    event_id?: string
  } | null
  veto_deadline: string | null
  executed_at: string | null
  vetoed_at: string | null
  result: { html_link?: string; error?: string; deleted?: boolean } | null
  created_at: string
}

const STATUS_STYLES: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  executing: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  executed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
  vetoed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100',
}

const WEEKDAYS_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
function fmtPayloadTime(p: ActionRow['payload']): string {
  if (!p?.start || !p?.end) return ''
  const s = new Date(p.start)
  const e = new Date(p.end)
  const wd = WEEKDAYS_SHORT[s.getDay()]
  const d = `${s.getDate()}/${s.getMonth() + 1}`
  const t1 = `${String(s.getHours()).padStart(2, '0')}.${String(s.getMinutes()).padStart(2, '0')}`
  const t2 = `${String(e.getHours()).padStart(2, '0')}.${String(e.getMinutes()).padStart(2, '0')}`
  return `${wd} ${d} ${t1}-${t2}`
}

export const dynamic = 'force-dynamic'

export default async function ActionsPage() {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('actions')
    .select('id, type, status, payload, veto_deadline, executed_at, vetoed_at, result, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return <div className="text-red-600">DB-fejl: {error.message}</div>
  }

  const actions = (data || []) as ActionRow[]

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Actions</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Kalender-forslag og deres status. Veto på Telegram med &quot;nej&quot;.
      </p>

      {actions.length === 0 ? (
        <p className="text-zinc-500">
          Ingen actions endnu. Send en aftale-besked til botten.
        </p>
      ) : (
        <ul className="space-y-3">
          {actions.map((a) => {
            const when = fmtPayloadTime(a.payload)
            const summary = a.payload?.summary || '(uden titel)'
            const deadline = a.veto_deadline ? new Date(a.veto_deadline) : null
            const deadlinePassed = deadline ? deadline < new Date() : false
            return (
              <li
                key={a.id}
                className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 bg-white dark:bg-zinc-900"
              >
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                  <span className="text-zinc-500 font-mono">{fmtDate(a.created_at)}</span>
                  <span className="text-zinc-400">·</span>
                  <span className={`px-2 py-0.5 rounded uppercase tracking-wide ${STATUS_STYLES[a.status] || ''}`}>
                    {a.status}
                  </span>
                  <span className="text-zinc-400">·</span>
                  <span className="text-zinc-500">
                    {a.type === 'calendar_delete' ? 'calendar_delete' : a.type}
                  </span>
                </div>
                <p className="text-sm font-medium">{summary}</p>
                {when && <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{when}</p>}
                {a.payload?.location && (
                  <p className="text-xs text-zinc-500 mt-1">{a.payload.location}</p>
                )}

                {a.status === 'proposed' && deadline && (
                  <p className="text-xs text-zinc-500 mt-2">
                    veto-deadline: {fmtDate(deadline.toISOString())}
                    {deadlinePassed && ' (passeret, venter på watcher)'}
                  </p>
                )}
                {a.status === 'executed' && a.type === 'calendar_insert' && a.result?.html_link && (
                  <a
                    href={a.result.html_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2 inline-block"
                  >
                    Åbn i Google Calendar
                  </a>
                )}
                {a.status === 'executed' && a.type === 'calendar_delete' && (
                  <p className="text-xs text-zinc-500 mt-2">Slettet fra Google Calendar</p>
                )}
                {a.status === 'failed' && a.result?.error && (
                  <p className="text-xs text-red-600 mt-2">fejl: {a.result.error}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
