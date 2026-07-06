// Kalender-delen af Telegram-flowet: udled ny aftale, find slet-kandidat,
// forstå og udfør en kalender-rettelse. Splittet ud af lib/telegram-webhook.ts
// (2026-07-06). Haiku bruges til at MATCHE (titel/intent); alt der kan gøres
// deterministisk (instans-valg, tidsberegning) sker i kode, jf. AGENTS.md.
import 'server-only'
import {
  extractJsonObject,
  fmtTimeColonCph,
  nowInCopenhagen,
  requireEnv,
  sendChatAction,
  sendMessage,
  type HandleResult,
  type TelegramMessage,
} from './telegram-shared'
import { getEvents, updateEvent, type GoogleCalendarEvent } from './calendar'
import { fmtRange, fmtDay, startOfTodayCph, endOfTodayCph } from './format'

const PROPOSAL_MODEL = 'claude-haiku-4-5-20251001'
const CALENDAR_EDIT_MODEL = 'claude-haiku-4-5-20251001'

// Kalender-edit prefilter. Matcher kun sandsynlige edit-kommandoer før Haiku
// afgør intent, så almindelige captures ikke betaler for et model-kald.
// NB: \b virker ikke med æ/ø/å i JS (kun ASCII tæller som word-tegn), derfor
// Unicode-grænser (?<![\p{L}\p{N}]) ... (?![\p{L}\p{N}]) med u-flag.
const CALENDAR_EDIT_TRIGGER = /(?<![\p{L}\p{N}])(?:ret(?:te|ter|tede)?|ændr(?:e|er|ede)?|flyt(?:te|ter|tede)?|startede[\s\S]{0,80}først|slut(?:tede|ter|tid)?|(?:gik|går) til|skubbede[\s\S]{0,80}til)(?![\p{L}\p{N}])/iu

export type CalendarProposal = {
  summary: string
  start: string
  end: string
  location?: string
}

export type CalendarDeletion = {
  event_id: string
  summary: string
  start: string
  end: string
  location?: string
}

export type CalendarEditType = 'end' | 'start' | 'shift'

export type CalendarEditIntent =
  | {
      isEditIntent: true
      eventHint: string
      editType: CalendarEditType
      newTime: string
    }
  | { isEditIntent: false }

export type EditableCalendarEvent = GoogleCalendarEvent & {
  id: string
  start: { dateTime: string }
  end: { dateTime: string }
}

// Slet-intent regex: matcher hele ord, ikke substrings, for at undgå false positives
// ("aftal" i "aftale" matcher fx ikke). Bruger word boundaries.
const DELETE_INTENT = /\b(slet|fjern|aflys|aflyse|aflyst|cancel|drop)\b/i

export function hasDeleteIntent(text: string | null | undefined): boolean {
  if (!text) return false
  return DELETE_INTENT.test(text)
}

export async function proposeCalendarEvent(captureContent: string): Promise<CalendarProposal | null> {
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
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{
    propose?: boolean
    summary?: string
    start?: string
    end?: string
    location?: string
  }>(raw)
  if (!parsed) return null

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

export type DeleteAttempt =
  | { match: CalendarDeletion; candidates?: never; reason?: never }
  | { match: null; candidates: CandidateSummary[]; reason: string }

export type CandidateSummary = {
  summary: string
  start?: string
  end?: string
  location?: string
}

// Lader Haiku finde et matchende kalender-event ud fra slet-beskeden.
// Returnerer enten match (klar til action) eller null + en kandidat-liste
// så vi kan vise brugeren hvad vi så på.
export async function proposeCalendarDelete(captureContent: string): Promise<DeleteAttempt> {
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
    const raw = j.content?.[0]?.text || ''
    const extracted = extractJsonObject<{ idx?: number | null; reason?: string }>(raw)
    if (!extracted) throw new Error('uparsbar Haiku-respons')
    parsed = extracted
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

export function looksLikeCalendarEdit(text: string | null | undefined): boolean {
  if (!text) return false
  return CALENDAR_EDIT_TRIGGER.test(text)
}

export async function detectCalendarEditIntent(
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
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{
    isEditIntent?: boolean
    eventHint?: string
    editType?: string
    newTime?: string
  }>(raw)
  if (!parsed) return { isEditIntent: false }

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
  message: string,
  now: Date
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
    '- Titel-overlap er vigtigst: "uni", "unilæsning" og "læsning" kan matche samme event; "seng"/"sove"/"sengetid" matcher "søvn".',
    '- Find kun den rette TITEL/begivenhed. Optræder en tilbagevendende begivenhed (fx søvn) flere dage i listen, så vælg bare ÉN af dem med den rette titel - systemet vælger selv den rette dag/instans bagefter ud fra beskedens tidspunkt.',
    '- Klokkeslættet i beskeden (fx "kl 2") er den nye tid, ikke et match-kriterie. Lad det ikke afgøre valget.',
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
  const raw = j.content?.[0]?.text || ''
  const parsed = extractJsonObject<{ event_id?: string | null }>(raw)
  if (!parsed || !parsed.event_id) return null
  const haikuMatch = candidates.find((event) => event.id === parsed.event_id)
  if (!haikuMatch) return null

  // Haiku matcher TITLEN pålideligt, men er upålidelig til at vælge den rette
  // INSTANS af en tilbagevendende begivenhed (valgte fx en søvn-instans der
  // allerede var afsluttet i morges i stedet for nattens). Vælg derfor instansen
  // DETERMINISTISK i kode: blandt kandidater med samme titel, tag den hvis start
  // er tættest på beskedens tidspunkt. Det rammer nattens søvn (få timer fremme)
  // frem for morgenens (mange timer tilbage), og dagens instans frem for morgendagens.
  const title = (haikuMatch.summary || '').trim().toLowerCase()
  const sameTitle = candidates.filter((e) => (e.summary || '').trim().toLowerCase() === title)
  if (sameTitle.length <= 1) return haikuMatch
  const nowMs = now.getTime()
  return sameTitle.reduce(
    (best, e) =>
      Math.abs(new Date(e.start.dateTime).getTime() - nowMs) <
      Math.abs(new Date(best.start.dateTime).getTime() - nowMs)
        ? e
        : best,
    sameTitle[0]
  )
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

export function normalizeEditTime(value: string, now?: Date): string | null {
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

export async function handleCalendarEdit(
  msg: TelegramMessage,
  intent: Extract<CalendarEditIntent, { isEditIntent: true }>,
  text: string
): Promise<HandleResult> {
  const chatId = msg.chat.id
  // Beskedens eget tidsstempel som "nu" -> deterministisk instans-valg og
  // robust ved gen-behandling (samme som activity-handlerne).
  const now = msg.date ? new Date(msg.date * 1000) : new Date()
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
    event = await matchCalendarEditEvent(intent.eventHint, candidates, text, now)
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

export function formatCandidates(candidates: CandidateSummary[]): string {
  if (!candidates.length) return ''
  const lines = candidates.map((c, i) => {
    const day = c.start ? fmtDay(c.start) : ''
    const range = c.start && c.end ? fmtRange(c.start, c.end) : ''
    const when = day || range ? ` (${[day, range].filter(Boolean).join(' ')})` : ''
    return `${i + 1}. ${c.summary}${when}`
  })
  return 'Det jeg så i kalenderen:\n' + lines.join('\n')
}

// Bekræftelse efter at en aftale er skrevet STRAKS i kalenderen (ingen veto).
// p.start/end er naive CPH-strenge fra Haiku; suffix med CPH-offset så fmtDay/
// fmtRange viser korrekt tid selv på Vercel (UTC).
export function formatInsertDone(p: CalendarProposal, htmlLink?: string): string {
  const sIso = withCphOffset(p.start)
  const eIso = withCphOffset(p.end)
  const loc = p.location ? `\nSted: ${p.location}` : ''
  const link = htmlLink ? `\n${htmlLink}` : ''
  return `✅ Lagt i kalenderen: ${p.summary}\nTid: ${fmtDay(sIso)} kl. ${fmtRange(sIso, eIso)}${loc}${link}`
}

// Bekræftelse efter STRAKS-sletning. p.start/end kommer fra Google (absolut ISO),
// så fmtRange/fmtDay bruges direkte uden offset-suffix.
export function formatDeletionDone(p: CalendarDeletion): string {
  const loc = p.location ? `\nSted: ${p.location}` : ''
  return `🗑️ Slettet fra kalenderen: ${p.summary}\nTid: ${fmtDay(p.start)} kl. ${fmtRange(p.start, p.end)}${loc}`
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
