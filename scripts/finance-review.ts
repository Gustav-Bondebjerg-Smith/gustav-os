// Read-only inspektion af spørge-loopet mod prod-DB'en.
// Kør:  node --conditions=react-server --import tsx scripts/finance-review.ts
import './load-env.mjs'
import { listReviewQueue } from '../lib/finance'
import { loadFinanceRules } from '../lib/finance-classify'
import { merchantToken, CATEGORIES } from '../lib/finance-shared'
import { getSupabase } from '../lib/supabase'

const HEAD = { count: 'exact' as const, head: true }

async function main() {
  const sb = getSupabase()

  console.log('--- kategori-fordeling ---')
  for (const c of CATEGORIES) {
    const { count } = await sb.from('transactions').select('*', HEAD).eq('category', c)
    console.log(`  ${c}: ${count ?? 0}`)
  }
  const { count: nr } = await sb.from('transactions').select('*', HEAD).eq('status', 'needs_review')
  console.log(`  (needs_review: ${nr ?? 0})`)

  const q = await listReviewQueue()
  console.log(`\n--- review-kø: ${q.length} ---`)
  for (const t of q.slice(0, 14)) {
    console.log(`  ${t.booked_date}  ${t.amount.toFixed(2).padStart(9)} kr  [${t.category ?? 'null'}]  token=${merchantToken(t.text_raw)}  ${t.text_raw.slice(0, 28)}`)
  }

  const rules = await loadFinanceRules()
  console.log(`\n--- lærte regler: ${rules.size} ---`)
  for (const [k, v] of rules) console.log(`  ${k} -> ${v.category}${v.sin ? ' / ' + v.sin : ''}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
