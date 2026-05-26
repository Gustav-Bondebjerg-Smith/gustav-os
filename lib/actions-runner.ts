import 'server-only'
import { getSupabase } from './supabase'
import { insertEvent, type CalendarInsertPayload } from './calendar'
import { sendTelegramMessage } from './telegram'

type ActionPayload = CalendarInsertPayload & {
  summary?: string
}

type ActionRow = {
  id: string
  type: string
  payload: ActionPayload
  source_capture_id: string | null
}

export type RunDueActionsResult = {
  checked_at: string
  found: number
  claimed: number
  executed: number
  failed: number
  skipped: number
  actions: Array<{
    id: string
    status: 'executed' | 'failed' | 'skipped'
    summary?: string
    error?: string
  }>
}

async function notify(text: string): Promise<void> {
  try {
    await sendTelegramMessage(text)
  } catch (e) {
    console.error('Telegram-notifikation fejlede:', e)
  }
}

export async function runDueActions(limit = 10): Promise<RunDueActionsResult> {
  const sb = getSupabase()
  const checkedAt = new Date().toISOString()
  const { data: due, error } = await sb
    .from('actions')
    .select('id, type, payload, source_capture_id')
    .eq('status', 'proposed')
    .lt('veto_deadline', checkedAt)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) throw new Error(`actions query-fejl: ${error.message}`)

  const result: RunDueActionsResult = {
    checked_at: checkedAt,
    found: due?.length || 0,
    claimed: 0,
    executed: 0,
    failed: 0,
    skipped: 0,
    actions: [],
  }

  for (const candidate of (due || []) as ActionRow[]) {
    const processingStartedAt = new Date().toISOString()
    const { data: claimedRows, error: claimError } = await sb
      .from('actions')
      .update({
        status: 'executing',
        processing_started_at: processingStartedAt,
        result: { started_at: processingStartedAt },
      })
      .eq('id', candidate.id)
      .eq('status', 'proposed')
      .select('id, type, payload, source_capture_id')
      .limit(1)

    if (claimError) throw new Error(`action claim-fejl (${candidate.id}): ${claimError.message}`)

    const action = (claimedRows?.[0] || null) as ActionRow | null
    if (!action) {
      result.skipped += 1
      result.actions.push({ id: candidate.id, status: 'skipped', summary: candidate.payload?.summary })
      continue
    }

    result.claimed += 1

    try {
      if (action.type !== 'calendar_insert') {
        throw new Error(`Ukendt action-type: ${action.type}`)
      }

      const event = await insertEvent(action.payload)
      const actionResult = { event_id: event.id, html_link: event.htmlLink }
      const { error: updateError } = await sb
        .from('actions')
        .update({
          status: 'executed',
          executed_at: new Date().toISOString(),
          processing_started_at: null,
          result: actionResult,
        })
        .eq('id', action.id)
      if (updateError) throw new Error(`action update-fejl: ${updateError.message}`)

      await sb.from('audit_log').insert({
        action: 'calendar_insert',
        payload: { ...action.payload, ...actionResult },
        status: 'applied',
        reason: `udført efter veto-vindue (action ${action.id})`,
      })

      const link = event.htmlLink ? `\n${event.htmlLink}` : ''
      await notify(`Skrevet i kalender: "${action.payload?.summary || 'aftale'}"${link}`)
      result.executed += 1
      result.actions.push({ id: action.id, status: 'executed', summary: action.payload?.summary })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await sb
        .from('actions')
        .update({
          status: 'failed',
          processing_started_at: null,
          result: { error: message },
        })
        .eq('id', action.id)
      await sb.from('audit_log').insert({
        action: 'calendar_insert',
        payload: action.payload,
        status: 'failed',
        reason: message,
      })
      await notify(`Kunne ikke skrive "${action.payload?.summary || 'aftale'}" i kalender: ${message}`)
      result.failed += 1
      result.actions.push({
        id: action.id,
        status: 'failed',
        summary: action.payload?.summary,
        error: message,
      })
    }
  }

  return result
}
