'use client'
// Topbar-faner. KLIENT-komponent med vilje: aktiv-fanen beregnes med usePathname(),
// så markeringen følger med ved klik-navigation. Tidligere blev den udregnet
// server-side i root-layoutet ud fra x-pathname, men root-layoutet re-renderer IKKE
// ved soft-navigation i App Routeren, så den lilla aktiv-boks frøs på den side man
// sidst hård-loadede (typisk /finans). usePathname genberegner ved hvert klik.
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const navItems = [
  { href: '/', label: 'I dag' },
  { href: '/opgaver', label: 'Opgaver' },
  { href: '/maal', label: 'Mål' },
  { href: '/finans', label: 'Finans' },
  { href: '/balance', label: 'Balance' },
  { href: '/review', label: 'Review' },
  { href: '/captures', label: 'Captures' },
  { href: '/ask', label: 'Ask' },
]

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function Tabs() {
  const pathname = usePathname()
  return (
    <nav className="tabs">
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`tab ${isActive(pathname, item.href) ? 'active' : ''}`.trim()}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
