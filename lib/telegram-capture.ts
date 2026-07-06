// Capture-flowet: gem beskeden, klassificér, embed, og udfør evt. auto-handling
// (aftale-oprettelse, slet-match eller opgave-oprettelse). Splittet ud af
// lib/telegram-webhook.ts (2026-07-06).
// content + source udledes af handleTelegramUpdate (voice transskriberes dér,
// så transskriptionen kan løbe gennem intent-routingen før den ender her).
// opts.forceDelete sættes når triagen/routeren har set en slet-intent i
// hverdagssprog, hvor DELETE_INTENT-regexen ikke ville ramme.
import 'server-only'
import { sendMessage, type HandleResult, type TelegramMessage } from './telegram-shared'
import {
  formatCandidates,
  formatDeletionDone,
  formatInsertDone,
  hasDeleteIntent,
  proposeCalendarDelete,
  proposeCalendarEvent,
  type CalendarProposal,
  type DeleteAttempt,
} from './telegram-calendar'
import { getSupabase } from './supabase'
import { storeChunk } from './memory'
import { insertEvent, deleteEvent } from './calendar'
import { classify, VALID_AREAS, type Classification } from './capture'
import { createTaskFromCapture, URGENCY_LABEL, type Task } from './tasks'
import { fmtDay } from './format'

// Bekræftelse når auto-fangsten har oprettet en opgave. Ingen veto/knapper -
// hastighed justeres på dashboardets Opgaver-fane (kernekravet er auto-opret +
// auto-prioritér, ikke en knap-flow i Telegram).
function formatTaskCreated(t: Task, heard: string): string {
  const bits = [URGENCY_LABEL[t.urgency]]
  if (t.key) bits.push('vigtig')
  const due = t.due_date ? `\nDeadline: ${fmtDay(t.due_date)}` : ''
  return `${heard}✅ Opgave oprettet: ${t.title}\nPrioritet: ${bits.join(' · ')}${due}\nJustér på Opgaver-fanen.`
}

export async function handleCapture(
  msg: TelegramMessage,
  content: string,
  source: 'telegram_text' | 'telegram_voice',
  opts: { forceDelete?: boolean } = {}
): Promise<HandleResult> {
  const sb = getSupabase()

  const { data, error } = await sb
    .from('raw_captures')
    .insert({ source, content })
    .select('id')
    .single()

  if (error) throw new Error(`raw_captures insert-fejl: ${error.message}`)

  const captureId = String(data.id)
  const heard = source === 'telegram_voice' ? `Hørt: "${content}"\n` : ''
  let reply = heard + 'Fanget og gemt.'
  let classification: Classification | null = null
  let area: string | null = null

  try {
    classification = await classify(content)
    area = VALID_AREAS.includes(classification.area as (typeof VALID_AREAS)[number])
      ? classification.area || null
      : null
    await sb
      .from('raw_captures')
      .update({ area, classification, processed: true })
      .eq('id', captureId)
    reply = heard + `Fanget og gemt. (${area || 'ukategoriseret'}, ${classification.type})`
  } catch (e) {
    console.error('klassificering fejlede (ikke kritisk):', e)
  }

  try {
    await storeChunk({
      content,
      source_type: 'raw_capture',
      source_id: captureId,
      area,
      metadata: {
        source,
        summary: classification?.summary || null,
        type: classification?.type || null,
      },
    })
  } catch (e) {
    console.error('embed fejlede (ikke kritisk):', e)
  }

  // To grene: slet-intent (fjerner en eksisterende aftale) eller aftale-intent
  // (opretter en ny). Slet-intent har forrang, fordi en besked som "slet
  // aftalen med skat" ofte klassificeres som aftale.
  // INGEN veto længere: kalender-handlinger udføres STRAKS (Gustavs valg
  // 2026-06-04). En fejl-skrivning kan altid rettes bagefter med "slet X" / "ret X".
  if (opts.forceDelete || hasDeleteIntent(content)) {
    let attempt: DeleteAttempt = { match: null, candidates: [], reason: 'flow fejlede' }
    try {
      attempt = await proposeCalendarDelete(content)
    } catch (e) {
      console.error('slet-match fejlede (ikke kritisk):', e)
    }
    if (attempt.match) {
      const m = attempt.match
      try {
        await deleteEvent(m.event_id)
        await sb.from('audit_log').insert({
          action: 'calendar_delete',
          payload: { ...m, deleted: true },
          status: 'applied',
          reason: 'slettet straks (ingen veto)',
        })
        await sendMessage(msg.chat.id, formatDeletionDone(m))
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        await sb.from('audit_log').insert({
          action: 'calendar_delete',
          payload: m,
          status: 'failed',
          reason: err,
        })
        await sendMessage(msg.chat.id, `Kunne ikke slette "${m.summary}" fra kalenderen: ${err}`)
      }
      return { status: 'processed', reason: 'capture_saved_with_delete' }
    }
    // Ingen match. Sig hvorfor + vis hvad jeg så, så Gustav kan justere
    // beskeden eller verificere at eventet faktisk findes i den rigtige kalender.
    const candidateText = formatCandidates(attempt.candidates)
    const tail = candidateText ? `\n\n${candidateText}` : ''
    await sendMessage(
      msg.chat.id,
      `${reply}\n\nKunne ikke matche slet-beskeden: ${attempt.reason}.${tail}`
    )
    return { status: 'processed', reason: 'capture_saved_no_delete_match' }
  }

  let proposal: CalendarProposal | null = null
  if (classification?.type === 'aftale') {
    try {
      proposal = await proposeCalendarEvent(content)
    } catch (e) {
      console.error('aftale-udledning fejlede (ikke kritisk):', e)
    }
  }

  if (proposal) {
    try {
      const event = await insertEvent(proposal)
      await sb.from('audit_log').insert({
        action: 'calendar_insert',
        payload: { ...proposal, event_id: event.id, html_link: event.htmlLink },
        status: 'applied',
        reason: 'skrevet straks (ingen veto)',
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
  } else if (classification?.type === 'opgave') {
    // Auto-fangst: opret + prioritér opgaven og bekræft. Best-effort - en fejl
    // her falder tilbage til den almindelige "fanget og gemt"-kvittering.
    try {
      const task = await createTaskFromCapture({ text: content, area, sourceCaptureId: captureId })
      await sendMessage(msg.chat.id, formatTaskCreated(task, heard))
    } catch (e) {
      console.error('opgave-oprettelse fejlede (ikke kritisk):', e)
      await sendMessage(msg.chat.id, reply)
    }
  } else {
    await sendMessage(msg.chat.id, reply)
  }

  return { status: 'processed', reason: 'capture_saved' }
}
