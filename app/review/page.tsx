// /review (Modul 5) - ugentlig review: seneste + arkiv. Server-component henter
// via service_role (lib/weekly-review.ts). Reviewet genereres automatisk søndag
// aften (cron) eller manuelt via knappen. Siden må ikke crashe -> try/catch.
import Link from 'next/link'
import { getLatestReview, listReviews, type WeeklyReview } from '@/lib/weekly-review'
import { ReviewReport } from '@/components/ReviewReport'
import { ReviewGenerate } from '@/components/ReviewGenerate'
import { fmtDate } from '@/lib/format'

export const dynamic = 'force-dynamic'

function fmtWeek(start: string, end: string): string {
  const dm = (d: string) => {
    const [, m, day] = d.split('-')
    return `${Number(day)}/${Number(m)}`
  }
  return `${dm(start)} - ${dm(end)} ${end.slice(0, 4)}`
}

const kr = (n: number) => Math.round(n).toLocaleString('da-DK')

function ReviewStats({ data }: { data: WeeklyReview['data'] }) {
  const topTime = data.time.slice(0, 3)
  return (
    <div className="review-stats">
      <div className="rs-item">
        <span className="rs-k">Fuldført</span>
        <span className="rs-v num">{data.completed.length}</span>
      </div>
      <div className="rs-item">
        <span className="rs-k">Åbne</span>
        <span className="rs-v num">{data.openCount}</span>
      </div>
      <div className="rs-item">
        <span className="rs-k">Uge-mål</span>
        <span className="rs-v num">
          {data.goals.week.done}/{data.goals.week.total}
        </span>
      </div>
      <div className="rs-item">
        <span className="rs-k">Konto-Δ ugen</span>
        <span className={`rs-v num ${data.finance.weekSwing >= 0 ? 'pos' : 'neg'}`}>
          {data.finance.weekSwing >= 0 ? '+' : '-'}
          {kr(Math.abs(data.finance.weekSwing))} kr
        </span>
      </div>
      {topTime.length > 0 && (
        <div className="rs-item rs-time">
          <span className="rs-k">Mest tid</span>
          <span className="rs-v">
            {topTime.map((t) => `${t.category} ${t.hours.toFixed(0)}t`).join(' · ')}
          </span>
        </div>
      )}
    </div>
  )
}

export default async function ReviewPage() {
  let latest: WeeklyReview | null = null
  let archive: WeeklyReview[] = []
  let loadError: string | null = null

  try {
    const all = await listReviews(12)
    latest = all[0] ?? (await getLatestReview())
    archive = all.filter((r) => r.weekStart !== latest?.weekStart)
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  return (
    <>
      <div className="vhead">
        <div className="vh-l">
          <span className="vh-no">06</span>
          <span className="vh-ttl">Review</span>
        </div>
        <span className="vh-sub">{latest ? fmtWeek(latest.weekStart, latest.weekEnd) : 'ingen endnu'}</span>
      </div>

      {loadError && <p className="empty">Kunne ikke hente reviews: {loadError}</p>}

      <section className="card">
        <div className="card-head">
          <div className="sect">
            <span className="no">A</span>
            <span className="ttl">Seneste review</span>
          </div>
          <ReviewGenerate hasLatest={!!latest} />
        </div>
        {latest ? (
          <>
            <ReviewReport report={latest.report} />
            <ReviewStats data={latest.data} />
            <p className="review-meta">
              Genereret {fmtDate(latest.generatedAt)}
              {latest.deliveredTelegram ? ' · sendt på Telegram' : ''}
            </p>
          </>
        ) : (
          <p className="empty">
            Intet review endnu. Det genereres automatisk søndag aften, eller tryk Generér nu.
            Kræver lidt data i kalender/opgaver/mål/finans først.
          </p>
        )}
      </section>

      {archive.length > 0 && (
        <section className="card fin-block">
          <div className="card-head">
            <div className="sect">
              <span className="no">B</span>
              <span className="ttl">Arkiv</span>
            </div>
            <span className="tag num">{archive.length}</span>
          </div>
          <div className="review-archive">
            {archive.map((r) => (
              <details key={r.weekStart} className="review-arch-item">
                <summary>
                  <span className="raw-week num">{fmtWeek(r.weekStart, r.weekEnd)}</span>
                  <span className="raw-meta">{fmtDate(r.generatedAt)}</span>
                </summary>
                <ReviewReport report={r.report} />
              </details>
            ))}
          </div>
        </section>
      )}

      <p className="board-foot">
        <Link href="/">← Tilbage til I dag</Link>
      </p>
    </>
  )
}
