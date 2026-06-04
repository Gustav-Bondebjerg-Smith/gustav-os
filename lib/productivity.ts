// Produktivitets-modul. To tal til operatør-kortet, beregnet fra balance-modulets
// kategoriserede kalender-events (genbruger Sonnet-kategoriseringen + dens cache):
//   produktivitet = produktiv tid / logget ikke-søvn tid   (kvaliteten af det loggede)
//   dækning       = logget ikke-søvn tid / vågne timer      (hvor meget af dagen logget)
// Ganget sammen = "andel af vågen tid der var produktiv" (Gustavs oprindelige idé),
// men delt op i to rene knapper, så et lavt tal ikke skyldes glemt logning alene.
//
// Beregningen er tung (getBalance kalder Sonnet) og kører derfor i et nattecron,
// der gemmer dagens tal. Forsiden læser kun det gemte tal via getLatestProductivity.
import 'server-only'
import { getBalance } from './balance'
import { getSupabase } from './supabase'

// Kategorier der tæller som produktiv tid (Gustavs definition: uni, vagt, AI-projekt,
// socialt, træning). fritid/transport/andet + huller tæller ikke. Søvn holdes udenfor.
export const PRODUCTIVE_CATEGORIES = ['studie', 'arbejde', 'projekt', 'socialt', 'krop'] as const
const SLEEP_CATEGORY = 'søvn'
const WINDOW_DAYS = 30

export type ProductivitySnapshot = {
  snapshotDate: string
  windowDays: number
  productiveHours: number
  loggedHours: number // logget ikke-søvn
  sleepHours: number
  wakingHours: number // window_days * 24 - søvn
  productivityPct: number | null // produktiv / logget (null hvis intet logget)
  coveragePct: number // logget / vågne
  eventCount: number
  generatedAt: string | null
}

// I dag som YYYY-MM-DD i Copenhagen (aldrig server-UTC).
function todayCphYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

const round1 = (n: number) => Math.round(n * 10) / 10

// Beregn de to tal fra de seneste windowDays dages kategoriserede events.
export async function computeProductivity(
  windowDays = WINDOW_DAYS,
): Promise<Omit<ProductivitySnapshot, 'snapshotDate'>> {
  const balance = await getBalance(windowDays)
  const totals = new Map(balance.totals.map((t) => [t.category, t.hours]))
  const sleep = totals.get(SLEEP_CATEGORY) ?? 0
  const productive = PRODUCTIVE_CATEGORIES.reduce((sum, c) => sum + (totals.get(c) ?? 0), 0)
  const logged = Math.max(0, balance.trackedHours - sleep) // logget ikke-søvn tid
  const waking = Math.max(0, windowDays * 24 - sleep)
  const productivityPct = logged > 0 ? round1((productive / logged) * 100) : null
  const coveragePct = waking > 0 ? round1((logged / waking) * 100) : 0
  return {
    windowDays,
    productiveHours: round1(productive),
    loggedHours: round1(logged),
    sleepHours: round1(sleep),
    wakingHours: round1(waking),
    productivityPct,
    coveragePct,
    eventCount: balance.eventCount,
    generatedAt: balance.generatedAt,
  }
}

// Beregn + gem dagens snapshot (upsert pr. dato, så gentagne kørsler er idempotente).
export async function snapshotProductivity(): Promise<ProductivitySnapshot> {
  const snapshotDate = todayCphYmd()
  const m = await computeProductivity()
  const sb = getSupabase()
  const { error } = await sb.from('productivity_snapshots').upsert(
    {
      snapshot_date: snapshotDate,
      window_days: m.windowDays,
      productive_hours: m.productiveHours,
      logged_hours: m.loggedHours,
      sleep_hours: m.sleepHours,
      waking_hours: m.wakingHours,
      productivity_pct: m.productivityPct,
      coverage_pct: m.coveragePct,
      event_count: m.eventCount,
      generated_at: m.generatedAt,
    },
    { onConflict: 'snapshot_date' },
  )
  if (error) throw new Error(`snapshotProductivity-fejl: ${error.message}`)
  return { snapshotDate, ...m }
}

// Seneste gemte snapshot til operatør-kortet. Null hvis cron ikke har kørt endnu.
export async function getLatestProductivity(): Promise<ProductivitySnapshot | null> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('productivity_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getLatestProductivity-fejl: ${error.message}`)
  if (!data) return null
  const r = data as Record<string, unknown>
  return {
    snapshotDate: String(r.snapshot_date),
    windowDays: Number(r.window_days),
    productiveHours: Number(r.productive_hours),
    loggedHours: Number(r.logged_hours),
    sleepHours: Number(r.sleep_hours),
    wakingHours: Number(r.waking_hours),
    productivityPct: r.productivity_pct === null ? null : Number(r.productivity_pct),
    coveragePct: Number(r.coverage_pct),
    eventCount: Number(r.event_count),
    generatedAt: r.generated_at ? String(r.generated_at) : null,
  }
}

// Cron-indgang: beregn + gem, returnér et kort resumé til HTTP-svaret.
export async function runProductivityCron(): Promise<{
  snapshotDate: string
  productivityPct: number | null
  coveragePct: number
  eventCount: number
}> {
  const snap = await snapshotProductivity()
  return {
    snapshotDate: snap.snapshotDate,
    productivityPct: snap.productivityPct,
    coveragePct: snap.coveragePct,
    eventCount: snap.eventCount,
  }
}
