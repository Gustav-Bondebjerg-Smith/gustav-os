'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Command, Send } from 'lucide-react'
import { createCaptureAction } from '@/app/captures/actions'
import { initialCreateCaptureState } from '@/app/captures/state'

const DAYS = ['SØNDAG', 'MANDAG', 'TIRSDAG', 'ONSDAG', 'TORSDAG', 'FREDAG', 'LØRDAG']
const MONL = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
]
const p = (n: number) => String(n).padStart(2, '0')
const greetFor = (h: number) =>
  h < 10 ? 'God morgen' : h < 13 ? 'God formiddag' : h < 18 ? 'God eftermiddag' : 'God aften'

// #02 Session: levende hilsen + ur, "dagens ene ting" (lokal indtil et rigtigt
// felt findes), og capture-felt der genbruger den eksisterende server action.
export function SessionCard() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    const t = () => setNow(new Date())
    t()
    const i = setInterval(t, 1000)
    return () => clearInterval(i)
  }, [])

  // "Dagens ene ting" holdes uncontrolled (ref + localStorage) så vi slipper for
  // setState i en effect. Renere og ingen ekstra re-render.
  const oneThingRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const v = window.localStorage.getItem('os-one-thing')
    if (v && oneThingRef.current) oneThingRef.current.value = v
  }, [])

  const [state, action, pending] = useActionState(createCaptureAction, initialCreateCaptureState)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state.ok) formRef.current?.reset()
  }, [state])

  const greet = now ? greetFor(now.getHours()) : 'God dag'
  const dateStr = now ? `${DAYS[now.getDay()]}, ${now.getDate()}. ${MONL[now.getMonth()]}` : '—'
  const hh = now ? p(now.getHours()) : '—'
  const mm = now ? p(now.getMinutes()) : '—'
  const ss = now ? p(now.getSeconds()) : '—'

  return (
    <section className="card" id="session">
      <div className="card-head">
        <div className="sect"><span className="no">02</span><span className="ttl">Session</span></div>
        <span className="tag">SDU · UTC+2</span>
      </div>
      <div className="ses-top">
        <div className="ses-head-l">
          <div className="ses-greet">{greet}, <span className="nm">Gustav</span>.</div>
          <div className="ses-date">{dateStr}</div>
        </div>
        <div className="ses-clock">
          <div className="ses-time">{hh}:{mm}<span className="sec">:{ss}</span></div>
          <div className="ses-region">Lokal tid</div>
        </div>
      </div>
      <div className="ses-one">
        <span className="lbl">I dag vil jeg</span>
        <input
          ref={oneThingRef}
          type="text"
          defaultValue=""
          onChange={(e) => window.localStorage.setItem('os-one-thing', e.target.value)}
          placeholder="Sæt dagens ene ting…"
          aria-label="Dagens ene ting"
        />
      </div>
      <form className="ses-capture" action={action} ref={formRef}>
        <Command size={13} className="cmd-ico" aria-hidden="true" />
        <input
          name="content"
          placeholder="Capture en tanke, idé eller note…"
          disabled={pending}
          maxLength={5000}
          aria-label="Capture"
        />
        <button type="submit" className="send" disabled={pending}>
          <Send size={12} aria-hidden="true" /> {pending ? 'Sender…' : 'Capture'}
        </button>
      </form>
      {state.message && (
        <p className="ses-cap-msg" style={{ color: state.ok ? 'var(--color-pos)' : 'var(--color-neg)' }}>
          {state.message}
        </p>
      )}
    </section>
  )
}
