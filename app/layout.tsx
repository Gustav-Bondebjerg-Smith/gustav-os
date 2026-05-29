import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Link from 'next/link'
import { headers } from 'next/headers'
import { getServerSupabase } from '@/lib/supabase-server'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Gustav OS',
  description: 'Personligt AI operating system',
}

// Top-nav layout. Fra Fase 7 er dashboardet auth-gated af proxy.ts.
// Layoutet skjuler nav + log-ud på /login så vi ikke distraherer der.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Tjek pathname via header (proxy.ts sætter x-pathname).
  const h = await headers()
  const pathname = h.get('x-pathname') || ''
  const isLogin = pathname.startsWith('/login') || pathname.startsWith('/auth')

  // Hent bruger til at vise email i nav (kun hvis logget ind).
  let email: string | null = null
  if (!isLogin) {
    try {
      const sb = await getServerSupabase()
      const { data } = await sb.auth.getUser()
      email = data.user?.email ?? null
    } catch {
      // Hvis Supabase er nede eller cookies er korrupte, fortsætter vi uden email.
    }
  }

  return (
    <html lang="da" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        {!isLogin && (
          <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
              <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
                gustav<span className="text-zinc-400">/os</span>
              </Link>
              <nav className="flex items-center gap-6 text-sm">
                <Link href="/" className="hover:underline">I dag</Link>
                <Link href="/balance" className="hover:underline">Balance</Link>
                <Link href="/captures" className="hover:underline">Captures</Link>
                <Link href="/actions" className="hover:underline">Actions</Link>
                <Link href="/ask" className="hover:underline">Ask</Link>
                {email && (
                  <>
                    <span className="text-zinc-400 text-xs hidden sm:inline">{email}</span>
                    <form action="/auth/signout" method="post">
                      <button
                        type="submit"
                        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        Log ud
                      </button>
                    </form>
                  </>
                )}
              </nav>
            </div>
          </header>
        )}
        <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  )
}
