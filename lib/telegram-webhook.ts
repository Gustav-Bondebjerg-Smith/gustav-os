// Server-only Telegram webhook flow - INDGANGEN.
// Spejler scripts/telegram-poll.mjs, men uden load-env.mjs så det virker på Vercel.
//
// Splittet 2026-07-06 (var 2248 linjer). Denne fil ejer nu kun: update-claim/
// mark, veto, tekst-kommandoer (/ask, /), triagen og selve routing-cascaden i
// handleTelegramUpdate. Domænerne bor i:
//   lib/telegram-shared.ts    typer + Telegram-API + transskription + utils
//   lib/telegram-calendar.ts  propose/edit/delete + Haiku-matching
//   lib/telegram-activity.ts  tids-tracking start/stop + pending
//   lib/telegram-capture.ts   capture-flowet + auto-aftale/-opgave
//   lib/telegram-recall.ts    /ask + recall via second brain
//   lib/telegram-agent.ts     tool-calling-routerens dispatch (USE_AGENT_ROUTER)
import 'server-only'
import {
  extractJsonObject,
  nowInCopenhagen,
  requireEnv,
  sendChatAction,
  sendMessage,
  transcribeVoice,
  type HandleResult,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram-shared'
import {
  detectCalendarEditIntent,
  handleCalendarEdit,
  looksLikeCalendarEdit,
  type CalendarEditIntent,
} from './telegram-calendar'
import {
  detectActivityStart,
  detectActivityStop,
  handleActivityStart,
  handleActivityStop,
  looksLikeActivityStart,
  looksLikeActivityStop,
  type ActivityIntent,
} from './telegram-activity'
import { handleCapture } from './telegram-capture'
import { answerQuestion, handleAsk } from './telegram-recall'
import { dispatchViaAgent } from './telegram-agent'
import { getSupabase } from './supabase'

// Re-export så app/api/telegram/route.ts (og evt. scripts) kan blive ved med at
// importere alt fra ét sted.
export type { TelegramUpdate } from './telegram-shared'

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001'
const VETO_WORDS = new Set(['nej', 'veto', 'stop', 'annuller', 'annullér', 'cancel', 'skip', 'no'])

function isVetoMessage(text: string | undefined): boolean {
  if (!text) return false
  const normalized = text.trim().toLowerCase().replace(/[.,!?]/g, '')
  return VETO_WORDS.has(normalized)
}

export async function claimTelegramUpdate(update: TelegramUpdate): Promise<boolean> {
  const sb = getSupabase()
  const msg = update.message
  const { error } = await sb.from('telegram_updates').insert({
    update_id: update.update_id,
    status: 'processing',
    chat_id: msg?.chat.id ?? null,
    message_id: msg?.message_id ?? null,
  })

  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`telegram_updates insert-fejl: ${error.message}`)
}

export async function markTelegramUpdate(
  updateId: number,
  status: 'processed' | 'ignored' | 'failed',
  details: { reason?: string; error?: string } = {}
): Promise<void> {
  const sb = getSupabase()
  const { error } = await sb
    .from('telegram_updates')
    .update({
      status,
      reason: details.reason ?? null,
      error: details.error ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq('update_id', updateId)

  if (error) throw new Error(`telegram_updates update-fejl: ${error.message}`)
}

async function findVetoTarget(replyToMsgId?: number) {
  const sb = getSupabase()
  const nowIso = new Date().toISOString()

  if (replyToMsgId) {
    const { data, error } = await sb
      .from('actions')
      .select('id, type, payload, telegram_message_id')
      .eq('status', 'proposed')
      .eq('telegram_message_id', replyToMsgId)
      .limit(1)
    if (error) throw new Error(`findVetoTarget reply-fejl: ${error.message}`)
    if (data?.[0]) return data[0]
  }

  const { data, error } = await sb
    .from('actions')
    .select('id, type, payload, telegram_message_id')
    .eq('status', 'proposed')
    .gte('veto_deadline', nowIso)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(`findVetoTarget DB-fejl: ${error.message}`)
  return data?.[0] || null
}

async function handleVeto(msg: TelegramMessage): Promise<HandleResult> {
  const sb = getSupabase()
  const target = await findVetoTarget(msg.reply_to_message?.message_id)
  if (!target) {
    await sendMessage(msg.chat.id, 'Ingen forslag at vetoe lige nu.')
    return { status: 'processed', reason: 'veto_without_target' }
  }

  const { error: updErr } = await sb
    .from('actions')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
    .eq('id', target.id)
  if (updErr) throw new Error(`veto-update fejl: ${updErr.message}`)

  await sb.from('audit_log').insert({
    action: target.type || 'calendar_insert',
    payload: target.payload,
    status: 'vetoed',
    reason: `veto via Telegram: "${msg.text}"`,
  })

  const summary = target.payload?.summary || 'forslag'
  const verb = target.type === 'calendar_delete' ? 'Slettes ikke fra' : 'Skrives ikke i'
  await sendMessage(msg.chat.id, `Vetoet: "${summary}". ${verb} kalenderen.`)
  return { status: 'processed', reason: 'vetoed_action' }
}

// Hverdagssprog-router. Når INGEN af de hurtige regex-stier ramte, spørger vi
// Haiku bredt hvad beskeden vil - også uden faste kommando-ord, og også når
// teksten kommer fra en transskriberet voicenote. Returnerer kun en KATEGORI;
// den valgte handler bekræfter selv bagefter med sin egen detector (dobbelt-gate
// mod falske positiver), og alt usikkert falder tilbage til 'note' (= capture).
type MessageCategory =
  | 'activity_start'
  | 'activity_stop'
  | 'calendar_edit'
  | 'calendar_delete'
  | 'recall'
  | 'note'

async function triageMessageIntent(
  text: string,
  now: Date = new Date()
): Promise<MessageCategory> {
  if (!text || text.trim().length < 3) return 'note'

  const system = [
    'Du er router i Gustavs personlige assistent. Afgør hvad en kort dansk besked VIL - også når den er sagt eller skrevet i afslappet hverdagssprog uden faste kommando-ord.',
    `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen(now)}.`,
    '',
    'Svar KUN med JSON, intet andet: {"category": "<værdi>"}.',
    '',
    'Mulige værdier:',
    '- "activity_start": Gustav begynder en aktivitet LIGE NU og vil tidstage den. Fx "nu kaster jeg mig over anatomien", "så er det bøgerne", "i gang med frokost", "tid til en løbetur".',
    '- "activity_stop": Gustav holder op med eller pauser sin nuværende aktivitet LIGE NU uden at starte en ny. Fx "så er jeg færdig", "holder lige en pause", "det var det for i dag".',
    '- "calendar_edit": Gustav vil RETTE tiden på en aftale der ALLEREDE findes i dag (inkl. hans faste daglige søvn-begivenhed). Fx "træningen rykkede til tre", "mødet trak ud til halv fem", "lad os sige uni gik til nu", "tror jeg først går i seng kl 2 i nat" (= ret søvnens starttid), "jeg står op kl 7" (= ret søvnens sluttid).',
    '- "calendar_delete": Gustav vil FJERNE eller aflyse en aftale der allerede findes. Fx "den frokost ryger ud", "jeg dropper tandlægen i morgen".',
    '- "recall": Gustav SPØRGER assistenten om noget den kan slå op i hans egne tidligere noter, captures eller planer - typisk hvad han skulle huske, lave eller havde planlagt. Fx "hvad skulle jeg nå i dag", "hvad havde jeg af opgaver", "hvad sagde jeg om eksamen i går", "hvornår skulle jeg ringe til mor".',
    '- "note": ALT andet. En tanke, ide, observation, et retorisk/reflekterende spørgsmål, noget vagt eller fremtidigt, en besked der GIVER assistenten info ("husk at ..."), ELLER en NY aftale der skal oprettes. Dette er standardvalget.',
    '',
    'Regler:',
    '- activity_start/activity_stop KUN når handlingen sker NU - ikke fortid ("startede i morges") eller fremtid ("starter kl 15").',
    '- En NY aftale der skal i kalenderen ("møde med Anna fredag kl 14") er "note", IKKE calendar_edit. Edit og delete er kun ændring eller fjernelse af noget der allerede findes.',
    '- "recall" er KUN når Gustav beder om at FÅ noget at vide fra det han tidligere har gemt. En besked der GIVER ny info ("husk at ringe til mor") er "note". Et retorisk spørgsmål han bare tænker højt ("hvorfor er jeg så træt") er også "note".',
    '- Er du i tvivl, vælg "note". Det er altid sikkert at gemme noget som note.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: TRIAGE_MODEL,
      max_tokens: 50,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{ category?: string }>(raw)
  if (!parsed) return 'note'

  const valid: MessageCategory[] = [
    'activity_start',
    'activity_stop',
    'calendar_edit',
    'calendar_delete',
    'recall',
    'note',
  ]
  return valid.includes(parsed.category as MessageCategory)
    ? (parsed.category as MessageCategory)
    : 'note'
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<HandleResult> {
  const msg = update.message
  if (!msg) return { status: 'ignored', reason: 'no_message' }

  const allowedChat = requireEnv('TELEGRAM_CHAT_ID')
  if (String(msg.chat.id) !== String(allowedChat)) {
    console.warn(`Ignorerer Telegram-besked fra ukendt chat ${msg.chat.id}`)
    return { status: 'ignored', reason: 'unknown_chat' }
  }

  // Udled beskedens tekst FØR routingen. Voicenotes transskriberes her (én gang),
  // så transskriptionen løber gennem præcis samme intent-routing som tekst. Før
  // lå transskriptionen inde i handleCapture, så en voicenote aldrig nåede
  // activity/stop/edit-stierne og altid endte som note.
  let source: 'telegram_text' | 'telegram_voice'
  let text: string
  if (typeof msg.text === 'string' && msg.text.length > 0) {
    source = 'telegram_text'
    text = msg.text
  } else if (msg.voice) {
    source = 'telegram_voice'
    await sendChatAction(msg.chat.id)
    try {
      text = await transcribeVoice(msg.voice.file_id)
    } catch (e) {
      console.error('Transskription fejlede:', e)
      await sendMessage(msg.chat.id, 'Kunne ikke transskribere din voicenote. Prøv igen om lidt.')
      return { status: 'processed', reason: 'voice_transcription_failed' }
    }
    if (!text) {
      await sendMessage(msg.chat.id, 'Jeg fik ingen tekst ud af din voicenote. Prøv at tale lidt tydeligere.')
      return { status: 'processed', reason: 'empty_voice_transcript' }
    }
  } else {
    await sendMessage(msg.chat.id, 'Jeg kan tage tekst og voicenotes. Send en af delene.')
    return { status: 'processed', reason: 'unsupported_message' }
  }

  // Veto, /ask og /-kommandoer er rene tekst-kommandoer. En voicenote skal aldrig
  // kunne vetoe eller ramme en slash-kommando (Whisper kan transskribere "nej"
  // eller "/ask" upålideligt), så de gælder kun når kilden faktisk er tekst.
  if (source === 'telegram_text') {
    if (isVetoMessage(text)) return handleVeto(msg)
    if (/^\/ask(\s|$)/i.test(text)) return handleAsk(msg)
    if (text.startsWith('/')) {
      await sendMessage(
        msg.chat.id,
        'Hej Gustav. Send tekst eller voicenote til capture. Brug /ask <spørgsmål> til at spørge din second brain.'
      )
      return { status: 'processed', reason: 'command_help' }
    }
  }

  // Tool-calling router bag flag. Når aktivt erstatter ét Sonnet-kald hele
  // regex+triage-cascaden nedenfor og ruter til samme handlers (veto/kalender
  // uændret). Rul tilbage ved at fjerne env-var USE_AGENT_ROUTER. Veto/ask/slash
  // ovenfor er bevidst tjekket FØR, så de er ens i begge tilstande.
  if (process.env.USE_AGENT_ROUTER === '1') {
    return dispatchViaAgent(msg, text, source)
  }

  const messageTime = msg.date ? new Date(msg.date * 1000) : new Date()

  // ---- Hurtige regex-stier (uændret, live-verificeret adfærd) ----
  // Rammer en konkret kommando-frase et af mønstrene, går vi direkte til den
  // rette detector og sparer triage-kaldet nedenfor.

  // Kalender-edit går uden om capture/action/veto: Gustav beder eksplicit om at
  // rette en eksisterende event, så vi PATCHer Google Calendar direkte.
  if (looksLikeCalendarEdit(text)) {
    let intent: CalendarEditIntent = { isEditIntent: false }
    try {
      intent = await detectCalendarEditIntent(text, messageTime)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await sendMessage(msg.chat.id, `Kunne ikke forstå kalender-rettelsen lige nu: ${error}`)
      return { status: 'processed', reason: 'calendar_edit_intent_failed' }
    }
    if (intent.isEditIntent) return handleCalendarEdit(msg, intent, text)
  }

  // Aktivitets-start har forrang over almindelig capture.
  if (looksLikeActivityStart(text)) {
    let intent: ActivityIntent = { isActivityStart: false, activityName: null }
    try {
      intent = await detectActivityStart(text)
    } catch (e) {
      console.error('activity intent detection fejlede (falder tilbage til capture):', e)
    }
    if (intent.isActivityStart && intent.activityName) {
      return handleActivityStart(msg, intent.activityName)
    }
  }

  // Aktivitets-stop: lukker den aktive aktivitet uden at starte en ny. Tjekkes
  // EFTER start (en "starter på"-besked rammer aldrig stop-prefilteret). Bemærk:
  // bare "stop" er et veto-ord og er allerede fanget højere oppe.
  if (looksLikeActivityStop(text)) {
    let isStop = false
    try {
      isStop = await detectActivityStop(text)
    } catch (e) {
      console.error('activity stop detection fejlede (falder tilbage til capture):', e)
    }
    if (isStop) return handleActivityStop(msg)
  }

  // ---- Fallback: hverdagssprog uden faste trigger-ord ----
  // Ingen regex-sti ramte (eller deres detector sagde nej). Spørg Haiku bredt
  // hvad beskeden vil, og rut til den rette handler. Hver handling bekræftes
  // STADIG af sin egen detector (dobbelt-gate mod falske positiver). Alt usikkert
  // - inkl. triage-fejl - falder til capture, præcis som før.
  let category: MessageCategory = 'note'
  try {
    category = await triageMessageIntent(text, messageTime)
  } catch (e) {
    console.error('intent-triage fejlede (falder tilbage til capture):', e)
  }

  if (category === 'activity_start') {
    let intent: ActivityIntent = { isActivityStart: false, activityName: null }
    try {
      intent = await detectActivityStart(text)
    } catch (e) {
      console.error('activity start (fallback) fejlede:', e)
    }
    if (intent.isActivityStart && intent.activityName) {
      return handleActivityStart(msg, intent.activityName)
    }
  } else if (category === 'activity_stop') {
    let isStop = false
    try {
      isStop = await detectActivityStop(text)
    } catch (e) {
      console.error('activity stop (fallback) fejlede:', e)
    }
    if (isStop) return handleActivityStop(msg)
  } else if (category === 'calendar_edit') {
    let intent: CalendarEditIntent = { isEditIntent: false }
    try {
      intent = await detectCalendarEditIntent(text, messageTime)
    } catch (e) {
      console.error('calendar edit (fallback) fejlede:', e)
    }
    if (intent.isEditIntent) return handleCalendarEdit(msg, intent, text)
  } else if (category === 'recall') {
    // Read-only opslag i second brain. Voice + tekst rammer her, så
    // hverdagssprogs-spørgsmål ("hvad skulle jeg nå i dag") virker uden /ask.
    return answerQuestion(msg.chat.id, text, 'recall')
  } else if (category === 'calendar_delete') {
    return handleCapture(msg, text, source, { forceDelete: true })
  }

  return handleCapture(msg, text, source)
}
