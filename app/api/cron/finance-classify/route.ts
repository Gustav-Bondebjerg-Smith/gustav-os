// Cron: dræn finans-klassificeringskøen i bundne portioner (Modul 4). Efter en
// månedlig upload på /finans har de nye posteringer category=null; denne cron
// kategoriserer dem i baggrunden (lærte regler først, så AI med konfidens), så
// importen er selvbetjent uden serverless-timeout. Kaldes hvert kvarter af
// Supabase pg_cron (samme mønster som /api/cron/actions, migration 0014).
import { validateCronRequest, withCronLock } from '@/lib/cron'
import { runFinanceClassifyBatch } from '@/lib/finance-classify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request)
  if (unauthorized) return unauthorized

  try {
    const locked = await withCronLock('finance-classify', 4 * 60, () => runFinanceClassifyBatch())
    if (!locked.locked) {
      return Response.json({ ok: true, locked: true, reason: 'already_running' })
    }
    return Response.json({ ok: true, ...locked.result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cron finance-classify fejl:', error)
    return Response.json({ ok: false, error }, { status: 500 })
  }
}
