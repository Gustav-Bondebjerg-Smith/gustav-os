// Generér en ugentlig review mod prod-DB'en via lib/weekly-review.ts.
// Kør:  node --conditions=react-server --import tsx scripts/weekly-review.ts [--store] [--deliver]
//   (load-env overskriver shellens tomme ANTHROPIC_API_KEY med .env.local's)
//
// Default er en DRY-RUN: genererer + printer reviewet uden at skrive til DB
// eller sende Telegram. --store gemmer i weekly_reviews + second brain.
// --deliver sender på Telegram. force=true, så hver kørsel laver et friskt review.
import './load-env.mjs'
import { generateWeeklyReview } from '../lib/weekly-review'

async function main() {
  const args = process.argv.slice(2)
  const store = args.includes('--store')
  const deliver = args.includes('--deliver')

  console.log(`Genererer ugentlig review (store=${store}, deliver=${deliver})...\n`)
  const r = await generateWeeklyReview({ store, deliver, force: true })

  console.log(`Uge: ${r.weekStart} til ${r.weekEnd}  (created=${r.created}, leveret=${r.deliveredTelegram})`)
  console.log('\n--- DATA ---')
  console.log(`Tid: ${r.data.trackedHours.toFixed(1)}t over ${r.data.eventCount} events`)
  if (r.data.time.length) {
    console.log(`  ${r.data.time.map((t) => `${t.category} ${t.hours.toFixed(1)}t`).join(', ')}`)
  }
  console.log(`Opgaver: ${r.data.completed.length} fuldført, ${r.data.openCount} åbne`)
  console.log(
    `Mål: uge ${r.data.goals.week.done}/${r.data.goals.week.total}, måned ${r.data.goals.month.done}/${r.data.goals.month.total}`,
  )
  console.log(`Finans: nettoformue ${r.data.finance.netWorth} kr, ugens Δ ${r.data.finance.weekSwing} kr`)
  if (r.data.finance.sins.length) {
    console.log(`  Synder: ${r.data.finance.sins.map((s) => `${s.label} ${s.amount}`).join(', ')}`)
  }

  console.log('\n--- REVIEW ---\n')
  console.log(r.report)
  if (!store) {
    console.log('\n(dry-run: intet gemt. Brug --store for at gemme, --deliver for Telegram.)')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
