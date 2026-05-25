// Fase 1 round-trip test: skriv en raw_capture, læs den tilbage, ryd op.
// Kør: node scripts/test-db.mjs
import './load-env.mjs'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error('Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local')
  process.exit(1)
}

// Service role-klient: server-side, bypasser RLS. Brug ALDRIG denne i browseren.
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

console.log('1) Skriver en test-raw_capture...')
const { data: inserted, error: insertErr } = await supabase
  .from('raw_captures')
  .insert({ source: 'dashboard', content: `Test ${new Date().toISOString()}`, area: 'studie' })
  .select()
  .single()

if (insertErr) {
  console.error('   Skrivning fejlede:', insertErr.message)
  if (/schema cache|does not exist|relation/i.test(insertErr.message)) {
    console.error('   -> Tabellen findes ikke. Har du kørt 0001_init.sql i SQL Editor?')
  }
  process.exit(1)
}
console.log('   OK. id =', inserted.id)

console.log('2) Læser rækken tilbage...')
const { data: rows, error: selectErr } = await supabase
  .from('raw_captures')
  .select('id, source, content, area, created_at')
  .eq('id', inserted.id)

if (selectErr) {
  console.error('   Læsning fejlede:', selectErr.message)
  process.exit(1)
}
console.log('   OK. Fandt:', JSON.stringify(rows[0], null, 2))

console.log('3) Rydder op (sletter test-rækken)...')
const { error: delErr } = await supabase.from('raw_captures').delete().eq('id', inserted.id)
console.log(delErr ? `   Oprydning fejlede (ikke kritisk): ${delErr.message}` : '   OK. Slettet.')

console.log('\nFase 1 round-trip virker. Du kan skrive til og læse fra Supabase.')
