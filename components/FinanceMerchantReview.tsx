'use client'

// "Gennemgå pr. forretning" på /finans (Modul 4). Folder ALLE posteringer sammen
// pr. forretning (merchantToken) til én række, sorteret efter vægt. Gustav retter
// kategori + sin og trykker Færdig -> setMerchantCategoryAction sætter HELE
// forretningen til manuel (kaskaderer + markerer den gennemgået, så den forsvinder
// fra listen). Hver række kan foldes ud til sine posteringer + varelinjer (genbruger
// FinanceTransactions), så fx cola under Netto kan tagges som sodavand individuelt.
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, ChevronDown } from 'lucide-react'
import {
  type Category,
  type SinTag,
  type ProductGroup,
  type MerchantGroup,
  type CategoryDef,
  type SinDef,
} from '@/lib/finance-shared'
import { setMerchantCategoryAction, getMerchantLineGroupsAction } from '@/app/finans/actions'
import { FinanceMerchantLines } from './FinanceMerchantLines'

function kr(n: number): string {
  return Math.round(n).toLocaleString('da-DK') + ' kr'
}

type RowState = { category: Category | ''; sin: SinTag | ''; saving: boolean; note: string | null }

export function FinanceMerchantReview({
  items,
  categories,
  sins,
}: {
  items: MerchantGroup[]
  categories: CategoryDef[]
  sins: SinDef[]
}) {
  const router = useRouter()
  const sinLabel = new Map(sins.map((s) => [s.key, s.label]))
  const [query, setQuery] = useState('')
  const [showReviewed, setShowReviewed] = useState(false)
  const [state, setState] = useState<Record<string, RowState>>({})
  const [openToken, setOpenToken] = useState<string | null>(null)
  const [linesByToken, setLinesByToken] = useState<Record<string, ProductGroup[] | 'loading'>>({})

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

  async function toggleExpand(token: string) {
    if (openToken === token) {
      setOpenToken(null)
      return
    }
    setOpenToken(token)
    if (!linesByToken[token]) {
      setLinesByToken((p) => ({ ...p, [token]: 'loading' }))
      const groups = await getMerchantLineGroupsAction(token)
      setLinesByToken((p) => ({ ...p, [token]: groups }))
    }
  }

  async function save(g: MerchantGroup) {
    const r = rowFor(g)
    if (!r.category) {
      patch(g.token, { note: 'Vælg en kategori først.' })
      return
    }
    patch(g.token, { saving: true, note: null })
    const res = await setMerchantCategoryAction(g.token, r.category, r.sin || null)
    patch(g.token, { saving: false, note: res.message ?? (res.ok ? 'Færdig.' : 'Kunne ikke gemme.') })
    if (res.ok) router.refresh()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((g) => {
      if (!showReviewed && g.reviewed) return false
      if (!q) return true
      return (
        g.label.toLowerCase().includes(q) ||
        g.token.includes(q) ||
        g.examples.some((e) => e.toLowerCase().includes(q))
      )
    })
  }, [items, query, showReviewed])

  if (items.length === 0) return <p className="empty">Ingen posteringer at gennemgå endnu.</p>

  return (
    <div className="mrev">
      <div className="mrev-bar">
        <input
          className="mrev-search"
          type="search"
          placeholder="Søg forretning (fx hiper, netto)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Søg forretning"
        />
        <label className="mrev-toggle">
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />
          vis færdige
        </label>
      </div>
      <p className="mrev-hint">
        {filtered.length} forretninger · sorteret efter vægt. Fold ud og ret varelinjer (fx cola -&gt;
        sodavand) FØR du trykker Færdig - Færdig sætter kategori/sin for hele forretningen og fjerner
        den fra listen.
      </p>

      <div className="mrev-list">
        {filtered.map((g) => {
          const r = rowFor(g)
          const isOpen = openToken === g.token
          const lineGroups = linesByToken[g.token]
          return (
            <div className={`mrev-row ${isOpen ? 'open' : ''}`} key={g.token}>
              <div className="mrev-top">
                <button
                  type="button"
                  className="tx-exp"
                  onClick={() => toggleExpand(g.token)}
                  aria-label={isOpen ? 'Skjul posteringer' : 'Vis posteringer'}
                >
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <span className="mrev-name">{g.label}</span>
                {g.reviewed && <span className="pill done">færdig</span>}
                {g.mixed && <span className="pill warn">blandet</span>}
                {g.sin && <span className="pill sin">{sinLabel.get(g.sin) ?? g.sin}</span>}
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
                  {categories.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
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
                  {sins.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="mrev-save" onClick={() => save(g)} disabled={r.saving}>
                  {r.saving ? 'Gemmer…' : 'Færdig'}
                </button>
                {r.note && <span className="mrev-note">{r.note}</span>}
              </div>

              {isOpen && (
                <div className="mrev-drill">
                  {lineGroups === 'loading' || lineGroups === undefined ? (
                    <p className="empty">Henter varer…</p>
                  ) : (
                    <FinanceMerchantLines items={lineGroups} categories={categories} sins={sins} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
