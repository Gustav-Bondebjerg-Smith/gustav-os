// proxy.ts - Next.js 16 (tidligere middleware.ts; omdøbt i v16).
// Tre opgaver:
// 1) Refresh Supabase-session så cookies er friske før page rendres.
// 2) Gate dashboard-routes mod logget-ind whitelist-email.
// 3) Sætte x-pathname header så layout.tsx kan vise/skjule nav.
//
// VIGTIGT: Server actions kører som POST til samme route - matcher-config
// dækker dem også, men docs advarer om at en refaktor kan smutte. Server
// actions SKAL derfor tjekke auth selv (se app/ask/actions.ts).
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Ruter der ikke kræver login. Alt andet bag proxyen kræver session.
const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Forward pathname til layout via header (Next.js 16 har endnu ikke et
  // native way at læse pathname fra server components).
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', pathname)

  let response = NextResponse.next({ request: { headers: requestHeaders } })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    // Env mangler - lad siden rendre, så fejlen vises der i stedet for at
    // alt redirecter i loop.
    return response
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        // Mønster fra Supabase SSR-guide: skriv til BÅDE request og response.
        // Request-skrivning gør at supabase ser de friske cookies i samme
        // proxy-kald, response-skrivning sender Set-Cookie til browseren.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request: { headers: requestHeaders } })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // getUser() laver round-trip til Auth-serveren og returnerer verificeret
  // bruger. Det er det Supabase docs anbefaler for proxy/middleware.
  const { data: { user } } = await supabase.auth.getUser()

  // Defense in depth: tjek whitelist her også. Hvis et lækket magic link
  // eller en bug skulle slippe igennem callback, fanger vi det her på
  // hver navigation.
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  const userEmail = user?.email?.trim().toLowerCase() ?? null
  const isAuthed = !!user && !!allowed && userEmail === allowed

  if (!isAuthed && !isPublic(pathname)) {
    // Ikke logget ind, prøver at se gated indhold - send til login.
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (isAuthed && pathname === '/login') {
    // Allerede logget ind, sender dem væk fra login-siden.
    return NextResponse.redirect(new URL('/captures', request.url))
  }

  return response
}

// Match alt undtagen statiske assets, image-optimization og favicon.
// /api/* gates ikke her - de skal selv validere (fx Telegram webhook
// med shared secret kommer i led 2).
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
