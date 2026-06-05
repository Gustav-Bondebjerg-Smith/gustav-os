'use client'

// Tilfoej/slet brugerdefinerede finans-kategorier. De faste 10 kan ikke slettes
// (data + AI-klassificering peger paa dem). En tilfoejet kategori dukker op i ALLE
// kategori-menuer (gennemgang + posteringer + varelinjer) og fodres ind i AI-prompten.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import type { CategoryDef } from '@/lib/finance-shared'
import { addCategoryAction, deleteCategoryAction } from '@/app/finans/actions'

export function FinanceCategories({ items }: { items: CategoryDef[] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function add() {
    const label = name.trim()
    if (!label || busy) return
    setBusy(true)
    setNote(null)
    const res = await addCategoryAction(label)
    setBusy(false)
    setNote(res.message ?? null)
    if (res.ok) {
      setName('')
      router.refresh()
    }
  }

  async function remove(c: CategoryDef) {
    if (busy) return
    setBusy(true)
    setNote(null)
    const res = await deleteCategoryAction(c.key)
    setBusy(false)
    if (res.message) setNote(res.message)
    if (res.ok) router.refresh()
  }

  const customCount = items.filter((c) => !c.builtin).length

  return (
    <div className="fcat">
      <div className="fcat-add">
        <input
          className="fcat-input"
          type="text"
          placeholder="Ny kategori (fx Gaver, Børn)…"
          value={name}
          maxLength={30}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          aria-label="Ny kategori"
        />
        <button type="button" className="fcat-btn" onClick={add} disabled={busy || !name.trim()}>
          Tilføj
        </button>
        {note && <span className="fcat-note">{note}</span>}
      </div>

      <div className="fcat-list">
        {items.map((c) => (
          <span className={`fcat-chip ${c.builtin ? 'builtin' : 'custom'}`} key={c.key}>
            {c.label}
            {!c.builtin && (
              <button
                type="button"
                className="fcat-x"
                onClick={() => remove(c)}
                disabled={busy}
                aria-label={`Slet ${c.label}`}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
      </div>

      <p className="fcat-hint">
        {customCount === 0
          ? 'De faste kan ikke slettes. Tilføj dine egne ovenfor - de dukker op i alle kategori-menuer og bruges også af AI-klassificeringen.'
          : `${customCount} egen${customCount === 1 ? '' : 'e'} ud over de faste. Faste kan ikke slettes; sletter du en egen, beholder gamle posteringer værdien til du retter dem.`}
      </p>
    </div>
  )
}
