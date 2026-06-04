// Parser for Storebox-eksportens receipts-JSON (Modul 4). Eksporten er en MAPPE:
//   receipts-*.json  = array af kvitteringer (det denne parser læser)
//   user-*.json, cards-*.json, attachments/*.pdf = metadata/bilag (ubrugt endnu)
// Storebox sendes som HELE historikken hver gang -> idempotens via receiptId.
// Ren funktion: tager allerede-parset JSON (eller en JSON-streng). Ingen I/O.
import { cleanText, type ParsedReceipt, type ParsedReceiptLine } from './finance-shared'

type RawMoney = { amount?: number | null } | null | undefined
type RawLine = {
  name?: string | null
  count?: number | null
  productNumber?: string | null
  category?: string | null
  totalPrice?: RawMoney
  itemPrice?: RawMoney
}
type RawReceipt = {
  receiptId?: string | null
  purchaseDateTimeString?: string | null
  price?: RawMoney
  merchant?: { name?: string | null; city?: string | null } | null
  receiptLines?: RawLine[] | null
}

function money(m: RawMoney): number {
  const a = m?.amount
  return typeof a === 'number' && Number.isFinite(a) ? a : 0
}

export function parseStoreboxReceipts(input: unknown): ParsedReceipt[] {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (!Array.isArray(raw)) return []
  const out: ParsedReceipt[] = []
  for (const r of raw as RawReceipt[]) {
    if (!r || !r.receiptId) continue
    const iso = (r.purchaseDateTimeString || '').trim()
    const bookedDate = iso.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedDate)) continue
    const lines: ParsedReceiptLine[] = (r.receiptLines || []).map((l) => ({
      name: cleanText(l?.name),
      count: typeof l?.count === 'number' ? l.count : 1,
      amount: money(l?.totalPrice ?? l?.itemPrice),
      productNumber: l?.productNumber ?? null,
      storeboxCategory: l?.category ?? null,
    }))
    out.push({
      receiptId: String(r.receiptId),
      purchaseDate: iso,
      bookedDate,
      merchantName: cleanText(r.merchant?.name),
      merchantCity: cleanText(r.merchant?.city) || null,
      total: money(r.price),
      lines,
    })
  }
  return out
}
