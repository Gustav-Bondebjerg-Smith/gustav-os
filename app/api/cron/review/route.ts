// Modul 5: ugentlig review-cron. Schedulet søndag aften via vercel.json
// (0 18 * * 0 UTC = 20:00 CPH sommer / 19:00 vinter). validateCronRequest
// gater på Bearer CRON_SECRET; withCronLock forhindrer overlap hvis et kald
// hænger. Selve genereringen + Telegram-leveringen sker i lib/weekly-review.ts.
import { validateCronRequest, withCronLock } from '@/lib/cron'
import { runWeeklyReviewCron } from '@/lib/weekly-review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request)
  if (unauthorized) return unauthorized

  try {
    const locked = await withCronLock('weekly-review', 10 * 60, () => runWeeklyReviewCron())
    if (!locked.locked) {
      return Response.json({ ok: true, locked: true, reason: 'already_running' })
    }
    return Response.json({ ok: true, ...locked.result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cron review fejl:', error)
    return Response.json({ ok: false, error }, { status: 500 })
  }
}
