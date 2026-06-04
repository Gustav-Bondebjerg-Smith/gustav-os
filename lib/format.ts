// Dato-formattering. Alt vises i Europe/Copenhagen så Vercel (UTC) ikke
// rapporterer søvn 23-07 i stedet for 01-09. Intl.DateTimeFormat klarer
// både CET og CEST automatisk.
const TZ = 'Europe/Copenhagen'

const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør']
const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

function partsCph(iso: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(iso))
}

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? ''
}

function weekdayCph(iso: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(new Date(iso))
  return WEEKDAY_MAP[wd] ?? 0
}

// "tir 27/5 14.03" - bruges i lister
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const p = partsCph(iso)
  return `${WEEKDAYS[weekdayCph(iso)]} ${Number(pick(p, 'day'))}/${Number(pick(p, 'month'))} ${pick(p, 'hour')}.${pick(p, 'minute')}`
}

// "14.03" - bare tid i CPH
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const p = partsCph(iso)
  return `${pick(p, 'hour')}.${pick(p, 'minute')}`
}

// "14.03-15.30" hvis samme dag, "23.00-07.00 (28/5)" hvis krydser midnat
export function fmtRange(startIso?: string | null, endIso?: string | null): string {
  if (!startIso || !endIso) return ''
  const sP = partsCph(startIso)
  const eP = partsCph(endIso)
  const startT = `${pick(sP, 'hour')}.${pick(sP, 'minute')}`
  const endT = `${pick(eP, 'hour')}.${pick(eP, 'minute')}`
  const sameDate =
    pick(sP, 'year') === pick(eP, 'year') &&
    pick(sP, 'month') === pick(eP, 'month') &&
    pick(sP, 'day') === pick(eP, 'day')
  if (sameDate) return `${startT}-${endT}`
  return `${startT}-${endT} (${Number(pick(eP, 'day'))}/${Number(pick(eP, 'month'))})`
}

// "tir 27/5"
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const p = partsCph(iso)
  return `${WEEKDAYS[weekdayCph(iso)]} ${Number(pick(p, 'day'))}/${Number(pick(p, 'month'))}`
}

// True hvis iso's kalenderdag (CPH) ligger FØR i dag (CPH). Til "forsinket"-
// markering på opgaver: en deadline i går er overskredet, en deadline i dag er
// ikke. YYYY-MM-DD sorterer leksikografisk = kronologisk, så streng-compare er nok.
export function isPastDayCph(iso: string | null | undefined): boolean {
  if (!iso) return false
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date(iso)) < fmt.format(new Date())
}

// Tjekker om iso ligger på samme kalenderdag som "i dag" i Copenhagen.
export function isTodayCph(iso: string): boolean {
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
  return todayYmd === ymd
}

// Start/slut af "i dag" i Copenhagen, returneret som UTC Date-objekter
// klar til Google Calendar API (som tager ISO med Z).
export function startOfTodayCph(): Date {
  return cphMidnightForToday(0)
}
export function endOfTodayCph(): Date {
  // 23:59:59.999 i Copenhagen = midnight næste dag - 1 ms
  return new Date(cphMidnightForToday(1).getTime() - 1)
}

function cphMidnightForToday(dayOffset: number): Date {
  // 1) Find dato (YYYY-MM-DD) i Copenhagen lige nu.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [yStr, mStr, dStr] = ymd.split('-')
  const y = Number(yStr), m = Number(mStr) - 1, d = Number(dStr) + dayOffset
  // 2) Find Copenhagen-offset for samme dato (12:00 UTC giver sikkert samme dato).
  const noonUtcMs = Date.UTC(y, m, d, 12, 0, 0)
  const cphHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
      .format(new Date(noonUtcMs))
  )
  const offsetHours = cphHour - 12 // 1 i vinter, 2 i sommer
  // 3) 00:00 i Copenhagen = midnight UTC for samme dato, justeret for offset.
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetHours * 3600000)
}
