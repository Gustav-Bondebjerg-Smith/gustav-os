// Finans-fanen (Modul 4). Server-component henter alt via service_role og giver
// det til klient-komponenterne. Nettoformue + synder regnes ud fra de importerede
// bank-posteringer (saldo) + matchede Storebox-varelinjer. Mutationer auth-gater
// selv i actions.ts. Siden må ikke crashe -> hver hentning har sit eget try/catch.
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import {
  getNetWorth,
  getSinSummary,
  getNetWorthHistory,
  listManualBalances,
  listTransactions,
  listReviewQueue,
  SIN_LABEL,
  type NetWorth,
  type SinSummary,
  type NetWorthPoint,
  type ManualBalance,
  type Transaction,
} from '@/lib/finance'
import { FinanceManualBalances } from '@/components/FinanceManualBalances'
import { FinanceUpload } from '@/components/FinanceUpload'
import { FinanceTransactions } from '@/components/FinanceTransactions'
import { NetWorthCurve } from '@/components/NetWorthCurve'

export const dynamic = 'force-dynamic'

const fmt = (n: number) => Math.round(n).toLocaleString('da-DK')
const signed = (n: number) => (n >= 0 ? '+' : '-') + fmt(Math.abs(n)) + ' kr'

export default async function FinansPage() {
  let nw: NetWorth | null = null
  let sins: SinSummary[] = []
  let balances: ManualBalance[] = []
  let txs: Transaction[] = []
  let reviewItems: Transaction[] = []
  let history: NetWorthPoint[] = []
  let loadError: string | null = null
  let unclassified = 0

  try {
    nw = await getNetWorth()
    sins = await getSinSummary()
    history = await getNetWorthHistory()
    balances = await listManualBalances()
    txs = await listTransactions({ limit: 80 })
    reviewItems = await listReviewQueue()
    unclassified = txs.filter((t) => t.category === null).length
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  const sinTotal = sins.reduce((a, s) => a + s.amount, 0)
  const sinMax = Math.max(...sins.map((s) => s.amount), 1)

  return (
    <>
      <div className="vhead">
        <div className="vh-l">
          <span className="vh-no">03</span>
          <span className="vh-ttl">Finans</span>
        </div>
        <span className="vh-sub num">{nw ? fmt(nw.netWorth) + ' kr' : '—'}</span>
      </div>

      {loadError && <p className="empty">Kunne ikke hente finans-data: {loadError}</p>}

      <div className="fin-grid">
        {/* Nettoformue */}
        <section className="card">
          <div className="card-head">
            <div className="sect"><span className="no">A</span><span className="ttl">Nettoformue</span></div>
            <span className="tag live">Live</span>
          </div>
          {nw && (
            <>
              <div className="fin-top">
                <div>
                  <div className="nw-label">Nettoformue</div>
                  <div className="nw-value num">{fmt(nw.netWorth)}<span className="unit">kr</span></div>
                </div>
                <div className="swings">
                  <div className="swing">
                    <div className="k">I dag</div>
                    <div className={`v num ${nw.daySwing >= 0 ? 'pos' : 'neg'}`}>{signed(nw.daySwing)}</div>
                  </div>
                  <div className="swing">
                    <div className="k">Denne måned</div>
                    <div className={`v num ${nw.monthSwing >= 0 ? 'pos' : 'neg'}`}>{signed(nw.monthSwing)}</div>
                  </div>
                </div>
              </div>
              <div className="nw-break">
                <span>Konto {fmt(nw.checking)} kr</span>
                {nw.assets.length > 0 && <span className="pos">+ aktiver {fmt(nw.assets.reduce((a, b) => a + b.amount, 0))} kr</span>}
                {nw.liabilities.length > 0 && <span className="neg">- gæld {fmt(nw.liabilities.reduce((a, b) => a + b.amount, 0))} kr</span>}
              </div>
              <NetWorthCurve points={history} />
            </>
          )}
        </section>

        {/* Syndeudgifter */}
        <section className="card">
          <div className="card-head">
            <div className="sect">
              <span className="no">B</span>
              <span className="ttl"><AlertTriangle size={14} aria-hidden="true" /> Syndeudgifter</span>
            </div>
            <span className="sin-total num">{fmt(sinTotal)} kr</span>
          </div>
          {sins.length === 0 ? (
            <p className="empty">
              Ingen synder registreret denne måned.
              {unclassified > 0 ? ' (Klassificering kører stadig.)' : ''}
            </p>
          ) : (
            <div className="sin-rows">
              {sins.map((s) => (
                <div className="sin-row" key={s.tag}>
                  <span className="cat">{SIN_LABEL[s.tag]}</span>
                  <span className="track"><span className="fill" style={{ width: `${Math.round((s.amount / sinMax) * 100)}%` }} /></span>
                  <span className="amt num">{fmt(s.amount)} kr</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Til gennemsyn (spørge-loop): usikre/ukategoriserede posteringer */}
      {reviewItems.length > 0 && (
        <section className="card fin-block review-card">
          <div className="card-head">
            <div className="sect"><span className="no">!</span><span className="ttl">Til gennemsyn</span></div>
            <span className="tag num">{reviewItems.length} usikre</span>
          </div>
          <p className="review-hint">
            Vælg en kategori, så lærer OS&apos;en forretningen og retter lignende posteringer automatisk.
          </p>
          <FinanceTransactions items={reviewItems} />
        </section>
      )}

      {/* Manuelle balancer */}
      <section className="card fin-block">
        <div className="card-head">
          <div className="sect"><span className="no">C</span><span className="ttl">Balancer</span></div>
          <span className="tag">Opsparing · investering · gæld</span>
        </div>
        <FinanceManualBalances items={balances} />
      </section>

      {/* Import */}
      <section className="card fin-block">
        <div className="card-head">
          <div className="sect"><span className="no">D</span><span className="ttl">Importér</span></div>
          <span className="tag">Månedlig opdatering</span>
        </div>
        <FinanceUpload />
      </section>

      {/* Posteringer */}
      <section className="card fin-block">
        <div className="card-head">
          <div className="sect"><span className="no">E</span><span className="ttl">Posteringer</span></div>
          <span className="tag num">{unclassified > 0 ? `${unclassified} ukategoriseret` : 'seneste 80'}</span>
        </div>
        <FinanceTransactions items={txs} />
      </section>

      <p className="board-foot">
        <Link href="/">← Tilbage til I dag</Link>
      </p>
    </>
  )
}
