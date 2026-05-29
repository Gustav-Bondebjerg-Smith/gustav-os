// /captures - liste over raw_captures fra Telegram (tekst + voice).
// Server component med filtre via query-params:
//   ?q=...      tekstsøgning (ILIKE, case-insensitive substring)
//   ?area=...   personlig | studie | arbejde
//   ?type=...   opgave | note | ide | aftale (på classification->>type i JSONB)
//   ?source=... text | voice
// Alle filtre kombineres med AND. Chips toggler det enkelte filter,
// søge-form bevarer de andre filtre som hidden inputs.
import Link from 'next/link'
import { getSupabase } from '@/lib/supabase'
import { fmtDate } from '@/lib/format'
import { NewCaptureForm } from './new-capture-form'

type Capture = {
  id: string
  source: string
  content: string
  area: string | null
  classification: { type?: string; summary?: string } | null
  processed: boolean
  created_at: string
}

const AREAS = ['personlig', 'studie', 'arbejde'] as const
const TYPES = ['opgave', 'note', 'ide', 'aftale'] as const
const SOURCES = ['text', 'voice', 'web'] as const

// Mapping fra UI-source-værdi til DB-source-værdi. Telegram-captures gemmes
// som telegram_text/telegram_voice, web-formularen som dashboard.
const SOURCE_DB_MAP: Record<(typeof SOURCES)[number], string> = {
  text: 'telegram_text',
  voice: 'telegram_voice',
  web: 'dashboard',
}

type Area = (typeof AREAS)[number]
type Type = (typeof TYPES)[number]
type Source = (typeof SOURCES)[number]

type Filters = {
  q: string
  area: Area | null
  type: Type | null
  source: Source | null
}

const AREA_STYLES: Record<string, string> = {
  personlig: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  studie: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100',
  arbejde: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
}

function isMember<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
}

function buildHref(current: Filters, override: Partial<Filters>): string {
  const merged: Filters = { ...current, ...override }
  const params = new URLSearchParams()
  if (merged.q) params.set('q', merged.q)
  if (merged.area) params.set('area', merged.area)
  if (merged.type) params.set('type', merged.type)
  if (merged.source) params.set('source', merged.source)
  const qs = params.toString()
  return qs ? `/captures?${qs}` : '/captures'
}

function chipClass(active: boolean): string {
  return active
    ? 'px-2.5 py-1 rounded-full text-xs bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
    : 'px-2.5 py-1 rounded-full text-xs border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
}

function hasAnyFilter(f: Filters): boolean {
  return !!(f.q || f.area || f.type || f.source)
}

function labelSource(source: string): string {
  if (source === 'telegram_voice') return 'voice'
  if (source === 'telegram_text') return 'text'
  if (source === 'dashboard') return 'web'
  return source
}

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  q?: string
  area?: string
  type?: string
  source?: string
}>

export default async function CapturesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const filters: Filters = {
    q: (params.q || '').trim().slice(0, 200),
    area: isMember(params.area, AREAS) ? params.area : null,
    type: isMember(params.type, TYPES) ? params.type : null,
    source: isMember(params.source, SOURCES) ? params.source : null,
  }

  const sb = getSupabase()
  let query = sb
    .from('raw_captures')
    .select('id, source, content, area, classification, processed, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (filters.area) query = query.eq('area', filters.area)
  if (filters.type) query = query.eq('classification->>type', filters.type)
  if (filters.source) query = query.eq('source', SOURCE_DB_MAP[filters.source])
  if (filters.q) {
    // Escape % og _ så de er literal, og brug ilike for case-insensitive substring.
    const safe = filters.q.replace(/[\\%_]/g, (m) => `\\${m}`)
    query = query.ilike('content', `%${safe}%`)
  }

  const { data, error } = await query
  if (error) {
    return <div className="text-red-600">DB-fejl: {error.message}</div>
  }

  const captures = (data || []) as Capture[]
  const filtersActive = hasAnyFilter(filters)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Captures</h1>
        <p className="text-sm text-zinc-500">
          Telegram-tekst, voicenotes og web-form. Op til 100 nyeste. Filtre + søgning kombineres med AND.
        </p>
      </div>

      <NewCaptureForm />

      {/* Søge-form: GET. Hidden inputs bevarer aktive chips. */}
      <form action="/captures" method="get" className="mb-4 flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={filters.q}
          placeholder="Søg i tekst..."
          maxLength={200}
          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        />
        {filters.area && <input type="hidden" name="area" value={filters.area} />}
        {filters.type && <input type="hidden" name="type" value={filters.type} />}
        {filters.source && <input type="hidden" name="source" value={filters.source} />}
        <button
          type="submit"
          className="px-3 py-1.5 text-sm rounded-lg bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Søg
        </button>
      </form>

      {/* Filter-chips: klik toggler det enkelte filter. */}
      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-xs text-zinc-500 uppercase tracking-wide mr-1">Område:</span>
        {AREAS.map((a) => (
          <Link
            key={a}
            href={buildHref(filters, { area: filters.area === a ? null : a })}
            className={chipClass(filters.area === a)}
          >
            {a}
          </Link>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2 items-center">
        <span className="text-xs text-zinc-500 uppercase tracking-wide mr-1">Type:</span>
        {TYPES.map((t) => (
          <Link
            key={t}
            href={buildHref(filters, { type: filters.type === t ? null : t })}
            className={chipClass(filters.type === t)}
          >
            {t}
          </Link>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2 items-center">
        <span className="text-xs text-zinc-500 uppercase tracking-wide mr-1">Kilde:</span>
        {SOURCES.map((s) => (
          <Link
            key={s}
            href={buildHref(filters, { source: filters.source === s ? null : s })}
            className={chipClass(filters.source === s)}
          >
            {s}
          </Link>
        ))}
        {filtersActive && (
          <Link href="/captures" className="ml-2 text-xs text-zinc-500 hover:underline">
            nulstil
          </Link>
        )}
      </div>

      <p className="text-xs text-zinc-500 mb-4">
        {captures.length} resultat{captures.length === 1 ? '' : 'er'}
        {filtersActive ? ' (filtreret)' : ''}.
      </p>

      {captures.length === 0 ? (
        <p className="text-zinc-500 text-sm">
          {filtersActive
            ? 'Ingen captures matcher filtrene. Prøv at nulstille.'
            : 'Ingen captures endnu. Send en besked til Telegram-botten for at starte.'}
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
                <span className="text-zinc-500">{labelSource(c.source)}</span>
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
                    <span className="text-zinc-600 dark:text-zinc-300">{c.classification.type}</span>
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
                <p className="text-xs text-zinc-500 mt-2 italic">{c.classification.summary}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
