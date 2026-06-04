// Opgave-board (Modul 2). CRUD + AI-prioritering oven på tasks-tabellen
// (0001 + 0011). Skriver altid via service_role (getSupabase), som resten af lib/.
//
// Auto-fangst: en capture klassificeret som type="opgave" bliver til en opgave
// med AI-tildelt hastighed + prioritet (createTaskFromCapture). Bruges af både
// web-capture (lib/capture.ts) og Telegram (lib/telegram-webhook.ts).
import 'server-only'
import { getSupabase } from './supabase'
import { isUrgency, type Urgency, type Task, type TaskStatus } from './tasks-shared'

// Re-eksportér det klient-sikre lag, så server-kode kan nøjes med ét import-sted.
export { URGENCIES, URGENCY_LABEL, isUrgency } from './tasks-shared'
export type { Urgency, Task, TaskStatus } from './tasks-shared'

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

const TASK_COLS =
  'id, title, details, due_date, status, area, urgency, key, priority_score, completed_at, tags, source_capture_id, created_at, updated_at'

function requireEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`Mangler ${name} i env`)
  return v
}

function nowIso(): string {
  return new Date().toISOString()
}

// I dag som YYYY-MM-DD i Copenhagen - giver Haiku den rette referencedag.
function todayCphYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

// Rå DB-række -> Task (normaliserer null-felter + urgency-fallback).
function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    details: (r.details as string) ?? null,
    due_date: (r.due_date as string) ?? null,
    status: (r.status as TaskStatus) ?? 'open',
    area: (r.area as string) ?? null,
    urgency: isUrgency(r.urgency) ? r.urgency : 'someday',
    key: Boolean(r.key),
    priority_score: r.priority_score == null ? null : Number(r.priority_score),
    completed_at: (r.completed_at as string) ?? null,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    source_capture_id: (r.source_capture_id as string) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

export type TaskFilter = {
  status?: TaskStatus | 'active' // 'active' = open (default for boardet)
  urgency?: Urgency
  area?: string
}

// Henter opgaver til boardet. Default: åbne opgaver, sorteret så vigtige +
// høj-prioritet ligger øverst i hver bunke.
export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const sb = getSupabase()
  let q = sb.from('tasks').select(TASK_COLS)

  const status = filter.status ?? 'active'
  if (status === 'active') q = q.eq('status', 'open')
  else q = q.eq('status', status)
  if (filter.urgency) q = q.eq('urgency', filter.urgency)
  if (filter.area) q = q.eq('area', filter.area)

  q = q
    .order('key', { ascending: false })
    .order('priority_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true })

  const { data, error } = await q
  if (error) throw new Error(`listTasks-fejl: ${error.message}`)
  return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>))
}

export type CreateTaskInput = {
  title: string
  urgency?: Urgency
  key?: boolean
  priority_score?: number | null
  due_date?: string | null
  area?: string | null
  details?: string | null
  tags?: string[]
  source_capture_id?: string | null
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const title = input.title.trim()
  if (!title) throw new Error('createTask: tom titel')
  const sb = getSupabase()
  const { data, error } = await sb
    .from('tasks')
    .insert({
      title,
      urgency: input.urgency ?? 'someday',
      key: input.key ?? false,
      priority_score: input.priority_score ?? null,
      due_date: input.due_date ?? null,
      area: input.area ?? null,
      details: input.details ?? null,
      tags: input.tags ?? [],
      source_capture_id: input.source_capture_id ?? null,
      status: 'open',
    })
    .select(TASK_COLS)
    .single()
  if (error) throw new Error(`createTask-fejl: ${error.message}`)
  return rowToTask(data as Record<string, unknown>)
}

export async function completeTask(id: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('tasks')
    .update({ status: 'done', completed_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
  if (error) throw new Error(`completeTask-fejl: ${error.message}`)
}

export async function reopenTask(id: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('tasks')
    .update({ status: 'open', completed_at: null, updated_at: nowIso() })
    .eq('id', id)
  if (error) throw new Error(`reopenTask-fejl: ${error.message}`)
}

export async function moveTask(id: string, urgency: Urgency): Promise<void> {
  if (!isUrgency(urgency)) throw new Error(`moveTask: ugyldig urgency ${urgency}`)
  const sb = getSupabase()
  const { error } = await sb
    .from('tasks')
    .update({ urgency, updated_at: nowIso() })
    .eq('id', id)
  if (error) throw new Error(`moveTask-fejl: ${error.message}`)
}

// Hård sletning. Bevidst valg: auto-fangst kan ramme forkert, og en fejl-opgave
// skal kunne fjernes rent fra boardet (ikke samle sig som 'cancelled'-støj).
export async function deleteTask(id: string): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.from('tasks').delete().eq('id', id)
  if (error) throw new Error(`deleteTask-fejl: ${error.message}`)
}

export type TaskClassification = {
  title: string
  urgency: Urgency
  key: boolean
  priority_score: number
  due_date: string | null
}

// Haiku udleder hastighed + prioritet + en ren titel fra en opgave-besked.
// Forstærker (erstatter ikke) den eksisterende type-klassificering: kaldes kun
// når en capture allerede er type="opgave", eller fra board-tilføj-feltet.
export async function classifyTask(text: string): Promise<TaskClassification> {
  const system = [
    'Du omdanner en kort dansk besked til en opgave i Gustavs personlige opgave-board.',
    'Gustav er medicinstuderende (SDU), sygeplejevikar og forskningsassistent.',
    `I dag er ${todayCphYmd()} (Europe/Copenhagen).`,
    'Svar KUN med JSON, intet andet:',
    '{"title":"...","urgency":"today|week|month|someday","key":true,"priority_score":0,"due_date":null}',
    '- title: kort, handlingsorienteret. Fjern "jeg skal", "husk at", "jeg skal nå at". Første bogstav stort, intet punktum til sidst.',
    '- urgency: "today" hvis i dag/nu/haster/deadline i dag; "week" hvis denne uge/snart; "month" hvis denne måned; "someday" ellers (intet tidspres).',
    '- key: true KUN hvis opgaven er vigtig/høj-indsats (eksamen, aflevering, vagt, deadline, helbred, penge). Ellers false.',
    '- priority_score: heltal 0-100. Højere = vigtigere og mere presserende. Vej både hastighed og konsekvens.',
    '- due_date: "YYYY-MM-DD" KUN hvis en konkret deadline kan udledes, ellers null.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<TaskClassification>

  const score = Number(parsed.priority_score)
  const due =
    typeof parsed.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)
      ? parsed.due_date
      : null
  return {
    title: (parsed.title || text).trim().slice(0, 200),
    urgency: isUrgency(parsed.urgency) ? parsed.urgency : 'someday',
    key: Boolean(parsed.key),
    priority_score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 50,
    due_date: due,
  }
}

export type CreateTaskFromCaptureInput = {
  text: string
  area?: string | null
  sourceCaptureId?: string | null
}

// Klassificerer en opgave-besked og opretter opgaven prioriteret. Returnerer den
// oprettede opgave (til bekræftelse på Telegram / web). Bruges af auto-fangst og
// af board-tilføj-feltet.
export async function createTaskFromCapture(input: CreateTaskFromCaptureInput): Promise<Task> {
  const tc = await classifyTask(input.text)
  // "YYYY-MM-DD" -> noon UTC. Noon UTC ligger altid på samme kalenderdag i CPH
  // (UTC+1/+2), så deadline skrider aldrig en dag ved visning via fmtDay.
  const due = tc.due_date ? `${tc.due_date}T12:00:00Z` : null
  return createTask({
    title: tc.title,
    urgency: tc.urgency,
    key: tc.key,
    priority_score: tc.priority_score,
    due_date: due,
    area: input.area ?? null,
    source_capture_id: input.sourceCaptureId ?? null,
  })
}
