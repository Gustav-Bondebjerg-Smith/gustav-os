// Verificér finans-læselaget mod prod-DB'en efter import.
// Kør:  node --conditions=react-server --import tsx scripts/finance-verify.ts
import './load-env.mjs'
import { getNetWorth, getSinSummary, listTransactions, listReviewQueue } from '../lib/finance'
import { getSupabase } from '../lib/supabase'

const HEAD = { count: 'exact' as const, head: true }

async function main() {
  const sb = getSupabase()

  const { count: txAll } = await sb.from('transactions').select('*', HEAD)
  const { count: rcAll } = await sb.from('storebox_receipts').select('*', HEAD)
  const { count: rcMatched } = await sb
    .from('storebox_receipts')
    .select('*', HEAD)
    .not('matched_transaction_id', 'is', null)
  const { count: lines } = await sb.from('transaction_lines').select('*', HEAD)
  const { count: mb } = await sb.from('manual_balances').select('*', HEAD)
  const { count: review } = await sb.from('transactions').select('*', HEAD).eq('status', 'needs_review')
  const { count: unclassified } = await sb.from('transactions').select('*', HEAD).is('category', null)

  console.log('--- rækketal ---')
  console.log('transactions:', txAll ?? 0)
  console.log('storebox_receipts:', rcAll ?? 0, '(matchede:', rcMatched ?? 0, ')')
  console.log('transaction_lines:', lines ?? 0)
  console.log('manual_balances:', mb ?? 0)
  console.log('needs_review:', review ?? 0)
  console.log('uklassificeret (category null):', unclassified ?? 0)

  console.log('\n--- nettoformue ---')
  console.log(await getNetWorth())

  console.log('\n--- syndeudgifter denne måned ---')
  console.log(await getSinSummary())

  console.log('\n--- seneste 3 transaktioner ---')
  for (const t of await listTransactions({ limit: 3 })) {
    console.log(`  ${t.booked_date}  ${t.amount.toFixed(2)} kr  ${t.category ?? '?'}  ${t.text_raw.slice(0, 28)}`)
  }

  console.log('\nReview-kø:', (await listReviewQueue()).length)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
