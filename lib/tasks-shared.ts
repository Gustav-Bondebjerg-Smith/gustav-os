// Klient-sikkert delt lag for opgave-boardet (Modul 2). Indeholder KUN typer +
// konstanter - ingen server-imports - så det kan importeres i både server
// (lib/tasks.ts, app/page.tsx) og klient (components/TaskBoard.tsx).
//
// lib/tasks.ts (`server-only`) re-eksporterer alt herfra, så server-kode kan
// nøjes med ét import-sted (@/lib/tasks). Klient-kode importerer herfra direkte.

export const URGENCIES = ['today', 'week', 'month', 'someday'] as const
export type Urgency = (typeof URGENCIES)[number]

export const URGENCY_LABEL: Record<Urgency, string> = {
  today: 'I dag',
  week: 'Denne uge',
  month: 'Denne måned',
  someday: 'Senere',
}

export type TaskStatus = 'open' | 'done' | 'cancelled'

export type Task = {
  id: string
  title: string
  details: string | null
  due_date: string | null
  status: TaskStatus
  area: string | null
  urgency: Urgency
  key: boolean
  priority_score: number | null
  completed_at: string | null
  tags: string[]
  source_capture_id: string | null
  created_at: string
  updated_at: string
}

export function isUrgency(v: unknown): v is Urgency {
  return typeof v === 'string' && (URGENCIES as readonly string[]).includes(v)
}
