// Tids-tracking via Telegram: "starter på X" / "stopper". Splittet ud af
// lib/telegram-webhook.ts (2026-07-06).
// Flow: Gustav skriver "starter på X". Hvis der allerede er en pending aktivitet
// for hans chat, lukkes den ved at indsætte en kalenderbegivenhed fra dens
// started_at til nu. Den nye aktivitet gemmes som pending.
import 'server-only'
import {
  extractJsonObject,
  fmtTimeColonCph,
  requireEnv,
  sendMessage,
  type HandleResult,
  type TelegramMessage,
} from './telegram-shared'
import { getSupabase } from './supabase'
import { insertEvent } from './calendar'

const ACTIVITY_DETECTOR_MODEL = 'claude-haiku-4-5-20251001'

// Hurtig pre-filter inden vi kalder Haiku for at klassificere intent. Sparer
// et model-kald på de fleste beskeder. Hvis nye trigger-fraser skal med, så
// tilføj dem her OG i system-prompten i detectActivityStart.
// NB: \b virker ikke med æ/ø/å i JS (kun ASCII tæller som word-tegn), så fraser
// der ender på "på" ("starter på", "tager fat på") matchede ALDRIG den gamle
// regex. Derfor Unicode-grænser: (?<![\p{L}\p{N}]) ... (?![\p{L}\p{N}]) med
// u-flag. Holdes i sync med trigger-listen i detectActivityStart's system-prompt.
const ACTIVITY_TRIGGER = /(?<![\p{L}\p{N}])(starter på|starter med|går i gang med|begynder(?: på| med)?|skifter til|påbegynder|tager fat på)(?![\p{L}\p{N}])/iu

// Stop-/afslut-trigger: lukker den aktive aktivitet UDEN at starte en ny.
// Bevidst IKKE bare "stop" alene - det er allerede et veto-ord (VETO_WORDS) og
// fanges højere oppe i routingen. Samme Unicode-grænse-trick som ACTIVITY_TRIGGER
// pga. æ/ø/å. Holdes i sync med trigger-listen i detectActivityStop's system-prompt.
const ACTIVITY_STOP_TRIGGER = /(?<![\p{L}\p{N}])(slutter(?: på| med)?|slut|stopper(?: med)?|afslutter|holder pause|tager (?:en )?pause|pause|færdig(?: med)?|done)(?![\p{L}\p{N}])/iu

// Tids-tracking-events tagges i description så de kan filtreres/findes i kalenderen.
const TRACKING_EVENT_TAG = 'Tids-tracking via Telegram'

// Hvis en aktivitet har "kørt" længere end dette (typisk fordi Gustav glemte at
// skifte, fx natten over), springer vi kalender-indsætningen over, så vi ikke
// forurener kalenderen med en kæmpe forkert blok. Tunes via MAX_ACTIVITY_HOURS.
const MAX_ACTIVITY_MS = (Number(process.env.MAX_ACTIVITY_HOURS) || 16) * 3600000

export type ActivityIntent = {
  isActivityStart: boolean
  activityName: string | null
}

type PendingActivityRow = {
  chat_id: number
  activity_name: string
  started_at: string
}

export function looksLikeActivityStart(text: string | null | undefined): boolean {
  if (!text) return false
  return ACTIVITY_TRIGGER.test(text)
}

export function looksLikeActivityStop(text: string | null | undefined): boolean {
  if (!text) return false
  return ACTIVITY_STOP_TRIGGER.test(text)
}

export async function detectActivityStart(text: string): Promise<ActivityIntent> {
  if (!text || text.trim().length < 3) {
    return { isActivityStart: false, activityName: null }
  }

  const system = [
    'Du klassificerer om en kort dansk besked udtrykker at brugeren STARTER en ny aktivitet lige nu.',
    'Svar KUN med JSON, intet andet:',
    '{"isActivityStart": true, "activityName": "kort dansk titel max 6 ord"}',
    'eller',
    '{"isActivityStart": false, "activityName": null}',
    '',
    'Trigger-fraser: "starter på", "starter med", "går i gang med", "begynder", "skifter til", "påbegynder", "tager fat på" og lignende.',
    'activityName: bare aktiviteten uden trigger-fraserne. Eksempler:',
    '  "starter på pleuritis-kapitlet" -> "pleuritis-kapitlet"',
    '  "skifter til frokost" -> "frokost"',
    '  "går i gang med journalen" -> "journalen"',
    'Første bogstav stort. Ingen punktum til sidst.',
    '',
    'Returner false hvis beskeden er:',
    '- en aftale med tidspunkt ("møde kl 14")',
    '- en note, ide, refleksion eller observation',
    '- en slet-besked ("slet aftalen")',
    '- en /-kommando',
    '- i fortid eller fremtid ("startede i går", "starter i morgen kl 10")',
    '- generel tekst uden klar nu-start',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ACTIVITY_DETECTOR_MODEL,
      max_tokens: 100,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{ isActivityStart?: boolean; activityName?: string | null }>(raw)
  if (!parsed) return { isActivityStart: false, activityName: null }
  if (!parsed.isActivityStart || !parsed.activityName) {
    return { isActivityStart: false, activityName: null }
  }
  return { isActivityStart: true, activityName: parsed.activityName.trim() }
}

// Bekræfter at en stop-/afslut-besked faktisk betyder "luk den aktive aktivitet
// nu". Ingen navne-udtrækning nødvendig (vi lukker bare den pending der findes),
// så Haiku skal kun sige ja/nej. Samme prefilter-så-Haiku-mønster som start.
export async function detectActivityStop(text: string): Promise<boolean> {
  if (!text || text.trim().length < 3) return false

  const system = [
    'Du klassificerer om en kort dansk besked betyder at brugeren STOPPER eller AFSLUTTER sin nuværende aktivitet lige nu (inkl. at holde pause).',
    'Svar KUN med JSON, intet andet:',
    '{"isActivityStop": true}',
    'eller',
    '{"isActivityStop": false}',
    '',
    'Trigger-fraser: "slutter", "slutter på X", "stopper", "afslutter", "holder pause", "tager en pause", "færdig", "færdig med X", "done", "slut" og lignende.',
    '',
    'Returner true KUN hvis beskeden udtrykker at brugeren NU holder op med det han er i gang med.',
    'Returner false hvis beskeden er:',
    '- en START på en ny aktivitet ("starter på X", "skifter til X")',
    '- en note/ide/refleksion der blot nævner at slutte ("glæder mig til at være færdig med eksamen")',
    '- en aftale eller fortidig/fremtidig hændelse ("jeg blev færdig i går")',
    '- en slet-besked ("slet aftalen") eller en /-kommando',
    '- generel tekst uden en klar nu-stop',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ACTIVITY_DETECTOR_MODEL,
      max_tokens: 50,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{ isActivityStop?: boolean }>(raw)
  if (!parsed) return false
  return parsed.isActivityStop === true
}

async function getPendingActivity(chatId: number): Promise<PendingActivityRow | null> {
  const sb = getSupabase()
  const { data, error } = await sb
    .from('pending_activity')
    .select('chat_id, activity_name, started_at')
    .eq('chat_id', chatId)
    .maybeSingle()
  if (error) throw new Error(`pending_activity select-fejl: ${error.message}`)
  return data || null
}

async function upsertPendingActivity(
  chatId: number,
  activityName: string,
  startedAt: Date
): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('pending_activity')
    .upsert(
      {
        chat_id: chatId,
        activity_name: activityName,
        started_at: startedAt.toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id' }
    )
  if (error) throw new Error(`pending_activity upsert-fejl: ${error.message}`)
}

async function deletePendingActivity(chatId: number): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb.from('pending_activity').delete().eq('chat_id', chatId)
  if (error) throw new Error(`pending_activity delete-fejl: ${error.message}`)
}

export async function handleActivityStart(
  msg: TelegramMessage,
  activityName: string
): Promise<HandleResult> {
  const chatId = msg.chat.id
  // Brug beskedens eget tidsstempel (msg.date) i stedet for serverens new Date():
  // det er hvornår Gustav faktisk sendte beskeden (korrekt aktivitets-grænse, ikke
  // forskudt af Haiku-latency) og gør tiden deterministisk hvis updaten gen-behandles.
  const now = msg.date ? new Date(msg.date * 1000) : new Date()

  let pending: PendingActivityRow | null = null
  try {
    pending = await getPendingActivity(chatId)
  } catch (e) {
    console.error('pending_activity lookup fejlede:', e)
    await sendMessage(
      chatId,
      `Kunne ikke læse pending aktivitet: ${e instanceof Error ? e.message : String(e)}`
    )
    return { status: 'processed', reason: 'activity_lookup_failed' }
  }

  if (pending) {
    const startDate = new Date(pending.started_at)
    const durationMs = now.getTime() - startDate.getTime()
    let inserted = false

    // Indsæt kun et kalender-event hvis varigheden er gyldig OG rimelig.
    // durationMs <= 0: clock-skew eller gen-behandling. > MAX: glemt at skifte.
    if (durationMs > 0 && durationMs <= MAX_ACTIVITY_MS) {
      try {
        await insertEvent({
          summary: pending.activity_name,
          start: startDate,
          end: now,
          description: TRACKING_EVENT_TAG,
        })
        inserted = true
      } catch (e) {
        console.error('Kalender-indsætning for tids-tracking fejlede:', e)
        await sendMessage(
          chatId,
          `Kunne ikke indsætte "${pending.activity_name}" i kalenderen: ${e instanceof Error ? e.message : String(e)}. Pending bevares.`
        )
        return { status: 'processed', reason: 'activity_calendar_failed' }
      }
    }

    try {
      await upsertPendingActivity(chatId, activityName, now)
    } catch (e) {
      console.error('pending_activity upsert fejlede efter kalender-håndtering:', e)
      // Hvis vi NÅEDE at indsætte X, så ryd pending, så X ikke bliver indsat igen
      // ved næste "starter på" (ellers en dublet med samme started_at). Hvis vi
      // IKKE indsatte, er den gamle pending stadig korrekt og bevares.
      if (inserted) {
        try {
          await deletePendingActivity(chatId)
        } catch (delErr) {
          console.error('kunne ikke rydde pending efter upsert-fejl:', delErr)
        }
        await sendMessage(
          chatId,
          `Indsatte "${pending.activity_name}" i kalenderen, men kunne ikke gemme ny pending. Pending er ryddet - skriv "starter på ${activityName}" igen.`
        )
      } else {
        await sendMessage(
          chatId,
          `Kunne ikke gemme ny pending: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      return { status: 'processed', reason: 'activity_upsert_failed' }
    }

    if (inserted) {
      const startTime = fmtTimeColonCph(startDate)
      const endTime = fmtTimeColonCph(now)
      await sendMessage(
        chatId,
        `✅ Indsat: ${pending.activity_name} (${startTime}–${endTime}). Nu i gang: ${activityName}`
      )
    } else if (durationMs <= 0) {
      await sendMessage(
        chatId,
        `▶️ Nu i gang: ${activityName} (${fmtTimeColonCph(now)}). Sprang kalenderen over for "${pending.activity_name}" (ugyldig varighed).`
      )
    } else {
      const hours = Math.round(durationMs / 3600000)
      await sendMessage(
        chatId,
        `▶️ Nu i gang: ${activityName} (${fmtTimeColonCph(now)}). "${pending.activity_name}" havde kørt ~${hours}t - for langt til at logge automatisk, så jeg sprang kalenderen over.`
      )
    }
    return {
      status: 'processed',
      reason: inserted ? 'activity_switched' : 'activity_switched_no_calendar',
    }
  }

  // Ingen pending: gem bare den nye uden at indsætte noget.
  try {
    await upsertPendingActivity(chatId, activityName, now)
  } catch (e) {
    console.error('pending_activity upsert fejlede:', e)
    await sendMessage(
      chatId,
      `Kunne ikke gemme pending aktivitet: ${e instanceof Error ? e.message : String(e)}`
    )
    return { status: 'processed', reason: 'activity_save_failed' }
  }
  await sendMessage(chatId, `▶️ Startet: ${activityName} (${fmtTimeColonCph(now)})`)
  return { status: 'processed', reason: 'activity_started' }
}

// Stop/afslut: lukker den aktive aktivitet ved at indsætte en kalenderbegivenhed
// fra dens started_at til nu, og rydder så pending UDEN at starte en ny.
// Modstykket til "skift" i handleActivityStart (som lukker + åbner i ét).
export async function handleActivityStop(msg: TelegramMessage): Promise<HandleResult> {
  const chatId = msg.chat.id
  // Samme som start: brug beskedens eget tidsstempel som aktivitets-grænse.
  const now = msg.date ? new Date(msg.date * 1000) : new Date()

  let pending: PendingActivityRow | null = null
  try {
    pending = await getPendingActivity(chatId)
  } catch (e) {
    console.error('pending_activity lookup fejlede (stop):', e)
    await sendMessage(
      chatId,
      `Kunne ikke læse pending aktivitet: ${e instanceof Error ? e.message : String(e)}`
    )
    return { status: 'processed', reason: 'activity_lookup_failed' }
  }

  if (!pending) {
    await sendMessage(chatId, 'Der er ingen aktiv aktivitet at afslutte.')
    return { status: 'processed', reason: 'activity_stop_no_pending' }
  }

  const startDate = new Date(pending.started_at)
  const durationMs = now.getTime() - startDate.getTime()

  // Indsæt kalender FØR vi rydder pending, så aktiviteten ikke går tabt hvis
  // indsætningen fejler. Samme varigheds-guard som ved skift: spring kalenderen
  // over hvis varigheden er ugyldig (<= 0) eller urimelig lang (glemt at stoppe).
  let inserted = false
  if (durationMs > 0 && durationMs <= MAX_ACTIVITY_MS) {
    try {
      await insertEvent({
        summary: pending.activity_name,
        start: startDate,
        end: now,
        description: TRACKING_EVENT_TAG,
      })
      inserted = true
    } catch (e) {
      console.error('Kalender-indsætning ved stop fejlede:', e)
      await sendMessage(
        chatId,
        `Kunne ikke indsætte "${pending.activity_name}" i kalenderen: ${e instanceof Error ? e.message : String(e)}. Pending bevares.`
      )
      return { status: 'processed', reason: 'activity_stop_calendar_failed' }
    }
  }

  try {
    await deletePendingActivity(chatId)
  } catch (e) {
    console.error('kunne ikke rydde pending efter stop:', e)
    await sendMessage(
      chatId,
      `${inserted ? `Indsatte "${pending.activity_name}" i kalenderen, men k` : 'K'}unne ikke rydde pending aktivitet: ${e instanceof Error ? e.message : String(e)}`
    )
    return { status: 'processed', reason: 'activity_stop_clear_failed' }
  }

  if (inserted) {
    const startTime = fmtTimeColonCph(startDate)
    const endTime = fmtTimeColonCph(now)
    await sendMessage(
      chatId,
      `⏹️ Stoppet: ${pending.activity_name} (${startTime}–${endTime}). Ingen aktiv aktivitet nu.`
    )
    return { status: 'processed', reason: 'activity_stopped' }
  }
  if (durationMs <= 0) {
    await sendMessage(
      chatId,
      `⏹️ Stoppet: ${pending.activity_name}. Sprang kalenderen over (ugyldig varighed).`
    )
  } else {
    const hours = Math.round(durationMs / 3600000)
    await sendMessage(
      chatId,
      `⏹️ Stoppet: ${pending.activity_name}. Havde kørt ~${hours}t - for langt til at logge automatisk, så jeg sprang kalenderen over.`
    )
  }
  return { status: 'processed', reason: 'activity_stopped_no_calendar' }
}
