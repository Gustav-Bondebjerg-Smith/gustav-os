'use client'

// "Gennemgå pr. forretning" på /finans (Modul 4). Folder ALLE posteringer sammen
// pr. forretning (merchantToken) til én række, sorteret efter vægt. Gustav retter
// kategori + sin og trykker Gem -> setMerchantCategoryAction kaskaderer til hele
// forretningen (også de "sikre"), så fx Hiper=takeaway rettes på tværs af hele
// historikken i ét klik. Søgefelt til hurtigt at finde en forretning.
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CATEGORIES,
  CATEGORY_LABEL,
  SIN_TAGS,
  SIN_LABEL,
  type Category,
  type SinTag,
  type MerchantGroup,
} from '@/lib/finance-shared'
import { setMerchantCategoryAction } from '@/app/finans/actions'

function kr(n: number): string {
  return Math.round(n).toLocaleString('da-DK') + ' kr'
}

type RowState = { category: Category | ''; sin: SinTag | ''; saving: boolean; note: string | null }

export function FinanceMerchantReview({ items }: { items: MerchantGroup[] }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<Record<string, RowState>>({})

  // Effektiv værdi for en række: lokal override hvis sat, ellers det dominerende
  // fra serveren.
  const defaultRow = (g: MerchantGroup | undefined): RowState => ({
    category: g?.category ?? '',
    sin: g?.sin ?? '',
    saving: false,
    note: null,
  })
  function rowFor(g: MerchantGroup): RowState {
    return state[g.token] ?? defaultRow(g)
  }
  function patch(token: string, p: Partial<RowState>) {
    setState((s) => {
      const base = s[token] ?? defaultRow(items.find((x) => x.token === token))
      return { ...s, [token]: { ...base, ...p } }
    })
  }

  async function save(g: MerchantGroup) {
    const r = rowFor(g)
    if (!r.category) {
      patch(g.token, { note: 'Vælg en kategori først.' })
      return
    }
    patch(g.token, { saving: true, note: null })
    const res = await setMerchantCategoryAction(g.token, r.category, r.sin || null)
    patch(g.token, { saving: false, note: res.message ?? (res.ok ? 'Gemt.' : 'Kunne ikke gemme.') })
    if (res.ok) router.refresh()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (g) =>
        g.label.toLowerCase().includes(q) ||
        g.token.includes(q) ||
        g.examples.some((e) => e.toLowerCase().includes(q)),
    )
  }, [items, query])

  if (items.length === 0) return <p className="empty">Ingen posteringer at gennemgå endnu.</p>

  return (
    <div className="mrev">
      <input
        className="mrev-search"
        type="search"
        placeholder="Søg forretning (fx hiper, netto)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Søg forretning"
      />
      <p className="mrev-hint">
        {filtered.length} forretninger · sorteret efter vægt. Ret kategori/sin og tryk Gem - så rettes
        ALLE posteringer for forretningen, også de allerede klassificerede.
      </p>

      <div className="mrev-list">
        {filtered.map((g) => {
          const r = rowFor(g)
          return (
            <div className="mrev-row" key={g.token}>
              <div className="mrev-top">
                <span className="mrev-name">{g.label}</span>
                {g.mixed && <span className="pill warn">blandet</span>}
                {g.sin && <span className="pill sin">{SIN_LABEL[g.sin]}</span>}
                <span className="mrev-count num">{g.count}×</span>
                <span className={`mrev-amt num ${g.total < 0 ? 'neg' : 'pos'}`}>{kr(g.total)}</span>
              </div>
              <div className="mrev-controls">
                <select
                  className="tx-cat"
                  value={r.category}
                  onChange={(e) => patch(g.token, { category: e.target.value as Category | '', note: null })}
                  aria-label="Kategori"
                >
                  <option value="" disabled>
                    (vælg kategori)
                  </option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <select
                  className="tx-cat"
                  value={r.sin}
                  onChange={(e) => patch(g.token, { sin: e.target.value as SinTag | '', note: null })}
                  aria-label="Sin"
                >
                  <option value="">(ingen sin)</option>
                  {SIN_TAGS.map((s) => (
                    <option key={s} value={s}>
                      {SIN_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button type="button" className="mrev-save" onClick={() => save(g)} disabled={r.saving}>
                  {r.saving ? 'Gemmer…' : 'Gem'}
                </button>
                {r.note && <span className="mrev-note">{r.note}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
