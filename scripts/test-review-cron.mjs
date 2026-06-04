// Smoke-test review-cronen MED korrekt Bearer-secret.
// Bruger CRON_SECRET fra .env.local (via load-env), så endpointets auth passerer.
// NB: et succesfuldt kald GENERERER + SENDER reviewet på Telegram (idempotent pr.
// uge, så gentagne kald spammer ikke - de ser ugen findes + er leveret og skipper).
// Kør:  node scripts/test-review-cron.mjs [local|prod]
//   default local (http://localhost:3000)
import './load-env.mjs'

const target = (process.argv[2] || 'local').toLowerCase()
const base = target === 'prod' ? 'https://gustav-os.vercel.app' : 'http://localhost:3000'
const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('Mangler CRON_SECRET i .env.local')
  process.exit(1)
}

console.log(`-> GET ${base}/api/cron/review`)
let res
try {
  res = await fetch(`${base}/api/cron/review`, {
    headers: { Authorization: `Bearer ${secret}` },
  })
} catch (e) {
  console.error(`Kunne ikke nå endpointet på ${base}. Kører dev-serveren? (${e instanceof Error ? e.message : e})`)
  process.exit(1)
}
console.log(`<- HTTP ${res.status}: ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
