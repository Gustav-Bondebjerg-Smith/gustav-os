// /balance - Claude-genereret balance-rapport over kalender.
// Server component. Suspense bruges fordi Sonnet-kaldet tager 5-15 sek.
// Cache lever 1 time per (days) (se lib/balance.ts), så efterfølgende
// visits er instant indtil næste revalidate.
import Link from 'next/link'
import { Suspense } from 'react'
import { getBalance } from '@/lib/balance'
import { fmtDate } from '@/lib/format'

const DAYS_OPTIONS = [7, 14, 30] as const

const CATEGORY_STYLES: Record<string, { bar: string; chip: string }> = {
  søvn: {
    bar: 'bg-indigo-500',
    chip: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-100',
  },
  studie: {
    bar: 'bg-purple-500',
    chip: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100',
  },
  arbejde: {
    bar: 'bg-green-500',
    chip: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100',
  },
  projekt: {
    bar: 'bg-blue-500',
    chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
  },
  transport: {
    bar: 'bg-zinc-400',
    chip: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  },
  socialt: {
    bar: 'bg-orange-500',
    chip: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100',
  },
  krop: {
    bar: 'bg-rose-500',
    chip: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  },
  fritid: {
    bar: 'bg-amber-500',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  },
  andet: {
    bar: 'bg-zinc-300 dark:bg-zinc-700',
    chip: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  },
}

const FALLBACK_STYLE = {
  bar: 'bg-zinc-300 dark:bg-zinc-700',
  chip: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
}

function styleFor(category: string) {
  return CATEGORY_STYLES[category] || FALLBACK_STYLE
}

function clampDays(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 14
  if (n > 60) return 60
  return Math.round(n)
}

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{ days?: string }>

export default async function BalancePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const days = clampDays(params.days)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Balance</h1>
        <p className="text-sm text-zinc-500">
          Claude Sonnet kategoriserer dine events og skriver en kort vurdering. Timer regnes
          præcist i koden. Cachet i op til 1 time pr. periode.
        </p>
      </div>

      <nav className="flex items-center gap-3 text-sm">
        <span className="text-zinc-500">Periode:</span>
        {DAYS_OPTIONS.map((opt) => {
          const active = opt === days
          return (
            <Link
              key={opt}
              href={`/balance?days=${opt}`}
              className={
                active
                  ? 'px-3 py-1 rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'px-3 py-1 rounded-full border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }
            >
              {opt} dage
            </Link>
          )
        })}
      </nav>

      <Suspense key={days} fallback={<BalanceLoading days={days} />}>
        <BalanceContent days={days} />
      </Suspense>
    </div>
  )
}

function BalanceLoading({ days }: { days: number }) {
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-6 bg-white dark:bg-zinc-900">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Beregner balance over {days} dage. Sonnet kategoriserer events og skriver rapporten.
        Første visit varer typisk 5-15 sek; derefter cachet en time.
      </p>
      <div className="mt-4 space-y-2">
        {[60, 45, 30, 25, 15].map((w) => (
          <div key={w} className="h-3 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

async function BalanceContent({ days }: { days: number }) {
  let result
  try {
    result = await getBalance(days)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return (
      <div className="border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 rounded-lg p-4 text-sm text-red-700 dark:text-red-200">
        Kunne ikke hente balance: {msg}
      </div>
    )
  }

  if (result.eventCount === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Ingen events i de sidste {days} dage. Læg noget i kalenderen og kom igen.
      </p>
    )
  }

  const trackedPct = Math.round((result.trackedHours / result.totalHours) * 100)

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Timer pr. kategori
          </h2>
          <span className="text-xs text-zinc-400">
            {result.eventCount} events · {result.trackedHours.toFixed(1)}t af {result.totalHours}t ({trackedPct}%)
          </span>
        </div>
        <ul className="space-y-2">
          {result.totals.map((t) => {
            const s = styleFor(t.category)
            const pct = Math.min(100, t.pct)
            return (
              <li key={t.category} className="text-sm">
                <div className="flex items-baseline justify-between mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${s.chip}`}>
                    {t.category}
                  </span>
                  <span className="text-xs text-zinc-500 font-mono">
                    {t.hours.toFixed(1)}t · {Math.round(t.pct)}%
                  </span>
                </div>
                <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                  <div className={`h-full ${s.bar}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-2">
          Vurdering
        </h2>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap">
          {result.report}
        </div>
        <p className="text-xs text-zinc-400 mt-2">
          Genereret {fmtDate(result.generatedAt)} · cachet 1 time
        </p>
      </section>
    </div>
  )
}
