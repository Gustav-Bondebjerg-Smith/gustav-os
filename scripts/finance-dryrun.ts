// DRY-RUN verificering af finans-parserne mod Gustavs RIGTIGE filer - UDEN DB.
// Kør:  node_modules/.bin/tsx scripts/finance-dryrun.ts
//
// Beviser at bank-CSV + Storebox parses korrekt, og at reconciliation matcher
// kvitteringer til bank-posteringer, FØR vi bygger DB-import + UI ovenpå.
// Læser fra den private mappe uden for repoet. Finder filerne uanset navn.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseBankCsv } from '../lib/finance-csv'
import { parseStoreboxReceipts } from '../lib/finance-storebox'
import { reconcile } from '../lib/finance-reconcile'

const DIR = '/Users/gustavbondebjergsmith/Developer/gustav-os-private/finans'

const csvName = readdirSync(DIR).find((f) => f.toLowerCase().endsWith('.csv'))
if (!csvName) throw new Error('Ingen .csv i ' + DIR)
const sbDir = readdirSync(DIR).find((f) => f.startsWith('storebox-'))
if (!sbDir) throw new Error('Ingen storebox-mappe i ' + DIR)
const receiptsName = readdirSync(join(DIR, sbDir)).find(
  (f) => f.startsWith('receipts-') && f.endsWith('.json'),
)
if (!receiptsName) throw new Error('Ingen receipts-*.json i ' + sbDir)

// Bank-CSV er ISO-8859-1; Storebox-JSON er UTF-8.
const csvText = readFileSync(join(DIR, csvName), 'latin1')
const receiptsJson = readFileSync(join(DIR, sbDir, receiptsName), 'utf8')

const txs = parseBankCsv(csvText)
const receipts = parseStoreboxReceipts(receiptsJson)

const txDates = txs.map((t) => t.bookedDate).sort()
const rcDates = receipts.map((r) => r.bookedDate).sort()
console.log(`Bank-CSV (${csvName}): ${txs.length} posteringer  [${txDates[0]} -> ${txDates.at(-1)}]`)
console.log(`Storebox (${receiptsName}): ${receipts.length} kvitteringer  [${rcDates[0]} -> ${rcDates.at(-1)}]`)

// Kun kvitteringer inden for bankens periode (min..max) KAN matche.
const bankMin = txDates[0]
const bankMax = txDates.at(-1)!
const inWindow = receipts.filter((r) => r.bookedDate >= bankMin && r.bookedDate <= bankMax)

const res = reconcile(txs, receipts)
const rateWindow = inWindow.length ? Math.round((res.matchedCount / inWindow.length) * 100) : 0
console.log(`\nRECONCILIATION`)
console.log(`  kvitteringer i bankens periode (kan matche): ${inWindow.length} / ${receipts.length}`)
console.log(`  matchede: ${res.matchedCount}`)
console.log(`  umatchede i alt: ${res.unmatchedCount}  (heraf ${inWindow.length - res.matchedCount} inden for bankens periode)`)
console.log(`  tvetydige: ${res.ambiguousCount}`)
console.log(`  match-rate i bankens periode: ${rateWindow}%`)

console.log(`\n--- 12 eksempel-matches (kvittering <- bank-postering) ---`)
for (const m of res.matches.filter((x) => x.tx).slice(0, 12)) {
  const r = m.receipt
  const t = m.tx!
  console.log(
    `  ${r.bookedDate}  ${r.merchantName.padEnd(8).slice(0, 8)}  ${String(r.total.toFixed(2)).padStart(9)} kr` +
      `  <-  [${t.bookedDate} Δ${m.dateDiffDays}d s${m.score}] ${t.textRaw.slice(0, 34)}`,
  )
}

console.log(`\n--- op til 10 umatchede kvitteringer i bankens periode (hvorfor matcher de ikke?) ---`)
const unmatchedInWindow = res.matches.filter(
  (m) => !m.tx && m.receipt.bookedDate >= bankMin && m.receipt.bookedDate <= bankMax,
)
for (const m of unmatchedInWindow.slice(0, 10)) {
  const r = m.receipt
  console.log(`  ${r.bookedDate}  ${r.merchantName}  ${r.total.toFixed(2)} kr  (${r.lines.length} varelinjer)`)
}
if (unmatchedInWindow.length === 0) console.log('  (ingen - alt i bankens periode matchede)')

// Kerneværdien: varelinje-opdeling ("133 i Netto = grønt + øl").
const sample = res.matches.find((m) => m.tx && m.receipt.lines.length >= 4)
if (sample) {
  console.log(`\n--- eksempel varelinjer: ${sample.receipt.merchantName} ${sample.receipt.bookedDate} (total ${sample.receipt.total.toFixed(2)} kr) ---`)
  for (const l of sample.receipt.lines) {
    console.log(`  ${String(l.amount.toFixed(2)).padStart(9)} kr  ${l.name}`)
  }
}
