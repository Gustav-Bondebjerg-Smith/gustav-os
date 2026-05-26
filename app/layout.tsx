import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Link from 'next/link'
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

// Top-nav layout. Lokal-only i Fase 6 (ingen auth). Auth tilføjes i Fase 7
// sammen med Vercel-deploy.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="da" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
              gustav<span className="text-zinc-400">/os</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm">
              <Link href="/captures" className="hover:underline">Captures</Link>
              <Link href="/actions" className="hover:underline">Actions</Link>
              <Link href="/ask" className="hover:underline">Ask</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  )
}
