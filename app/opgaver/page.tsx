// Opgaver-fanen (Modul 2). Server-component henter åbne opgaver via service_role
// og giver dem til board-klienten. Auth-gating sker i proxy/middleware; mutationer
// auth-gater desuden selv i actions.ts.
import { listTasks, type Task } from '@/lib/tasks'
import { TaskBoard } from '@/components/TaskBoard'

export const dynamic = 'force-dynamic'

export default async function OpgaverPage() {
  let tasks: Task[] = []
  let loadError: string | null = null
  try {
    tasks = await listTasks()
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }
  return <TaskBoard initialTasks={tasks} loadError={loadError} />
}
