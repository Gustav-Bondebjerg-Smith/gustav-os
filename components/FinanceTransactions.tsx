'use client'

// Transaktionsliste på /finans (Modul 4). Render fra props. Hver postering viser
// kategori (redigerbar -> retter AI-fejl), evt. sin-badge, og kan foldes ud for
// varelinjer hvis en Storebox-kvittering er hægtet på (lazy-load).
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, ChevronDown, Receipt } from 'lucide-react'
import {
  CATEGORIES,
  CATEGORY_LABEL,
  SIN_LABEL,
  isCategory,
  type Transaction,
  type TransactionLine,
} from '@/lib/finance-shared'
import { getLinesAction, setCategoryAction } from '@/app/finans/actions'

function kr(n: number): string {
  const v = Math.round(n * 100) / 100
  return v.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr'
}
function dayLabel(ymd: string): string {
  // YYYY-MM-DD -> DD/MM
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}` : ymd
}

export function FinanceTransactions({ items }: { items: Transaction[] }) {
  const router = useRouter()
  const [openId, setOpenId] = useState<string | null>(null)
  const [linesById, setLinesById] = useState<Record<string, TransactionLine[] | 'loading'>>({})

  async function toggle(t: Transaction) {
    if (openId === t.id) {
      setOpenId(null)
      return
    }
    setOpenId(t.id)
    if (t.storebox_receipt_id && !linesById[t.id]) {
      setLinesById((p) => ({ ...p, [t.id]: 'loading' }))
      const lines = await getLinesAction(t.id)
      setLinesById((p) => ({ ...p, [t.id]: lines }))
    }
  }

  async function changeCategory(t: Transaction, category: string) {
    if (!isCategory(category)) return
    await setCategoryAction(t.id, category, t.sin_tag)
    router.refresh()
  }

  if (items.length === 0) return <p className="empty">Ingen posteringer endnu.</p>

  return (
    <div className="txl">
      {items.map((t) => {
        const hasReceipt = !!t.storebox_receipt_id
        const isOpen = openId === t.id
        const lines = linesById[t.id]
        return (
          <div className={`tx ${isOpen ? 'open' : ''}`} key={t.id}>
            <div className="tx-main">
              <button
                type="button"
                className="tx-exp"
                onClick={() => toggle(t)}
                disabled={!hasReceipt}
                aria-label={hasReceipt ? 'Vis varelinjer' : 'Ingen kvittering'}
              >
                {hasReceipt ? (
                  isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />
                ) : (
                  <span className="tx-dot" />
                )}
              </button>
              <span className="tx-date num">{dayLabel(t.booked_date)}</span>
              <span className="tx-text">
                {t.text_raw || t.detail || '(uden tekst)'}
                {hasReceipt && <Receipt size={12} className="tx-recpt" aria-label="Kvittering" />}
              </span>
              <div className="tx-tags">
                {t.sin_tag && <span className="pill sin">{SIN_LABEL[t.sin_tag]}</span>}
              </div>
              <select
                className="tx-cat"
                value={t.category ?? ''}
                onChange={(e) => changeCategory(t, e.target.value)}
                aria-label="Kategori"
              >
                <option value="" disabled>
                  (ukategoriseret)
                </option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              <span className={`tx-amt num ${t.amount < 0 ? 'neg' : 'pos'}`}>
                {t.amount > 0 ? '+' : ''}
                {kr(t.amount)}
              </span>
            </div>

            {isOpen && hasReceipt && (
              <div className="tx-lines">
                {lines === 'loading' || lines === undefined ? (
                  <p className="empty">Henter varelinjer…</p>
                ) : lines.length === 0 ? (
                  <p className="empty">Ingen varelinjer.</p>
                ) : (
                  lines.map((l) => (
                    <div className="txln" key={l.id}>
                      <span className="txln-name">{l.text}</span>
                      {l.sin_tag && <span className="pill sin sm">{SIN_LABEL[l.sin_tag]}</span>}
                      <span className="txln-amt num">{kr(l.amount)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
