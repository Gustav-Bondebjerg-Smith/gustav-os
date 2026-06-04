// Modul 5: ugentlig review. Samler ugens data (tid fra balance, opgaver, mål,
// finans), lader Claude Sonnet skrive et review i Gustav OS-personaen (wins /
// hvad smuttede / åbne sløjfer / top 3 næste uge), gemmer det idempotent pr.
// ISO-uge, indekserer det i second brain og kan levere det på Telegram.
//
// Skrive-sti: service_role (getSupabase). Auth-gating sker i cron-routen
// (validateCronRequest) og i web-actionen (authedEmail). Selve genereringen er
// ren server-logik her.
import 'server-only'
import { getSupabase } from './supabase'
import { getBalance } from './balance'
import { listTasks } from './tasks'
import { listGoals } from './goals'
import { getWeeklyFinanceSummary } from './finance'
import { sendTelegramMessage } from './telegram'
import { storeChunk } from './memory'
import { SIN_LABEL } from './finance-shared'
import { URGENCY_LABEL } from './tasks-shared'

const REVIEW_MODEL = 'claude-sonnet-4-6'
const CPH = 'Europe/Copenhagen'
const TELEGRAM_MAX = 3900

// ------------------------------- typer -------------------------------

export type WeeklyReviewData = {
  time: Array<{ category: string; hours: number; pct: number }>
  trackedHours: number
  eventCount: number
  completed: string[]
  openCount: number
  goals: { week: { done: number; total: number }; month: { done: number; total: number } }
  finance: { netWorth: number; weekSwing: number; sins: Array<{ label: string; amount: number }> }
}

export type WeeklyReview = {
  weekStart: string // mandag (YYYY-MM-DD, CPH)
  weekEnd: string // søndag
  report: string // markdown fra Sonnet
  data: WeeklyReviewData
  generatedAt: string
  deliveredTelegram: boolean
}

// --------------------------- dato-helpers (CPH) ---------------------------

// YYYY-MM-DD i CPH for et tidspunkt.
function cphYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CPH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

// Læg n dage til en YMD via UTC-middag, så DST-skift ikke flytter datoen.
function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Ugedag 0=søn..6=lør for en YMD.
function dowYmd(ymd: string): number {
  return new Date(ymd + 'T12:00:00Z').getUTCDay()
}

// Mandag + søndag i ISO-ugen der indeholder 'now' (CPH). Søndag aften (cron-tid)
// rammer dermed den uge der netop er gået.
function reviewWeek(now: Date): { weekStart: string; weekEnd: string } {
  const today = cphYmd(now)
  const dow = dowYmd(today)
  const toMonday = dow === 0 ? -6 : 1 - dow
  const weekStart = addDaysYmd(today, toMonday)
  return { weekStart, weekEnd: addDaysYmd(weekStart, 6) }
}

function fmtDk(d: string): string {
  const [y, m, day] = d.split('-')
  return `${Number(day)}/${Number(m)}-${y}`
}

// ------------------------------- DB-mapping -------------------------------

function rowToReview(row: Record<string, unknown>): WeeklyReview {
  return {
    weekStart: String(row.week_start),
    weekEnd: String(row.week_end),
    report: String(row.report ?? ''),
    data: (row.data as WeeklyReviewData) ?? emptyData(),
    generatedAt: String(row.generated_at ?? row.created_at ?? ''),
    deliveredTelegram: Boolean(row.delivered_telegram),
  }
}

function emptyData(): WeeklyReviewData {
  return {
    time: [],
    trackedHours: 0,
    eventCount: 0,
    completed: [],
    openCount: 0,
    goals: { week: { done: 0, total: 0 }, month: { done: 0, total: 0 } },
    finance: { netWorth: 0, weekSwing: 0, sins: [] },
  }
}

async function getReviewByWeek(weekStart: string): Promise<WeeklyReview | null> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('weekly_reviews')
    .select('week_start, week_end, report, data, generated_at, created_at, delivered_telegram')
    .eq('week_start', weekStart)
    .limit(1)
  if (error) throw new Error(`getReviewByWeek-fejl: ${error.message}`)
  const row = data?.[0]
  return row ? rowToReview(row as Record<string, unknown>) : null
}

export async function getLatestReview(): Promise<WeeklyReview | null> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('weekly_reviews')
    .select('week_start, week_end, report, data, generated_at, created_at, delivered_telegram')
    .order('week_start', { ascending: false })
    .limit(1)
  if (error) throw new Error(`getLatestReview-fejl: ${error.message}`)
  const row = data?.[0]
  return row ? rowToReview(row as Record<string, unknown>) : null
}

export async function listReviews(limit = 12): Promise<WeeklyReview[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('weekly_reviews')
    .select('week_start, week_end, report, data, generated_at, created_at, delivered_telegram')
    .order('week_start', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listReviews-fejl: ${error.message}`)
  return (data ?? []).map((r) => rowToReview(r as Record<string, unknown>))
}

// ------------------------------- indsamling -------------------------------

async function getCompletedThisWeek(weekStart: string): Promise<string[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('tasks')
    .select('title, completed_at')
    .eq('status', 'done')
    .gte('completed_at', weekStart)
    .order('completed_at', { ascending: true })
  if (error) throw new Error(`getCompletedThisWeek-fejl: ${error.message}`)
  return (data ?? []).map((r) => String((r as Record<string, unknown>).title ?? '')).filter(Boolean)
}

async function gather(weekStart: string): Promise<WeeklyReviewData & { openTitles: string[] }> {
  // Tid (balance) er best-effort: den bruger unstable_cache + Google Calendar.
  // Fejler en enkelt kilde, skal reviewet stadig kunne genereres fra resten.
  const balancePromise = getBalance(7).catch((e) => {
    console.error('weekly-review: getBalance fejlede, fortsætter uden tid:', e instanceof Error ? e.message : e)
    return null
  })
  const [balance, openTasks, goals, finance, completed] = await Promise.all([
    balancePromise,
    listTasks({ status: 'active' }),
    listGoals(),
    getWeeklyFinanceSummary(),
    getCompletedThisWeek(weekStart),
  ])

  const weekGoals = goals.filter((g) => g.scope === 'week')
  const monthGoals = goals.filter((g) => g.scope === 'month')

  // Åbne opgaver: vigtige + i dag/denne uge øverst, så prompten ser det presserende først.
  const rank = (u: string) => (u === 'today' ? 0 : u === 'week' ? 1 : u === 'month' ? 2 : 3)
  const openTitles = [...openTasks]
    .sort((a, b) => Number(b.key) - Number(a.key) || rank(a.urgency) - rank(b.urgency))
    .map((t) => `${t.title}${t.key ? ' (nøgle)' : ''} [${URGENCY_LABEL[t.urgency]}]`)

  return {
    time: balance?.totals ?? [],
    trackedHours: balance?.trackedHours ?? 0,
    eventCount: balance?.eventCount ?? 0,
    completed,
    openCount: openTasks.length,
    goals: {
      week: { done: weekGoals.filter((g) => g.done).length, total: weekGoals.length },
      month: { done: monthGoals.filter((g) => g.done).length, total: monthGoals.length },
    },
    finance: {
      netWorth: Math.round(finance.netWorth),
      weekSwing: Math.round(finance.weekSwing),
      sins: finance.sins.map((s) => ({ label: SIN_LABEL[s.tag], amount: s.amount })),
      // åbne opgave-titler bæres separat ud, ikke i den gemte data
    },
    openTitles,
  }
}

// ------------------------------- Sonnet -------------------------------

function section(title: string, lines: string[]): string {
  return `${title}\n${lines.length ? lines.join('\n') : '(ingen)'}`
}

function buildPrompt(
  weekStart: string,
  weekEnd: string,
  d: WeeklyReviewData,
  openTitles: string[],
): { system: string; user: string } {
  const system = [
    'Du er Gustav OS og skriver Gustavs ugentlige review.',
    'Stemme: dansk, direkte og udfordrende, men konstruktiv. Ingen moralisering. Han er 23. INGEN em-dash; brug punktum eller bindestreg.',
    'Ankr mod realistiske benchmarks for en travl medicinstuderende, ikke outliers. Hvis han nedgør sig selv som "doven", afvis det og reframe til "reaktiv, arbejder på proaktiv".',
    'Om Gustav: medicinstuderende SDU (4. semester), sygeplejevikar (SPV) + forskningsassistent, bor i Odense. Bygger Gustav OS (kategori "projekt").',
    '',
    'Dette er en REFLEKSION + PLANLÆGNING, ikke en tidsfordeling. Tallene er kontekst, ikke pointen.',
    'Skriv reviewet i markdown med PRÆCIS disse fire overskrifter, i denne rækkefølge:',
    '## Wins',
    '## Hvad smuttede',
    '## Åbne sløjfer',
    '## Top 3 næste uge',
    'Hver sektion: 2-4 korte punkter (markdown-bullets). Wins/smuttede: konkret, forankret i ugens data. Åbne sløjfer: uafsluttede opgaver/mål der venter. Top 3: de tre vigtigste ting næste uge, prioriteret og handlingsbare.',
    'Maks ca. 250 ord i alt. Vær konkret, ikke generisk. Brug hans faktiske tal og opgaver. Ingen indledning eller afslutning udenfor de fire overskrifter.',
  ].join('\n')

  const timeLines = d.time.map((t) => `${t.category}: ${t.hours.toFixed(1)}t (${Math.round(t.pct)}%)`)
  const goalLines = [
    `Denne uge: ${d.goals.week.done}/${d.goals.week.total} nået`,
    `Denne måned: ${d.goals.month.done}/${d.goals.month.total} nået`,
  ]
  const finLines = [
    `Nettoformue: ${d.finance.netWorth.toLocaleString('da-DK')} kr`,
    `Ugens konto-Δ: ${d.finance.weekSwing >= 0 ? '+' : '-'}${Math.abs(d.finance.weekSwing).toLocaleString('da-DK')} kr`,
    d.finance.sins.length
      ? `Syndeudgifter (måned til dato): ${d.finance.sins.map((s) => `${s.label} ${s.amount} kr`).join(', ')}`
      : 'Syndeudgifter: ingen registreret',
  ]

  const user = [
    `Review-uge: ${fmtDk(weekStart)} til ${fmtDk(weekEnd)}.`,
    section(`Tid sidste 7 dage (${d.eventCount} events, ${d.trackedHours.toFixed(1)}t kategoriseret):`, timeLines),
    section(`Opgaver fuldført i ugen (${d.completed.length}):`, d.completed),
    section(`Opgaver stadig åbne (${d.openCount}):`, openTitles.slice(0, 20)),
    section('Mål:', goalLines),
    section('Finans:', finLines),
  ].join('\n\n')

  return { system, user }
}

async function callSonnet(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) throw new Error('Mangler ANTHROPIC_API_KEY')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      max_tokens: 1400,
      temperature: 0.5,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const text = String(j.content?.[0]?.text || '').trim()
  if (!text) throw new Error('Tomt review-svar fra Sonnet')
  return text
}

// ------------------------------- levering -------------------------------

async function deliverToTelegram(review: WeeklyReview): Promise<void> {
  const header = `📋 Ugentlig review (${fmtDk(review.weekStart)} - ${fmtDk(review.weekEnd)})`
  let body = `${header}\n\n${review.report}`
  if (body.length > TELEGRAM_MAX) body = body.slice(0, TELEGRAM_MAX) + '\n\n[...] Se hele reviewet på /review.'
  await sendTelegramMessage(body)
}

// sourceId skal være weekly_reviews-rækkens uuid (memory_chunks.source_id er en
// uuid-kolonne, som i capture-flowet), ikke uge-datoen.
async function indexInSecondBrain(review: WeeklyReview, sourceId: string): Promise<void> {
  const content = `Ugentlig review ${fmtDk(review.weekStart)} til ${fmtDk(review.weekEnd)}\n\n${review.report}`
  await storeChunk({
    content,
    source_type: 'weekly_review',
    source_id: sourceId,
    area: 'personlig',
    metadata: { weekStart: review.weekStart, weekEnd: review.weekEnd },
  })
}

// ------------------------------- generering -------------------------------

export type GenerateOptions = {
  store?: boolean // skriv til DB + second brain (default true)
  deliver?: boolean // send på Telegram (default false)
  force?: boolean // regenerér selvom ugen allerede findes (default false)
}

export async function generateWeeklyReview(
  opts: GenerateOptions = {},
): Promise<WeeklyReview & { created: boolean }> {
  const { store = true, deliver = false, force = false } = opts
  const { weekStart, weekEnd } = reviewWeek(new Date())

  // Idempotent: findes ugen allerede, regenerér ikke (medmindre force). Lever
  // kun hvis bedt om OG ikke allerede leveret, så cron-retries ikke spammer.
  if (!force) {
    const existing = await getReviewByWeek(weekStart)
    if (existing) {
      let deliveredTelegram = existing.deliveredTelegram
      if (deliver && !existing.deliveredTelegram) {
        await deliverToTelegram(existing)
        deliveredTelegram = true
        await getSupabase()
          .from('weekly_reviews')
          .update({ delivered_telegram: true })
          .eq('week_start', weekStart)
      }
      return { ...existing, deliveredTelegram, created: false }
    }
  }

  const { openTitles, ...data } = await gather(weekStart)
  const { system, user } = buildPrompt(weekStart, weekEnd, data, openTitles)
  const report = await callSonnet(system, user)
  const generatedAt = new Date().toISOString()

  const review: WeeklyReview = { weekStart, weekEnd, report, data, generatedAt, deliveredTelegram: false }

  if (deliver) {
    await deliverToTelegram(review)
    review.deliveredTelegram = true
  }

  if (store) {
    const sb = getSupabase()
    const { data: row, error } = await sb
      .from('weekly_reviews')
      .upsert(
        {
          week_start: weekStart,
          week_end: weekEnd,
          report,
          data,
          generated_at: generatedAt,
          delivered_telegram: review.deliveredTelegram,
        },
        { onConflict: 'week_start' },
      )
      .select('id')
      .single()
    if (error) throw new Error(`weekly_reviews upsert-fejl: ${error.message}`)
    // Second brain er best-effort: en embedding-fejl må ikke vælte reviewet.
    try {
      await indexInSecondBrain(review, String((row as { id: string }).id))
    } catch (e) {
      console.error('weekly-review second-brain-indeksering fejlede:', e)
    }
  }

  return { ...review, created: true }
}

// Cron-indgang: generér + lever på Telegram. Idempotent pr. uge.
export async function runWeeklyReviewCron(): Promise<{
  weekStart: string
  weekEnd: string
  created: boolean
  delivered: boolean
}> {
  const r = await generateWeeklyReview({ store: true, deliver: true })
  return { weekStart: r.weekStart, weekEnd: r.weekEnd, created: r.created, delivered: r.deliveredTelegram }
}
