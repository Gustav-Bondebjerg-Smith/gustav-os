// Server-side Supabase-klient med anon-key + cookie-handling.
// Bruges fra server components, route handlers og server actions til alt
// der skal være knyttet til den loggede bruger. Token-refresh sker via
// proxy.ts; her i komponenter må setAll fejle stille (Next.js tillader ikke
// at sætte cookies fra server components, og det er fint - proxyen har
// allerede sat dem på vej ind).
//
// Brug getClaims() / getUser() til auth-checks. getSession() validerer ikke
// JWT og må ikke bruges til authorization (se @supabase/ssr README).
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function getServerSupabase(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Mangler NEXT_PUBLIC_SUPABASE_URL eller NEXT_PUBLIC_SUPABASE_ANON_KEY i .env.local'
    )
  }
  const cookieStore = await cookies()
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(toSet) {
        // I server components kan vi ikke skrive cookies. Det er meningen.
        // proxy.ts ejer session-refresh og skriver Set-Cookie. Vi tier
        // her i stedet for at smide en fejl der ville crashe siden.
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // OK i server components, kritisk i route handlers/server actions
          // (men der virker cookieStore.set faktisk, så vi når aldrig hertil).
        }
      },
    },
  })
}
