// Server action der gemmer en capture fra dashboardet.
// Reglerne fra Telegram-webhooken genbruges via lib/capture.ts: rå
// indhold gemmes FØRST, derefter klassificering + embedding best-effort.
'use server'
import { revalidatePath } from 'next/cache'
import { getServerSupabase } from '@/lib/supabase-server'
import { saveCapture } from '@/lib/capture'
import { URGENCY_LABEL } from '@/lib/tasks-shared'
import type { CreateCaptureState } from './state'

const MAX_LEN = 5000

export async function createCaptureAction(
  _prev: CreateCaptureState,
  formData: FormData,
): Promise<CreateCaptureState> {
  // Auth-guard. Proxy.ts dækker normalt /captures, men server actions er
  // ikke garanteret beskyttet af samme matcher, så vi tjekker selv.
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) {
    return {
      ok: false,
      message: 'Server-konfiguration mangler ALLOWED_EMAIL.',
      area: null,
      type: null,
    }
  }
  const sb = await getServerSupabase()
  const { data } = await sb.auth.getUser()
  const email = data.user?.email?.toLowerCase()
  if (!email || email !== allowed) {
    return { ok: false, message: 'Du er ikke logget ind.', area: null, type: null }
  }

  const raw = String(formData.get('content') ?? '').trim()
  if (!raw) {
    return { ok: false, message: 'Skriv noget før du gemmer.', area: null, type: null }
  }
  if (raw.length > MAX_LEN) {
    return {
      ok: false,
      message: `For lang capture (max ${MAX_LEN} tegn).`,
      area: null,
      type: null,
    }
  }

  try {
    const result = await saveCapture({ content: raw, source: 'dashboard' })
    revalidatePath('/captures')
    revalidatePath('/')
    const note = result.classifyError
      ? 'Gemt rå. Klassificering fejlede, prøv reclassify senere.'
      : result.task
        ? `Gemt som opgave (${URGENCY_LABEL[result.task.urgency]}).`
        : 'Gemt.'
    return {
      ok: true,
      message: note,
      area: result.area,
      type: result.classification?.type || null,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `Kunne ikke gemme: ${msg}`, area: null, type: null }
  }
}
