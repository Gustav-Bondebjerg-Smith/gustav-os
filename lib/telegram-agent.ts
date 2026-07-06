// Tool-calling routerens dispatch (bag USE_AGENT_ROUTER-flag). Splittet ud af
// lib/telegram-webhook.ts (2026-07-06).
// Mapper routerens valgte værktøj til de EKSISTERENDE handlers, så veto- og
// kalender-logikken genbruges uændret. Routeren erstatter detektions-laget
// (regex + triage + double-gate), ikke eksekveringen.
import 'server-only'
import { sendChatAction, sendMessage, type HandleResult, type TelegramMessage } from './telegram-shared'
import {
  formatInsertDone,
  handleCalendarEdit,
  normalizeEditTime,
  type CalendarEditType,
  type CalendarProposal,
} from './telegram-calendar'
import { handleActivityStart, handleActivityStop } from './telegram-activity'
import { handleCapture } from './telegram-capture'
import { answerQuestion } from './telegram-recall'
import { getSupabase } from './supabase'
import { insertEvent } from './calendar'
import { fmtDay } from './format'
import { createTaskFromCapture, completeTask, moveTask, deleteTask, listTasks, URGENCIES, URGENCY_LABEL, isUrgency, type Task } from './tasks'
import { routeMessage, type RouterResult, type RouterTurn } from './agent-router'
import { recallGlobal, formatGlobalForPrompt, saveMemory, type MemoryType } from './memory-facts'
import { suggestMeal } from './meals'
import { getSpendSummary } from './finance'

// create_event: routeren giver eksplicitte slots (summary/start/end), så vi går
// uden om proposeCalendarEvent og bygger aftalen direkte. Skriver straks i
// kalenderen (ingen veto), som aftale-grenen i handleCapture.
async function handleAgentCreate(
  msg: TelegramMessage,
  input: Record<string, unknown>
): Promise<HandleResult> {
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const start = typeof input.start === 'string' ? input.start.trim() : ''
  const end = typeof input.end === 'string' ? input.end.trim() : ''
  if (!summary || !start || !end) {
    await sendMessage(
      msg.chat.id,
      'Jeg manglede titel eller tid til at oprette aftalen. Prøv igen med et klart tidspunkt.'
    )
    return { status: 'processed', reason: 'agent_create_missing_slots' }
  }

  const proposal: CalendarProposal = { summary, start, end }
  const sb = getSupabase()
  try {
    const event = await insertEvent(proposal)
    await sb.from('audit_log').insert({
      action: 'calendar_insert',
      payload: { ...proposal, event_id: event.id, html_link: event.htmlLink },
      status: 'applied',
      reason: 'agent create: skrevet straks (ingen veto)',
    })
    await sendMessage(msg.chat.id, formatInsertDone(proposal, event.htmlLink))
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sb.from('audit_log').insert({
      action: 'calendar_insert',
      payload: proposal,
      status: 'failed',
      reason: err,
    })
    await sendMessage(msg.chat.id, `Kunne ikke skrive "${proposal.summary}" i kalenderen: ${err}`)
  }
  return { status: 'processed', reason: 'agent_create_done' }
}

// ---- Opgave-board via routeren (create/complete/move/delete/list) ----
// Tynde wrappers over lib/tasks. create genbruger createTaskFromCapture (samme
// klassificering som web-boardet). complete/move/delete identificerer opgaven ud
// fra et søgeord i titlen: matchet vælges DETERMINISTISK i kode (ikke af LLM'en,
// jf. instans-lektien i CLAUDE.md), og er det tvetydigt eller uden match, spørger
// vi i stedet for at gætte forkert.
function normalizeTaskText(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim()
}

// Score et titel-match mod hint'et. Eksakt > substreng > token-overlap. Bevidst
// simpelt: boardet har få åbne opgaver, så substreng + ord-stamme rammer fint.
function taskMatchScore(hintNorm: string, titleNorm: string): number {
  if (!hintNorm || !titleNorm) return 0
  if (titleNorm === hintNorm) return 1000
  if (titleNorm.includes(hintNorm)) return 600
  if (hintNorm.includes(titleNorm)) return 400
  const hintTokens = hintNorm.split(/\s+/).filter((w) => w.length >= 2)
  if (hintTokens.length === 0) return 0
  const titleTokens = titleNorm.split(/\s+/).filter(Boolean)
  let hits = 0
  for (const h of hintTokens) {
    if (titleTokens.some((t) => t === h || t.startsWith(h) || h.startsWith(t))) hits++
  }
  if (hits === 0) return 0
  return 10 * hits + (hits === hintTokens.length ? 5 : 0)
}

type TaskResolution =
  | { kind: 'match'; task: Task }
  | { kind: 'ambiguous'; tasks: Task[] }
  | { kind: 'none' }

// Vælg én opgave ud fra hint. Flere lige-gode kandidater -> 'ambiguous' (vi
// spørger). Ingen over 0 -> 'none'. Aldrig et tvunget gæt på det destruktive.
function resolveTaskByHint(hint: string, tasks: Task[]): TaskResolution {
  const hintNorm = normalizeTaskText(hint)
  if (!hintNorm || tasks.length === 0) return { kind: 'none' }
  const scored = tasks
    .map((t) => ({ t, s: taskMatchScore(hintNorm, normalizeTaskText(t.title)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  if (scored.length === 0) return { kind: 'none' }
  const best = scored[0].s
  const winners = scored.filter((x) => x.s === best)
  if (winners.length === 1) return { kind: 'match', task: winners[0].t }
  return { kind: 'ambiguous', tasks: winners.map((x) => x.t) }
}

function taskNotFoundMessage(hint: string, openTasks: Task[]): string {
  if (openTasks.length === 0) return 'Du har ingen åbne opgaver på boardet.'
  const list = openTasks.slice(0, 8).map((t) => `• ${t.title}`).join('\n')
  return `Fandt ingen opgave der matcher "${hint}". Dine åbne opgaver:\n${list}`
}

function taskAmbiguousMessage(hint: string, tasks: Task[]): string {
  const list = tasks.map((t) => `• ${t.title}`).join('\n')
  return `Flere opgaver matcher "${hint}". Hvilken mener du? Skriv lidt mere af titlen.\n${list}`
}

async function handleAgentTaskCreate(msg: TelegramMessage, title: string): Promise<HandleResult> {
  if (!title) {
    await sendMessage(msg.chat.id, 'Hvad skal opgaven hedde?')
    return { status: 'processed', reason: 'agent_task_create_missing_title' }
  }
  try {
    const task = await createTaskFromCapture({ text: title })
    const bits = [URGENCY_LABEL[task.urgency]]
    if (task.key) bits.push('vigtig')
    if (task.due_date) bits.push(`frist ${fmtDay(task.due_date)}`)
    await sendMessage(msg.chat.id, `✅ Tilføjet: ${task.title}\n${bits.join(' · ')}`)
    return { status: 'processed', reason: 'agent_task_created' }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke tilføje opgaven: ${err}`)
    return { status: 'processed', reason: 'agent_task_create_failed' }
  }
}

async function handleAgentTaskComplete(msg: TelegramMessage, hint: string): Promise<HandleResult> {
  if (!hint) {
    await sendMessage(msg.chat.id, 'Hvilken opgave er du færdig med?')
    return { status: 'processed', reason: 'agent_task_complete_missing_hint' }
  }
  let tasks: Task[]
  try {
    tasks = await listTasks()
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke hente opgaverne: ${err}`)
    return { status: 'processed', reason: 'agent_task_complete_list_failed' }
  }
  const res = resolveTaskByHint(hint, tasks)
  if (res.kind === 'none') {
    await sendMessage(msg.chat.id, taskNotFoundMessage(hint, tasks))
    return { status: 'processed', reason: 'agent_task_complete_no_match' }
  }
  if (res.kind === 'ambiguous') {
    await sendMessage(msg.chat.id, taskAmbiguousMessage(hint, res.tasks))
    return { status: 'processed', reason: 'agent_task_complete_ambiguous' }
  }
  try {
    await completeTask(res.task.id)
    await sendMessage(msg.chat.id, `✔️ Færdig: ${res.task.title}`)
    return { status: 'processed', reason: 'agent_task_completed' }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke markere opgaven færdig: ${err}`)
    return { status: 'processed', reason: 'agent_task_complete_failed' }
  }
}

async function handleAgentTaskMove(
  msg: TelegramMessage,
  hint: string,
  urgencyRaw: string
): Promise<HandleResult> {
  if (!hint) {
    await sendMessage(msg.chat.id, 'Hvilken opgave vil du flytte?')
    return { status: 'processed', reason: 'agent_task_move_missing_hint' }
  }
  if (!isUrgency(urgencyRaw)) {
    await sendMessage(msg.chat.id, 'Flytte til hvornår? Skriv i dag, denne uge, denne måned eller senere.')
    return { status: 'processed', reason: 'agent_task_move_bad_urgency' }
  }
  let tasks: Task[]
  try {
    tasks = await listTasks()
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke hente opgaverne: ${err}`)
    return { status: 'processed', reason: 'agent_task_move_list_failed' }
  }
  const res = resolveTaskByHint(hint, tasks)
  if (res.kind === 'none') {
    await sendMessage(msg.chat.id, taskNotFoundMessage(hint, tasks))
    return { status: 'processed', reason: 'agent_task_move_no_match' }
  }
  if (res.kind === 'ambiguous') {
    await sendMessage(msg.chat.id, taskAmbiguousMessage(hint, res.tasks))
    return { status: 'processed', reason: 'agent_task_move_ambiguous' }
  }
  try {
    await moveTask(res.task.id, urgencyRaw)
    await sendMessage(msg.chat.id, `➡️ Flyttet til ${URGENCY_LABEL[urgencyRaw]}: ${res.task.title}`)
    return { status: 'processed', reason: 'agent_task_moved' }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke flytte opgaven: ${err}`)
    return { status: 'processed', reason: 'agent_task_move_failed' }
  }
}

async function handleAgentTaskDelete(msg: TelegramMessage, hint: string): Promise<HandleResult> {
  if (!hint) {
    await sendMessage(msg.chat.id, 'Hvilken opgave skal slettes?')
    return { status: 'processed', reason: 'agent_task_delete_missing_hint' }
  }
  let tasks: Task[]
  try {
    tasks = await listTasks()
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke hente opgaverne: ${err}`)
    return { status: 'processed', reason: 'agent_task_delete_list_failed' }
  }
  const res = resolveTaskByHint(hint, tasks)
  if (res.kind === 'none') {
    await sendMessage(msg.chat.id, taskNotFoundMessage(hint, tasks))
    return { status: 'processed', reason: 'agent_task_delete_no_match' }
  }
  if (res.kind === 'ambiguous') {
    await sendMessage(msg.chat.id, taskAmbiguousMessage(hint, res.tasks))
    return { status: 'processed', reason: 'agent_task_delete_ambiguous' }
  }
  try {
    await deleteTask(res.task.id)
    await sendMessage(msg.chat.id, `🗑 Slettet: ${res.task.title}`)
    return { status: 'processed', reason: 'agent_task_deleted' }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke slette opgaven: ${err}`)
    return { status: 'processed', reason: 'agent_task_delete_failed' }
  }
}

async function handleAgentTaskList(msg: TelegramMessage, urgencyRaw: string): Promise<HandleResult> {
  let tasks: Task[]
  try {
    tasks = await listTasks(isUrgency(urgencyRaw) ? { urgency: urgencyRaw } : undefined)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await sendMessage(msg.chat.id, `Kunne ikke hente opgaverne: ${err}`)
    return { status: 'processed', reason: 'agent_task_list_failed' }
  }
  if (tasks.length === 0) {
    await sendMessage(
      msg.chat.id,
      isUrgency(urgencyRaw)
        ? `Ingen åbne opgaver under ${URGENCY_LABEL[urgencyRaw]}.`
        : 'Du har ingen åbne opgaver på boardet.'
    )
    return { status: 'processed', reason: 'agent_task_list_empty' }
  }
  const lines: string[] = []
  if (isUrgency(urgencyRaw)) {
    for (const t of tasks) lines.push(`• ${t.title}${t.key ? ' (vigtig)' : ''}`)
  } else {
    for (const u of URGENCIES) {
      const grp = tasks.filter((t) => t.urgency === u)
      if (grp.length === 0) continue
      lines.push(`${URGENCY_LABEL[u]}:`)
      for (const t of grp) lines.push(`• ${t.title}${t.key ? ' (vigtig)' : ''}`)
    }
  }
  await sendMessage(msg.chat.id, `📋 Åbne opgaver (${tasks.length}):\n${lines.join('\n')}`)
  return { status: 'processed', reason: 'agent_task_listed' }
}

// Kort-tids samtale-hukommelse for routeren. Når routeren stiller et afklarende
// spørgsmål, gemmer vi samtalen-indtil-nu, så Gustavs NÆSTE besked (svaret) sendes
// med som kontekst og fuldfører den oprindelige handling i stedet for at blive
// vurderet kontekstløst. Ryddes så snart en handling udføres, og udløber efter
// vinduet så en gammel halv-samtale ikke hænger på en helt ny besked.
const CLARIFY_WINDOW_MS = (Number(process.env.CLARIFY_WINDOW_MINUTES) || 5) * 60 * 1000
const CLARIFY_MAX_TURNS = 8 // cap på gemte ture, så hukommelsen ikke vokser ubundet

// Alle tre helpers fejler blødt: mangler tabellen (migration ikke kørt) eller
// driller DB'en, degraderer vi til statsløs routing i stedet for at vælte hele
// webhooken. Routeren virker så præcis som før hukommelsen blev tilføjet.
async function loadClarification(chatId: number): Promise<RouterTurn[] | null> {
  try {
    const sb = getSupabase()
    const { data, error } = await sb
      .from('pending_clarification')
      .select('messages, updated_at')
      .eq('chat_id', chatId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    if (Date.now() - new Date(data.updated_at).getTime() > CLARIFY_WINDOW_MS) {
      await clearClarification(chatId)
      return null
    }
    return Array.isArray(data.messages) ? (data.messages as RouterTurn[]) : null
  } catch (e) {
    console.error('pending_clarification load fejlede (statsløs fallback):', e)
    return null
  }
}

async function saveClarification(chatId: number, messages: RouterTurn[]): Promise<void> {
  try {
    const sb = getSupabase()
    const { error } = await sb.from('pending_clarification').upsert(
      {
        chat_id: chatId,
        messages: messages.slice(-CLARIFY_MAX_TURNS),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id' }
    )
    if (error) throw new Error(error.message)
  } catch (e) {
    console.error('pending_clarification gem fejlede (ignoreret):', e)
  }
}

async function clearClarification(chatId: number): Promise<void> {
  try {
    const sb = getSupabase()
    const { error } = await sb.from('pending_clarification').delete().eq('chat_id', chatId)
    if (error) throw new Error(error.message)
  } catch (e) {
    console.error('pending_clarification ryd fejlede (ignoreret):', e)
  }
}

// Mad-forslag. Read-mostly (samme undtagelse fra double-gate som search_memory):
// suggestMeal laeser kataloget + laerte fakta og returnerer en konkret opskrift.
// Den eneste skrivning er at en GENERERET opskrift gemmes tilbage i kataloget, og
// den er best-effort inde i lib/meals.ts, saa en fejl der aldrig blokerer svaret.
async function handleAgentSuggestMeal(
  msg: TelegramMessage,
  meal: string,
  constraints: string
): Promise<HandleResult> {
  await sendChatAction(msg.chat.id)
  try {
    const { reply } = await suggestMeal({
      meal: meal || 'aftensmad',
      constraints: constraints || undefined,
    })
    await sendMessage(msg.chat.id, reply)
    return { status: 'processed', reason: 'agent_suggested_meal' }
  } catch (e) {
    console.error('suggest_meal fejlede:', e)
    await sendMessage(msg.chat.id, 'Kunne ikke finde på et mad-forslag lige nu. Prøv igen om lidt.')
    return { status: 'processed', reason: 'agent_meal_failed' }
  }
}

// Forbrugs-resumé. REN LÆSNING (samme undtagelse fra double-gate som
// search_memory/suggest_meal): getSpendSummary aggregerer posteringerne pr.
// måned deterministisk i kode. LLM'en vælger kun værktøjet + slots (focus/months),
// ingen tal kommer fra modellen. Skriver intet.
async function handleAgentFinanceSummary(
  msg: TelegramMessage,
  focus: string,
  months: number | null
): Promise<HandleResult> {
  await sendChatAction(msg.chat.id)
  try {
    const { reply } = await getSpendSummary({
      focus: focus || undefined,
      months: months ?? undefined,
    })
    await sendMessage(msg.chat.id, reply)
    return { status: 'processed', reason: 'agent_finance_summary' }
  } catch (e) {
    console.error('finance_summary fejlede:', e)
    await sendMessage(msg.chat.id, 'Kunne ikke hente forbrugstallene lige nu. Prøv igen om lidt.')
    return { status: 'processed', reason: 'agent_finance_failed' }
  }
}

export async function dispatchViaAgent(
  msg: TelegramMessage,
  text: string,
  source: 'telegram_text' | 'telegram_voice'
): Promise<HandleResult> {
  const now = msg.date ? new Date(msg.date * 1000) : new Date()
  await sendChatAction(msg.chat.id)

  // Hent evt. åben afklaring og byg samtalen, så et svar på routerens spørgsmål
  // vurderes MED kontekst (fuldfører handlingen) i stedet for kontekstløst (loop).
  const prior = await loadClarification(msg.chat.id)
  const convo: RouterTurn[] = [...(prior || []), { role: 'user', content: text }]

  // Lærte globale fakta lægges cache-stabilt ind i routerens system-prompt, så
  // korrektioner Gustav har gemt ændrer adfærd uden kode-edit. recallGlobal fejler
  // blødt til [], så en manglende tabel bare giver tom streng = routeren som før.
  const globalFacts = formatGlobalForPrompt(await recallGlobal())

  let routed: RouterResult
  try {
    routed = await routeMessage(convo, now, globalFacts)
  } catch (e) {
    console.error('agent-router fejlede (falder tilbage til capture):', e)
    await clearClarification(msg.chat.id)
    return handleCapture(msg, text, source)
  }

  // Tvivl -> afklarende spørgsmål, aldrig en tavs note (kerne-kravet fra council).
  // Gem samtalen (inkl. spørgsmålet) så Gustavs næste besked har kontekst.
  if (routed.kind === 'ask') {
    await sendMessage(msg.chat.id, routed.askText)
    await saveClarification(msg.chat.id, [...convo, { role: 'assistant', content: routed.askText }])
    return { status: 'processed', reason: 'agent_asked' }
  }

  // Enhver ikke-spørgsmål-udgang afslutter afklaringen: ryd state før dispatch.
  await clearClarification(msg.chat.id)

  if (routed.kind !== 'tool') {
    return handleCapture(msg, text, source)
  }

  const input = routed.input
  switch (routed.tool) {
    case 'create_event':
      return handleAgentCreate(msg, input)
    case 'edit_event': {
      const eventHint = typeof input.event_hint === 'string' ? input.event_hint.trim() : ''
      const editTypeRaw = typeof input.edit_type === 'string' ? input.edit_type : ''
      const editTypes: CalendarEditType[] = ['end', 'start', 'shift']
      const newTime = typeof input.new_time === 'string' ? normalizeEditTime(input.new_time, now) : null
      if (!eventHint || !newTime || !editTypes.includes(editTypeRaw as CalendarEditType)) {
        return handleCapture(msg, text, source)
      }
      return handleCalendarEdit(
        msg,
        { isEditIntent: true, eventHint, editType: editTypeRaw as CalendarEditType, newTime },
        text
      )
    }
    case 'delete_event':
      // Genbruger det eksisterende slet-forslag + veto-flow (re-udleder event fra teksten).
      return handleCapture(msg, text, source, { forceDelete: true })
    case 'start_activity': {
      const name = typeof input.activity_name === 'string' ? input.activity_name.trim() : ''
      if (!name) return handleCapture(msg, text, source)
      return handleActivityStart(msg, name)
    }
    case 'stop_activity':
      return handleActivityStop(msg)
    case 'search_memory': {
      const query =
        typeof input.query === 'string' && input.query.trim() ? input.query.trim() : text
      return answerQuestion(msg.chat.id, query, 'recall')
    }
    case 'save_note':
      return handleCapture(msg, text, source)
    case 'save_memory': {
      // Varigt faktum/præference. Let validering, skriv via memory-facts-laget,
      // bekræft kort. Ugyldig input eller fejlet skrivning (fx migration ikke
      // kørt) -> fald tilbage til capture, så informationen aldrig går tabt.
      const memTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference']
      const memType = typeof input.type === 'string' ? input.type : ''
      const memKey = typeof input.key === 'string' ? input.key.trim() : ''
      const memContent = typeof input.content === 'string' ? input.content.trim() : ''
      const memWhy = typeof input.why === 'string' ? input.why.trim() : ''
      if (!memTypes.includes(memType as MemoryType) || !memKey || !memContent) {
        return handleCapture(msg, text, source)
      }
      try {
        const saved = await saveMemory({
          type: memType as MemoryType,
          scope: 'global',
          key: memKey,
          content: memContent,
          why: memWhy || undefined,
        })
        await sendMessage(msg.chat.id, `🧠 Husket: ${saved.content}`)
        return { status: 'processed', reason: 'agent_saved_memory' }
      } catch (e) {
        console.error('save_memory fejlede (gemmer som note i stedet):', e)
        return handleCapture(msg, text, source)
      }
    }
    case 'create_task': {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      return handleAgentTaskCreate(msg, title)
    }
    case 'complete_task': {
      const hint = typeof input.task_hint === 'string' ? input.task_hint.trim() : ''
      return handleAgentTaskComplete(msg, hint)
    }
    case 'move_task': {
      const hint = typeof input.task_hint === 'string' ? input.task_hint.trim() : ''
      const urgency = typeof input.urgency === 'string' ? input.urgency.trim() : ''
      return handleAgentTaskMove(msg, hint, urgency)
    }
    case 'delete_task': {
      const hint = typeof input.task_hint === 'string' ? input.task_hint.trim() : ''
      return handleAgentTaskDelete(msg, hint)
    }
    case 'list_tasks': {
      const urgency = typeof input.urgency === 'string' ? input.urgency.trim() : ''
      return handleAgentTaskList(msg, urgency)
    }
    case 'suggest_meal': {
      const meal = typeof input.meal === 'string' ? input.meal.trim() : ''
      const constraints = typeof input.constraints === 'string' ? input.constraints.trim() : ''
      return handleAgentSuggestMeal(msg, meal, constraints)
    }
    case 'finance_summary': {
      const focus = typeof input.focus === 'string' ? input.focus.trim() : ''
      const months =
        typeof input.months === 'number' && Number.isFinite(input.months) ? input.months : null
      return handleAgentFinanceSummary(msg, focus, months)
    }
    default:
      console.warn('agent-router: ukendt værktøj', routed.tool)
      return handleCapture(msg, text, source)
  }
}
