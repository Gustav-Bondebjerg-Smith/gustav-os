import { validateCronRequest, withCronLock } from '@/lib/cron'
import { runProactiveBriefing } from '@/lib/proactive'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request)
  if (unauthorized) return unauthorized

  try {
    const locked = await withCronLock('patterns', 10 * 60, () => runProactiveBriefing('patterns'))
    if (!locked.locked) {
      return Response.json({ ok: true, locked: true, reason: 'already_running' })
    }
    return Response.json({ ok: true, ...locked.result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cron patterns fejl:', error)
    return Response.json({ ok: false, error }, { status: 500 })
  }
}
