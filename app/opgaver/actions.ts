// Server actions for opgave-boardet. Hver action auth-gater selv (server actions
// er ikke garanteret dækket af proxy-matcheren) og revaliderer board + forside.
'use server'
import { revalidatePath } from 'next/cache'
import { getServerSupabase } from '@/lib/supabase-server'
import {
  createTaskFromCapture,
  completeTask,
  reopenTask,
  moveTask,
  deleteTask,
} from '@/lib/tasks'
import { isUrgency, type Urgency } from '@/lib/tasks-shared'
import type { TaskActionResult, AddTaskResult } from './state'

// Returnerer den indloggede e-mail hvis den matcher ALLOWED_EMAIL, ellers null.
async function authedEmail(): Promise<string | null> {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  if (!allowed) return null
  const sb = await getServerSupabase()
  const { data } = await sb.auth.getUser()
  const email = data.user?.email?.toLowerCase()
  return email && email === allowed ? email : null
}

function revalidate(): void {
  revalidatePath('/opgaver')
  revalidatePath('/')
}

// Tilføj fra board-feltet: AI prioriterer (samme flow som auto-fangst, bare uden
// kilde-capture). Returnerer den oprettede opgave så klienten kan vise den straks.
export async function addTaskAction(text: string): Promise<AddTaskResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Du er ikke logget ind.' }
  const clean = (text || '').trim()
  if (!clean) return { ok: false, message: 'Skriv en opgave først.' }
  if (clean.length > 500) return { ok: false, message: 'For lang opgave (max 500 tegn).' }
  try {
    const task = await createTaskFromCapture({ text: clean })
    revalidate()
    return { ok: true, task }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function toggleTaskAction(id: string, done: boolean): Promise<TaskActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    if (done) await completeTask(id)
    else await reopenTask(id)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function moveTaskAction(id: string, urgency: Urgency): Promise<TaskActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  if (!isUrgency(urgency)) return { ok: false, message: 'Ugyldig hastighed.' }
  try {
    await moveTask(id, urgency)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteTaskAction(id: string): Promise<TaskActionResult> {
  if (!(await authedEmail())) return { ok: false, message: 'Ikke logget ind.' }
  try {
    await deleteTask(id)
    revalidate()
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
