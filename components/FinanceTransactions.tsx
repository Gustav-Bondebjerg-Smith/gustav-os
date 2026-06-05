'use client'

// Transaktionsliste på /finans (Modul 4). Render fra props. Hver postering viser
// kategori (redigerbar -> retter AI-fejl), evt. sin-badge, og kan foldes ud for
// varelinjer hvis en Storebox-kvittering er hægtet på (lazy-load).
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, ChevronDown, Receipt } from 'lucide-react'
import {
  type Transaction,
  type TransactionLine,
  type CategoryDef,
  type SinDef,
} from '@/lib/finance-shared'
import { getLinesAction, setCategoryAction, setLineCategoryAction } from '@/app/finans/actions'

function kr(n: number): string {
  const v = Math.round(n * 100) / 100
  return v.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr'
}
function dayLabel(ymd: string): string {
  // YYYY-MM-DD -> DD/MM
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}` : ymd
}

export function FinanceTransactions({
  items,
  categories,
  sins,
}: {
  items: Transaction[]
  categories: CategoryDef[]
  sins: SinDef[]
}) {
  const router = useRouter()
  const sinLabel = new Map(sins.map((s) => [s.key, s.label]))
  const [openId, setOpenId] = useState<string | null>(null)
  const [linesById, setLinesById] = useState<Record<string, TransactionLine[] | 'loading'>>({})
  const [note, setNote] = useState<string | null>(null)
  // Optimistisk kategori pr. postering: i udfoldningen kommer items fra en lazy
  // klient-hentning der IKKE gen-hentes ved router.refresh, så uden override ville
  // select'en snappe tilbage til den gamle vaerdi.
  const [catOverride, setCatOverride] = useState<Record<string, string>>({})

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
    if (!category) return
    setCatOverride((p) => ({ ...p, [t.id]: category }))
    const res = await setCategoryAction(t.id, category, t.sin_tag)
    if (res.message) setNote(res.message)
    router.refresh()
  }

  // Ret EN varelinje (kategori og/eller sin). Optimistisk patch af linjen + refresh
  // (saa synde-kortet opdateres). Skriver KUN linjen - ingen forretnings-regel.
  async function changeLine(
    txId: string,
    line: TransactionLine,
    next: { category?: string; sin?: string },
  ) {
    const category =
      next.category !== undefined ? (next.category || null) : line.category
    const sin =
      next.sin !== undefined ? (next.sin || null) : line.sin_tag
    setLinesById((p) => {
      const arr = p[txId]
      if (!arr || arr === 'loading') return p
      return {
        ...p,
        [txId]: arr.map((x) => (x.id === line.id ? { ...x, category, sin_tag: sin } : x)),
      }
    })
    await setLineCategoryAction(line.id, category ?? '', sin)
    router.refresh()
  }

  if (items.length === 0) return <p className="empty">Ingen posteringer endnu.</p>

  return (
    <div className="txl">
      {note && <p className="txl-note">{note}</p>}
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
                {t.sin_tag && <span className="pill sin">{sinLabel.get(t.sin_tag) ?? t.sin_tag}</span>}
              </div>
              <select
                className="tx-cat"
                value={catOverride[t.id] ?? t.category ?? ''}
                onChange={(e) => changeCategory(t, e.target.value)}
                aria-label="Kategori"
              >
                <option value="" disabled>
                  (ukategoriseret)
                </option>
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
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
                      <select
                        className="tx-cat"
                        value={l.category ?? ''}
                        onChange={(e) => changeLine(t.id, l, { category: e.target.value })}
                        aria-label="Vare-kategori"
                      >
                        <option value="">(ukat.)</option>
                        {categories.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="tx-cat"
                        value={l.sin_tag ?? ''}
                        onChange={(e) => changeLine(t.id, l, { sin: e.target.value })}
                        aria-label="Vare-sin"
                      >
                        <option value="">(ingen sin)</option>
                        {sins.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <span className={`txln-amt num ${-l.amount < 0 ? 'neg' : 'pos'}`}>{kr(-l.amount)}</span>
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
