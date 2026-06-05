// "I dag" - bento-forside (Claude Design struct D). Alle kort er RIGTIGE data:
// tidslinjen (getEvents), opgaver (listTasks), mål (listGoals) og finans
// (getNetWorth + getSinSummary fra bank-CSV + Storebox).
import Link from 'next/link'
import { getEvents, type GoogleCalendarEvent } from '@/lib/calendar'
import { startOfTodayCph, endOfTodayCph, isPastDayCph } from '@/lib/format'
import { listTasks, type Task } from '@/lib/tasks'
import { listGoals, SCOPES, SCOPE_LABEL, type Goal } from '@/lib/goals'
import { getNetWorth, getSinSummary, getNetWorthHistory, type NetWorth, type SinSummary, type NetWorthPoint } from '@/lib/finance'
import { Card } from '@/components/Card'
import { SessionCard } from '@/components/SessionCard'
import { NetWorthCurve } from '@/components/NetWorthCurve'
import { PrivacyToggle } from '@/components/PrivacyToggle'
import { getLatestProductivity, type ProductivitySnapshot } from '@/lib/productivity'
import { Check, AlertTriangle } from 'lucide-react'

export const dynamic = 'force-dynamic'

const kr = (n: number) => Math.round(n).toLocaleString('da-DK') + ' kr'
const fmt = (n: number) => Math.round(n).toLocaleString('da-DK')
const signed = (n: number) => (n >= 0 ? '+' : '-') + fmt(Math.abs(n)) + ' kr'

function hhmmCph(iso?: string | null): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

export default async function HomePage() {
  const now = new Date()

  let events: GoogleCalendarEvent[] = []
  let calendarError: string | null = null
  try {
    events = await getEvents(startOfTodayCph(), endOfTodayCph())
  } catch (e) {
    calendarError = e instanceof Error ? e.message : String(e)
  }

  // Dagens opgaver: åbne opgaver der enten haster i dag eller er markeret vigtige.
  // Top 3 efter board-sorteringen (vigtig > prioritet). Forsiden må aldrig fejle
  // på dette - tom liste ved fejl.
  let dayTasks: Task[] = []
  let dayTaskTotal = 0
  try {
    const open = await listTasks()
    const today = open.filter((t) => t.urgency === 'today' || t.key)
    dayTaskTotal = today.length
    dayTasks = today.slice(0, 3)
  } catch {
    /* forsiden viser bare tomt opgavekort hvis hentning fejler */
  }

  // Mål grupperet på scope (uge/måned). Forsiden viser dem read-only; redigering
  // sker på /maal. Må heller ikke fejle forsiden.
  let goals: Goal[] = []
  try {
    goals = await listGoals()
  } catch {
    /* tomt mål-kort hvis hentning fejler */
  }

  // Operatør-kort: ægte ugefokus (øverste uge-mål) + produktivitet (gemt af nattecron).
  const weekGoals = goals.filter((g) => g.scope === 'week')
  const focusGoal = weekGoals.find((g) => !g.done) ?? weekGoals[0] ?? null
  let prod: ProductivitySnapshot | null = null
  try {
    prod = await getLatestProductivity()
  } catch {
    /* operatør-kortet viser "bygges op" hvis hentning fejler */
  }

  // Finans-kort: nettoformue (fra bank-saldo) + denne måneds synder. Rigtige tal.
  // Må aldrig fejle forsiden.
  let nw: NetWorth | null = null
  let sins: SinSummary[] = []
  let nwHistory: NetWorthPoint[] = []
  try {
    nw = await getNetWorth()
    sins = await getSinSummary()
    nwHistory = await getNetWorthHistory(90)
  } catch {
    /* tomt finans-kort hvis hentning fejler */
  }
  const sinTotal = sins.reduce((a, s) => a + s.amount, 0)
  const sinMax = Math.max(...sins.map((s) => s.amount), 1)

  const isOngoing = (ev: GoogleCalendarEvent) =>
    !!ev.start?.dateTime && !!ev.end?.dateTime &&
    new Date(ev.start.dateTime) <= now && now < new Date(ev.end.dateTime)
  const hasOngoing = events.some(isOngoing)
  const firstUpcomingId = events.find(
    (ev) => ev.start?.dateTime && new Date(ev.start.dateTime) > now,
  )?.id

  return (
    <div className="grid" data-struct="D">
      {/* 01 OPERATØR */}
      <Card
        id="operator"
        no="01"
        title="Operatør"
        tag={<span className="op-online"><span className="d" />Online</span>}
      >
        <div className="op-top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <span className="op-avatar"><img src="/gustav.jpg" alt="Gustav" /></span>
          <div className="op-id">
            <div className="op-name">Gustav <span className="last">Bondebjerg Smith</span></div>
            <div className="op-role">Medicinstuderende · SDU Odense</div>
          </div>
        </div>
        <div className="op-stats">
          <div className="op-stat">
            <div className="k">Ugefokus</div>
            {focusGoal ? (
              <div className="op-focus">{focusGoal.title}</div>
            ) : (
              <Link className="op-focus-empty" href="/maal">Sæt et ugefokus →</Link>
            )}
          </div>
          <div className="op-stat">
            <div className="k">Produktivitet · 30 dage</div>
            {prod && prod.productivityPct !== null ? (
              <div className="op-prod">
                <span className="n num">{Math.round(prod.productivityPct)}<span className="u">%</span></span>
                <span className="op-cover num">{Math.round(prod.coveragePct)}% af dagen logget</span>
              </div>
            ) : (
              <div className="op-prod-empty">Bygges op. Log din tid i kalenderen.</div>
            )}
          </div>
        </div>
      </Card>

      {/* 02 SESSION (klient: levende ur + capture) */}
      <SessionCard />

      {/* 03 FINANS (rigtige tal fra bank-CSV + Storebox) */}
      <Card
        id="finans"
        no="03"
        title="Finans"
        tag={
          <div className="card-tools">
            <PrivacyToggle />
            <span className="tag live">Live</span>
          </div>
        }
      >
        {nw ? (
          <>
            <Link className="fin-link" href="/finans">
              <div className="fin-top">
                <div>
                  <div className="nw-label">Nettoformue</div>
                  <div className="nw-value num">{fmt(nw.netWorth)}<span className="unit">kr</span></div>
                </div>
                <div className="swings">
                  <div className="swing"><div className="k">I dag</div><div className={`v num ${nw.daySwing >= 0 ? 'pos' : 'neg'}`}>{signed(nw.daySwing)}</div></div>
                  <div className="swing"><div className="k">Denne måned</div><div className={`v num ${nw.monthSwing >= 0 ? 'pos' : 'neg'}`}>{signed(nw.monthSwing)}</div></div>
                  <div className="swing"><div className="k">Dette år</div><div className={`v num ${nw.yearSwing >= 0 ? 'pos' : 'neg'}`}>{signed(nw.yearSwing)}</div></div>
                </div>
              </div>
            </Link>
            {nwHistory.length > 1 && <NetWorthCurve points={nwHistory} compact />}
            <div className="sin">
              <div className="sin-head">
                <span className="l">
                  <AlertTriangle size={14} aria-hidden="true" /> Syndeudgifter · denne måned
                  {sins.length > 0 && <span className="sin-warn-dot" />}
                </span>
                <span className="sin-total num">{kr(sinTotal)}</span>
              </div>
              {sins.length === 0 ? (
                <p className="empty">Ingen synder registreret denne måned.</p>
              ) : (
                <div className="sin-rows">
                  {sins.slice(0, 5).map((s) => (
                    <div className="sin-row" key={s.tag}>
                      <span className="cat">{s.label}</span>
                      <span className="track"><span className="fill" style={{ width: `${Math.round((s.amount / sinMax) * 100)}%` }} /></span>
                      <span className="amt num">{kr(s.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="empty">Finans-data ikke tilgængelig endnu.</p>
        )}
      </Card>

      {/* 04 DAGENS OPGAVER (rigtige opgaver fra boardet) */}
      <Card id="opgaver" no="04" title="Dagens opgaver" tag={<span className="tag">{dayTaskTotal} i dag</span>}>
        {dayTasks.length === 0 ? (
          <p className="empty">Ingen opgaver i dag. Sig til OS&apos;en hvad du skal nå.</p>
        ) : (
          <div className="tasks">
            {dayTasks.map((t) => {
              const overdue = isPastDayCph(t.due_date)
              return (
                <Link className="task" href="/opgaver" key={t.id}>
                  <span className="check"><Check aria-hidden="true" /></span>
                  <div className="t-body">
                    <div className="t-title">{t.title}</div>
                    <div className="t-meta">
                      {t.urgency === 'today' ? <span className="pill today">I dag</span> : null}
                      {t.key ? <span className="pill vigtig">Vigtig</span> : null}
                      {overdue ? <span className="pill over">Forsinket</span> : null}
                      {t.area ? <span className={`pill area-${t.area}`}>{t.area}</span> : null}
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </Card>

      {/* 05 I DAG (rigtig kalender) */}
      <Card id="idag" no="05" title="I dag" tag={<span className="tag">Resten af dagen</span>}>
        {calendarError ? (
          <p className="empty">Kalender-fejl: {calendarError}</p>
        ) : events.length === 0 ? (
          <p className="empty">Ingen events i dag.</p>
        ) : (
          <div className="blocks">
            {events.map((ev) => {
              const start = ev.start?.dateTime
              const end = ev.end?.dateTime
              const past = end ? new Date(end) <= now : false
              const ongoing = isOngoing(ev)
              const isNext = !!ev.id && ev.id === firstUpcomingId
              const cls = [
                'block',
                past && 'past',
                (ongoing || (isNext && !hasOngoing)) && 'now',
                isNext && 'next',
              ].filter(Boolean).join(' ')
              const whenTop = start ? hhmmCph(start) : ev.start?.date ? 'hele' : '—'
              const whenBot = end ? hhmmCph(end) : ev.start?.date ? 'dagen' : ''
              return (
                <div className={cls} key={ev.id}>
                  <div className="when">{whenTop}<br /><span className="to">{whenBot}</span></div>
                  <div className="what"><div className="wt">{ev.summary || '(uden titel)'}</div></div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* 06 MÅL (rigtige mål fra boardet, read-only - rediger på /maal) */}
      <Card
        id="maal"
        no="06"
        title="Mål"
        tag={goals.length > 0 ? <span className="tag">{goals.filter((g) => g.done).length}/{goals.length} klar</span> : undefined}
      >
        {goals.length === 0 ? (
          <p className="empty">Ingen mål endnu. Sæt uge- og måneds-mål på Mål-fanen.</p>
        ) : (
          <div className="goals">
            {SCOPES.map((scope) => {
              const groupGoals = goals.filter((g) => g.scope === scope)
              const done = groupGoals.filter((g) => g.done).length
              return (
                <div className="goal-grp" key={scope}>
                  <div className="goal-lbl">{SCOPE_LABEL[scope]} · {done}/{groupGoals.length}</div>
                  <div className="goal-list">
                    {groupGoals.length === 0 ? (
                      <p className="empty">Ingen endnu.</p>
                    ) : (
                      groupGoals.map((g) => (
                        <Link className={`fh-task ${g.done ? 'done' : ''}`} href="/maal" key={g.id}>
                          <span className="fh-check"><Check aria-hidden="true" /></span>
                          <span className="goal-text">{g.title}</span>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
