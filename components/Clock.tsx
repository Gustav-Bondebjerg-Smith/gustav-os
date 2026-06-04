'use client'

import { useEffect, useState } from 'react'

const DAYS = ['SØNDAG', 'MANDAG', 'TIRSDAG', 'ONSDAG', 'TORSDAG', 'FREDAG', 'LØRDAG']
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAJ', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC']
const p = (n: number) => String(n).padStart(2, '0')

// Topbar-ur. Starter på null (server + første klient-render = "—") for at undgå
// hydration-mismatch, derefter tikker det hvert sekund.
export function Clock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    const t = () => setNow(new Date())
    t()
    const i = setInterval(t, 1000)
    return () => clearInterval(i)
  }, [])
  const date = now ? `${DAYS[now.getDay()]} ${now.getDate()}. ${MON[now.getMonth()]}` : '—'
  const time = now ? `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}` : '—'
  return (
    <div className="clock">
      <span className="date">{date}</span>
      <span className="time">{time}</span>
    </div>
  )
}
