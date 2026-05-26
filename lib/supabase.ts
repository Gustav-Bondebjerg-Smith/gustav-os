// Service_role Supabase-klient - bypasser RLS. KUN server-side.
// 'server-only' importen får build til at fejle hvis denne fil ved en
// fejl importeres fra et client component.
//
// Brug-mønster fra Fase 7 og frem:
// - Dashboard-pages bruger getServerSupabase() fra ./supabase-server med
//   anon-key + cookies (gated af proxy.ts der kræver gyldig session).
// - Denne klient bruges kun til interne flows der ikke har en bruger-session:
//   embed-/ask-pipeline der allerede er gated af session andetsteds, samt
//   evt. fremtidige Telegram webhook + cron-jobs.
import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Mangler NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY i .env.local'
    )
  }
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}
