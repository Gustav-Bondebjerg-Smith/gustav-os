// Vagthund-cron. Schedulet dagligt via Supabase pg_cron (migration 0019,
// 05:30 UTC) - IKKE i vercel.json, så Hobby-cron-listen ikke vokser.
// validateCronRequest gater på Bearer CRON_SECRET; withCronLock forhindrer
// overlap og skriver samtidig health-jobbets egen puls. Selve checkene
// (bankdata-friskhed, kategoriseringskø, cron-puls) ligger i lib/health.ts.
import { validateCronRequest, withCronLock } from '@/lib/cron'
import { runHealthCheck } from '@/lib/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request)
  if (unauthorized) return unauthorized

  try {
    const locked = await withCronLock('health', 4 * 60, () => runHealthCheck())
    if (!locked.locked) {
      return Response.json({ ok: true, locked: true, reason: 'already_running' })
    }
    // HealthResult har sit eget ok-felt (ok = ingen flag), så det returneres direkte.
    return Response.json(locked.result)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cron health fejl:', error)
    return Response.json({ ok: false, error }, { status: 500 })
  }
}
