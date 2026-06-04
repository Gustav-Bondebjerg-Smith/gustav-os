// Server actions for mål. Hver action auth-gater selv + revaliderer /maal + /.
'use server'
import { revalidatePath } from 'next/cache'
import { getServerSupabase } from '@/lib/supabase-server'
import { addGoal, toggleGoal, removeGoal } from '@/lib/goals'
import { isScope, type GoalScope } from '@/lib/goals-shared'
import type { GoalActionResult, AddGoalResult } from './state'

async function authedEmail(): Promise<string | null> {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) return null
  const sb = await getServerSupabase()
  const { data } = await sb.auth.getUser()
  const email = data.user?.email?.toLowerCase()
  return email && email === allowed ? email : null
}

function revalidate(): void {
  revalidatePath('/maal')
  revalidatePath('/')
}

export async function addGoalAction(scope: GoalScope, title: string): Promise<AddGoalResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Du er ikke logget ind.' }
  if (!isScope(scope)) return { ok: false, message: 'Ugyldig periode.' }
  const clean = (title || '').trim()
  if (!clean) return { ok: false, message: 'Skriv et mål først.' }
  if (clean.length > 200) return { ok: false, message: 'For langt mål (max 200 tegn).' }
  try {
    const goal = await addGoal(scope, clean)
    revalidate()
    return { ok: true, goal }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function toggleGoalAction(id: string, done: boolean): Promise<GoalActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    await toggleGoal(id, done)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function removeGoalAction(id: string): Promise<GoalActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    await removeGoal(id)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
