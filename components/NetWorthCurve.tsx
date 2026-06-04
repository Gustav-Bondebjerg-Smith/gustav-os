// Nettoformue-graf som ren inline-SVG (ingen charting-dependency). To tilstande:
// compact = mindre graf til forside-kortet; fuld = til /finans. Begge har nu akser:
// y = værdi (kr), x = dato (DD/MM/YYYY). preserveAspectRatio="none" + fast viewBox
// lader CSS strække plottet; non-scaling-stroke holder linje + gridlines skarpe.
// Farve: grøn ved op-trend, rød ved ned (matcher swing-tallene over kurven).
import type { NetWorthPoint } from '@/lib/finance-shared'

const fmtKr = (n: number) => Math.round(n).toLocaleString('da-DK')
// ISO YYYY-MM-DD -> DD/MM/YYYY (felterne er allerede nul-polstrede i ISO-formatet).
function dmy(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
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
  const H = compact ? 34 : 56
  const padY = compact ? 3 : 4
  const vals = points.map((p) => p.netWorth)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const xAt = (i: number) => (i / (points.length - 1)) * W
  const yAt = (v: number) => H - padY - ((v - min) / span) * (H - padY * 2)

  const line = points.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.netWorth).toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const first = points[0]
  const last = points[points.length - 1]
  const trendUp = last.netWorth >= first.netWorth

  // Akse-ticks. Fuld: 3 niveauer + 3 datoer. Compact: 2 + 2, så små kort ikke bliver tætte.
  const yTicks = compact ? [max, min] : [max, (max + min) / 2, min]
  const midIdx = Math.floor((points.length - 1) / 2)
  const xTicks = compact ? [first, last] : [first, points[midIdx], last]
  const krSuffix = compact ? '' : ' kr'

  return (
    <div className={`nw-chart${compact ? ' compact' : ''} ${trendUp ? 'up' : 'down'}`}>
      <div className="nwc-yaxis num">
        {yTicks.map((v, i) => (
          <span key={i}>
            {fmtKr(v)}
            {krSuffix}
          </span>
        ))}
      </div>
      <svg
        className="nwc-plot"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Nettoformue-graf, ${fmtKr(min)} til ${fmtKr(max)} kr`}
      >
        {yTicks.map((v, i) => (
          <line
            key={i}
            className="nwc-grid"
            x1="0"
            y1={yAt(v).toFixed(2)}
            x2={W}
            y2={yAt(v).toFixed(2)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <polygon className="nwc-area" points={area} />
        <polyline className="nwc-line" points={line} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="nwc-xaxis num">
        {xTicks.map((p, i) => (
          <span key={i}>{dmy(p.date)}</span>
        ))}
      </div>
    </div>
  )
}
