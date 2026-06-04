// Mål (Modul 3). CRUD oven på goals-tabellen (0012). Skriver altid via
// service_role (getSupabase), som resten af lib/. Bevidst minimal: ingen AI,
// ingen auto-nulstilling - mål bliver stående til Gustav fjerner dem.
import 'server-only'
import { getSupabase } from './supabase'
import { isScope, type GoalScope, type Goal } from './goals-shared'

// Re-eksportér det klient-sikre lag, så server-kode kan nøjes med ét import-sted.
export { SCOPES, SCOPE_LABEL, isScope } from './goals-shared'
export type { GoalScope, Goal } from './goals-shared'

const COLS = 'id, scope, title, done, sort, created_at, updated_at'

function nowIso(): string {
  return new Date().toISOString()
}

function rowToGoal(r: Record<string, unknown>): Goal {
  return {
    id: String(r.id),
    scope: isScope(r.scope) ? r.scope : 'week',
    title: String(r.title ?? ''),
    done: Boolean(r.done),
    sort: r.sort == null ? 0 : Number(r.sort),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

// Alle mål, sorteret (sort, derefter ældste først). Siden grupperer selv på scope.
export async function listGoals(): Promise<Goal[]> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('goals')
    .select(COLS)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`listGoals-fejl: ${error.message}`)
  return (data ?? []).map((r) => rowToGoal(r as Record<string, unknown>))
}

export async function addGoal(scope: GoalScope, title: string): Promise<Goal> {
  if (!isScope(scope)) throw new Error(`addGoal: ugyldig scope ${scope}`)
  const t = title.trim()
  if (!t) throw new Error('addGoal: tom titel')
  const sb = getSupabase()
  const { data, error } = await sb
    .from('goals')
    .insert({ scope, title: t })
    .select(COLS)
    .single()
  if (error) throw new Error(`addGoal-fejl: ${error.message}`)
  return rowToGoal(data as Record<string, unknown>)
}

export async function toggleGoal(id: string, done: boolean): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('goals')
    .update({ done, updated_at: nowIso() })
    .eq('id', id)
  if (error) throw new Error(`toggleGoal-fejl: ${error.message}`)
}

export async function removeGoal(id: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.from('goals').delete().eq('id', id)
  if (error) throw new Error(`removeGoal-fejl: ${error.message}`)
}
