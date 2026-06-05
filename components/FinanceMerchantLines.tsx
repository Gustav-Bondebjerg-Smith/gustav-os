'use client'

// Varerne i en forretnings-udfoldning, foldet sammen pr. vare (productKey). Gustav
// retter kategori/sin EN gang pr. vare -> setProductLineCategoryAction kaskaderer
// GLOBALT (alle butikker, Gustavs valg), saa fx alle "Pepsi Max" bliver sodavand i
// et hug i stedet for kvittering-for-kvittering.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CATEGORIES,
  CATEGORY_LABEL,
  SIN_TAGS,
  SIN_LABEL,
  isCategory,
  isSinTag,
  type Category,
  type SinTag,
  type ProductGroup,
} from '@/lib/finance-shared'
import { setProductLineCategoryAction } from '@/app/finans/actions'

function kr(n: number): string {
  return Math.round(n).toLocaleString('da-DK') + ' kr'
}

type Cur = { category: Category | null; sin: SinTag | null }

export function FinanceMerchantLines({ items }: { items: ProductGroup[] }) {
  const router = useRouter()
  const [override, setOverride] = useState<Record<string, Cur>>({})
  const [note, setNote] = useState<string | null>(null)

  async function change(p: ProductGroup, next: { category?: string; sin?: string }) {
    const cur = override[p.key] ?? { category: p.category, sin: p.sin }
    const category =
      next.category !== undefined ? (isCategory(next.category) ? next.category : null) : cur.category
    const sin = next.sin !== undefined ? (isSinTag(next.sin) ? next.sin : null) : cur.sin
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
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
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
              {SIN_TAGS.map((s) => (
                <option key={s} value={s}>
                  {SIN_LABEL[s]}
                </option>
              ))}
            </select>
            <span className="mline-amt num">{kr(p.total)}</span>
          </div>
        )
      })}
    </div>
  )
}
