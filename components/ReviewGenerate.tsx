// Klient-knap der trigger en manuel review-generering (force) og refresher siden.
// Mønster som de øvrige finans/mål-klienter: useTransition + router.refresh.
'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { generateReviewAction } from '@/app/review/actions'

export function ReviewGenerate({ hasLatest }: { hasLatest: boolean }) {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const router = useRouter()

  function run() {
    setMsg(null)
    startTransition(async () => {
      const r = await generateReviewAction()
      setMsg(r.message ?? (r.ok ? 'Færdig.' : 'Noget gik galt.'))
      if (r.ok) router.refresh()
    })
  }

  return (
    <div className="review-gen">
      <button className="review-gen-btn" onClick={run} disabled={pending}>
        {pending ? 'Genererer...' : hasLatest ? 'Generér igen' : 'Generér nu'}
      </button>
      {msg && <span className="review-gen-msg">{msg}</span>}
    </div>
  )
}
