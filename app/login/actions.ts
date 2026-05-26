// Server action for /login. Tjekker whitelist FØR vi rører Supabase, så
// fremmede emails ikke får sendt et magic link de aldrig kan bruge alligevel.
// (Whitelisten håndhæves også i /auth/callback - belt and suspenders.)
'use server'

import { headers } from 'next/headers'
import { getServerSupabase } from '@/lib/supabase-server'
import type { LoginState } from './state'

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = (formData.get('email')?.toString() || '').trim().toLowerCase()
  if (!email) {
    return { sent: false, email: '', error: 'Skriv en email.' }
  }

  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) {
    return {
      sent: false,
      email,
      error: 'ALLOWED_EMAIL er ikke sat i .env.local. Login er låst indtil det er på plads.',
    }
  }
  if (email !== allowed) {
    // Vi siger "magic link sendt" alligevel for ikke at lække hvem der har adgang.
    // Men der bliver INTET sendt - signInWithOtp kaldes aldrig for andre emails.
    return { sent: true, email, error: null }
  }

  // Find origin så magic link peger tilbage på den rigtige host (localhost
  // i dev, prod-domæne i deploy).
  const h = await headers()
  const host = h.get('x-forwarded-host') || h.get('host') || 'localhost:3000'
  const proto = h.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https')
  const origin = `${proto}://${host}`

  const sb = await getServerSupabase()
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: true,
    },
  })

  if (error) {
    return { sent: false, email, error: `Supabase Auth-fejl: ${error.message}` }
  }
  return { sent: true, email, error: null }
}
