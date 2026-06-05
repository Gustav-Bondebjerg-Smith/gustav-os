'use client'

// Varerne i en forretnings-udfoldning, foldet sammen pr. vare (productKey). Gustav
// retter kategori/sin EN gang pr. vare -> setProductLineCategoryAction kaskaderer
// GLOBALT (alle butikker, Gustavs valg), saa fx alle "Pepsi Max" bliver sodavand i
// et hug i stedet for kvittering-for-kvittering.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  type Category,
  type SinTag,
  type ProductGroup,
  type CategoryDef,
  type SinDef,
} from '@/lib/finance-shared'
import { setProductLineCategoryAction } from '@/app/finans/actions'

function kr(n: number): string {
  return Math.round(n).toLocaleString('da-DK') + ' kr'
}

type Cur = { category: Category | null; sin: SinTag | null }

export function FinanceMerchantLines({
  items,
  categories,
  sins,
}: {
  items: ProductGroup[]
  categories: CategoryDef[]
  sins: SinDef[]
}) {
  const router = useRouter()
  const [override, setOverride] = useState<Record<string, Cur>>({})
  const [note, setNote] = useState<string | null>(null)

  async function change(p: ProductGroup, next: { category?: string; sin?: string }) {
    const cur = override[p.key] ?? { category: p.category, sin: p.sin }
    const category =
      next.category !== undefined ? (next.category || null) : cur.category
    const sin = next.sin !== undefined ? (next.sin || null) : cur.sin
    setOverride((o) => ({ ...o, [p.key]: { category, sin } }))
    const res = await setProductLineCategoryAction(p.key, category ?? '', sin)
    if (res.message) setNote(res.message)
    router.refresh()
  }

  if (items.length === 0) return <p className="empty">Ingen varelinjer på denne forretning.</p>

  return (
    <div className="mlines">
      <p className="mlines-hint">Ret en vare én gang - det slår igennem på samme vare i ALLE butikker.</p>
      {note && <p className="txl-note">{note}</p>}
      {items.map((p) => {
        const cur = override[p.key] ?? { category: p.category, sin: p.sin }
        // Linjer er gemt omvendt (vare positiv, rabat negativ). Vend om ved visning, saa
        // udgift = roed med minus og rabat = groen uden minus (som forretnings-totalen).
        const disp = -p.total
        return (
          <div className="mline" key={p.key}>
            <span className="mline-name">{p.label}</span>
            {p.mixed && <span className="pill warn">blandet</span>}
            <span className="mline-count num">{p.count}×</span>
            <select
              className="tx-cat"
              value={cur.category ?? ''}
              onChange={(e) => change(p, { category: e.target.value })}
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
              value={cur.sin ?? ''}
              onChange={(e) => change(p, { sin: e.target.value })}
              aria-label="Vare-sin"
            >
              <option value="">(ingen sin)</option>
              {sins.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className={`mline-amt num ${disp < 0 ? 'neg' : 'pos'}`}>{kr(disp)}</span>
          </div>
        )
      })}
    </div>
  )
}
