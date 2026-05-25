// Lille env-loader: læser .env.local og OVERSKRIVER process.env.
// Hvorfor: Node's --env-file overskriver IKKE variabler der allerede findes i
// shellen (Claude Code sætter fx en tom ANTHROPIC_API_KEY). Her vinder filen altid.
import { readFileSync } from 'node:fs'

const path = new URL('../.env.local', import.meta.url)
for (const raw of readFileSync(path, 'utf8').split('\n')) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const i = line.indexOf('=')
  if (i === -1) continue
  const key = line.slice(0, i).trim()
  const val = line.slice(i + 1).trim()
  if (val) process.env[key] = val
}
