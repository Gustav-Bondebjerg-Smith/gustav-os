// Mål-fanen (Modul 3). Server-component henter alle mål via service_role og giver
// dem til board-klienten. Auth-gating sker i proxy/middleware; mutationer auth-
// gater desuden selv i actions.ts.
import { listGoals, type Goal } from '@/lib/goals'
import { GoalsBoard } from '@/components/GoalsBoard'

export const dynamic = 'force-dynamic'

export default async function MaalPage() {
  let goals: Goal[] = []
  let loadError: string | null = null
  try {
    goals = await listGoals()
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }
  return <GoalsBoard initialGoals={goals} loadError={loadError} />
}
