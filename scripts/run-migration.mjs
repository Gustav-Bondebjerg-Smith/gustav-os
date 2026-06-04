// Kør en SQL-migration mod Supabase via Management API'et.
// Brug:  node scripts/run-migration.mjs <nummer|filnavn>
//   fx:  node scripts/run-migration.mjs 0011
//
// Hvorfor: der er ingen Supabase CLI i projektet, og service_role/PostgREST kan
// ikke køre DDL. Management API'ets /database/query-endpoint KAN - det kræver et
// personligt access token (sbp_...) som du selv lægger i .env.local. Så slipper
// du (og agenter) for at copy-paste SQL i dashboardets SQL Editor.
//
// Engangsopsætning:
//   1) Lav et token: https://supabase.com/dashboard/account/tokens
//   2) Tilføj i .env.local:  SUPABASE_ACCESS_TOKEN=sbp_xxx
//   3) Kør:  node scripts/run-migration.mjs 0011
import './load-env.mjs'
import { readFileSync, readdirSync } from 'node:fs'

const arg = process.argv[2]
if (!arg) {
  console.error('Brug: node scripts/run-migration.mjs <nummer|filnavn>\n  fx: node scripts/run-migration.mjs 0011')
  process.exit(1)
}

const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  console.error(
    [
      'Mangler SUPABASE_ACCESS_TOKEN i .env.local.',
      '  1) Lav et token: https://supabase.com/dashboard/account/tokens',
      '  2) Tilføj linjen:  SUPABASE_ACCESS_TOKEN=sbp_xxx',
      '  3) Kør igen.',
      '',
      'Alternativt: kør SQL-filen manuelt i Supabase SQL Editor.',
    ].join('\n'),
  )
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const ref = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1]
if (!ref) {
  console.error('Kunne ikke udlede projekt-ref fra NEXT_PUBLIC_SUPABASE_URL:', url || '(tom)')
  process.exit(1)
}

const dir = new URL('../supabase/migrations/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
const match =
  files.find((f) => f === arg || f === `${arg}.sql`) ||
  files.find((f) => f.startsWith(`${arg}_`)) ||
  files.find((f) => f.startsWith(arg))
if (!match) {
  console.error(`Fandt ingen migration der matcher "${arg}". Tilgængelige:\n  ${files.sort().join('\n  ')}`)
  process.exit(1)
}

const sql = readFileSync(new URL(match, dir), 'utf8')
console.log(`Kører ${match} mod projekt ${ref} ...`)

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})

const text = await res.text()
if (!res.ok) {
  console.error(`FEJL (HTTP ${res.status}):\n${text}`)
  process.exit(1)
}
console.log(`OK - ${match} kørt.`)
const trimmed = text.trim()
if (trimmed && trimmed !== '[]') console.log('Svar:', trimmed)
