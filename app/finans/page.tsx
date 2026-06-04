// Stub indtil Modul 4 (finans). Holder fanen i nav'en uden 404.
export const dynamic = 'force-dynamic'

export default function FinansPage() {
  return (
    <div>
      <div className="vhead">
        <div className="vh-l"><span className="vh-no">03</span><span className="vh-ttl">Finans</span></div>
        <span className="vh-sub">Bygges i modul 4</span>
      </div>
      <p className="empty">
        Nettoformue med dagligt + månedligt sving, konti, opsparingsmål, posteringer og det røde
        syndeudgift-panel. Drevet af bank-CSV + Storebox med AI-kategorisering.
      </p>
    </div>
  )
}
