// Validerer at API-nøglerne i .env.local er til stede, korrekt formede, og virker.
// Kør: node scripts/test-keys.mjs
import './load-env.mjs'
const checks = []
function note(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FEJL'} | ${name.padEnd(18)} | ${detail}`)
}
const ascii = s => [...s].every(c => c.charCodeAt(0) < 128)

const a = process.env.ANTHROPIC_API_KEY || ''
const o = process.env.OPENAI_API_KEY || ''
const t = process.env.TELEGRAM_BOT_TOKEN || ''

// 1) Format-tjek (fanger transskriptionsfejl uden at bruge penge)
note('Anthropic format', a.startsWith('sk-ant-') && ascii(a), `prefix=${a.startsWith('sk-ant-')} ascii=${ascii(a)} len=${a.length}`)
note('OpenAI format', o.startsWith('sk-') && ascii(o), `prefix=${o.startsWith('sk-')} ascii=${ascii(o)} len=${o.length}`)
note('Telegram format', /^\d+:[\w-]+$/.test(t), `format=${/^\d+:[\w-]+$/.test(t)} len=${t.length}`)

// 2) Live-tjek (gratis GET-kald, ingen tokens brugt)
try {
  const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': a, 'anthropic-version': '2023-06-01' } })
  note('Anthropic live', r.ok, `HTTP ${r.status}`)
} catch (e) { note('Anthropic live', false, e.message) }

try {
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${o}` } })
  note('OpenAI live', r.ok, `HTTP ${r.status}`)
} catch (e) { note('OpenAI live', false, e.message) }

try {
  const r = await fetch(`https://api.telegram.org/bot${t}/getMe`)
  const j = await r.json()
  note('Telegram live', j.ok, j.ok ? `bot @${j.result.username}` : JSON.stringify(j))
} catch (e) { note('Telegram live', false, e.message) }

const failed = checks.filter(c => !c.ok)
console.log(failed.length ? `\n${failed.length} tjek fejlede.` : '\nAlle nøgler er gyldige og virker.')
process.exit(failed.length ? 1 : 0)
