// /auth/signout - POST-only. Kalder supabase.auth.signOut og smider brugeren
// tilbage på /login. GET er bevidst ikke understøttet for at undgå at en
// uskyldig <a href> eller prefetch logger dig ud.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getServerSupabase } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  const sb = await getServerSupabase()
  await sb.auth.signOut()
  const url = new URL(request.url)
  return NextResponse.redirect(new URL('/login', url.origin), { status: 303 })
}
