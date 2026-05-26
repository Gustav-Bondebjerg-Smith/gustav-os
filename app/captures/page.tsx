// /captures - liste over alle raw_captures fra Telegram (tekst + voice).
// Server component der henter direkte fra Supabase.
import { getSupabase } from '@/lib/supabase'
import { fmtDate } from '@/lib/ask'

type Capture = {
  id: string
  source: string
  content: string
  area: string | null
  classification: { type?: string; summary?: string } | null
  processed: boolean
  created_at: string
}

const AREA_STYLES: Record<string, string> = {
  personlig: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  studie: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100',
  arbejde: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
}

// Disable caching - vi vil altid se nyeste captures.
export const dynamic = 'force-dynamic'

export default async function CapturesPage() {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('raw_captures')
    .select('id, source, content, area, classification, processed, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    return (
      <div className="text-red-600">
        DB-fejl: {error.message}
      </div>
    )
  }

  const captures = (data || []) as Capture[]

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Captures</h1>
      <p className="text-sm text-zinc-500 mb-6">
        {captures.length} seneste captures fra Telegram. Nyeste først.
      </p>

      {captures.length === 0 ? (
        <p className="text-zinc-500">
          Ingen captures endnu. Send en besked til Telegram-botten for at starte.
        </p>
      ) : (
        <ul className="space-y-3">
          {captures.map((c) => (
            <li
              key={c.id}
              className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 bg-white dark:bg-zinc-900"
            >
              <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                <span className="text-zinc-500 font-mono">{fmtDate(c.created_at)}</span>
                <span className="text-zinc-400">·</span>
                <span className="text-zinc-500">
                  {c.source === 'telegram_voice' ? 'voice' : 'text'}
                </span>
                {c.area && (
                  <>
                    <span className="text-zinc-400">·</span>
                    <span className={`px-2 py-0.5 rounded ${AREA_STYLES[c.area] || 'bg-zinc-100 text-zinc-700'}`}>
                      {c.area}
                    </span>
                  </>
                )}
                {c.classification?.type && (
                  <>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-600 dark:text-zinc-300">
                      {c.classification.type}
                    </span>
                  </>
                )}
                {!c.processed && (
                  <>
                    <span className="text-zinc-400">·</span>
                    <span className="text-amber-600 dark:text-amber-400">ubehandlet</span>
                  </>
                )}
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.content}</p>
              {c.classification?.summary && (
                <p className="text-xs text-zinc-500 mt-2 italic">
                  {c.classification.summary}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
