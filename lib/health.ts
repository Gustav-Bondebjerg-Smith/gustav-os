// Vagthunden: dagligt helbredstjek af systemets pipelines (Modul: drift).
// Fanger den fejlklasse der IKKE råber op af sig selv: data der stille bliver
// forældet og cron-jobs der stille dør. Tre checks i v1:
//   1) Bankdata-friskhed: nyeste posteringsdato må højst være 30 dage gammel
//      (månedsbasis, Gustavs valg 2026-07-06). Ellers: upload-påmindelse.
//   2) Kategoriseringskø: for mange posteringer uden kategori = klassificerings-
//      cronnen er sandsynligvis i stå (eller Anthropic har været nede længe).
//   3) Cron-puls: hvert job skriver last_success i cron_runs (withCronLock,
//      migration 0019). Et job der ikke har kørt inden for sin forventning flages.
// Adfærd: sender KUN en Telegram-besked når mindst ét flag er rejst. Grøn dag =
// stilhed. Deterministisk kode hele vejen - ingen LLM-kald.
import 'server-only'
import { getSupabase } from './supabase'
import { sendTelegramMessage } from './telegram'

// Tærskler. Kan tunes via env uden kode-edit.
const BANK_STALE_DAYS = Number(process.env.HEALTH_BANK_STALE_DAYS) || 30
const QUEUE_LIMIT = Number(process.env.HEALTH_QUEUE_LIMIT) || 25

// Forventet maksimal alder (timer) på hvert jobs seneste vellykkede kørsel.
// Rundhåndede grænser: actions/finance-classify kører hvert 10.-15. min via
// pg_cron, men flages først efter 3 timer, så en enkelt hikke ikke larmer.
// 'health' tjekker ikke sig selv (den kører jo lige nu).
const JOB_MAX_AGE_HOURS: Record<string, number> = {
  actions: 3,
  'finance-classify': 3,
  productivity: 36,
  'weekly-review': 8 * 24,
  patterns: 8 * 24,
}

export type HealthResult = {
  ok: boolean
  flags: string[]
  notified: boolean
  checked: {
    newestTransaction: string | null
    unclassifiedCount: number | null
    pulses: Record<string, string>
  }
}

const DAY_MS = 86_400_000

// Nyeste posteringsdato. null = ingen bankdata overhovedet (også et flag).
async function newestTransactionDate(): Promise<string | null> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('transactions')
    .select('booked_date')
    .order('booked_date', { ascending: false })
    .limit(1)
  if (error) throw new Error(`health: transactions-opslag fejlede: ${error.message}`)
  return data?.[0]?.booked_date ?? null
}

// Antal posteringer uden kategori (= klassificeringskøen).
async function unclassifiedCount(): Promise<number> {
  const sb = getSupabase()
  const { count, error } = await sb
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .is('category', null)
  if (error) throw new Error(`health: kø-optælling fejlede: ${error.message}`)
  return count ?? 0
}

async function cronPulses(): Promise<Record<string, string>> {
  const sb = getSupabase()
  const { data, error } = await sb.from('cron_runs').select('name, last_success')
  if (error) throw new Error(`health: cron_runs-opslag fejlede: ${error.message}`)
  const out: Record<string, string> = {}
  for (const row of data ?? []) out[row.name as string] = row.last_success as string
  return out
}

function fmtDaDate(iso: string): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso))
}

export async function runHealthCheck(now: Date = new Date()): Promise<HealthResult> {
  const flags: string[] = []

  // 1) Bankdata-friskhed. booked_date er en date (YYYY-MM-DD); alder i hele dage.
  const newest = await newestTransactionDate()
  if (!newest) {
    flags.push('Ingen bankdata i systemet overhovedet. Upload CSV på /finans.')
  } else {
    const ageDays = Math.floor((now.getTime() - Date.parse(newest)) / DAY_MS)
    if (ageDays > BANK_STALE_DAYS) {
      flags.push(
        `Bankdata slutter ${fmtDaDate(newest)} (${ageDays} dage siden). Upload frisk CSV + Storebox på /finans.`
      )
    }
  }

  // 2) Kategoriseringskø.
  let queue: number | null = null
  try {
    queue = await unclassifiedCount()
    if (queue > QUEUE_LIMIT) {
      flags.push(
        `${queue} posteringer venter på kategori (grænse ${QUEUE_LIMIT}). Klassificerings-cronnen er muligvis i stå - tjek /finans og Vercel-logs.`
      )
    }
  } catch (e) {
    flags.push(`Kunne ikke tælle kategoriseringskøen: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 3) Cron-puls. Kun jobs vi har en forventning til; ukendte navne ignoreres.
  let pulses: Record<string, string> = {}
  try {
    pulses = await cronPulses()
    for (const [job, maxHours] of Object.entries(JOB_MAX_AGE_HOURS)) {
      const last = pulses[job]
      if (!last) {
        flags.push(`Cron-jobbet "${job}" har ingen puls-række i cron_runs (migration 0019 kørt?).`)
        continue
      }
      const ageHours = (now.getTime() - new Date(last).getTime()) / 3_600_000
      if (ageHours > maxHours) {
        const rounded = Math.round(ageHours)
        flags.push(
          `Cron-jobbet "${job}" har ikke kørt succesfuldt i ~${rounded} timer (forventet inden for ${maxHours}). Tjek pg_cron/Vercel.`
        )
      }
    }
  } catch (e) {
    flags.push(`Kunne ikke læse cron-pulsen: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Kun støj når noget er galt. Grøn dag = ingen besked.
  let notified = false
  if (flags.length > 0) {
    const text = `🩺 Vagthund: ${flags.length} flag\n${flags.map((f) => `- ${f}`).join('\n')}`
    try {
      await sendTelegramMessage(text)
      notified = true
    } catch (e) {
      // Telegram nede + noget er galt: log højt, så det i det mindste står i Vercel-logs.
      console.error('vagthund: kunne ikke sende Telegram-besked:', e, 'flags:', flags)
    }
  }

  return {
    ok: flags.length === 0,
    flags,
    notified,
    checked: { newestTransaction: newest, unclassifiedCount: queue, pulses },
  }
}
