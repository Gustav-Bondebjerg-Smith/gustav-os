// Nettoformue-kurve som ren inline-SVG (ingen charting-dependency). To tilstande:
// compact = lille sparkline til forside-kortet; fuld = med dato- + beløbsakse til
// /finans. Server-komponent (ren funktion). preserveAspectRatio="none" + et fast
// viewBox lader CSS strække bredden; non-scaling-stroke holder linjen skarp.
import type { NetWorthPoint } from '@/lib/finance-shared'

const fmtKr = (n: number) => Math.round(n).toLocaleString('da-DK')
function dm(d: string): string {
  const [, m, day] = d.split('-')
  return `${Number(day)}/${Number(m)}`
}

export function NetWorthCurve({
  points,
  compact = false,
}: {
  points: NetWorthPoint[]
  compact?: boolean
}) {
  if (points.length < 2) {
    if (compact) return null
    return <p className="empty">Ikke nok historik til en kurve endnu. Den bygges op dag for dag.</p>
  }

  const W = 100
  const H = compact ? 30 : 52
  const padY = compact ? 2 : 4
  const vals = points.map((p) => p.netWorth)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const xAt = (i: number) => (i / (points.length - 1)) * W
  const yAt = (v: number) => H - padY - ((v - min) / span) * (H - padY * 2)

  const line = points.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.netWorth).toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const last = points[points.length - 1]
  // preserveAspectRatio="none" ville strække en <circle> til en ellipse, så vi
  // markerer ikke seneste punkt med en prik. Op/ned styrer kun farven.
  const trendUp = last.netWorth >= points[0].netWorth

  return (
    <div className={`nw-curve${compact ? ' compact' : ''}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={`nwc-svg ${trendUp ? 'up' : 'down'}`}
        role="img"
        aria-label={`Nettoformue-kurve, ${fmtKr(min)} til ${fmtKr(max)} kr`}
      >
        <polygon className="nwc-area" points={area} />
        <polyline className="nwc-line" points={line} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {!compact && (
        <div className="nwc-axis">
          <span>{dm(points[0].date)}</span>
          <span className="nwc-range num">
            {fmtKr(min)} - {fmtKr(max)} kr
          </span>
          <span>{dm(last.date)}</span>
        </div>
      )}
    </div>
  )
}
