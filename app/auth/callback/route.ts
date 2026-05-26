// /auth/callback - modtager magic link redirect, bytter code for session.
// Whitelister email igen efter exchange (belt and suspenders - hvis nogen
// fucker med ALLOWED_EMAIL midt i et login-flow, fanger vi det her).
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getServerSupabase } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const errorParam = url.searchParams.get('error_description')

  if (errorParam) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorParam)}`, url.origin)
    )
  }
  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin))
  }

  const sb = await getServerSupabase()
  const { error } = await sb.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url.origin)
    )
  }

  // Hent verificeret bruger (getUser kontakter auth-serveren, ikke bare cookies).
  const { data: { user }, error: userError } = await sb.auth.getUser()
  if (userError || !user) {
    return NextResponse.redirect(new URL('/login?error=no_user', url.origin))
  }

  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed || user.email?.trim().toLowerCase() !== allowed) {
    // Fremmed email gennem callback - log dem ud med det samme og afvis.
    await sb.auth.signOut()
    return NextResponse.redirect(new URL('/login?error=forbidden', url.origin))
  }

  return NextResponse.redirect(new URL('/captures', url.origin))
}
