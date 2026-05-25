// Lister tilgængelige Claude-modeller på din Anthropic-konto.
// Bruges til at vælge aktuelle modelnavne (gæt ikke - modelnavne ændrer sig).
// Kør: node scripts/list-models.mjs
import './load-env.mjs'

const key = process.env.ANTHROPIC_API_KEY
if (!key) { console.error('Mangler ANTHROPIC_API_KEY i .env.local'); process.exit(1) }

const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
  headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
})
if (!r.ok) { console.error('Fejl:', r.status, await r.text()); process.exit(1) }

const { data } = await r.json()
console.log(`${data.length} model(ler) på din konto:\n`)
for (const m of data) {
  console.log(`- ${m.id}   (${m.display_name || 'uden navn'})`)
}
