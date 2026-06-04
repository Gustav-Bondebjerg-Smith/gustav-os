// Klient-sikkert delt lag for mål (Modul 3). KUN typer + konstanter, ingen
// server-imports, så det kan bruges af både server (lib/goals.ts, app/page.tsx)
// og klient (components/GoalsBoard.tsx). lib/goals.ts re-eksporterer alt herfra.

export const SCOPES = ['week', 'month'] as const
export type GoalScope = (typeof SCOPES)[number]

export const SCOPE_LABEL: Record<GoalScope, string> = {
  week: 'Denne uge',
  month: 'Denne måned',
}

export type Goal = {
  id: string
  scope: GoalScope
  title: string
  done: boolean
  sort: number
  created_at: string
  updated_at: string
}

export function isScope(v: unknown): v is GoalScope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
}
