// Genopbyg nettoformue-kurven fra bank-saldoens historik + skriv dagens snapshot.
// Kør:  node --conditions=react-server --import tsx scripts/finance-snapshot.ts
//   (load-env giver Supabase service_role-adgang til prod)
// Idempotent (upsert pr. dato) - kan køres når som helst, fx efter en import.
import './load-env.mjs'
import { backfillNetWorthSnapshots, snapshotNetWorth, getNetWorthHistory } from '../lib/finance'

async function main() {
  console.log('Backfiller nettoformue-snapshots fra bank-saldoens historik...')
  const n = await backfillNetWorthSnapshots()
  console.log(`  ${n} daglige snapshots skrevet/opdateret`)

  console.log('Skriver dagens snapshot...')
  await snapshotNetWorth()

  const hist = await getNetWorthHistory(3650)
  console.log(`  Kurve har nu ${hist.length} punkter`)
  if (hist.length) {
    const first = hist[0]
    const last = hist[hist.length - 1]
    console.log(`  Første: ${first.date} = ${Math.round(first.netWorth)} kr`)
    console.log(`  Seneste: ${last.date} = ${Math.round(last.netWorth)} kr`)
  }
  console.log('\nFærdig.')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
