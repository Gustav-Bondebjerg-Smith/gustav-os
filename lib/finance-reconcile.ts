// Reconciliation (Modul 4): match hver Storebox-kvittering til den tilsvarende
// bank-postering, så varelinjerne kan hægtes på den kanoniske transaktion.
// Regler: beløb eksakt (|tx| == kvitteringstotal), dato inden for vindue,
// forretning fuzzy. 1:1 - en bank-postering kan kun matche én kvittering.
// Ren funktion, ingen I/O.
import type { ParsedBankTx, ParsedReceipt } from './finance-shared'

const DAY_MS = 86_400_000
const DATE_WINDOW_DAYS = 3 // kort-afregning kan slæbe et par dage efter selve købet
const AMOUNT_EPS = 0.011 // øre-tolerance på beløbs-match

// Normalisér til sammenligning: lowercase, fjern diakritik, kun [a-z0-9 ], kollaps.
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining diakritiske tegn
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / DAY_MS)
}

// Hvor godt matcher kvitteringens forretning bank-posteringens tekst?
function merchantScore(receipt: ParsedReceipt, tx: ParsedBankTx): number {
  const hay = norm(`${tx.textRaw} ${tx.detail} ${tx.counterparty}`)
  const name = norm(receipt.merchantName)
  if (!name) return 0
  let score = 0
  if (hay.includes(name)) score += 3 // hele navnet som substring = stærkt
  for (const t of name.split(' ').filter((t) => t.length >= 3)) {
    if (hay.includes(t)) score += 1 // token-overlap (fx "rema", "1000")
  }
  const city = norm(receipt.merchantCity || '')
  if (city && hay.includes(city)) score += 1 // by bekræfter
  return score
}

export type ReceiptMatch = {
  receipt: ParsedReceipt
  tx: ParsedBankTx | null
  txIndex: number // indeks i bankTxs, eller -1
  score: number
  dateDiffDays: number
  ambiguous: boolean // flere lige gode kandidater (samme score+dato) - bør reviewes
}

export type ReconcileResult = {
  matches: ReceiptMatch[]
  matchedCount: number
  unmatchedCount: number
  ambiguousCount: number
}

export function reconcile(bankTxs: ParsedBankTx[], receipts: ParsedReceipt[]): ReconcileResult {
  const usedTx = new Set<number>()
  const matches: ReceiptMatch[] = receipts.map((receipt) => ({
    receipt,
    tx: null,
    txIndex: -1,
    score: 0,
    dateDiffDays: Infinity,
    ambiguous: false,
  }))

  // Bank-udgifter med samme beløb i datovinduet, endnu ubrugte.
  const candidatesFor = (receipt: ParsedReceipt): number[] => {
    const out: number[] = []
    for (let i = 0; i < bankTxs.length; i++) {
      if (usedTx.has(i)) continue
      const tx = bankTxs[i]
      if (tx.amount >= 0) continue // kun udgifter
      if (Math.abs(Math.abs(tx.amount) - receipt.total) > AMOUNT_EPS) continue
      if (daysBetween(tx.bookedDate, receipt.bookedDate) > DATE_WINDOW_DAYS) continue
      out.push(i)
    }
    return out
  }

  // Bedste kandidat: højest forretnings-score, derefter nærmeste dato.
  const pickBest = (receipt: ParsedReceipt, cand: number[]) => {
    const scored = cand.map((i) => ({
      i,
      s: merchantScore(receipt, bankTxs[i]),
      dd: daysBetween(bankTxs[i].bookedDate, receipt.bookedDate),
    }))
    scored.sort((a, b) => b.s - a.s || a.dd - b.dd)
    const top = scored[0]
    const ambiguous = scored.length > 1 && scored[1].s === top.s && scored[1].dd === top.dd
    return { best: top.i, bestScore: top.s, bestDate: top.dd, ambiguous }
  }

  // To runder: runde 0 tager kun sikre matches (entydig kandidat eller klar
  // forretnings-vinder), så en svag match ikke "stjæler" en postering en stærkere
  // kvittering passer bedre til. Runde 1 tager resten.
  for (let round = 0; round < 2; round++) {
    for (const m of matches) {
      if (m.tx) continue
      const cand = candidatesFor(m.receipt)
      if (cand.length === 0) continue
      const { best, bestScore, bestDate, ambiguous } = pickBest(m.receipt, cand)
      const confident = cand.length === 1 || bestScore >= 1
      if (round === 0 && !confident) continue
      usedTx.add(best)
      m.tx = bankTxs[best]
      m.txIndex = best
      m.score = bestScore
      m.dateDiffDays = bestDate
      m.ambiguous = ambiguous
    }
  }

  const matchedCount = matches.filter((m) => m.tx).length
  return {
    matches,
    matchedCount,
    unmatchedCount: matches.length - matchedCount,
    ambiguousCount: matches.filter((m) => m.ambiguous).length,
  }
}
