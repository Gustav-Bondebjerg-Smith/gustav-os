'use client'

// Manuelle balancer på /finans (Modul 4): opsparing, investering, SU-gæld osv.
// Indgår i nettoformuen oven på checking-saldoen. Render fra props; efter en
// mutation kalder vi router.refresh() så server-komponenten henter friske tal.
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import type { ManualBalance } from '@/lib/finance-shared'
import { addManualBalanceAction, deleteManualBalanceAction } from '@/app/finans/actions'

const kr = (n: number) => Math.round(n).toLocaleString('da-DK') + ' kr'

// "12.345,67" / "12345" -> number. Tolerant over for dansk format.
function parseDanish(s: string): number | null {
  const v = Number(s.replace(/\./g, '').replace(',', '.').trim())
  return Number.isFinite(v) ? v : null
}

export function FinanceManualBalances({ items }: { items: ManualBalance[] }) {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'asset' | 'liability'>('asset')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    const amt = parseDanish(amount)
    if (!label.trim() || amt === null || busy) return
    setBusy(true)
    setError(null)
    const res = await addManualBalanceAction(label.trim(), amt, kind)
    setBusy(false)
    if (res.ok) {
      setLabel('')
      setAmount('')
      router.refresh()
    } else {
      setError(res.message ?? 'Kunne ikke gemme.')
    }
  }

  async function remove(id: string) {
    const res = await deleteManualBalanceAction(id)
    if (res.ok) router.refresh()
    else setError(res.message ?? 'Kunne ikke slette.')
  }

  return (
    <div className="mb">
      {items.length === 0 ? (
        <p className="empty">Ingen manuelle balancer. Tilføj opsparing, investering eller gæld nedenfor.</p>
      ) : (
        <div className="mb-list">
          {items.map((b) => (
            <div className="mb-row" key={b.id}>
              <span className={`mb-kind ${b.kind}`}>{b.kind === 'asset' ? 'Aktiv' : 'Gæld'}</span>
              <span className="mb-label">{b.label}</span>
              <span className={`mb-amt num ${b.kind === 'liability' ? 'neg' : ''}`}>
                {b.kind === 'liability' ? '-' : ''}
                {kr(b.amount)}
              </span>
              <button type="button" className="t-del" onClick={() => remove(b.id)} aria-label="Slet balance">
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="add-row mb-add" onSubmit={add}>
        <Plus aria-hidden="true" />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Navn (fx Opsparing, SU-gæld)"
          aria-label="Navn på balance"
          disabled={busy}
        />
        <input
          className="mb-amt-in num"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Beløb"
          inputMode="decimal"
          aria-label="Beløb"
          disabled={busy}
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value === 'liability' ? 'liability' : 'asset')}
          aria-label="Type"
          disabled={busy}
        >
          <option value="asset">Aktiv</option>
          <option value="liability">Gæld</option>
        </select>
        <button type="submit" className="mb-add-btn" disabled={busy}>
          {busy ? '…' : 'Tilføj'}
        </button>
      </form>

      {error && <p className="ses-cap-msg" style={{ color: 'var(--color-neg)' }}>{error}</p>}
    </div>
  )
}
