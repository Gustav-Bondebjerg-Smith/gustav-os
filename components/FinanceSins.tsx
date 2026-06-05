'use client'

// Tilfoej/slet brugerdefinerede synder (sin_tags). De faste 6 kan ikke slettes
// (data + AI-klassificering peger paa dem). En tilfoejet synd dukker op i ALLE
// sin-menuer (gennemgang + posteringer + varelinjer) og fodres ind i AI-prompten,
// saa Haiku ogsaa kan auto-tagge den. Spejler FinanceCategories - genbruger .fcat*.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import type { SinDef } from '@/lib/finance-shared'
import { addSinAction, deleteSinAction } from '@/app/finans/actions'

export function FinanceSins({ items }: { items: SinDef[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function add() {
    const label = name.trim()
    if (!label || busy) return
    setBusy(true)
    setNote(null)
    const res = await addSinAction(label)
    setBusy(false)
    setNote(res.message ?? null)
    if (res.ok) {
      setName('')
      router.refresh()
    }
  }

  async function remove(s: SinDef) {
    if (busy) return
    setBusy(true)
    setNote(null)
    const res = await deleteSinAction(s.key)
    setBusy(false)
    if (res.message) setNote(res.message)
    if (res.ok) router.refresh()
  }

  const customCount = items.filter((s) => !s.builtin).length

  return (
    <div className="fcat">
      <div className="fcat-add">
        <input
          className="fcat-input"
          type="text"
          placeholder="Ny synd (fx Tobak, Slik)…"
          value={name}
          maxLength={30}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          aria-label="Ny synd"
        />
        <button type="button" className="fcat-btn" onClick={add} disabled={busy || !name.trim()}>
          Tilføj
        </button>
        {note && <span className="fcat-note">{note}</span>}
      </div>

      <div className="fcat-list">
        {items.map((s) => (
          <span className={`fcat-chip ${s.builtin ? 'builtin' : 'custom'}`} key={s.key}>
            {s.label}
            {!s.builtin && (
              <button
                type="button"
                className="fcat-x"
                onClick={() => remove(s)}
                disabled={busy}
                aria-label={`Slet ${s.label}`}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
      </div>

      <p className="fcat-hint">
        {customCount === 0
          ? 'De faste kan ikke slettes. Tilføj dine egne ovenfor - de dukker op i alle sin-menuer og bruges også af AI-klassificeringen.'
          : `${customCount} egen${customCount === 1 ? '' : 'e'} ud over de faste. Faste kan ikke slettes; sletter du en egen, beholder gamle posteringer værdien til du retter dem.`}
      </p>
    </div>
  )
}
