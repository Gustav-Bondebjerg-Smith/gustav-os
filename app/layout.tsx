import type { Metadata } from 'next'
import { IBM_Plex_Sans, IBM_Plex_Mono, Newsreader } from 'next/font/google'
import Link from 'next/link'
import { headers } from 'next/headers'
import { Clock } from '@/components/Clock'
import { Tabs } from '@/components/Tabs'
import './globals.css'

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
})
const newsreader = Newsreader({
  variable: '--font-newsreader',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  title: 'gustav/os',
  description: 'Personligt AI operating system',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // proxy.ts sætter x-pathname. Skjul topbar på login/auth.
  const h = await headers()
  const pathname = h.get('x-pathname') || ''
  const isLogin = pathname.startsWith('/login') || pathname.startsWith('/auth')

  return (
    <html
      lang="da"
      className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable} dark`}
    >
      <body>
        {!isLogin && (
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="dot" />gustav<span className="slash">/</span>os
            </Link>
            <Tabs />
            <Clock />
            <form action="/auth/signout" method="post">
              <button type="submit" className="logout">Log ud</button>
            </form>
          </header>
        )}
        <main className="wrap">{children}</main>
      </body>
    </html>
  )
}
