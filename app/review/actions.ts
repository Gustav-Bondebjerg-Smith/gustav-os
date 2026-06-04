// Server action for /review (Modul 5). Auth-gater selv mod ALLOWED_EMAIL (server
// actions er ikke garanteret dækket af proxy-matcheren). Selve genereringen sker
// i lib/weekly-review.ts. Manuel generering leverer IKKE på Telegram (kun den
// schedulerede søndags-cron gør det) for ikke at spamme ved gentryk.
'use server'
import { revalidatePath } from 'next/cache'
import { getServerSupabase } from '@/lib/supabase-server'
import { generateWeeklyReview } from '@/lib/weekly-review'

async function authedEmail(): Promise<string | null> {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) return null
  const sb = await getServerSupabase()
  const { data } = await sb.auth.getUser()
  const email = data.user?.email?.toLowerCase()
  return email && email === allowed ? email : null
}

export async function generateReviewAction(): Promise<{ ok: boolean; message?: string }> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    const r = await generateWeeklyReview({ store: true, deliver: false, force: true })
    revalidatePath('/review')
    revalidatePath('/')
    return { ok: true, message: r.created ? 'Review genereret.' : 'Review opdateret.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
