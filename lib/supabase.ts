// Server-side Supabase-klient til dashboardet.
// Bruger service_role-nøgle, så vi bypasser RLS. Det er OK fordi dashboardet
// kun køres lokalt i Fase 6. Når vi deployer i Fase 7 tilføjes Supabase Auth
// + en anon-klient + RLS-policies.
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
