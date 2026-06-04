// Engangs-test: kalder produktivitets-cronen mod den lokale dev-server, så vi ser
// at de to tal beregnes fra rigtige kalender-data (kræver ANTHROPIC + Google i .env.local).
// Kør i to terminaler:
//   env -u ANTHROPIC_API_KEY npm run dev
//   node scripts/test-productivity-cron.mjs
import './load-env.mjs'

async function main() {
  const secret = process.env.CRON_SECRET
  if (!secret) throw new Error('Mangler CRON_SECRET i .env.local')
  const url = process.env.TEST_CRON_URL || 'http://localhost:3000/api/cron/productivity'
  console.log('Kalder', url, '...')
  const r = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
  const text = await r.text()
  console.log('HTTP', r.status)
  console.log(text)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
