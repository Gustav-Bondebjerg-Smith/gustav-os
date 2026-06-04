// Bulk-klassificering af finans mod prod-DB'en via lib/finance-classify.ts.
// Kør:  node --conditions=react-server --import tsx scripts/finance-classify.ts
//   (load-env overskriver shellens tomme ANTHROPIC_API_KEY med .env.local's)
// Idempotent: behandler kun rækker der mangler kategori.
import './load-env.mjs'
import {
  markMatchedTransactionsGrocery,
  classifyReceiptLines,
  classifyUnmatchedTransactions,
} from '../lib/finance-classify'

async function main() {
  console.log('1/3 Markerer matchede transaktioner som dagligvarer...')
  const g = await markMatchedTransactionsGrocery()
  console.log(`    ${g} sat til dagligvarer`)

  console.log('2/3 Klassificerer varelinjer (sin-detektion: øl/sodavand/snacks)...')
  const lines = await classifyReceiptLines({ concurrency: 6 })
  console.log(`    ${lines} varelinjer klassificeret`)

  console.log('3/3 Klassificerer umatchede transaktioner (forretnings-niveau)...')
  const tx = await classifyUnmatchedTransactions({ batchSize: 10, concurrency: 6 })
  console.log(`    ${tx} transaktioner klassificeret`)

  console.log('\nFærdig.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
