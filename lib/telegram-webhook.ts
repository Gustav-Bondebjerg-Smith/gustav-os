// Server-only Telegram webhook flow.
// Spejler scripts/telegram-poll.mjs, men uden load-env.mjs så det virker på Vercel.
import 'server-only'
import { getSupabase } from './supabase'
import { ask } from './ask'
import { fmtDate, fmtRange, fmtDay, startOfTodayCph, endOfTodayCph } from './format'
import type { Chunk } from './ask-types'
import { storeChunk } from './memory'
import { getEvents, insertEvent, updateEvent, type GoogleCalendarEvent } from './calendar'
import { classify, VALID_AREAS, type Classification } from './capture'

const PROPOSAL_MODEL = 'claude-haiku-4-5-20251001'
const ACTIVITY_DETECTOR_MODEL = 'claude-haiku-4-5-20251001'
const CALENDAR_EDIT_MODEL = 'claude-haiku-4-5-20251001'
const TRIAGE_MODEL = 'claude-haiku-4-5-20251001'
const WHISPER_MODEL = 'whisper-1'
const VETO_WORDS = new Set(['nej', 'veto', 'stop', 'annuller', 'annullér', 'cancel', 'skip', 'no'])

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

// Kalender-edit prefilter. Matcher kun sandsynlige edit-kommandoer før Haiku
// afgør intent, så almindelige captures ikke betaler for et model-kald.
const CALENDAR_EDIT_TRIGGER = /(?<![\p{L}\p{N}])(?:ret(?:te|ter|tede)?|ændr(?:e|er|ede)?|flyt(?:te|ter|tede)?|startede[\s\S]{0,80}først|slut(?:tede|ter|tid)?|(?:gik|går) til|skubbede[\s\S]{0,80}til)(?![\p{L}\p{N}])/iu

type TelegramChat = {
  id: number
}

type TelegramVoice = {
  file_id: string
}

type TelegramMessage = {
  message_id: number
  date?: number // unix-sekunder; hvornår beskeden blev sendt (bruges som aktivitets-tidsstempel)
  chat: TelegramChat
  text?: string
  voice?: TelegramVoice
  reply_to_message?: {
    message_id: number
  }
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string }

type SentMessage = {
  message_id: number
}

type TelegramFile = {
  file_path: string
}

type CalendarProposal = {
  summary: string
  start: string
  end: string
  location?: string
}

type CalendarDeletion = {
  event_id: string
  summary: string
  start: string
  end: string
  location?: string
}

type CalendarEditType = 'end' | 'start' | 'shift'

type CalendarEditIntent =
  | {
      isEditIntent: true
      eventHint: string
      editType: CalendarEditType
      newTime: string
    }
  | { isEditIntent: false }

type EditableCalendarEvent = GoogleCalendarEvent & {
  id: string
  start: { dateTime: string }
  end: { dateTime: string }
}

// Slet-intent regex: matcher hele ord, ikke substrings, for at undgå false positives
// ("aftal" i "aftale" matcher fx ikke). Bruger word boundaries.
const DELETE_INTENT = /\b(slet|fjern|aflys|aflyse|aflyst|cancel|drop)\b/i

function hasDeleteIntent(text: string | null | undefined): boolean {
  if (!text) return false
  return DELETE_INTENT.test(text)
}

type HandleResult = {
  status: 'processed' | 'ignored'
  reason?: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Mangler ${name} i env`)
  return value
}

function isVetoMessage(text: string | undefined): boolean {
  if (!text) return false
  const normalized = text.trim().toLowerCase().replace(/[.,!?]/g, '')
  return VETO_WORDS.has(normalized)
}

async function tg<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await r.json()
  return json as TelegramApiResponse<T>
}

async function sendMessage(chatId: number, text: string): Promise<SentMessage> {
  const sent = await tg<SentMessage>('sendMessage', { chat_id: chatId, text })
  if (!sent.ok) {
    throw new Error(`Telegram sendMessage fejl: ${sent.description || sent.error_code || 'ukendt'}`)
  }
  return sent.result
}

async function sendChatAction(chatId: number): Promise<void> {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' })
  } catch {
    // Ikke kritisk. Chat action er kun UX.
  }
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

async function transcribeAudio(bytes: ArrayBuffer, filename = 'voice.oga'): Promise<string> {
  const key = requireEnv('OPENAI_API_KEY')
  const form = new FormData()
  form.append('file', new Blob([bytes]), filename)
  form.append('model', WHISPER_MODEL)
  form.append('language', 'da')

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!r.ok) throw new Error(`Whisper HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  return (j.text || '').trim()
}

async function transcribeVoice(fileId: string): Promise<string> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN')
  const file = await tg<TelegramFile>('getFile', { file_id: fileId })
  if (!file.ok) {
    throw new Error(`getFile fejlede: ${file.description || file.error_code || 'ukendt'}`)
  }

  const filePath = file.result.file_path
  const resp = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!resp.ok) throw new Error(`Download fejlede: HTTP ${resp.status}`)

  const bytes = await resp.arrayBuffer()
  const name = filePath.split('/').pop() || 'voice.oga'
  return transcribeAudio(bytes, name)
}

function nowInCopenhagen(value: Date = new Date()): string {
  return new Intl.DateTimeFormat('da-DK', {
    timeZone: 'Europe/Copenhagen',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

async function proposeCalendarEvent(captureContent: string): Promise<CalendarProposal | null> {
  if (!captureContent || captureContent.trim().length < 3) return null

  const system = [
    'Du udleder en konkret kalender-aftale fra en kort dansk besked.',
    `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen()}.`,
    '',
    'Svar KUN med JSON, intet andet. To mulige svar:',
    '',
    'Hvis beskeden indeholder en KONKRET aftale med specifik tid:',
    '{"propose": true, "summary": "...", "start": "YYYY-MM-DDTHH:MM:00", "end": "YYYY-MM-DDTHH:MM:00", "location": "..."}',
    '',
    'Hvis IKKE (vag tid, blot en tanke, ingen tid, fortidig hændelse osv.):',
    '{"propose": false, "reason": "kort dansk forklaring"}',
    '',
    'Regler:',
    '- start/end er NAIVE datetime uden timezone-offset (kalenderen sætter Europe/Copenhagen).',
    '- summary: kort dansk titel, max 6 ord, første bogstav stort.',
    '- Hvis kun starttid og ingen sluttid: sæt end = start + 1 time.',
    '- "fredag" uden uge = den FØRSTKOMMENDE fredag fra nu.',
    '- "i morgen" = dagen efter dagens dato i København.',
    '- Hvis tiden er vag ("snart", "engang", "i næste uge" uden dag), eller hvis det er en ren tanke/note -> propose: false.',
    '- Hvis tiden allerede er passeret (fortidig) -> propose: false.',
    '- location: kun hvis den er nævnt eksplicit i beskeden. Ellers udelad feltet.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PROPOSAL_MODEL,
      max_tokens: 300,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: captureContent }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: {
    propose?: boolean
    summary?: string
    start?: string
    end?: string
    location?: string
  }

  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (!parsed.propose || !parsed.summary || !parsed.start || !parsed.end) return null
  return {
    summary: parsed.summary,
    start: parsed.start,
    end: parsed.end,
    ...(parsed.location ? { location: parsed.location } : {}),
  }
}

// Henter events fra START af i dag (CPH) til N dage frem. Vigtigt at gå
// tilbage til dagens start så vi også fanger events der allerede er afsluttet
// i dag - ellers kan vi ikke slette en aftale fra fx kl 19 hvis kl er 22.
async function loadCandidateEvents(daysAhead: number): Promise<GoogleCalendarEvent[]> {
  const from = startOfTodayCph()
  const to = new Date(Date.now() + daysAhead * 24 * 3600 * 1000)
  const events = await getEvents(from, to)
  // Filtrér events uden id (kan ikke slettes alligevel).
  return events.filter((e): e is GoogleCalendarEvent & { id: string } => !!e.id)
}

type DeleteAttempt =
  | { match: CalendarDeletion; candidates?: never; reason?: never }
  | { match: null; candidates: CandidateSummary[]; reason: string }

type CandidateSummary = {
  summary: string
  start?: string
  end?: string
  location?: string
}

// Lader Haiku finde et matchende kalender-event ud fra slet-beskeden.
// Returnerer enten match (klar til action) eller null + en kandidat-liste
// så vi kan vise brugeren hvad vi så på.
async function proposeCalendarDelete(captureContent: string): Promise<DeleteAttempt> {
  if (!captureContent || captureContent.trim().length < 3) {
    return { match: null, candidates: [], reason: 'beskeden er for kort' }
  }

  let candidates: GoogleCalendarEvent[]
  try {
    candidates = await loadCandidateEvents(14)
  } catch (e) {
    console.error('Kunne ikke hente kalender-events til delete-forslag:', e)
    return { match: null, candidates: [], reason: 'kunne ikke hente kalender' }
  }
  if (candidates.length === 0) {
    return { match: null, candidates: [], reason: 'ingen events i de næste 14 dage' }
  }

  // Tag op til 200 så vi rammer 99%-tilfælde. Haiku har plads i context.
  const list = candidates.slice(0, 200).map((ev, i) => ({
    idx: i,
    id: ev.id,
    summary: ev.summary || '(uden titel)',
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    location: ev.location,
  }))

  const candidateSummaries: CandidateSummary[] = list.slice(0, 5).map((e) => ({
    summary: e.summary,
    start: e.start,
    end: e.end,
    ...(e.location ? { location: e.location } : {}),
  }))

  const system = [
    'Du finder det ene kalender-event der bedst matcher en kort dansk slet-besked.',
    `Lige nu i København: ${nowInCopenhagen()}.`,
    '',
    'Du får en JSON-liste af events. Vælg DET MEST SANDSYNLIGE match - også selvom det ikke er perfekt.',
    'Vær GENERØS: en titel-overlap som "spise med skat" matcher beskeden "slet aftalen spise med skat".',
    'Returner kun null hvis INTET event har nogen som helst relation til beskeden.',
    '',
    'Svar KUN med JSON:',
    '{"idx": <tal fra listen>} hvis nogen rimelig kandidat findes',
    '{"idx": null, "reason": "kort dansk forklaring"} ellers',
    '',
    'Matching-regler:',
    '- Titel-substring tæller som match ("skat" matcher "spise med skat").',
    '- Tid + dato-anker ("kl 19", "i morgen") strammer matchet hvis flere events har lignende titel.',
    '- Hvis flere events matcher: vælg det tætteste på nu (fremtid > nyligt afsluttet).',
    '- Ignorer fyldord som "aftalen", "mødet", "begivenheden" i beskeden - de er bare grammatik.',
  ].join('\n')

  const userPayload = JSON.stringify({
    besked: captureContent,
    events: list.map((e) => ({
      idx: e.idx,
      summary: e.summary,
      start: e.start,
      end: e.end,
      location: e.location ?? null,
    })),
  })

  let parsed: { idx?: number | null; reason?: string }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PROPOSAL_MODEL,
        max_tokens: 200,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: userPayload }],
      }),
    })
    if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)
    const j = await r.json()
    const raw = (j.content?.[0]?.text || '').trim()
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch (e) {
    console.error('Haiku-kald til delete-match fejlede:', e)
    return { match: null, candidates: candidateSummaries, reason: 'Haiku-fejl' }
  }

  if (parsed.idx === null || parsed.idx === undefined) {
    return {
      match: null,
      candidates: candidateSummaries,
      reason: parsed.reason || 'Haiku fandt ikke match',
    }
  }
  const chosen = list[parsed.idx]
  if (!chosen || !chosen.id || !chosen.start || !chosen.end) {
    return { match: null, candidates: candidateSummaries, reason: 'valgt event mangler felter' }
  }

  return {
    match: {
      event_id: chosen.id,
      summary: chosen.summary,
      start: chosen.start,
      end: chosen.end,
      ...(chosen.location ? { location: chosen.location } : {}),
    },
  }
}

function looksLikeCalendarEdit(text: string | null | undefined): boolean {
  if (!text) return false
  return CALENDAR_EDIT_TRIGGER.test(text)
}

async function detectCalendarEditIntent(
  text: string,
  now: Date = new Date()
): Promise<CalendarEditIntent> {
  if (!text || text.trim().length < 3) return { isEditIntent: false }

  const system = [
    'Du klassificerer om en kort dansk Telegram-besked beder om at RETTE, ÆNDRE eller FLYTTE en eksisterende kalenderbegivenhed.',
    `Lige nu i København (Europe/Copenhagen): ${nowInCopenhagen(now)}. Aktuel tid som HH:MM: ${fmtTimeColonCph(now)}.`,
    'Svar KUN med JSON, intet andet.',
    '',
    'Hvis beskeden er en kalender-edit:',
    '{"isEditIntent": true, "eventHint": "kort titel/søgeord", "editType": "end|start|shift", "newTime": "HH:MM"}',
    '',
    'Hvis ikke:',
    '{"isEditIntent": false}',
    '',
    'editType-regler:',
    '- "end": brug når brugeren retter sluttiden. Eksempler: "unilæsning sluttede 13:30", "X gik til 15:00", "X går til nu", "ret sluttid til 16:15".',
    '- "start": brug når brugeren retter starttiden, men sluttiden bevares. Eksempler: "jeg startede AI arbejde først 18:20", "ret starttid på X til 09:30".',
    '- "shift": brug når hele eventet flyttes, og varigheden skal bevares. Eksempler: "flyt træning til 14:30", "skubbede læsning til 11:00", "ændre møde til 10:00" hvis der ikke står start/slut.',
    '',
    'Søvn/sengetid (Gustav har en fast daglig søvn-begivenhed, typisk om natten):',
    '- "går i seng kl X", "sover først kl X", "i seng ved/kl X" -> editType "start", eventHint "søvn".',
    '- "står op kl X", "vågner kl X", "sover til kl X" -> editType "end", eventHint "søvn".',
    '- Gælder kun med et konkret klokkeslæt. Uden tid (fx "jeg sover dårligt") -> false.',
    '',
    'eventHint er kun navnet på eventet, uden ord som ret/ændre/flyt/startede/først/sluttede/gik/går til/skubbede/til/klokken og uden tidspunkt.',
    'newTime skal være 24-timers HH:MM, fx "09:05" eller "18:20".',
    `Hvis brugeren skriver "nu", skal newTime være den aktuelle HH:MM ovenfor: "${fmtTimeColonCph(now)}".`,
    '',
    'Returner false hvis beskeden er en ny aftale, en slet-besked, en aktivitet-start/stop uden kalender-edit, en note/ide/refleksion, eller hvis der ikke er en konkret tid.',
  ].join('\n')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CALENDAR_EDIT_MODEL,
      max_tokens: 160,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: {
    isEditIntent?: boolean
    eventHint?: string
    editType?: string
    newTime?: string
  }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { isEditIntent: false }
  }

  const editTypes: CalendarEditType[] = ['end', 'start', 'shift']
  const editType = parsed.editType
  const newTime = parsed.newTime ? normalizeEditTime(parsed.newTime, now) : null
  const eventHint = parsed.eventHint?.trim()
  if (
    !parsed.isEditIntent ||
    !eventHint ||
    !newTime ||
    !editType ||
    !editTypes.includes(editType as CalendarEditType)
  ) {
    return { isEditIntent: false }
  }

  return {
    isEditIntent: true,
    eventHint,
    editType: editType as CalendarEditType,
    newTime,
  }
}

// Henter events der kan redigeres: fra lidt før dagens start (CPH) til ind i
// MORGEN formiddag. Det ekstra halve døgn fanger en søvn-/natbegivenhed der
// starter efter midnat ("i nat går jeg i seng kl 2") - dens dato er teknisk i
// morgen, så det gamle "kun i dag"-vindue missede den. matchCalendarEditEvent
// vælger så den rette instans ud fra beskedens "i nat"/"i dag"-spor.
async function loadEditableEvents(): Promise<EditableCalendarEvent[]> {
  const from = new Date(startOfTodayCph().getTime() - 2 * 3600000)
  const to = new Date(endOfTodayCph().getTime() + 12 * 3600000)
  const events = await getEvents(from, to)
  return events.filter(
    (e): e is EditableCalendarEvent => !!e.id && !!e.start?.dateTime && !!e.end?.dateTime
  )
}

async function matchCalendarEditEvent(
  eventHint: string,
  candidates: EditableCalendarEvent[],
  message: string
): Promise<EditableCalendarEvent | null> {
  if (!eventHint || candidates.length === 0) return null

  const list = candidates.slice(0, 200).map((ev) => ({
    event_id: ev.id,
    summary: ev.summary || '(uden titel)',
    start: ev.start.dateTime,
    end: ev.end.dateTime,
    location: ev.location ?? null,
  }))

  const system = [
    'Du matcher en kort dansk besked + eventHint til præcis én kalenderbegivenhed fra et vindue omkring nu (i dag plus i nat/i morgen tidlig).',
    `Lige nu i København: ${nowInCopenhagen()}.`,
    '',
    'Du får Gustavs oprindelige "besked", et "eventHint" og en JSON-liste af events (hver med start/end-dato). Vælg det ene event beskeden handler om.',
    'Vær generøs med små titel-forskelle og bøjninger, men returner null hvis intet event har en reel relation.',
    '',
    'Svar KUN med JSON:',
    '{"event_id": "id fra listen"} hvis der er et rimeligt match',
    '{"event_id": null, "reason": "kort dansk forklaring"} ellers',
    '',
    'Matching-regler:',
    '- Titel-overlap er vigtigst: "uni", "unilæsning" og "læsning" kan matche samme event; "seng"/"sove" matcher "søvn".',
    '- Hvis FLERE events har samme/lignende titel (en tilbagevendende begivenhed som søvn findes både i dag og i nat/i morgen), vælg den rette INSTANS ud fra beskeden: brug "i nat"/"i dag"/"i morgen", det nævnte klokkeslæt og tidspunktet nu. Fremadrettet hensigt ("går i seng kl 2 i nat") -> den førstkommende instans fra nu. Korrektion af noget der lige er sket -> den seneste forbi-instans.',
    '- Ignorer fyldord som "aftale", "event", "møde", "arbejde" hvis resten af hintet matcher bedre.',
  ].join('\n')

  const userPayload = JSON.stringify({ besked: message, eventHint, events: list })
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CALENDAR_EDIT_MODEL,
      max_tokens: 160,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: userPayload }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${await r.text()}`)

  const j = await r.json()
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: { event_id?: string | null }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (!parsed.event_id) return null
  return candidates.find((event) => event.id === parsed.event_id) || null
}

type CalendarEditComputation = {
  patch: {
    start?: Date
    end?: Date
  }
  start: Date
  end: Date
}

function computeCalendarEdit(
  event: EditableCalendarEvent,
  intent: Extract<CalendarEditIntent, { isEditIntent: true }>
): CalendarEditComputation {
  const currentStart = new Date(event.start.dateTime)
  const currentEnd = new Date(event.end.dateTime)
  const newTime = normalizeEditTime(intent.newTime)
  if (!newTime) throw new Error(`Ugyldig tid: ${intent.newTime}`)

  if (intent.editType === 'end') {
    const endDay = cphYmd(event.end.dateTime)
    let end = cphDateTimeOnDay(endDay, newTime)
    if (end.getTime() <= currentStart.getTime()) {
      end = cphDateTimeOnDay(addDaysToYmd(endDay, 1), newTime)
    }
    if (end.getTime() <= currentStart.getTime()) {
      throw new Error('Den nye sluttid skal være efter starttid.')
    }
    return { patch: { end }, start: currentStart, end }
  }

  if (intent.editType === 'start') {
    const startDay = cphYmd(event.start.dateTime)
    let start = cphDateTimeOnDay(startDay, newTime)
    // Lander den nye starttid efter sluttid, ligger sengetiden før midnat (fx
    // "i seng kl 23" på en søvn-begivenhed der ellers starter 01:00 dagen efter).
    // Prøv da dagen FØR, så blokken stadig er sammenhængende.
    if (start.getTime() >= currentEnd.getTime()) {
      start = cphDateTimeOnDay(addDaysToYmd(startDay, -1), newTime)
    }
    if (start.getTime() >= currentEnd.getTime()) {
      throw new Error('Den nye starttid skal være før sluttid.')
    }
    return { patch: { start }, start, end: currentEnd }
  }

  const durationMs = currentEnd.getTime() - currentStart.getTime()
  if (durationMs <= 0) throw new Error('Eventet har en ugyldig varighed.')
  const start = cphDateTimeOnDay(cphYmd(event.start.dateTime), newTime)
  const end = new Date(start.getTime() + durationMs)
  return { patch: { start, end }, start, end }
}

function normalizeEditTime(value: string, now?: Date): string | null {
  const normalized = value.trim().replace('.', ':')
  if (/^(nu|now)$/i.test(normalized)) return now ? fmtTimeColonCph(now) : null
  const match = normalized.match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
  if (!match) return null
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

function cphYmd(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof value === 'string' ? new Date(value) : value)
}

function cphDateTimeOnDay(ymd: string, hhmm: string): Date {
  return new Date(withCphOffset(`${ymd}T${hhmm}:00`))
}

function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0))
  const yyyy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatCalendarEditConfirmation(
  summary: string | undefined,
  start: Date,
  end: Date
): string {
  return `✅ Rettet: ${summary || '(uden titel)'} (${fmtTimeColonCph(start)}–${fmtTimeColonCph(end)})`
}

async function handleCalendarEdit(
  msg: TelegramMessage,
  intent: Extract<CalendarEditIntent, { isEditIntent: true }>,
  text: string
): Promise<HandleResult> {
  const chatId = msg.chat.id
  await sendChatAction(chatId)

  let candidates: EditableCalendarEvent[] = []
  try {
    candidates = await loadEditableEvents()
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke hente kalenderen lige nu: ${error}`)
    return { status: 'processed', reason: 'calendar_edit_load_failed' }
  }

  let event: EditableCalendarEvent | null = null
  try {
    event = await matchCalendarEditEvent(intent.eventHint, candidates, text)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke matche kalender-event lige nu: ${error}`)
    return { status: 'processed', reason: 'calendar_edit_match_failed' }
  }

  if (!event) {
    await sendMessage(chatId, `Kunne ikke finde '${intent.eventHint}' i kalenderen i dag.`)
    return { status: 'processed', reason: 'calendar_edit_no_match' }
  }

  let computed: CalendarEditComputation
  try {
    computed = computeCalendarEdit(event, intent)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke beregne den nye tid: ${error}`)
    return { status: 'processed', reason: 'calendar_edit_time_failed' }
  }

  try {
    const updated = await updateEvent(event.id, computed.patch)
    const start = updated.start?.dateTime ? new Date(updated.start.dateTime) : computed.start
    const end = updated.end?.dateTime ? new Date(updated.end.dateTime) : computed.end
    await sendMessage(
      chatId,
      formatCalendarEditConfirmation(updated.summary || event.summary, start, end)
    )
    return { status: 'processed', reason: 'calendar_edit_updated' }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke rette kalenderen: ${error}`)
    return { status: 'processed', reason: 'calendar_edit_update_failed' }
  }
}

function formatCandidates(candidates: CandidateSummary[]): string {
  if (!candidates.length) return ''
  const lines = candidates.map((c, i) => {
    const day = c.start ? fmtDay(c.start) : ''
    const range = c.start && c.end ? fmtRange(c.start, c.end) : ''
    const when = day || range ? ` (${[day, range].filter(Boolean).join(' ')})` : ''
    return `${i + 1}. ${c.summary}${when}`
  })
  return 'Det jeg så i kalenderen:\n' + lines.join('\n')
}

function formatProposal(p: CalendarProposal, vetoMinutes = 10): string {
  // p.start/end er naive CPH-strenge fra Haiku ("2026-05-29T14:00:00").
  // Suffix med korrekt offset for at få fmtRange/fmtDay til at vise CPH-tid
  // korrekt selv på Vercel (UTC).
  const sIso = withCphOffset(p.start)
  const eIso = withCphOffset(p.end)
  const day = fmtDay(sIso)
  const range = fmtRange(sIso, eIso)
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return [
    `Forslag: ${p.summary}`,
    `Tid: ${day} kl. ${range}${loc}`,
    '',
    `Skriv "nej" inden ${vetoMinutes} min for at vetoe. Ellers skriver jeg den i kalenderen.`,
  ].join('\n')
}

// Slet-forslag. p.start/end kommer fra Google (absolute ISO med offset),
// så vi kan bruge fmtRange direkte uden offset-suffix.
function formatDeletion(p: CalendarDeletion, vetoMinutes = 10): string {
  const day = fmtDay(p.start)
  const range = fmtRange(p.start, p.end)
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return [
    `Slet: ${p.summary}`,
    `Tid: ${day} kl. ${range}${loc}`,
    '',
    `Skriv "nej" inden ${vetoMinutes} min for at vetoe. Ellers slettes den fra kalenderen.`,
  ].join('\n')
}

// Vedhæfter Europe/Copenhagen-offset til en naive datetime-streng som
// "2026-05-29T14:00:00", så new Date() fortolker den korrekt på Vercel (UTC).
// Bruger Intl til at finde aktuel offset (1 om vinteren, 2 om sommeren).
function withCphOffset(naive: string): string {
  if (/[+-]\d\d:?\d\d$/.test(naive) || naive.endsWith('Z')) return naive
  // Find offset på den dato strengen beskriver.
  const datePart = naive.slice(0, 10) // "YYYY-MM-DD"
  const noonUtcMs = Date.UTC(
    Number(datePart.slice(0, 4)),
    Number(datePart.slice(5, 7)) - 1,
    Number(datePart.slice(8, 10)),
    12, 0, 0
  )
  const cphHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Copenhagen',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(noonUtcMs))
  )
  const offsetHours = cphHour - 12
  const sign = offsetHours >= 0 ? '+' : '-'
  const hh = String(Math.abs(offsetHours)).padStart(2, '0')
  return `${naive}${sign}${hh}:00`
}

function formatSources(sources: Chunk[]): string {
  if (!sources.length) return ''
  const lines = sources.map((c, i) => {
    const sim = c.similarity.toFixed(2)
    const preview = c.content.length > 80 ? c.content.slice(0, 80) + '...' : c.content
    return `[${i + 1}] ${fmtDate(c.created_at)} (sim=${sim}): ${preview}`
  })
  return 'Kilder:\n' + lines.join('\n')
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

// Kerne-recall: slår op i second brain og svarer. Bruges af både /ask
// (tekst-kommando) og recall-kategorien i triagen (hverdagssprog + voice).
// label giver audit-reason: "ask" -> ask_answered/ask_failed, "recall" -> recall_*.
// Read-only, så ingen dobbelt-gate: triagen kan rute hertil på egen hånd.
async function answerQuestion(
  chatId: number,
  question: string,
  label: 'ask' | 'recall'
): Promise<HandleResult> {
  await sendChatAction(chatId)
  try {
    const { answer, sources } = await ask(question)
    const srcText = sources.length ? '\n\n' + formatSources(sources) : ''
    await sendMessage(chatId, answer + srcText)
    return { status: 'processed', reason: `${label}_answered` }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await sendMessage(chatId, `Kunne ikke svare lige nu: ${error}`)
    return { status: 'processed', reason: `${label}_failed` }
  }
}

async function handleAsk(msg: TelegramMessage): Promise<HandleResult> {
  const question = (msg.text || '').replace(/^\/ask\s*/i, '').trim()
  if (!question) {
    await sendMessage(
      msg.chat.id,
      'Brug: /ask <spørgsmål>. Fx: /ask hvad var jeg ved at glemme i går?'
    )
    return { status: 'processed', reason: 'empty_ask' }
  }
  return answerQuestion(msg.chat.id, question, 'ask')
}

// content + source udledes nu af handleTelegramUpdate (voice transskriberes dér,
// så transskriptionen kan løbe gennem intent-routingen før den ender her).
// opts.forceDelete sættes når triagen har set en slet-intent i hverdagssprog,
// hvor DELETE_INTENT-regexen nedenfor ikke ville ramme.
async function handleCapture(
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
  const vetoMinutes = Number(process.env.VETO_MINUTES) || 10
  const deadlineIso = new Date(Date.now() + vetoMinutes * 60 * 1000).toISOString()

  if (opts.forceDelete || hasDeleteIntent(content)) {
    let attempt: DeleteAttempt = { match: null, candidates: [], reason: 'flow fejlede' }
    try {
      attempt = await proposeCalendarDelete(content)
    } catch (e) {
      console.error('delete-forslag fejlede (ikke kritisk):', e)
    }
    if (attempt.match) {
      try {
        const sent = await sendMessage(msg.chat.id, formatDeletion(attempt.match, vetoMinutes))
        const { error: actErr } = await sb.from('actions').insert({
          type: 'calendar_delete',
          payload: attempt.match,
          source_capture_id: captureId,
          telegram_message_id: sent.message_id,
          veto_deadline: deadlineIso,
        })
        if (actErr) console.error('delete-forslag kunne ikke gemmes som action:', actErr.message)
      } catch (e) {
        console.error('delete-proposal-besked kunne ikke sendes:', e)
        await sendMessage(msg.chat.id, reply)
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
      console.error('forslag fejlede (ikke kritisk):', e)
    }
  }

  if (proposal) {
    try {
      const sent = await sendMessage(msg.chat.id, formatProposal(proposal, vetoMinutes))
      const { error: actErr } = await sb.from('actions').insert({
        type: 'calendar_insert',
        payload: proposal,
        source_capture_id: captureId,
        telegram_message_id: sent.message_id,
        veto_deadline: deadlineIso,
      })
      if (actErr) console.error('forslag kunne ikke gemmes som action:', actErr.message)
    } catch (e) {
      console.error('proposal-besked kunne ikke sendes:', e)
      await sendMessage(msg.chat.id, reply)
    }
  } else {
    await sendMessage(msg.chat.id, reply)
  }

  return { status: 'processed', reason: 'capture_saved' }
}

// Tids-tracking-events tagges i description så de kan filtreres/findes i kalenderen.
const TRACKING_EVENT_TAG = 'Tids-tracking via Telegram'

// Hvis en aktivitet har "kørt" længere end dette (typisk fordi Gustav glemte at
// skifte, fx natten over), springer vi kalender-indsætningen over, så vi ikke
// forurener kalenderen med en kæmpe forkert blok. Tunes via MAX_ACTIVITY_HOURS.
const MAX_ACTIVITY_MS = (Number(process.env.MAX_ACTIVITY_HOURS) || 16) * 3600000

// Tids-tracking via aktivitets-start.
// Flow: Gustav skriver "starter på X". Hvis der allerede er en pending aktivitet
// for hans chat, lukkes den ved at indsætte en kalenderbegivenhed fra dens
// started_at til nu. Den nye aktivitet gemmes som pending.

type ActivityIntent = {
  isActivityStart: boolean
  activityName: string | null
}

type PendingActivityRow = {
  chat_id: number
  activity_name: string
  started_at: string
}

function looksLikeActivityStart(text: string | null | undefined): boolean {
  if (!text) return false
  return ACTIVITY_TRIGGER.test(text)
}

function looksLikeActivityStop(text: string | null | undefined): boolean {
  if (!text) return false
  return ACTIVITY_STOP_TRIGGER.test(text)
}

async function detectActivityStart(text: string): Promise<ActivityIntent> {
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
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: { isActivityStart?: boolean; activityName?: string | null }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { isActivityStart: false, activityName: null }
  }
  if (!parsed.isActivityStart || !parsed.activityName) {
    return { isActivityStart: false, activityName: null }
  }
  return { isActivityStart: true, activityName: parsed.activityName.trim() }
}

// Bekræfter at en stop-/afslut-besked faktisk betyder "luk den aktive aktivitet
// nu". Ingen navne-udtrækning nødvendig (vi lukker bare den pending der findes),
// så Haiku skal kun sige ja/nej. Samme prefilter-så-Haiku-mønster som start.
async function detectActivityStop(text: string): Promise<boolean> {
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
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: { isActivityStop?: boolean }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return false
  }
  return parsed.isActivityStop === true
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
  const raw = (j.content?.[0]?.text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed: { category?: string }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return 'note'
  }

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

// "HH:MM" i Europe/Copenhagen. Bruger kolon (ikke punktum) fordi det er
// formatet for tids-tracking-bekræftelser.
function fmtTimeColonCph(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23', // h23 (ikke hour12:false) garanterer 00-23, aldrig "24:00" ved midnat
  }).formatToParts(date)
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${h}:${m}`
}

async function handleActivityStart(
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
async function handleActivityStop(msg: TelegramMessage): Promise<HandleResult> {
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
