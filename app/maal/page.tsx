// Stub indtil Modul 3 (mål). Holder fanen i nav'en uden 404.
export const dynamic = 'force-dynamic'

export default function MaalPage() {
  return (
    <div>
      <div className="vhead">
        <div className="vh-l"><span className="vh-no">02</span><span className="vh-ttl">Mål</span></div>
        <span className="vh-sub">Bygges i modul 3</span>
      </div>
      <p className="empty">
        Fokus-mål med delmål-checkliste + uge-, måneds- og semester-mål med fremdriftsbjælker.
      </p>
    </div>
  )
}
