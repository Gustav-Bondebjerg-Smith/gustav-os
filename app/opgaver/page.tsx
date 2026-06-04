// Stub indtil Modul 2 (opgave-board). Holder fanen i nav'en uden 404.
export const dynamic = 'force-dynamic'

export default function OpgaverPage() {
  return (
    <div>
      <div className="vhead">
        <div className="vh-l"><span className="vh-no">01</span><span className="vh-ttl">Opgaver</span></div>
        <span className="vh-sub">Bygges i modul 2</span>
      </div>
      <p className="empty">
        Opgave-boardet er på vej: fire bunker (overskredet / i dag / denne uge / senere), filtre,
        og automatisk fangst når du siger til OS&apos;en at du skal nå noget.
      </p>
    </div>
  )
}
