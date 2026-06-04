// Produktivitets-cron. Schedulet dagligt via vercel.json (0 3 * * * UTC = 04/05 CPH).
// validateCronRequest gater på Bearer CRON_SECRET; withCronLock forhindrer overlap.
// Selve beregningen (tung: getBalance -> Sonnet) + lagring sker i lib/productivity.ts.
import { validateCronRequest, withCronLock } from '@/lib/cron'
import { runProductivityCron } from '@/lib/productivity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request)
  if (unauthorized) return unauthorized

  try {
    const locked = await withCronLock('productivity', 10 * 60, () => runProductivityCron())
    if (!locked.locked) {
      return Response.json({ ok: true, locked: true, reason: 'already_running' })
    }
    return Response.json({ ok: true, ...locked.result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cron productivity fejl:', error)
    return Response.json({ ok: false, error }, { status: 500 })
  }
}
