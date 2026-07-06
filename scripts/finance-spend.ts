// Read-only smoke-test af forbrugs-resuméet (finance_summary-toolet) mod prod-DB.
// Printer præcis det Telegram-svar Gustav ville få, uden at sende noget.
// Kør:  node --conditions=react-server --import tsx scripts/finance-spend.ts
// Eller ét fokus: node --conditions=react-server --import tsx scripts/finance-spend.ts "mad" 3
import './load-env.mjs'
import { getSpendSummary } from '../lib/finance'

async function show(label: string, opts: { focus?: string; months?: number }) {
  const { reply } = await getSpendSummary(opts)
  console.log(`\n=== ${label} ===`)
  console.log(reply)
}

async function main() {
  const focusArg = process.argv[2]
  if (focusArg) {
    const months = Number(process.argv[3]) || undefined
    await show(`focus="${focusArg}"${months ? ` months=${months}` : ''}`, { focus: focusArg, months })
    return
  }
  await show('overblik (ingen focus)', {})
  await show('focus="mad"', { focus: 'mad' })
  await show('focus="mad ude/takeaway/hurtigmad" (rå frase)', { focus: 'mad ude/takeaway/hurtigmad' })
  await show('focus="takeaway" (synd)', { focus: 'takeaway' })
  await show('focus="sodavand" (varelinje-synd)', { focus: 'sodavand' })
  await show('focus="transport" months=2', { focus: 'transport', months: 2 })
  await show('focus="vrøvlefokus" (ukendt -> overblik)', { focus: 'vrøvlefokus' })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
