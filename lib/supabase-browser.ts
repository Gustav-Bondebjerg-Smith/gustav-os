// Browser-side Supabase-klient med anon-key.
// Bruges fra client components til at fx kalde supabase.auth.signInWithOtp
// så magic link-flowet kan starte. createBrowserClient håndterer
// document.cookie automatisk - vi behøver ikke konfigurere getAll/setAll.
'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

export function getBrowserSupabase(): SupabaseClient {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Mangler NEXT_PUBLIC_SUPABASE_URL eller NEXT_PUBLIC_SUPABASE_ANON_KEY'
    )
  }
  _client = createBrowserClient(url, key)
  return _client
}
