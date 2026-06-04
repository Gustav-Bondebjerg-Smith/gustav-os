// Bulk-import af bank-CSV + Storebox til prod-DB'en via lib/finance.ts.
// Kører den ÆGTE produktionssti (samme funktioner som upload-UI'et bruger),
// så det også er verificering af hele import + reconciliation end-to-end.
//
// Kør:  node --conditions=react-server --import tsx scripts/finance-import.ts
//   (--conditions=react-server gør 'server-only' til en no-op uden for Next)
//
// Idempotent: kan køres igen efter mere bankdata - kun nye rækker indsættes,
// og umatchede kvitteringer forsøges matchet på ny.
import './load-env.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { importBankCsv, importStoreboxReceipts } from '../lib/finance'

const DIR = '/Users/gustavbondebjergsmith/Developer/gustav-os-private/finans'

async function main() {
  const csvName = readdirSync(DIR).find((f) => f.toLowerCase().endsWith('.csv'))
  if (!csvName) throw new Error('Ingen .csv i ' + DIR)
  const sbDir = readdirSync(DIR).find((f) => f.startsWith('storebox-'))
  if (!sbDir) throw new Error('Ingen storebox-mappe i ' + DIR)
  const receiptsName = readdirSync(join(DIR, sbDir)).find(
    (f) => f.startsWith('receipts-') && f.endsWith('.json'),
  )
  if (!receiptsName) throw new Error('Ingen receipts-*.json i ' + sbDir)

  console.log(`Importerer bank-CSV: ${csvName}`)
  const csvText = readFileSync(join(DIR, csvName), 'latin1')
  const bank = await importBankCsv(csvText, csvName)
  console.log(`  parset ${bank.parsed}, indsat ${bank.inserted} nye (resten fandtes allerede)`)

  console.log(`Importerer Storebox: ${sbDir}/${receiptsName}`)
  const sbJson = readFileSync(join(DIR, sbDir, receiptsName), 'utf8')
  const store = await importStoreboxReceipts(sbJson, receiptsName)
  console.log(`  parset ${store.parsed}, indsat ${store.insertedReceipts} nye kvitteringer`)
  console.log(`  reconciliation: ${store.matched} kvitteringer matchet, ${store.linesInserted} varelinjer hægtet på`)

  console.log('\nFærdig.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
